import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { AuditRecord } from '../audit/audit-store';
import {
  getLatestGraphSnapshot,
  markGraphStale,
  saveGraphSnapshotAndMarkStale,
  type StoredGraphSnapshot,
} from './graph-store';
import { planIncrementalIndex, type FileFingerprint } from './incremental-index';
import {
  type GraphNodeKind,
  type GraphSnapshot,
  type PersistentGraphNode,
  type PersistentGraphRelationship,
  type PersistentGraphRelation,
  type RetrievalReason,
  type SourceLocation,
} from './model';
import { parseSource, type ParsedReference, type ParserFailure } from './parser-adapters';

const maxGraphParserFailures = 10_000;

export interface ParsedAuditFile {
  path: string;
  fingerprint: string | null;
  content: string | null;
  omissionReason?:
    | 'large_file'
    | 'fingerprint_limit'
    | 'fingerprint_incomplete'
    | 'file_changed'
    | 'content_capture_failed'
    | 'file_processing_failed';
}
export interface GraphIndexResult {
  snapshot: StoredGraphSnapshot;
  parserFailures: ParserFailure[];
  omittedFiles: number;
  filesParsed: number;
  invalidated: { revisions: number; nodes: number; relationships: number };
}

const fileOmissionMessages: Record<NonNullable<ParsedAuditFile['omissionReason']>, string> = {
  large_file: 'Source exceeds the 1,000,000-byte capture limit; metadata and fingerprint only.',
  fingerprint_limit:
    'File exceeds the remaining fingerprint byte budget or large-file allowance; path metadata only.',
  fingerprint_incomplete: 'File fingerprint could not be completed; path metadata only.',
  file_changed: 'File changed during audit capture; path metadata only.',
  content_capture_failed: 'Source content could not be captured; metadata and fingerprint only.',
  file_processing_failed: 'File could not be processed; path metadata only.',
};

function fileOmissionLanguage(reason: NonNullable<ParsedAuditFile['omissionReason']>): string {
  return reason === 'large_file' ? 'large-file' : 'audit-file';
}

interface PendingReference {
  filePath: string;
  reference: ParsedReference;
  extractionMethod: string;
}
interface SymbolRange {
  node: PersistentGraphNode;
  startLine: number;
  endLine: number;
  span: number;
  ordinal: number;
}
interface SymbolNameCandidates {
  all: PersistentGraphNode[];
  byPath: Map<string, PersistentGraphNode[]>;
}
interface PreviousExtractionIndex {
  revision: string;
  nodesById: Map<string, PersistentGraphNode>;
  filesByPath: Map<string, PersistentGraphNode>;
  evidenceByPath: Map<string, PersistentGraphNode>;
  nodesByPath: Map<string, PersistentGraphNode[]>;
  relationshipsByPath: Map<string, PersistentGraphRelationship[]>;
  failuresByPath: Map<string, ParserFailure[]>;
}

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function isReusableExtraction(method: string): boolean {
  return (
    method.startsWith('lexical-') ||
    method.startsWith('reused-lexical-') ||
    method.startsWith('typescript-ast-') ||
    method.startsWith('reused-typescript-ast-')
  );
}

/** Index the prior revision once, rather than scanning its entire graph for every file. */
function indexPreviousExtraction(previous: StoredGraphSnapshot): PreviousExtractionIndex {
  const index: PreviousExtractionIndex = {
    revision: previous.revision,
    nodesById: new Map(),
    filesByPath: new Map(),
    evidenceByPath: new Map(),
    nodesByPath: new Map(),
    relationshipsByPath: new Map(),
    failuresByPath: new Map(),
  };
  for (const node of previous.nodes) {
    index.nodesById.set(node.id, node);
    const path = node.source?.path;
    if (!path) continue;
    if (node.kind === 'file' && !index.filesByPath.has(path)) index.filesByPath.set(path, node);
    if (node.kind === 'evidence' && !index.evidenceByPath.has(path))
      index.evidenceByPath.set(path, node);
    if (isReusableExtraction(node.extractionMethod)) {
      const entries = index.nodesByPath.get(path) ?? [];
      entries.push(node);
      index.nodesByPath.set(path, entries);
    }
  }
  for (const relationship of previous.relationships) {
    const path = relationship.source?.path;
    if (!path || !isReusableExtraction(relationship.extractionMethod)) continue;
    const entries = index.relationshipsByPath.get(path) ?? [];
    entries.push(relationship);
    index.relationshipsByPath.set(path, entries);
  }
  for (const failure of previous.parserFailures) {
    const entries = index.failuresByPath.get(failure.path) ?? [];
    entries.push(failure);
    index.failuresByPath.set(failure.path, entries);
  }
  return index;
}

function sourceReferenceTarget(
  relationship: PersistentGraphRelationship,
  priorNodes: ReadonlyMap<string, PersistentGraphNode>
): string | null {
  const marker = ';target:';
  const markerIndex = relationship.provenance.lastIndexOf(marker);
  if (markerIndex >= 0) {
    try {
      return decodeURIComponent(relationship.provenance.slice(markerIndex + marker.length));
    } catch {
      return null;
    }
  }
  return priorNodes.get(relationship.targetId)?.label ?? null;
}

function localImportPath(
  fromPath: string,
  specifier: string,
  eligiblePaths: ReadonlySet<string>
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const candidates = [base];
  if (!posix.extname(base)) {
    candidates.push(...extensions.map((extension) => `${base}${extension}`));
    candidates.push(...extensions.map((extension) => `${base}/index${extension}`));
  }
  return candidates.find((candidate) => eligiblePaths.has(candidate)) ?? null;
}

function parserMethod(language: string): string {
  return language === 'TypeScript' || language === 'JavaScript'
    ? 'typescript-ast-v1'
    : `lexical-${language.toLowerCase()}`;
}

function callRangeHasPriority(left: SymbolRange, right: SymbolRange): boolean {
  return left.span < right.span || (left.span === right.span && left.ordinal < right.ordinal);
}

function pushCallRange(heap: SymbolRange[], range: SymbolRange): void {
  heap.push(range);
  let index = heap.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex];
    const current = heap[index];
    if (!parent || !current || callRangeHasPriority(parent, current)) break;
    heap[parentIndex] = current;
    heap[index] = parent;
    index = parentIndex;
  }
}

function popCallRange(heap: SymbolRange[]): void {
  const last = heap.pop();
  if (heap.length === 0 || !last) return;
  heap[0] = last;
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    const left = heap[leftIndex];
    const right = heap[rightIndex];
    const current = heap[index];
    if (!current) return;
    let bestIndex = index;
    const best = heap[bestIndex];
    if (left && best && callRangeHasPriority(left, best)) bestIndex = leftIndex;
    const nextBest = heap[bestIndex];
    if (right && nextBest && callRangeHasPriority(right, nextBest)) bestIndex = rightIndex;
    if (bestIndex === index) return;
    const child = heap[bestIndex];
    if (!child) return;
    heap[index] = child;
    heap[bestIndex] = current;
    index = bestIndex;
  }
}

/** Resolves each call to the narrowest containing symbol without rescanning every graph node. */
function indexCallersByReference(
  pendingReferences: readonly PendingReference[],
  symbolRangesByPath: ReadonlyMap<string, readonly SymbolRange[]>
): Map<PendingReference, PersistentGraphNode> {
  const callsByPath = new Map<string, PendingReference[]>();
  for (const item of pendingReferences) {
    if (item.reference.relation === 'IMPORTS' || item.reference.relation === 'DEPENDS_ON') continue;
    const calls = callsByPath.get(item.filePath) ?? [];
    calls.push(item);
    callsByPath.set(item.filePath, calls);
  }

  const callers = new Map<PendingReference, PersistentGraphNode>();
  for (const [path, calls] of callsByPath) {
    const ranges = symbolRangesByPath.get(path) ?? [];
    const orderedRanges = [...ranges].sort(
      (left, right) => left.startLine - right.startLine || left.ordinal - right.ordinal
    );
    calls.sort((left, right) => left.reference.source.startLine - right.reference.source.startLine);
    const active: SymbolRange[] = [];
    let nextRange = 0;
    for (const item of calls) {
      const line = item.reference.source.startLine;
      while (nextRange < orderedRanges.length) {
        const range = orderedRanges[nextRange];
        if (!range || range.startLine > line) break;
        pushCallRange(active, range);
        nextRange++;
      }
      while (active[0] && active[0].endLine < line) popCallRange(active);
      const caller = active[0]?.node;
      if (caller) callers.set(item, caller);
    }
  }
  return callers;
}

function addNode(
  nodes: PersistentGraphNode[],
  nodeById: Map<string, PersistentGraphNode>,
  projectId: string,
  revision: string,
  kind: GraphNodeKind,
  label: string,
  source: SourceLocation | null,
  extractionMethod: string,
  provenance: string,
  createdAt: number
): PersistentGraphNode {
  const node: PersistentGraphNode = {
    schemaVersion: 1,
    id: stableId(
      projectId,
      revision,
      kind,
      label,
      source?.path ?? '',
      String(source?.startLine ?? '')
    ),
    projectId,
    revision,
    kind,
    label,
    source,
    extractionMethod,
    provenance,
    stale: false,
    createdAt,
  };
  const existing = nodeById.get(node.id);
  if (existing) return existing;
  nodes.push(node);
  nodeById.set(node.id, node);
  return node;
}
function addRelationship(
  relationships: PersistentGraphRelationship[],
  relationshipIds: Set<string>,
  projectId: string,
  revision: string,
  sourceId: string,
  targetId: string,
  relation: PersistentGraphRelation,
  source: SourceLocation | null,
  extractionMethod: string,
  provenance: string,
  createdAt: number
): void {
  const id = stableId(
    projectId,
    revision,
    sourceId,
    targetId,
    relation,
    source?.path ?? '',
    String(source?.startLine ?? '')
  );
  if (relationshipIds.has(id)) return;
  relationshipIds.add(id);
  relationships.push({
    schemaVersion: 1,
    id,
    projectId,
    revision,
    sourceId,
    targetId,
    relation,
    source,
    extractionMethod,
    provenance,
    stale: false,
    createdAt,
  });
}

/** Copies only a fingerprint-matching file's extraction into the new revision. */
function reuseFileExtraction(
  previous: PreviousExtractionIndex,
  file: ParsedAuditFile,
  newFileNode: PersistentGraphNode,
  nodes: PersistentGraphNode[],
  nodeById: Map<string, PersistentGraphNode>,
  relationships: PersistentGraphRelationship[],
  relationshipIds: Set<string>,
  projectId: string,
  revision: string,
  auditId: string,
  createdAt: number,
  pendingReferences: PendingReference[]
): boolean {
  if (!file.fingerprint) return false;
  const priorFile = previous.filesByPath.get(file.path);
  const priorEvidence = previous.evidenceByPath.get(file.path);
  if (!priorFile || priorEvidence?.label !== file.fingerprint) return false;

  const remapped = new Map<string, PersistentGraphNode>([[priorFile.id, newFileNode]]);
  const remapNode = (id: string): PersistentGraphNode | null => {
    const known = remapped.get(id);
    if (known) return known;
    const prior = previous.nodesById.get(id);
    if (!prior) return null;
    const copied = addNode(
      nodes,
      nodeById,
      projectId,
      revision,
      prior.kind,
      prior.label,
      prior.source,
      `reused-${prior.extractionMethod.replace(/^(?:reused-)+/, '')}`,
      `reused-from:${previous.revision};prior-extraction:${prior.extractionMethod};audit:${auditId}`,
      createdAt
    );
    remapped.set(id, copied);
    return copied;
  };

  for (const node of previous.nodesByPath.get(file.path) ?? []) {
    if (node.id !== priorFile.id && node.id !== priorEvidence.id) remapNode(node.id);
  }
  for (const relationship of previous.relationshipsByPath.get(file.path) ?? []) {
    if (
      relationship.relation === 'IMPORTS' ||
      relationship.relation === 'CALLS' ||
      relationship.relation === 'DEPENDS_ON'
    ) {
      const target = sourceReferenceTarget(relationship, previous.nodesById);
      if (!target || !relationship.source) continue;
      pendingReferences.push({
        filePath: file.path,
        reference: {
          target,
          relation: relationship.relation,
          source: relationship.source,
        },
        extractionMethod: `reused-${relationship.extractionMethod.replace(/^(?:reused-)+/, '')}`,
      });
      continue;
    }
    // TESTS edges are derived from CALLS below and must resolve against the new revision.
    if (relationship.relation !== 'CONTAINS') continue;
    const source = remapNode(relationship.sourceId);
    const target = remapNode(relationship.targetId);
    if (!source || !target) continue;
    addRelationship(
      relationships,
      relationshipIds,
      projectId,
      revision,
      source.id,
      target.id,
      relationship.relation,
      relationship.source,
      `reused-${relationship.extractionMethod.replace(/^(?:reused-)+/, '')}`,
      `reused-from:${previous.revision};prior-extraction:${relationship.extractionMethod};audit:${auditId}`,
      createdAt
    );
  }
  return true;
}

/** Builds an explicit lexical graph. Extracted links remain observations, not findings or proof. */
export async function indexAuditGraph(
  audit: AuditRecord,
  files: readonly ParsedAuditFile[],
  previousFiles: readonly FileFingerprint[] = []
): Promise<GraphIndexResult> {
  // An audit id is immutable even when several dirty snapshots share one Git commit.
  const revision = `audit:${audit.id}`;
  const projectId = audit.locationId;
  const nodes: PersistentGraphNode[] = [];
  const nodeById = new Map<string, PersistentGraphNode>();
  const relationships: PersistentGraphRelationship[] = [];
  const relationshipIds = new Set<string>();
  const retrievalReasons: RetrievalReason[] = [];
  const parserFailures: ParserFailure[] = [];
  const pendingReferences: PendingReference[] = [];
  const current = files.flatMap(({ path, fingerprint }) =>
    fingerprint ? [{ path, hash: fingerprint }] : []
  );
  const latest = await getLatestGraphSnapshot(projectId);
  const now = Math.max(Date.now(), (latest?.capturedAt ?? 0) + 1);
  const inferredPrevious = latest
    ? latest.nodes
        .filter((node) => node.kind === 'evidence' && node.source)
        .map((node) => ({ path: node.source!.path, hash: node.label }))
    : [];
  const priorFilePaths = new Set([
    ...(latest?.nodes
      .filter((node) => node.kind === 'file' && node.source)
      .map((node) => node.source!.path) ?? []),
    ...previousFiles.map((file) => file.path),
  ]);
  const plan = planIncrementalIndex(
    previousFiles.length ? previousFiles : inferredPrevious,
    current,
    []
  );
  // A missing repository fingerprint does not make every file stale. Keep
  // invalidation path-scoped: known hash changes/deletions, files currently
  // missing a verified fingerprint, and historical paths absent from this
  // inventory. This preserves fresh evidence for independently verified
  // siblings while keeping uncertain paths visibly stale.
  const currentPaths = new Set(files.map((file) => file.path));
  const changedPaths = [
    ...new Set([
      ...plan.changed,
      ...plan.deleted,
      ...files.filter((file) => file.fingerprint === null).map((file) => file.path),
      ...[...priorFilePaths].filter((path) => !currentPaths.has(path)),
    ]),
  ];
  try {
    const previousIndex = latest ? indexPreviousExtraction(latest) : null;
    const reindexPaths = new Set(plan.reindex);
    const revisionNode = addNode(
      nodes,
      nodeById,
      projectId,
      revision,
      'repository_revision',
      revision,
      null,
      'audit-snapshot',
      `audit:${audit.id}`,
      now
    );
    const observation = addNode(
      nodes,
      nodeById,
      projectId,
      revision,
      'observation',
      `audit:${audit.id}`,
      null,
      'audit-inventory',
      `audit:${audit.id}`,
      now
    );
    addRelationship(
      relationships,
      relationshipIds,
      projectId,
      revision,
      observation.id,
      revisionNode.id,
      'SUPPORTS',
      null,
      'audit-inventory',
      `audit:${audit.id}`,
      now
    );
    for (const file of files) {
      const fileNode = addNode(
        nodes,
        nodeById,
        projectId,
        revision,
        'file',
        file.path,
        { path: file.path, startLine: 1, endLine: 1 },
        'filesystem-audit',
        file.fingerprint
          ? `fingerprint:${file.fingerprint}`
          : `audit:${audit.id};fingerprint:unavailable`,
        now
      );
      addRelationship(
        relationships,
        relationshipIds,
        projectId,
        revision,
        revisionNode.id,
        fileNode.id,
        'CONTAINS',
        null,
        'filesystem-audit',
        `audit:${audit.id}`,
        now
      );
      if (!file.fingerprint) {
        const reason = file.omissionReason ?? 'fingerprint_incomplete';
        parserFailures.push({
          path: file.path,
          language: fileOmissionLanguage(reason),
          message: fileOmissionMessages[reason],
        });
        continue;
      }
      const evidence = addNode(
        nodes,
        nodeById,
        projectId,
        revision,
        'evidence',
        file.fingerprint,
        { path: file.path, startLine: 1, endLine: 1 },
        'sha256',
        `audit:${audit.id}`,
        now
      );
      addRelationship(
        relationships,
        relationshipIds,
        projectId,
        revision,
        evidence.id,
        fileNode.id,
        'SUPPORTS',
        { path: file.path, startLine: 1, endLine: 1 },
        'sha256',
        `audit:${audit.id}`,
        now
      );
      retrievalReasons.push({
        id: randomUUID(),
        projectId,
        revision,
        evidenceNodeId: evidence.id,
        reason:
          'Retrieved because this eligible file belongs to the selected local audit snapshot.',
        retrievedAt: now,
      });
      if (file.content === null) {
        const reason = file.omissionReason ?? 'content_capture_failed';
        parserFailures.push({
          path: file.path,
          language: fileOmissionLanguage(reason),
          message: fileOmissionMessages[reason],
        });
        continue;
      }
      const reused = Boolean(
        previousIndex &&
        !reindexPaths.has(file.path) &&
        reuseFileExtraction(
          previousIndex,
          file,
          fileNode,
          nodes,
          nodeById,
          relationships,
          relationshipIds,
          projectId,
          revision,
          audit.id,
          now,
          pendingReferences
        )
      );
      if (reused && previousIndex) {
        parserFailures.push(...(previousIndex.failuresByPath.get(file.path) ?? []));
        continue;
      }
      let parsed: ReturnType<typeof parseSource>;
      try {
        parsed = parseSource(file.path, file.content);
      } catch {
        // A parser can fail on pathological input; preserve this file's fingerprint
        // and continue with the remaining files without leaking exception contents.
        parserFailures.push({
          path: file.path,
          language: 'unknown',
          message: 'Parser failed unexpectedly; source relationships may be missing.',
        });
        continue;
      }
      if ('message' in parsed) {
        parserFailures.push(parsed);
        continue;
      }
      for (const symbol of parsed.symbols) {
        const extractionMethod = parserMethod(parsed.language);
        const kind: GraphNodeKind = symbol.kind === 'test' ? 'test' : 'symbol';
        const symbolNode = addNode(
          nodes,
          nodeById,
          projectId,
          revision,
          kind,
          `${file.path}:${symbol.name}`,
          symbol.source,
          extractionMethod,
          `audit:${audit.id}`,
          now
        );
        addRelationship(
          relationships,
          relationshipIds,
          projectId,
          revision,
          fileNode.id,
          symbolNode.id,
          'CONTAINS',
          symbol.source,
          extractionMethod,
          `audit:${audit.id}`,
          now
        );
      }
      for (const reference of parsed.references) {
        pendingReferences.push({
          filePath: file.path,
          reference,
          extractionMethod: parserMethod(parsed.language),
        });
      }
    }

    const eligiblePaths = new Set(files.map((file) => file.path));
    const fileNodesByPath = new Map(
      nodes.filter((node) => node.kind === 'file').map((node) => [node.label, node] as const)
    );
    const symbolsByName = new Map<string, SymbolNameCandidates>();
    const symbolRangesByPath = new Map<string, SymbolRange[]>();
    for (const [ordinal, node] of nodes.entries()) {
      if ((node.kind !== 'symbol' && node.kind !== 'test') || !node.source) continue;
      const ranges = symbolRangesByPath.get(node.source.path) ?? [];
      ranges.push({
        node,
        startLine: node.source.startLine,
        endLine: node.source.endLine,
        span: node.source.endLine - node.source.startLine,
        ordinal,
      });
      symbolRangesByPath.set(node.source.path, ranges);
      const prefix = `${node.source.path}:`;
      if (!node.label.startsWith(prefix)) continue;
      const name = node.label.slice(prefix.length);
      const candidates = symbolsByName.get(name) ?? {
        all: [],
        byPath: new Map<string, PersistentGraphNode[]>(),
      };
      candidates.all.push(node);
      const localCandidates = candidates.byPath.get(node.source.path) ?? [];
      localCandidates.push(node);
      candidates.byPath.set(node.source.path, localCandidates);
      symbolsByName.set(name, candidates);
    }
    const getSymbolTarget = (name: string, fromPath: string): PersistentGraphNode | null => {
      const candidates = symbolsByName.get(name);
      if (!candidates) return null;
      const local = candidates.byPath.get(fromPath) ?? [];
      if (local.length === 1) return local[0]!;
      if (candidates.all.length === 1) return candidates.all[0]!;
      return null;
    };
    const callerByReference = indexCallersByReference(pendingReferences, symbolRangesByPath);
    for (const item of pendingReferences) {
      const { reference } = item;
      const importer = fileNodesByPath.get(item.filePath);
      if (!importer) continue;
      let sourceNode = importer;
      let targetNode: PersistentGraphNode | null = null;
      const relation = reference.relation;
      if (relation === 'IMPORTS') {
        const localPath = localImportPath(item.filePath, reference.target, eligiblePaths);
        targetNode = localPath
          ? (fileNodesByPath.get(localPath) ?? null)
          : addNode(
              nodes,
              nodeById,
              projectId,
              revision,
              'dependency',
              reference.target,
              null,
              item.extractionMethod,
              `audit:${audit.id};target:${encodeURIComponent(reference.target)}`,
              now
            );
      } else if (relation === 'DEPENDS_ON') {
        targetNode = addNode(
          nodes,
          nodeById,
          projectId,
          revision,
          'dependency',
          reference.target,
          null,
          item.extractionMethod,
          `audit:${audit.id};target:${encodeURIComponent(reference.target)}`,
          now
        );
      } else {
        const caller = callerByReference.get(item);
        if (caller) sourceNode = caller;
        targetNode = getSymbolTarget(reference.target, item.filePath);
        if (!targetNode) {
          targetNode = addNode(
            nodes,
            nodeById,
            projectId,
            revision,
            'symbol',
            reference.target,
            null,
            'unresolved-reference',
            `audit:${audit.id};unresolved:${encodeURIComponent(reference.target)}`,
            now
          );
        }
      }
      if (!targetNode) {
        targetNode = addNode(
          nodes,
          nodeById,
          projectId,
          revision,
          'dependency',
          reference.target,
          null,
          'unresolved-reference',
          `audit:${audit.id};unresolved:${encodeURIComponent(reference.target)}`,
          now
        );
      }
      const provenance = `audit:${audit.id};target:${encodeURIComponent(reference.target)}`;
      addRelationship(
        relationships,
        relationshipIds,
        projectId,
        revision,
        sourceNode.id,
        targetNode.id,
        relation,
        reference.source,
        item.extractionMethod,
        provenance,
        now
      );
      if (relation === 'CALLS' && sourceNode.kind === 'test') {
        addRelationship(
          relationships,
          relationshipIds,
          projectId,
          revision,
          sourceNode.id,
          targetNode.id,
          'TESTS',
          reference.source,
          item.extractionMethod,
          provenance,
          now
        );
      }
    }
    const omittedFiles = new Set(parserFailures.map((failure) => failure.path)).size;
    const fileCount = new Set(files.map((file) => file.path)).size;
    const filesParsed = Math.max(0, fileCount - omittedFiles);
    const persistedParserFailures =
      parserFailures.length <= maxGraphParserFailures
        ? parserFailures
        : [
            ...parserFailures.slice(0, maxGraphParserFailures - 1),
            {
              path: '__tracemind__/diagnostics-truncated',
              language: 'diagnostics-limit',
              message:
                'Additional parser diagnostics are omitted; audit graph coverage contains the full omission count.',
            },
          ];
    const snapshot: GraphSnapshot = {
      schemaVersion: 1,
      projectId,
      revision,
      nodes,
      relationships,
      retrievalReasons,
      parserFailures: persistedParserFailures,
    };
    const committed = await saveGraphSnapshotAndMarkStale(snapshot, changedPaths, now);
    return {
      snapshot: committed.snapshot,
      parserFailures: persistedParserFailures,
      omittedFiles,
      filesParsed,
      invalidated: committed.invalidated,
    };
  } catch (error) {
    if (latest && changedPaths.length > 0) {
      try {
        await markGraphStale(projectId, changedPaths);
      } catch {
        throw new Error('Graph indexing failed; historical graph freshness could not be updated.');
      }
    }
    throw error;
  }
}
