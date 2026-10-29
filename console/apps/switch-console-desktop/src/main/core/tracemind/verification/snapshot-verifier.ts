import { createHash } from 'node:crypto';
import type { AuditRecord } from '../audit/audit-store';
import { fingerprintOpenedFiles } from '../audit/fingerprint';
import {
  nativeFileIdentity,
  scanProject,
  type NativeProjectFs,
  type ProjectFileHandle,
} from '../native/access-registry';
import type { Snapshot } from './approval-service';
import {
  commandProposalSchema,
  discoverPackageChecks,
  type CommandProposal,
} from './command-contract';
import type { SandboxMode } from './sandbox';

const maxBytes = 128 * 1024 * 1024;
const maxManifestBytes = 1_000_000;

async function readManifest(
  handle: ProjectFileHandle,
  path: string,
  size: number,
  fingerprint: string
): Promise<string | null> {
  if (size > maxManifestBytes) return null;
  const bytes = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!read.bytesRead) break;
    offset += read.bytesRead;
  }
  if (offset !== size) return null;
  const content = bytes.subarray(0, size);
  const hash = createHash('sha256').update(content).digest('hex');
  const digest = createHash('sha256')
    .update('tracemind-files-v1\0')
    .update(JSON.stringify([path, hash]))
    .update('\n')
    .digest('hex');
  return digest === fingerprint ? content.toString('utf8') : null;
}

/** Re-scan eligible files while retaining only selected, fingerprint-matched manifests. */
async function captureAuditedManifests(
  audit: AuditRecord,
  native: NativeProjectFs,
  paths: readonly string[]
): Promise<{ manifests: Map<string, string>; parentIdentities: Map<string, string> } | null> {
  if (!audit.identity || !audit.fingerprint || !audit.inventory.inventoryComplete) return null;
  const selected = new Set(paths);
  const manifests = new Map<string, string>();
  const parentIdentities = new Map<string, string>();
  const digests: { path: string; hash: string }[] = [];
  let bytes = 0;
  let invalid = false;
  try {
    const scan = await scanProject(
      native,
      audit.root,
      audit.identity,
      { maxEntries: 50_000, maxDepth: 48 },
      async (path, handle, parentFd) => {
        const before = await handle.stat({ bigint: true });
        if (before.size > BigInt(maxBytes - bytes)) {
          invalid = true;
          return;
        }
        const result = await fingerprintOpenedFiles(
          [{ path, handle }],
          Math.max(1, maxBytes - bytes)
        );
        if (!result.fingerprint) {
          invalid = true;
          return;
        }
        if (selected.has(path)) {
          if (before.size <= BigInt(maxManifestBytes)) {
            const content = await readManifest(
              handle,
              path,
              Number(before.size),
              result.fingerprint
            );
            if (content === null) invalid = true;
            else {
              manifests.set(path, content);
              parentIdentities.set(path, nativeFileIdentity(native, parentFd));
            }
          }
        }
        const after = await handle.stat({ bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        ) {
          invalid = true;
          return;
        }
        bytes += Number(after.size);
        digests.push({ path, hash: result.fingerprint });
      }
    );
    if (!scan.complete || invalid || digests.length !== scan.files.length) return null;
    const hash = createHash('sha256').update('tracemind-audit-v1\0');
    for (const entry of digests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
      hash.update(`${JSON.stringify([entry.path, entry.hash])}\n`);
    if (hash.digest('hex') !== audit.fingerprint) return null;
    return { manifests, parentIdentities };
  } catch {
    return null;
  }
}

/** No command is executed; caller must obtain consent for this fresh filesystem scan. */
export async function discoverAuditedChecks(
  audit: AuditRecord,
  native: NativeProjectFs,
  sandboxMode: SandboxMode = 'unavailable'
): Promise<{ candidates: CommandProposal[]; limitations: string[] } | null> {
  const all = [
    ...new Set(
      audit.inventory.manifests.filter(
        (path) => path === 'package.json' || path.endsWith('/package.json')
      )
    ),
  ].sort((a, b) =>
    a === 'package.json' ? -1 : b === 'package.json' ? 1 : a < b ? -1 : a > b ? 1 : 0
  );
  const paths = all.slice(0, 32);
  const captured = await captureAuditedManifests(audit, native, paths);
  if (!captured) return null;
  const candidates: CommandProposal[] = [];
  const limitations: string[] = [
    'Only npm test scripts in eligible package manifests are discovered; discovery does not execute them.',
  ];
  if (all.length > paths.length)
    limitations.push(
      `Only the first ${paths.length} of ${all.length} package manifests were inspected.`
    );
  for (const path of paths) {
    const content = captured.manifests.get(path);
    if (content === undefined) {
      limitations.push(`${path}: manifest unavailable or above the capture limit.`);
      continue;
    }
    try {
      const directory = path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length);
      candidates.push(
        ...discoverPackageChecks(content, directory, `audit:${audit.id}`, sandboxMode)
      );
    } catch {
      limitations.push(`${path}: invalid or unsupported package manifest.`);
    }
  }
  candidates.sort((a, b) => a.workingDirectory.localeCompare(b.workingDirectory));
  return { candidates, limitations };
}

/**
 * Compares a fresh bounded, descriptor-relative scan with an existing audit.
 * This is not a consent grant and does not pin the root after this function returns.
 */
export async function verifyApprovalSnapshot(
  audit: AuditRecord,
  input: CommandProposal,
  native: NativeProjectFs
): Promise<Snapshot | null> {
  const parsed = commandProposalSchema.safeParse(input);
  if (
    !parsed.success ||
    !audit.identity ||
    !audit.fingerprint ||
    parsed.data.revision !== `audit:${audit.id}`
  )
    return null;
  const proposal = parsed.data;
  const manifestPath =
    proposal.workingDirectory === '.'
      ? 'package.json'
      : `${proposal.workingDirectory}/package.json`;
  const captured = await captureAuditedManifests(audit, native, [manifestPath]);
  const manifest = captured?.manifests.get(manifestPath);
  const workingDirectoryIdentity = captured?.parentIdentities.get(manifestPath);
  if (manifest === undefined || !workingDirectoryIdentity) return null;
  try {
    const candidate = discoverPackageChecks(
      manifest,
      proposal.workingDirectory,
      proposal.revision,
      proposal.sandboxMode
    )[0];
    if (
      !candidate ||
      JSON.stringify(candidate.declaredScripts) !== JSON.stringify(proposal.declaredScripts)
    )
      return null;
    return {
      root: audit.root,
      identity: audit.identity,
      fingerprint: audit.fingerprint,
      workingDirectoryIdentity,
    };
  } catch {
    return null;
  }
}
