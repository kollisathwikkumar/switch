import { createHash } from 'node:crypto';
import type { ParsedAuditFile } from '../graph/graph-service';
import { MAX_PARSER_SOURCE_BYTES } from '../graph/parser-adapters';
import {
  scanProject,
  type NativeProjectFs,
  type ProjectFileHandle,
} from '../native/access-registry';
import type { AuditEvidence, AuditInput, AuditRecord } from './audit-store';
import { fingerprintOpenedFiles } from './fingerprint';
import { readGitDirtyState } from './git-dirty-state';
import { readGitRevision } from './git-revision';
import { summarizeInventory } from './inventory-summary';

export interface ApprovedAuditProject {
  locationId: string;
  root: string;
  identity: string;
}
interface AuditGraphIndexResult {
  parserFailures: readonly { path: string }[];
  omittedFiles?: number;
  filesParsed?: number;
}
export interface AuditDependencies {
  consume: (locationId: string) => Promise<ApprovedAuditProject | null>;
  native: NativeProjectFs;
  gitStatusExecutable?: string;
  save: (input: AuditInput, evidence: readonly AuditEvidence[]) => Promise<AuditRecord>;
  maxBytes?: number;
  /** Receives only content already opened and confined by the audit scanner. */
  indexGraph?: (
    audit: AuditRecord,
    files: readonly ParsedAuditFile[]
  ) => Promise<AuditGraphIndexResult | void>;
  recordGraphCoverage?: (
    audit: AuditRecord,
    coverage: { status: 'complete' | 'partial'; omittedFiles: number; filesParsed: number }
  ) => Promise<AuditRecord>;
  /** Records a durable, non-sensitive limitation if graph persistence fails. */
  recordGraphFailure?: (
    audit: AuditRecord,
    coverage?: { omittedFiles: number; filesParsed: number }
  ) => Promise<AuditRecord>;
}

/** Read no more than the size already fingerprinted, and verify the captured bytes. */
async function readIndexedContent(
  handle: ProjectFileHandle,
  path: string,
  size: number,
  expectedFingerprint: string
): Promise<string | null> {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) return null;
  const contentHash = createHash('sha256').update(buffer.subarray(0, size)).digest('hex');
  const fingerprint = createHash('sha256')
    .update('tracemind-files-v1\0')
    .update(JSON.stringify([path, contentHash]))
    .update('\n')
    .digest('hex');
  return fingerprint === expectedFingerprint ? buffer.subarray(0, size).toString('utf8') : null;
}

/** Runs one bounded local scan and persists its metadata; no model or network is used. */
export async function runLocalAudit(
  locationId: string,
  deps: AuditDependencies
): Promise<AuditRecord> {
  const maxBytes = deps.maxBytes ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_073_741_824)
    throw new Error('Invalid audit byte limit');
  const project = await deps.consume(locationId);
  if (!project || project.locationId !== locationId) throw new Error('Audit approval required');
  const beforeRevision = await readGitRevision(deps.native, project.root, project.identity);
  const digests: { path: string; hash: string }[] = [];
  const parsedFiles: ParsedAuditFile[] = [];
  let bytes = 0;
  let largeFileBytes = 0;
  // Large sources cannot be parsed by the bounded adapter, so they must not
  // consume most of the aggregate budget before parseable siblings are seen.
  // Keep their fingerprints useful but bounded to one quarter of the budget,
  // with an absolute 16 MiB ceiling. Small/processable files retain priority.
  const largeFileFingerprintBudget = Math.min(16 * 1024 * 1024, Math.floor(maxBytes / 4));
  let fingerprintFailure: string | null = null;
  const scan = await scanProject(
    deps.native,
    project.root,
    project.identity,
    { maxEntries: 50_000, maxDepth: 48 },
    async (path, handle) => {
      const info = await handle.stat({ bigint: true });
      const parserOversized =
        Boolean(deps.indexGraph) && info.size > BigInt(MAX_PARSER_SOURCE_BYTES);
      const remainingBudget = maxBytes - bytes;
      const remainingLargeFileBudget = largeFileFingerprintBudget - largeFileBytes;
      const fileBudget = parserOversized
        ? Math.min(remainingBudget, remainingLargeFileBudget)
        : remainingBudget;
      if (info.size > BigInt(Math.max(0, fileBudget))) {
        fingerprintFailure = parserOversized
          ? 'Large-file fingerprint allowance reached.'
          : 'Fingerprint byte limit reached.';
        parsedFiles.push({
          path,
          fingerprint: null,
          content: null,
          omissionReason: 'fingerprint_limit',
        });
        return;
      }
      const result = await fingerprintOpenedFiles([{ path, handle }], Math.max(1, fileBudget));
      if (!result.fingerprint) {
        fingerprintFailure = `Fingerprint incomplete: ${result.reason}.`;
        parsedFiles.push({
          path,
          fingerprint: null,
          content: null,
          omissionReason: 'fingerprint_incomplete',
        });
        return;
      }
      const after = await handle.stat({ bigint: true });
      if (
        info.size !== after.size ||
        info.mtimeNs !== after.mtimeNs ||
        info.ctimeNs !== after.ctimeNs
      ) {
        fingerprintFailure = 'Fingerprint incomplete: file changed.';
        parsedFiles.push({
          path,
          fingerprint: null,
          content: null,
          omissionReason: 'file_changed',
        });
        return;
      }
      bytes += Number(after.size);
      if (parserOversized) largeFileBytes += Number(after.size);
      digests.push({ path, hash: result.fingerprint });
      if (deps.indexGraph && after.size > BigInt(MAX_PARSER_SOURCE_BYTES)) {
        parsedFiles.push({
          path,
          fingerprint: result.fingerprint,
          content: null,
          omissionReason: 'large_file',
        });
      } else if (deps.indexGraph) {
        let content: string | null = null;
        let omissionReason: ParsedAuditFile['omissionReason'];
        try {
          content = await readIndexedContent(handle, path, Number(after.size), result.fingerprint);
          if (content === null) {
            fingerprintFailure = 'Source capture changed after fingerprinting.';
            omissionReason = 'file_changed';
          }
        } catch {
          // Parsing is supplementary; the verified fingerprint remains useful evidence.
          omissionReason = 'content_capture_failed';
        }
        parsedFiles.push({ path, fingerprint: result.fingerprint, content, omissionReason });
      }
    }
  );
  if (deps.indexGraph) {
    const indexedPaths = new Set(parsedFiles.map((file) => file.path));
    for (const path of scan.files) {
      if (!indexedPaths.has(path))
        parsedFiles.push({
          path,
          fingerprint: null,
          content: null,
          omissionReason: 'file_processing_failed',
        });
    }
  }
  const dirtyState = await readGitDirtyState(
    deps.native,
    project.root,
    project.identity,
    deps.gitStatusExecutable
  );
  const afterRevision = await readGitRevision(deps.native, project.root, project.identity);
  const revision = beforeRevision && beforeRevision === afterRevision ? beforeRevision : null;
  const inventory = summarizeInventory({
    root: project.root,
    files: scan.files,
    skipped: scan.skipped,
    skippedEntries: scan.skippedEntries,
    skipDetailsTruncated: scan.skipDetailsTruncated,
    errors: scan.errors,
    complete: scan.complete,
    entriesExamined: scan.entriesExamined,
  });
  if (!revision)
    inventory.limitations.push(
      'Git revision is unavailable, unsupported, or changed during audit.'
    );
  if (dirtyState.dirty === null)
    inventory.limitations.push(`Working-tree dirty state is unavailable (${dirtyState.reason}).`);
  inventory.limitations.push('Git dirty status excludes submodule worktree changes.');
  inventory.limitations.push(
    'Filesystem identities can be reused and do not prove repository continuity.'
  );
  inventory.limitations.push(
    'Fingerprint covers eligible files only and is not an atomic repository snapshot.'
  );
  inventory.limitations.push(
    'The scan deadline is cooperative and cannot interrupt a blocking filesystem operation.'
  );
  if (fingerprintFailure) inventory.limitations.push(fingerprintFailure);
  if (!scan.complete)
    inventory.limitations.push('Fingerprint unavailable because the file scan was incomplete.');
  const graphComplete =
    scan.complete && !fingerprintFailure && parsedFiles.length === scan.files.length;
  if (deps.indexGraph) {
    inventory.graphCoverage = {
      status: 'partial',
      omittedFiles: Math.max(
        0,
        scan.files.length - parsedFiles.filter((file) => file.content !== null).length
      ),
    };
    if (!graphComplete || parsedFiles.some((file) => file.content === null))
      inventory.limitations.push(
        'Graph coverage is partial; some files could not be parsed and evidence may be missing.'
      );
    if (!scan.complete || fingerprintFailure)
      inventory.limitations.push(
        'Historical freshness is uncertain because the scan or fingerprint was incomplete.'
      );
  }
  let fingerprint: string | null = null;
  if (scan.complete && !fingerprintFailure) {
    const hash = createHash('sha256');
    hash.update('tracemind-audit-v1\0');
    for (const entry of digests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
      hash.update(`${JSON.stringify([entry.path, entry.hash])}\n`);
    fingerprint = hash.digest('hex');
  }
  const audit = await deps.save(
    {
      locationId,
      root: project.root,
      identity: project.identity,
      revision,
      dirty: dirtyState.dirty,
      fingerprint,
      capturedAt: Date.now(),
      inventory,
    },
    digests.map((item) => ({ path: item.path, fingerprint: item.hash }))
  );
  if (deps.indexGraph) {
    let result: AuditGraphIndexResult | void;
    try {
      result = await deps.indexGraph(audit, parsedFiles);
    } catch {
      if (!deps.recordGraphFailure)
        throw new Error('Graph indexing failed after audit persistence');
      return deps.recordGraphFailure(audit);
    }
    if (result && deps.recordGraphCoverage) {
      const capturedPaths = new Set(parsedFiles.map((file) => file.path));
      const observedOmissions = new Set([
        ...result.parserFailures.map((failure) => failure.path),
        ...parsedFiles.filter((file) => file.content === null).map((file) => file.path),
        ...scan.files.filter((path) => !capturedPaths.has(path)),
      ]).size;
      const countInRange = (value: number | undefined): boolean =>
        value === undefined ||
        (Number.isSafeInteger(value) && value >= 0 && value <= scan.files.length);
      const reportedOmittedFiles = result.omittedFiles ?? observedOmissions;
      const reportedFilesParsed =
        result.filesParsed ?? Math.max(0, scan.files.length - reportedOmittedFiles);
      const adapterCountsInRange =
        countInRange(result.omittedFiles) && countInRange(result.filesParsed);
      const adapterCountsConsistent =
        adapterCountsInRange &&
        reportedOmittedFiles >= observedOmissions &&
        reportedFilesParsed + reportedOmittedFiles === scan.files.length;
      // Reconcile adapter metrics with independently observed file outcomes.
      // Inconsistent counters must make coverage more conservative, never
      // promote a graph to complete or understate known omissions.
      const omittedFiles = adapterCountsInRange
        ? Math.min(
            scan.files.length,
            Math.max(
              observedOmissions,
              reportedOmittedFiles,
              scan.files.length - reportedFilesParsed
            )
          )
        : scan.files.length;
      const filesParsed = adapterCountsInRange
        ? Math.min(reportedFilesParsed, scan.files.length - omittedFiles)
        : 0;
      const coverage = {
        status:
          scan.complete &&
          !fingerprintFailure &&
          adapterCountsConsistent &&
          omittedFiles === 0 &&
          filesParsed === scan.files.length
            ? ('complete' as const)
            : ('partial' as const),
        omittedFiles,
        filesParsed,
      };
      try {
        return await deps.recordGraphCoverage(audit, coverage);
      } catch {
        if (!deps.recordGraphFailure)
          throw new Error('Graph coverage could not be persisted after indexing');
        return deps.recordGraphFailure(audit, {
          omittedFiles: coverage.omittedFiles,
          filesParsed: coverage.filesParsed,
        });
      }
    }
  }
  return audit;
}
