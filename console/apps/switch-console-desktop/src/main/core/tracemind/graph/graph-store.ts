import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DrizzleTx } from '@main/db/client';
import {
  kv,
  tracemindGraphNodes,
  tracemindGraphParserFailures,
  tracemindGraphRelationships,
  tracemindGraphRetrievalReasons,
  tracemindGraphRevisions,
} from '@main/db/schema';
import {
  graphNodeSchema,
  graphNodeKindSchema,
  graphPathSchema,
  graphRelationshipSchema,
  graphSnapshotSchema,
  maxGraphRelationships,
  retrievalReasonSchema,
} from './model';

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revisionSchema = z.string().min(1).max(128);
const maxGraphSnapshotBytes = 256 * 1024 * 1024;
const maxGraphHistoryBytes = 512 * 1024 * 1024;
const maxGraphRevisions = 1000;
const maxGraphNodes = 100_000;
const maxGraphRetrievalReasons = 100_000;
const maxGraphParserFailures = 10_000;
const maxGraphChangedPaths = 100_000;
const insertBatchSize = 80;
const snapshotRecordSchema = graphSnapshotSchema
  .extend({ capturedAt: z.number().int().nonnegative() })
  .strict();
const parserFailureSchema = z
  .object({ path: graphPathSchema, language: z.string().max(128), message: z.string().max(1024) })
  .strict();
export type StoredGraphSnapshot = z.infer<typeof snapshotRecordSchema>;

export interface GraphAdjacencyIndexRow {
  id: string;
  targetId: string;
  payloadBytes: number;
}

export interface GraphRevisionCounts {
  nodes: number;
  relationships: number;
}

const graphNodePreviewSchema = z.object({
  id: z.string().min(1).max(512),
  kind: graphNodeKindSchema,
  label: z.string().min(1).max(8192),
  stale: z.boolean(),
});
export interface GraphOverview {
  revision: string;
  rootNodeId: string | null;
  nodeCount: number;
  relationshipCount: number;
  parserFailureCount: number;
  nodes: z.infer<typeof graphNodePreviewSchema>[];
  nextCursor: string | null;
  parserFailures: z.infer<typeof parserFailureSchema>[];
  retrievalReasons: z.infer<typeof retrievalReasonSchema>[];
}

function prefix(projectId: string): string {
  return `tracemind:graph:${projectIdSchema.parse(projectId)}:`;
}
function key(projectId: string, revision: string): string {
  return `${prefix(projectId)}${encodeURIComponent(revisionSchema.parse(revision))}`;
}
function parse(raw: string, projectId: string, revision: string): StoredGraphSnapshot {
  assertGraphPayloadSize(raw);
  const value = snapshotRecordSchema.parse(JSON.parse(raw));
  if (value.projectId !== projectId || value.revision !== revision)
    throw new Error('Stored graph identity mismatch');
  return value;
}

function assertGraphPayloadSize(raw: string): void {
  if (Buffer.byteLength(raw, 'utf8') > maxGraphSnapshotBytes)
    throw new Error('Graph snapshot size limit exceeded');
}

function assertSnapshot(snapshot: StoredGraphSnapshot): void {
  if (
    snapshot.nodes.length > maxGraphNodes ||
    snapshot.relationships.length > maxGraphRelationships ||
    snapshot.retrievalReasons.length > maxGraphRetrievalReasons ||
    snapshot.parserFailures.length > maxGraphParserFailures
  )
    throw new Error('Graph revision count limit exceeded');
  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.projectId !== snapshot.projectId || node.revision !== snapshot.revision)
      throw new Error('Graph node revision mismatch');
    if (nodeIds.has(node.id)) throw new Error('Duplicate graph node');
    nodeIds.add(node.id);
  }
  const relationshipIds = new Set<string>();
  for (const relationship of snapshot.relationships) {
    if (
      relationship.projectId !== snapshot.projectId ||
      relationship.revision !== snapshot.revision
    )
      throw new Error('Graph relationship revision mismatch');
    if (relationshipIds.has(relationship.id)) throw new Error('Duplicate graph relationship');
    relationshipIds.add(relationship.id);
    if (!nodeIds.has(relationship.sourceId) || !nodeIds.has(relationship.targetId))
      throw new Error('Graph relationship references an unknown node');
  }
  for (const reason of snapshot.retrievalReasons) {
    if (reason.projectId !== snapshot.projectId || reason.revision !== snapshot.revision)
      throw new Error('Graph retrieval reason revision mismatch');
    if (!nodeIds.has(reason.evidenceNodeId))
      throw new Error('Retrieval reason references an unknown node');
  }
}

function decodeNodeRow(row: typeof tracemindGraphNodes.$inferSelect) {
  const node = graphNodeSchema.parse(JSON.parse(row.payload));
  if (
    node.projectId !== row.projectId ||
    node.revision !== row.revision ||
    node.id !== row.id ||
    node.kind !== row.kind ||
    node.label !== row.label ||
    node.stale !== row.stale ||
    (node.source?.path ?? null) !== row.sourcePath ||
    (node.source?.startLine ?? null) !== row.startLine ||
    (node.source?.endLine ?? null) !== row.endLine
  )
    throw new Error('Stored graph node index mismatch');
  return node;
}

function decodeRelationshipRow(row: typeof tracemindGraphRelationships.$inferSelect) {
  const relationship = graphRelationshipSchema.parse(JSON.parse(row.payload));
  if (
    relationship.projectId !== row.projectId ||
    relationship.revision !== row.revision ||
    relationship.id !== row.id ||
    relationship.sourceId !== row.sourceId ||
    relationship.targetId !== row.targetId ||
    relationship.relation !== row.relation ||
    relationship.stale !== row.stale ||
    (relationship.source?.path ?? null) !== row.sourcePath
  )
    throw new Error('Stored graph relationship index mismatch');
  return relationship;
}

function payloadBytes(snapshot: StoredGraphSnapshot): number {
  let total = 0;
  const append = <T>(value: T): boolean => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Graph record cannot be serialized');
    total += Buffer.byteLength(serialized, 'utf8');
    return total <= maxGraphSnapshotBytes;
  };
  for (const node of snapshot.nodes) if (!append(node)) return total;
  for (const relationship of snapshot.relationships) if (!append(relationship)) return total;
  for (const reason of snapshot.retrievalReasons) if (!append(reason)) return total;
  for (const failure of snapshot.parserFailures) if (!append(failure)) return total;
  return total;
}

function batches<T>(rows: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += insertBatchSize) {
    result.push(rows.slice(offset, offset + insertBatchSize));
  }
  return result;
}

function graphPayloadBytesInTransaction(
  tx: DrizzleTx,
  projectId: string,
  revision?: string
): number {
  const nodeWhere = revision
    ? and(eq(tracemindGraphNodes.projectId, projectId), eq(tracemindGraphNodes.revision, revision))
    : eq(tracemindGraphNodes.projectId, projectId);
  const relationshipWhere = revision
    ? and(
        eq(tracemindGraphRelationships.projectId, projectId),
        eq(tracemindGraphRelationships.revision, revision)
      )
    : eq(tracemindGraphRelationships.projectId, projectId);
  const reasonWhere = revision
    ? and(
        eq(tracemindGraphRetrievalReasons.projectId, projectId),
        eq(tracemindGraphRetrievalReasons.revision, revision)
      )
    : eq(tracemindGraphRetrievalReasons.projectId, projectId);
  const failureWhere = revision
    ? and(
        eq(tracemindGraphParserFailures.projectId, projectId),
        eq(tracemindGraphParserFailures.revision, revision)
      )
    : eq(tracemindGraphParserFailures.projectId, projectId);
  const nodes =
    tx
      .select({
        bytes: sql<number>`coalesce(sum(length(cast(${tracemindGraphNodes.payload} as blob))), 0)`,
      })
      .from(tracemindGraphNodes)
      .where(nodeWhere)
      .get()?.bytes ?? 0;
  const relationships =
    tx
      .select({
        bytes: sql<number>`coalesce(sum(length(cast(${tracemindGraphRelationships.payload} as blob))), 0)`,
      })
      .from(tracemindGraphRelationships)
      .where(relationshipWhere)
      .get()?.bytes ?? 0;
  const reasons =
    tx
      .select({
        bytes: sql<number>`coalesce(sum(length(cast(${tracemindGraphRetrievalReasons.reason} as blob))), 0)`,
      })
      .from(tracemindGraphRetrievalReasons)
      .where(reasonWhere)
      .get()?.bytes ?? 0;
  const failures =
    tx
      .select({
        bytes: sql<number>`coalesce(sum(length(cast(${tracemindGraphParserFailures.path} as blob)) + length(cast(${tracemindGraphParserFailures.language} as blob)) + length(cast(${tracemindGraphParserFailures.message} as blob))), 0)`,
      })
      .from(tracemindGraphParserFailures)
      .where(failureWhere)
      .get()?.bytes ?? 0;
  return nodes + relationships + reasons + failures;
}

function assertGraphHistoryCapacity(
  tx: DrizzleTx,
  snapshot: StoredGraphSnapshot,
  replacementBytes: number
): void {
  const revisionWhere = and(
    eq(tracemindGraphRevisions.projectId, snapshot.projectId),
    eq(tracemindGraphRevisions.revision, snapshot.revision)
  );
  const existingRevision = tx
    .select({ revision: tracemindGraphRevisions.revision })
    .from(tracemindGraphRevisions)
    .where(revisionWhere)
    .limit(1)
    .get();
  if (!existingRevision) {
    const revisionCount = tx
      .select({ count: sql<number>`count(*)` })
      .from(tracemindGraphRevisions)
      .where(eq(tracemindGraphRevisions.projectId, snapshot.projectId))
      .get()?.count;
    if ((revisionCount ?? 0) >= maxGraphRevisions) throw new Error('Too many graph revisions');
  }
  const priorBytes = existingRevision
    ? graphPayloadBytesInTransaction(tx, snapshot.projectId, snapshot.revision)
    : 0;
  const historyBytes = graphPayloadBytesInTransaction(tx, snapshot.projectId);
  if (historyBytes - priorBytes + replacementBytes > maxGraphHistoryBytes)
    throw new Error('Graph history size limit exceeded');
}

function persistGraphSnapshot(tx: DrizzleTx, snapshot: StoredGraphSnapshot): void {
  assertSnapshot(snapshot);
  const serializedBytes = payloadBytes(snapshot);
  if (serializedBytes > maxGraphSnapshotBytes)
    throw new Error('Graph snapshot size limit exceeded');
  assertGraphHistoryCapacity(tx, snapshot, serializedBytes);
  const projectId = snapshot.projectId;
  const revision = snapshot.revision;
  const where = and(
    eq(tracemindGraphNodes.projectId, projectId),
    eq(tracemindGraphNodes.revision, revision)
  );
  tx.delete(tracemindGraphRelationships)
    .where(
      and(
        eq(tracemindGraphRelationships.projectId, projectId),
        eq(tracemindGraphRelationships.revision, revision)
      )
    )
    .run();
  tx.delete(tracemindGraphRetrievalReasons)
    .where(
      and(
        eq(tracemindGraphRetrievalReasons.projectId, projectId),
        eq(tracemindGraphRetrievalReasons.revision, revision)
      )
    )
    .run();
  tx.delete(tracemindGraphParserFailures)
    .where(
      and(
        eq(tracemindGraphParserFailures.projectId, projectId),
        eq(tracemindGraphParserFailures.revision, revision)
      )
    )
    .run();
  tx.delete(tracemindGraphNodes).where(where).run();
  tx.insert(tracemindGraphRevisions)
    .values({
      projectId,
      revision,
      schemaVersion: snapshot.schemaVersion,
      capturedAt: snapshot.capturedAt,
    })
    .onConflictDoUpdate({
      target: [tracemindGraphRevisions.projectId, tracemindGraphRevisions.revision],
      set: { schemaVersion: snapshot.schemaVersion, capturedAt: snapshot.capturedAt },
    })
    .run();
  for (const batch of batches(
    snapshot.nodes.map((node, ordinal) => ({
      projectId,
      revision,
      id: node.id,
      ordinal,
      kind: node.kind,
      label: node.label,
      sourcePath: node.source?.path ?? null,
      startLine: node.source?.startLine ?? null,
      endLine: node.source?.endLine ?? null,
      stale: node.stale,
      payload: JSON.stringify(node),
    }))
  )) {
    tx.insert(tracemindGraphNodes).values(batch).run();
  }
  for (const batch of batches(
    snapshot.relationships.map((relationship, ordinal) => ({
      projectId,
      revision,
      id: relationship.id,
      ordinal,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      relation: relationship.relation,
      sourcePath: relationship.source?.path ?? null,
      stale: relationship.stale,
      payload: JSON.stringify(relationship),
    }))
  )) {
    tx.insert(tracemindGraphRelationships).values(batch).run();
  }
  for (const batch of batches(
    snapshot.retrievalReasons.map((reason) => ({
      projectId,
      revision,
      id: reason.id,
      evidenceNodeId: reason.evidenceNodeId,
      reason: reason.reason,
      retrievedAt: reason.retrievedAt,
    }))
  )) {
    tx.insert(tracemindGraphRetrievalReasons).values(batch).run();
  }
  for (const batch of batches(
    snapshot.parserFailures.map((failure, ordinal) => ({
      projectId,
      revision,
      ordinal,
      ...failure,
    }))
  )) {
    tx.insert(tracemindGraphParserFailures).values(batch).run();
  }
}

function readGraphSnapshotInTransaction(
  tx: DrizzleTx,
  projectId: string,
  revision: string
): StoredGraphSnapshot | null {
  const [header] = tx
    .select({
      schemaVersion: tracemindGraphRevisions.schemaVersion,
      capturedAt: tracemindGraphRevisions.capturedAt,
    })
    .from(tracemindGraphRevisions)
    .where(
      and(
        eq(tracemindGraphRevisions.projectId, projectId),
        eq(tracemindGraphRevisions.revision, revision)
      )
    )
    .limit(1)
    .all();
  if (!header) return null;
  const [size] = tx
    .select({
      nodes: sql<number>`(SELECT count(*) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${projectId} AND ${tracemindGraphNodes.revision} = ${revision})`,
      relationships: sql<number>`(SELECT count(*) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${projectId} AND ${tracemindGraphRelationships.revision} = ${revision})`,
      reasons: sql<number>`(SELECT count(*) FROM ${tracemindGraphRetrievalReasons} WHERE ${tracemindGraphRetrievalReasons.projectId} = ${projectId} AND ${tracemindGraphRetrievalReasons.revision} = ${revision})`,
      failures: sql<number>`(SELECT count(*) FROM ${tracemindGraphParserFailures} WHERE ${tracemindGraphParserFailures.projectId} = ${projectId} AND ${tracemindGraphParserFailures.revision} = ${revision})`,
      bytes: sql<number>`
        coalesce((SELECT sum(length(cast(payload as blob))) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${projectId} AND ${tracemindGraphNodes.revision} = ${revision}), 0) +
        coalesce((SELECT sum(length(cast(payload as blob))) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${projectId} AND ${tracemindGraphRelationships.revision} = ${revision}), 0) +
        coalesce((SELECT sum(length(cast(reason as blob))) FROM ${tracemindGraphRetrievalReasons} WHERE ${tracemindGraphRetrievalReasons.projectId} = ${projectId} AND ${tracemindGraphRetrievalReasons.revision} = ${revision}), 0) +
        coalesce((SELECT sum(length(cast(path as blob)) + length(cast(language as blob)) + length(cast(message as blob))) FROM ${tracemindGraphParserFailures} WHERE ${tracemindGraphParserFailures.projectId} = ${projectId} AND ${tracemindGraphParserFailures.revision} = ${revision}), 0)
      `,
    })
    .from(tracemindGraphRevisions)
    .where(
      and(
        eq(tracemindGraphRevisions.projectId, projectId),
        eq(tracemindGraphRevisions.revision, revision)
      )
    )
    .limit(1)
    .all();
  if (
    !size ||
    size.nodes > maxGraphNodes ||
    size.relationships > maxGraphRelationships ||
    size.reasons > maxGraphRetrievalReasons ||
    size.failures > maxGraphParserFailures
  )
    throw new Error('Graph revision count limit exceeded');
  if (size.bytes > maxGraphSnapshotBytes) throw new Error('Graph snapshot size limit exceeded');
  const nodeRows = tx
    .select()
    .from(tracemindGraphNodes)
    .where(
      and(eq(tracemindGraphNodes.projectId, projectId), eq(tracemindGraphNodes.revision, revision))
    )
    .orderBy(asc(tracemindGraphNodes.ordinal))
    .all();
  const relationshipRows = tx
    .select()
    .from(tracemindGraphRelationships)
    .where(
      and(
        eq(tracemindGraphRelationships.projectId, projectId),
        eq(tracemindGraphRelationships.revision, revision)
      )
    )
    .orderBy(asc(tracemindGraphRelationships.ordinal))
    .all();
  const reasonRows = tx
    .select({
      projectId: tracemindGraphRetrievalReasons.projectId,
      revision: tracemindGraphRetrievalReasons.revision,
      id: tracemindGraphRetrievalReasons.id,
      evidenceNodeId: tracemindGraphRetrievalReasons.evidenceNodeId,
      reason: tracemindGraphRetrievalReasons.reason,
      retrievedAt: tracemindGraphRetrievalReasons.retrievedAt,
    })
    .from(tracemindGraphRetrievalReasons)
    .where(
      and(
        eq(tracemindGraphRetrievalReasons.projectId, projectId),
        eq(tracemindGraphRetrievalReasons.revision, revision)
      )
    )
    .orderBy(asc(tracemindGraphRetrievalReasons.id))
    .all();
  const failureRows = tx
    .select({
      path: tracemindGraphParserFailures.path,
      language: tracemindGraphParserFailures.language,
      message: tracemindGraphParserFailures.message,
    })
    .from(tracemindGraphParserFailures)
    .where(
      and(
        eq(tracemindGraphParserFailures.projectId, projectId),
        eq(tracemindGraphParserFailures.revision, revision)
      )
    )
    .orderBy(asc(tracemindGraphParserFailures.ordinal))
    .all();
  const snapshot = snapshotRecordSchema.parse({
    schemaVersion: header.schemaVersion,
    projectId,
    revision,
    capturedAt: header.capturedAt,
    nodes: nodeRows.map(decodeNodeRow),
    relationships: relationshipRows.map(decodeRelationshipRow),
    retrievalReasons: reasonRows.map((row) => retrievalReasonSchema.parse(row)),
    parserFailures: failureRows.map((row) => parserFailureSchema.parse(row)),
  });
  assertSnapshot(snapshot);
  return snapshot;
}

function getOrMigrateSnapshotInTransaction(
  tx: DrizzleTx,
  projectId: string,
  revision: string
): StoredGraphSnapshot | null {
  const snapshot = readGraphSnapshotInTransaction(tx, projectId, revision);
  if (snapshot) return snapshot;
  const [legacy] = tx
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key(projectId, revision)))
    .limit(1)
    .all();
  if (!legacy) return null;
  const migrated = parse(legacy.value, projectId, revision);
  persistGraphSnapshot(tx, migrated);
  tx.delete(kv)
    .where(eq(kv.key, key(projectId, revision)))
    .run();
  return migrated;
}

function migrateLegacyGraphSnapshotsInTransaction(tx: DrizzleTx, projectId: string): void {
  const start = prefix(projectId);
  const where = and(gte(kv.key, start), lt(kv.key, `${start}\uffff`));
  const legacySize = tx
    .select({ bytes: sql<number>`coalesce(sum(length(cast(${kv.value} as blob))), 0)` })
    .from(kv)
    .where(where)
    .get();
  if ((legacySize?.bytes ?? 0) > maxGraphHistoryBytes)
    throw new Error('Graph history size limit exceeded');
  const legacyRows = tx
    .select({ value: kv.value })
    .from(kv)
    .where(where)
    .orderBy(asc(kv.key))
    .limit(maxGraphRevisions + 1)
    .all();
  if (legacyRows.length > maxGraphRevisions) throw new Error('Too many graph revisions');
  for (const row of legacyRows) {
    const legacy = snapshotRecordSchema.parse(JSON.parse(row.value));
    if (legacy.projectId !== projectId) throw new Error('Stored graph project mismatch');
    assertGraphPayloadSize(row.value);
    persistGraphSnapshot(tx, legacy);
    tx.delete(kv)
      .where(eq(kv.key, key(projectId, legacy.revision)))
      .run();
  }
}

function listGraphSnapshotsInTransaction(tx: DrizzleTx, projectId: string): StoredGraphSnapshot[] {
  migrateLegacyGraphSnapshotsInTransaction(tx, projectId);
  const history = tx
    .select({
      revisions: sql<number>`count(*)`,
      bytes: sql<number>`
        coalesce((SELECT sum(length(cast(payload as blob))) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${projectId}), 0) +
        coalesce((SELECT sum(length(cast(payload as blob))) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${projectId}), 0) +
        coalesce((SELECT sum(length(cast(reason as blob))) FROM ${tracemindGraphRetrievalReasons} WHERE ${tracemindGraphRetrievalReasons.projectId} = ${projectId}), 0) +
        coalesce((SELECT sum(length(cast(path as blob)) + length(cast(language as blob)) + length(cast(message as blob))) FROM ${tracemindGraphParserFailures} WHERE ${tracemindGraphParserFailures.projectId} = ${projectId}), 0)
      `,
    })
    .from(tracemindGraphRevisions)
    .where(eq(tracemindGraphRevisions.projectId, projectId))
    .get();
  if ((history?.revisions ?? 0) > maxGraphRevisions) throw new Error('Too many graph revisions');
  if ((history?.bytes ?? 0) > maxGraphHistoryBytes)
    throw new Error('Graph history size limit exceeded');
  const revisions = tx
    .select({ revision: tracemindGraphRevisions.revision })
    .from(tracemindGraphRevisions)
    .where(eq(tracemindGraphRevisions.projectId, projectId))
    .orderBy(asc(tracemindGraphRevisions.revision))
    .limit(maxGraphRevisions + 1)
    .all();
  return revisions.map((row) => {
    const snapshot = readGraphSnapshotInTransaction(tx, projectId, row.revision);
    if (!snapshot) throw new Error('Graph revision disappeared during history read');
    return snapshot;
  });
}

/** Saves a revision-scoped graph using the existing local SQLite KV store. */
export async function saveGraphSnapshot(
  input: z.input<typeof graphSnapshotSchema>,
  capturedAt: number = Date.now()
): Promise<StoredGraphSnapshot> {
  const snapshot = snapshotRecordSchema.parse({ ...input, capturedAt });
  db.transaction((tx) => {
    persistGraphSnapshot(tx, snapshot);
    tx.delete(kv)
      .where(eq(kv.key, key(snapshot.projectId, snapshot.revision)))
      .run();
  });
  return snapshot;
}

export async function getGraphSnapshot(
  projectId: string,
  revision: string
): Promise<StoredGraphSnapshot | null> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  return db.transaction((tx) => getOrMigrateSnapshotInTransaction(tx, id, rev));
}

export async function listGraphSnapshots(projectId: string): Promise<StoredGraphSnapshot[]> {
  const id = projectIdSchema.parse(projectId);
  return db.transaction((tx) => listGraphSnapshotsInTransaction(tx, id));
}

/** Reads only the most recently captured revision for incremental indexing. */
export async function getLatestGraphSnapshot(
  projectId: string
): Promise<StoredGraphSnapshot | null> {
  const id = projectIdSchema.parse(projectId);
  return db.transaction((tx) => {
    migrateLegacyGraphSnapshotsInTransaction(tx, id);
    const header = tx
      .select({ revision: tracemindGraphRevisions.revision })
      .from(tracemindGraphRevisions)
      .where(eq(tracemindGraphRevisions.projectId, id))
      .orderBy(desc(tracemindGraphRevisions.capturedAt), desc(tracemindGraphRevisions.revision))
      .limit(1)
      .get();
    if (!header) return null;
    const snapshot = readGraphSnapshotInTransaction(tx, id, header.revision);
    if (!snapshot) throw new Error('Latest graph revision disappeared during read');
    return snapshot;
  });
}

/** Migrates one bounded legacy KV snapshot, when present, without returning its payload. */
export async function ensureGraphRevision(projectId: string, revision: string): Promise<boolean> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  return db.transaction((tx) => {
    const [header] = tx
      .select({ revision: tracemindGraphRevisions.revision })
      .from(tracemindGraphRevisions)
      .where(
        and(eq(tracemindGraphRevisions.projectId, id), eq(tracemindGraphRevisions.revision, rev))
      )
      .limit(1)
      .all();
    if (header) return true;
    return getOrMigrateSnapshotInTransaction(tx, id, rev) !== null;
  });
}

export async function getGraphNodePayloadBytes(
  projectId: string,
  revision: string,
  nodeId: string
): Promise<number | null> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const node = z.string().min(1).max(512).parse(nodeId);
  return (
    db
      .select({ bytes: sql<number>`length(cast(${tracemindGraphNodes.payload} as blob))` })
      .from(tracemindGraphNodes)
      .where(
        and(
          eq(tracemindGraphNodes.projectId, id),
          eq(tracemindGraphNodes.revision, rev),
          eq(tracemindGraphNodes.id, node)
        )
      )
      .get()?.bytes ?? null
  );
}

export async function getGraphNode(projectId: string, revision: string, nodeId: string) {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const node = z.string().min(1).max(512).parse(nodeId);
  const row = db
    .select()
    .from(tracemindGraphNodes)
    .where(
      and(
        eq(tracemindGraphNodes.projectId, id),
        eq(tracemindGraphNodes.revision, rev),
        eq(tracemindGraphNodes.id, node)
      )
    )
    .limit(1)
    .get();
  return row ? decodeNodeRow(row) : null;
}

export async function getGraphRelationshipPayloadBytes(
  projectId: string,
  revision: string,
  relationshipId: string
): Promise<number | null> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const relationship = z.string().min(1).max(512).parse(relationshipId);
  return (
    db
      .select({ bytes: sql<number>`length(cast(${tracemindGraphRelationships.payload} as blob))` })
      .from(tracemindGraphRelationships)
      .where(
        and(
          eq(tracemindGraphRelationships.projectId, id),
          eq(tracemindGraphRelationships.revision, rev),
          eq(tracemindGraphRelationships.id, relationship)
        )
      )
      .get()?.bytes ?? null
  );
}

export async function getGraphRelationship(
  projectId: string,
  revision: string,
  relationshipId: string
) {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const relationship = z.string().min(1).max(512).parse(relationshipId);
  const row = db
    .select()
    .from(tracemindGraphRelationships)
    .where(
      and(
        eq(tracemindGraphRelationships.projectId, id),
        eq(tracemindGraphRelationships.revision, rev),
        eq(tracemindGraphRelationships.id, relationship)
      )
    )
    .limit(1)
    .get();
  return row ? decodeRelationshipRow(row) : null;
}

/** Reads indexed adjacency metadata only; callers load payloads after checking their budgets. */
export async function getGraphOutgoingIndexPage(
  projectId: string,
  revision: string,
  sourceNodeId: string,
  offset: number,
  limit: number
): Promise<GraphAdjacencyIndexRow[]> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const source = z.string().min(1).max(512).parse(sourceNodeId);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maxGraphRelationships)
    throw new Error('Invalid graph adjacency offset');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new Error('Invalid graph adjacency page size');
  return db
    .select({
      id: tracemindGraphRelationships.id,
      targetId: tracemindGraphRelationships.targetId,
      payloadBytes: sql<number>`length(cast(${tracemindGraphRelationships.payload} as blob))`,
    })
    .from(tracemindGraphRelationships)
    .where(
      and(
        eq(tracemindGraphRelationships.projectId, id),
        eq(tracemindGraphRelationships.revision, rev),
        eq(tracemindGraphRelationships.sourceId, source)
      )
    )
    .orderBy(asc(tracemindGraphRelationships.ordinal))
    .limit(limit)
    .offset(offset)
    .all();
}

/** Indexed incoming adjacency, ordered by SQLite rowid within the target index. */
export async function getGraphIncomingIndexPage(
  projectId: string,
  revision: string,
  targetNodeId: string,
  offset: number,
  limit: number
): Promise<GraphAdjacencyIndexRow[]> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const target = z.string().min(1).max(512).parse(targetNodeId);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maxGraphRelationships)
    throw new Error('Invalid graph adjacency offset');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new Error('Invalid graph adjacency page size');
  return db
    .select({
      id: tracemindGraphRelationships.id,
      targetId: tracemindGraphRelationships.sourceId,
      payloadBytes: sql<number>`length(cast(${tracemindGraphRelationships.payload} as blob))`,
    })
    .from(tracemindGraphRelationships)
    .where(
      and(
        eq(tracemindGraphRelationships.projectId, id),
        eq(tracemindGraphRelationships.revision, rev),
        eq(tracemindGraphRelationships.targetId, target)
      )
    )
    .orderBy(sql`rowid`)
    .limit(limit)
    .offset(offset)
    .all();
}

export async function getGraphRevisionCounts(
  projectId: string,
  revision: string
): Promise<GraphRevisionCounts | null> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const counts = db
    .select({
      nodes: sql<number>`(SELECT count(*) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${id} AND ${tracemindGraphNodes.revision} = ${rev})`,
      relationships: sql<number>`(SELECT count(*) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${id} AND ${tracemindGraphRelationships.revision} = ${rev})`,
    })
    .from(tracemindGraphRevisions)
    .where(
      and(eq(tracemindGraphRevisions.projectId, id), eq(tracemindGraphRevisions.revision, rev))
    )
    .limit(1)
    .get();
  return counts ? { nodes: counts.nodes, relationships: counts.relationships } : null;
}

export async function getGraphRootNode(
  projectId: string,
  revision: string
): Promise<ReturnType<typeof graphNodeSchema.parse> | null> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const row = db
    .select()
    .from(tracemindGraphNodes)
    .where(
      and(
        eq(tracemindGraphNodes.projectId, id),
        eq(tracemindGraphNodes.revision, rev),
        eq(tracemindGraphNodes.kind, 'repository_revision')
      )
    )
    .orderBy(asc(tracemindGraphNodes.ordinal))
    .limit(1)
    .get();
  return row ? decodeNodeRow(row) : null;
}

/** Bounded renderer-facing metadata and keyset-paged node previews. */
export async function getGraphOverview(
  projectId: string,
  revision: string,
  afterId: string | null
): Promise<GraphOverview | null> {
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  const cursor = z.string().min(1).max(512).nullable().parse(afterId);
  if (!(await ensureGraphRevision(id, rev))) return null;
  return db.transaction((tx) => {
    const header = tx
      .select({
        nodeCount: sql<number>`(SELECT count(*) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${id} AND ${tracemindGraphNodes.revision} = ${rev})`,
        relationshipCount: sql<number>`(SELECT count(*) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${id} AND ${tracemindGraphRelationships.revision} = ${rev})`,
        parserFailureCount: sql<number>`(SELECT count(*) FROM ${tracemindGraphParserFailures} WHERE ${tracemindGraphParserFailures.projectId} = ${id} AND ${tracemindGraphParserFailures.revision} = ${rev})`,
      })
      .from(tracemindGraphRevisions)
      .where(
        and(eq(tracemindGraphRevisions.projectId, id), eq(tracemindGraphRevisions.revision, rev))
      )
      .get();
    if (!header) return null;
    const nodeScope = and(
      eq(tracemindGraphNodes.projectId, id),
      eq(tracemindGraphNodes.revision, rev)
    );
    const root = tx
      .select({ id: tracemindGraphNodes.id })
      .from(tracemindGraphNodes)
      .where(and(nodeScope, eq(tracemindGraphNodes.kind, 'repository_revision')))
      .orderBy(asc(tracemindGraphNodes.ordinal))
      .limit(1)
      .get();
    const fallback =
      root ??
      tx
        .select({ id: tracemindGraphNodes.id })
        .from(tracemindGraphNodes)
        .where(nodeScope)
        .orderBy(asc(tracemindGraphNodes.id))
        .limit(1)
        .get();
    const page = tx
      .select({
        id: tracemindGraphNodes.id,
        payloadBytes: sql<number>`length(cast(${tracemindGraphNodes.payload} as blob))`,
      })
      .from(tracemindGraphNodes)
      .where(and(nodeScope, cursor ? gt(tracemindGraphNodes.id, cursor) : undefined))
      .orderBy(asc(tracemindGraphNodes.id))
      .limit(51)
      .all();
    const selected = page.slice(0, 50);
    for (const entry of selected) {
      z.string().min(1).max(512).parse(entry.id);
      if (
        !Number.isSafeInteger(entry.payloadBytes) ||
        entry.payloadBytes < 0 ||
        entry.payloadBytes > 128 * 1024
      )
        throw new Error('Graph node preview size limit exceeded');
    }
    const rows = selected.length
      ? tx
          .select()
          .from(tracemindGraphNodes)
          .where(
            and(
              nodeScope,
              inArray(
                tracemindGraphNodes.id,
                selected.map((entry) => entry.id)
              )
            )
          )
          .orderBy(asc(tracemindGraphNodes.id))
          .all()
      : [];
    const nodes = rows.map((row) => {
      const node = decodeNodeRow(row);
      return graphNodePreviewSchema.parse({
        id: node.id,
        kind: node.kind,
        label: node.label,
        stale: node.stale,
      });
    });
    const failures = tx
      .select({
        path: tracemindGraphParserFailures.path,
        language: tracemindGraphParserFailures.language,
        message: tracemindGraphParserFailures.message,
      })
      .from(tracemindGraphParserFailures)
      .where(
        and(
          eq(tracemindGraphParserFailures.projectId, id),
          eq(tracemindGraphParserFailures.revision, rev)
        )
      )
      .orderBy(asc(tracemindGraphParserFailures.ordinal))
      .limit(20)
      .all();
    const reasons = tx
      .select({
        id: tracemindGraphRetrievalReasons.id,
        projectId: tracemindGraphRetrievalReasons.projectId,
        revision: tracemindGraphRetrievalReasons.revision,
        evidenceNodeId: tracemindGraphRetrievalReasons.evidenceNodeId,
        reason: tracemindGraphRetrievalReasons.reason,
        retrievedAt: tracemindGraphRetrievalReasons.retrievedAt,
      })
      .from(tracemindGraphRetrievalReasons)
      .where(
        and(
          eq(tracemindGraphRetrievalReasons.projectId, id),
          eq(tracemindGraphRetrievalReasons.revision, rev)
        )
      )
      .orderBy(asc(tracemindGraphRetrievalReasons.id))
      .limit(3)
      .all();
    return {
      revision: rev,
      rootNodeId: fallback ? z.string().min(1).max(512).parse(fallback.id) : null,
      ...header,
      nodes,
      nextCursor: page.length > 50 ? (nodes.at(-1)?.id ?? null) : null,
      parserFailures: failures.map((failure) => parserFailureSchema.parse(failure)),
      retrievalReasons: reasons.map((reason) => retrievalReasonSchema.parse(reason)),
    };
  });
}

type StaleGraphResult = { revisions: number; nodes: number; relationships: number };

function markGraphStaleInTransaction(
  tx: DrizzleTx,
  projectId: string,
  paths: readonly string[]
): StaleGraphResult {
  migrateLegacyGraphSnapshotsInTransaction(tx, projectId);
  const revisions = new Set<string>();
  let nodes = 0;
  let relationships = 0;
  for (const batch of batches(paths)) {
    const updatedNodes = tx
      .update(tracemindGraphNodes)
      .set({
        stale: true,
        payload: sql`json_set(${tracemindGraphNodes.payload}, '$.stale', json('true'))`,
      })
      .where(
        and(
          eq(tracemindGraphNodes.projectId, projectId),
          eq(tracemindGraphNodes.stale, false),
          inArray(tracemindGraphNodes.sourcePath, batch)
        )
      )
      .returning({ revision: tracemindGraphNodes.revision })
      .all();
    nodes += updatedNodes.length;
    for (const row of updatedNodes) revisions.add(row.revision);

    const dependentNodeIds = tx
      .select({ id: tracemindGraphNodes.id })
      .from(tracemindGraphNodes)
      .where(
        and(
          eq(tracemindGraphNodes.projectId, projectId),
          inArray(tracemindGraphNodes.sourcePath, batch)
        )
      );
    const updatedRelationships = tx
      .update(tracemindGraphRelationships)
      .set({
        stale: true,
        payload: sql`json_set(${tracemindGraphRelationships.payload}, '$.stale', json('true'))`,
      })
      .where(
        and(
          eq(tracemindGraphRelationships.projectId, projectId),
          eq(tracemindGraphRelationships.stale, false),
          or(
            inArray(tracemindGraphRelationships.sourcePath, batch),
            inArray(tracemindGraphRelationships.sourceId, dependentNodeIds),
            inArray(tracemindGraphRelationships.targetId, dependentNodeIds)
          )
        )
      )
      .returning({ revision: tracemindGraphRelationships.revision })
      .all();
    relationships += updatedRelationships.length;
    for (const row of updatedRelationships) revisions.add(row.revision);
  }
  return { revisions: revisions.size, nodes, relationships };
}

function changedGraphPaths(paths: readonly string[]): string[] {
  const result = [...new Set(paths.map((path) => graphPathSchema.parse(path)))];
  if (result.length > maxGraphChangedPaths) throw new Error('Too many changed graph paths');
  return result;
}

/** Marks source-dependent nodes and incident relationships stale in indexed historical rows. */
export async function markGraphStale(
  projectId: string,
  changedPaths: readonly string[]
): Promise<StaleGraphResult> {
  const paths = changedGraphPaths(changedPaths);
  if (!paths.length) return { revisions: 0, nodes: 0, relationships: 0 };
  const id = projectIdSchema.parse(projectId);
  return db.transaction((tx) => markGraphStaleInTransaction(tx, id, paths));
}

/** Commits invalidation and the replacement audit graph as one SQLite transaction. */
export async function saveGraphSnapshotAndMarkStale(
  input: z.input<typeof graphSnapshotSchema>,
  changedPaths: readonly string[],
  capturedAt: number = Date.now()
): Promise<{ snapshot: StoredGraphSnapshot; invalidated: StaleGraphResult }> {
  const snapshot = snapshotRecordSchema.parse({ ...input, capturedAt });
  const paths = changedGraphPaths(changedPaths);
  return db.transaction((tx) => {
    const invalidated = markGraphStaleInTransaction(tx, snapshot.projectId, paths);
    persistGraphSnapshot(tx, snapshot);
    tx.delete(kv)
      .where(eq(kv.key, key(snapshot.projectId, snapshot.revision)))
      .run();
    return { snapshot, invalidated };
  });
}

const graphRecordInputSchema = z
  .object({
    kind: z.enum(['observation', 'command_run', 'hypothesis', 'evidence', 'finding']),
    label: z.string().trim().min(1).max(1024),
    source: z
      .object({
        path: graphPathSchema,
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
      })
      .strict()
      .nullable()
      .optional(),
    targetNodeId: z.string().min(1).max(512).optional(),
    relation: z.enum(['SUPPORTS', 'CONTRADICTS', 'VERIFIED_BY']).optional(),
    reason: z.string().trim().min(1).max(4096),
  })
  .strict()
  .refine((value) => Boolean(value.targetNodeId) === Boolean(value.relation));
export type GraphRecordInput = z.infer<typeof graphRecordInputSchema>;

/** Appends one entry transactionally without reading or rewriting the existing graph. */
export async function appendGraphRecordBounded(
  projectId: string,
  revision: string,
  input: GraphRecordInput
): Promise<void> {
  const value = graphRecordInputSchema.parse(input);
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  db.transaction((tx) => {
    const revisionWhere = and(
      eq(tracemindGraphRevisions.projectId, id),
      eq(tracemindGraphRevisions.revision, rev)
    );
    let header = tx
      .select({ revision: tracemindGraphRevisions.revision })
      .from(tracemindGraphRevisions)
      .where(revisionWhere)
      .get();
    if (!header) {
      if (!getOrMigrateSnapshotInTransaction(tx, id, rev))
        throw new Error('Graph revision not found');
      header = tx
        .select({ revision: tracemindGraphRevisions.revision })
        .from(tracemindGraphRevisions)
        .where(revisionWhere)
        .get();
    }
    if (!header) throw new Error('Graph revision disappeared');
    if (value.targetNodeId) {
      const target = tx
        .select({ id: tracemindGraphNodes.id })
        .from(tracemindGraphNodes)
        .where(
          and(
            eq(tracemindGraphNodes.projectId, id),
            eq(tracemindGraphNodes.revision, rev),
            eq(tracemindGraphNodes.id, value.targetNodeId)
          )
        )
        .get();
      if (!target) throw new Error('Graph target node not found');
    }
    const counts = tx
      .select({
        nodes: sql<number>`(SELECT count(*) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${id} AND ${tracemindGraphNodes.revision} = ${rev})`,
        nodeOrdinal: sql<number>`(SELECT coalesce(max(ordinal), -1) FROM ${tracemindGraphNodes} WHERE ${tracemindGraphNodes.projectId} = ${id} AND ${tracemindGraphNodes.revision} = ${rev})`,
        relationships: sql<number>`(SELECT count(*) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${id} AND ${tracemindGraphRelationships.revision} = ${rev})`,
        relationshipOrdinal: sql<number>`(SELECT coalesce(max(ordinal), -1) FROM ${tracemindGraphRelationships} WHERE ${tracemindGraphRelationships.projectId} = ${id} AND ${tracemindGraphRelationships.revision} = ${rev})`,
        reasons: sql<number>`(SELECT count(*) FROM ${tracemindGraphRetrievalReasons} WHERE ${tracemindGraphRetrievalReasons.projectId} = ${id} AND ${tracemindGraphRetrievalReasons.revision} = ${rev})`,
      })
      .from(tracemindGraphRevisions)
      .where(revisionWhere)
      .get();
    if (
      !counts ||
      counts.nodes >= maxGraphNodes ||
      counts.relationships > maxGraphRelationships ||
      counts.reasons > maxGraphRetrievalReasons ||
      (value.relation && counts.relationships === maxGraphRelationships) ||
      (value.kind === 'evidence' && counts.reasons === maxGraphRetrievalReasons) ||
      !Number.isSafeInteger(counts.nodeOrdinal) ||
      !Number.isSafeInteger(counts.relationshipOrdinal) ||
      counts.nodeOrdinal < -1 ||
      counts.relationshipOrdinal < -1 ||
      counts.nodeOrdinal >= Number.MAX_SAFE_INTEGER ||
      counts.relationshipOrdinal >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Graph revision count limit exceeded');
    const now = Date.now();
    const node = graphNodeSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      projectId: id,
      revision: rev,
      kind: value.kind,
      label: value.label,
      source: value.source ?? null,
      extractionMethod: 'user-recorded',
      provenance: 'investigation-entry',
      stale: false,
      createdAt: now,
    });
    const relationship =
      value.targetNodeId && value.relation
        ? graphRelationshipSchema.parse({
            schemaVersion: 1,
            id: randomUUID(),
            projectId: id,
            revision: rev,
            sourceId: node.id,
            targetId: value.targetNodeId,
            relation: value.relation,
            source: value.source ?? null,
            extractionMethod: 'user-recorded',
            provenance: 'investigation-entry',
            stale: false,
            createdAt: now,
          })
        : null;
    const reason =
      value.kind === 'evidence'
        ? retrievalReasonSchema.parse({
            id: randomUUID(),
            projectId: id,
            revision: rev,
            evidenceNodeId: node.id,
            reason: value.reason,
            retrievedAt: now,
          })
        : null;
    const addedBytes = [node, relationship, reason]
      .filter((record) => record !== null)
      .reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0);
    if (graphPayloadBytesInTransaction(tx, id, rev) + addedBytes > maxGraphSnapshotBytes)
      throw new Error('Graph snapshot size limit exceeded');
    if (graphPayloadBytesInTransaction(tx, id) + addedBytes > maxGraphHistoryBytes)
      throw new Error('Graph history size limit exceeded');
    tx.insert(tracemindGraphNodes)
      .values({
        projectId: id,
        revision: rev,
        id: node.id,
        ordinal: counts.nodeOrdinal + 1,
        kind: node.kind,
        label: node.label,
        sourcePath: node.source?.path ?? null,
        startLine: node.source?.startLine ?? null,
        endLine: node.source?.endLine ?? null,
        stale: node.stale,
        payload: JSON.stringify(node),
      })
      .run();
    if (relationship)
      tx.insert(tracemindGraphRelationships)
        .values({
          projectId: id,
          revision: rev,
          id: relationship.id,
          ordinal: counts.relationshipOrdinal + 1,
          sourceId: relationship.sourceId,
          targetId: relationship.targetId,
          relation: relationship.relation,
          sourcePath: relationship.source?.path ?? null,
          stale: relationship.stale,
          payload: JSON.stringify(relationship),
        })
        .run();
    if (reason) tx.insert(tracemindGraphRetrievalReasons).values(reason).run();
  });
}

/** Records an investigation observation, hypothesis, command, evidence, or finding with an explicit rationale. */
export async function appendGraphRecord(
  projectId: string,
  revision: string,
  input: GraphRecordInput
): Promise<StoredGraphSnapshot> {
  const value = graphRecordInputSchema.parse(input);
  const id = projectIdSchema.parse(projectId);
  const rev = revisionSchema.parse(revision);
  return db.transaction((tx) => {
    const snapshot = getOrMigrateSnapshotInTransaction(tx, id, rev);
    if (!snapshot) throw new Error('Graph revision not found');
    if (value.targetNodeId && !snapshot.nodes.some((node) => node.id === value.targetNodeId)) {
      throw new Error('Graph target node not found');
    }
    const now = Date.now();
    const nodeId = randomUUID();
    const node = {
      schemaVersion: 1,
      id: nodeId,
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      kind: value.kind,
      label: value.label,
      source: value.source ?? null,
      extractionMethod: 'user-recorded',
      provenance: 'investigation-entry',
      stale: false,
      createdAt: now,
    } as const;
    const relationships = [...snapshot.relationships];
    if (value.targetNodeId && value.relation) {
      relationships.push({
        schemaVersion: 1,
        id: randomUUID(),
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        sourceId: nodeId,
        targetId: value.targetNodeId,
        relation: value.relation,
        source: value.source ?? null,
        extractionMethod: 'user-recorded',
        provenance: 'investigation-entry',
        stale: false,
        createdAt: now,
      });
    }
    const reasons = [...snapshot.retrievalReasons];
    if (value.kind === 'evidence') {
      reasons.push({
        id: randomUUID(),
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        evidenceNodeId: nodeId,
        reason: value.reason,
        retrievedAt: now,
      });
    }
    const updated = snapshotRecordSchema.parse({
      ...snapshot,
      nodes: [...snapshot.nodes, node],
      relationships,
      retrievalReasons: reasons,
      capturedAt: now,
    });
    persistGraphSnapshot(tx, updated);
    return updated;
  });
}
