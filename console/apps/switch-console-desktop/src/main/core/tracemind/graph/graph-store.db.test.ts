import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const {
  appendGraphRecord,
  saveGraphSnapshot,
  saveGraphSnapshotAndMarkStale,
  getLatestGraphSnapshot,
  getGraphSnapshot,
  markGraphStale,
} = await import('./graph-store');
const { inspectGraph } = await import('./graph-query');
const { benchmarkGraphAdapter } = await import('./benchmark');
const graphStore = await import('./graph-store');

const snapshot = {
  projectId: 'local-1',
  revision: 'revision-a',
  nodes: [
    {
      id: 'revision',
      projectId: 'local-1',
      revision: 'revision-a',
      kind: 'repository_revision' as const,
      label: 'revision-a',
      source: null,
      extractionMethod: 'audit',
      provenance: 'audit:a',
      stale: false,
      createdAt: 1,
    },
    {
      id: 'file',
      projectId: 'local-1',
      revision: 'revision-a',
      kind: 'file' as const,
      label: 'src/a.ts',
      source: { path: 'src/a.ts', startLine: 1, endLine: 1 },
      extractionMethod: 'audit',
      provenance: 'audit:a',
      stale: false,
      createdAt: 1,
    },
    {
      id: 'evidence',
      projectId: 'local-1',
      revision: 'revision-a',
      kind: 'evidence' as const,
      label: 'a'.repeat(64),
      source: { path: 'src/a.ts', startLine: 1, endLine: 1 },
      extractionMethod: 'sha256',
      provenance: 'audit:a',
      stale: false,
      createdAt: 1,
    },
  ],
  relationships: [
    {
      id: 'contains',
      projectId: 'local-1',
      revision: 'revision-a',
      sourceId: 'revision',
      targetId: 'file',
      relation: 'CONTAINS' as const,
      source: null,
      extractionMethod: 'audit',
      provenance: 'audit:a',
      stale: false,
      createdAt: 1,
    },
    {
      id: 'supports',
      projectId: 'local-1',
      revision: 'revision-a',
      sourceId: 'evidence',
      targetId: 'file',
      relation: 'SUPPORTS' as const,
      source: { path: 'src/a.ts', startLine: 1, endLine: 1 },
      extractionMethod: 'sha256',
      provenance: 'audit:a',
      stale: false,
      createdAt: 1,
    },
  ],
  retrievalReasons: [
    {
      id: 'reason',
      projectId: 'local-1',
      revision: 'revision-a',
      evidenceNodeId: 'evidence',
      reason: 'Selected local audit file.',
      retrievedAt: 1,
    },
  ],
  parserFailures: [],
};

describe('persistent TraceMind graph', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });
  it('scopes incoming adjacency to the selected project and revision and enforces limits', async () => {
    await saveGraphSnapshot(snapshot, 1);
    for (const [projectId, revision] of [
      ['other', 'revision-a'],
      ['local-1', 'revision-b'],
    ] as const) {
      await saveGraphSnapshot(
        {
          ...snapshot,
          projectId,
          revision,
          nodes: snapshot.nodes.map((node) => ({ ...node, projectId, revision })),
          relationships: snapshot.relationships.map((edge) => ({ ...edge, projectId, revision })),
          retrievalReasons: snapshot.retrievalReasons.map((reason) => ({
            ...reason,
            projectId,
            revision,
          })),
        },
        1
      );
    }
    const limits = {
      direction: 'both' as const,
      maxDepth: 3,
      maxResults: 10,
      maxEdges: 20,
      maxTimeMs: 1000,
    };
    const result = await inspectGraph('local-1', 'revision-a', 'revision', limits);
    expect(result.nodes).toHaveLength(3);
    expect(result.relationships).toHaveLength(2);
    expect(
      result.nodes.every((node) => node.projectId === 'local-1' && node.revision === 'revision-a')
    ).toBe(true);
    expect(
      result.relationships.every(
        (edge) => edge.projectId === 'local-1' && edge.revision === 'revision-a'
      )
    ).toBe(true);
    expect(
      (
        await inspectGraph('local-1', 'revision-a', 'revision', { ...limits, maxDepth: 1 })
      ).nodes.map((node) => node.id)
    ).toEqual(['revision', 'file']);
    expect(
      (await inspectGraph('local-1', 'revision-a', 'revision', { ...limits, maxResults: 1 }))
        .stopReason
    ).toBe('result_limit');
    expect(
      (await inspectGraph('local-1', 'revision-a', 'revision', { ...limits, maxEdges: 1 }))
        .stopReason
    ).toBe('edge_limit');
    expect(
      (await inspectGraph('local-1', 'revision-a', 'revision', { ...limits, maxMemoryBytes: 1 }))
        .stopReason
    ).toBe('memory_limit');
    expect(
      (
        await inspectGraph(
          'local-1',
          'revision-a',
          'revision',
          { ...limits, maxTimeMs: 1 },
          (() => {
            let t = 0;
            return () => t++;
          })()
        )
      ).stopReason
    ).toBe('time_limit');
    const plan = fixture.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id, source_id FROM tracemind_graph_relationships WHERE project_id = ? AND revision = ? AND target_id = ? ORDER BY rowid LIMIT 64'
      )
      .all('local-1', 'revision-a', 'file') as { detail: string }[];
    expect(
      plan.some((row) => row.detail.includes('idx_tracemind_graph_relationships_target'))
    ).toBe(true);
    expect(plan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
  });
  it('discovers incoming supporting and contradictory evidence without reversing or duplicating edges', async () => {
    const contradiction = {
      ...snapshot.nodes[2]!,
      id: 'contradiction',
      label: 'Contradictory evidence',
    };
    const contradicts = {
      ...snapshot.relationships[1]!,
      id: 'contradicts',
      sourceId: contradiction.id,
      relation: 'CONTRADICTS' as const,
    };
    const cycle = {
      ...snapshot.relationships[0]!,
      id: 'cycle',
      sourceId: 'file',
      targetId: 'revision',
    };
    await saveGraphSnapshot(
      {
        ...snapshot,
        nodes: [...snapshot.nodes, contradiction],
        relationships: [...snapshot.relationships, contradicts, cycle],
      },
      1
    );
    const result = await inspectGraph('local-1', 'revision-a', 'revision', {
      maxDepth: 4,
      maxResults: 100,
      maxEdges: 100,
      maxTimeMs: 1000,
      direction: 'both',
    });
    expect(result.nodes.map((node) => node.id).sort()).toEqual([
      'contradiction',
      'evidence',
      'file',
      'revision',
    ]);
    expect(result.relationships).toHaveLength(4);
    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'supports', sourceId: 'evidence', targetId: 'file' }),
        expect.objectContaining({ id: 'contradicts', sourceId: 'contradiction', targetId: 'file' }),
      ])
    );
  });
  it('returns a bounded, cursor-paged graph overview without a full snapshot', async () => {
    const extraNodes = Array.from({ length: 120 }, (_, index) => ({
      id: `node-${String(index).padStart(3, '0')}`,
      projectId: 'local-1',
      revision: 'revision-a',
      kind: 'observation' as const,
      label: `Observation ${index}`,
      source: null,
      extractionMethod: 'test',
      provenance: 'fixture',
      stale: false,
      createdAt: 1,
    }));
    const parserFailures = Array.from({ length: 25 }, (_, index) => ({
      path: `src/unsupported-${index}.txt`,
      language: 'unsupported',
      message: 'No parser.',
    }));
    const retrievalReasons = Array.from({ length: 5 }, (_, index) => ({
      ...snapshot.retrievalReasons[0]!,
      id: `reason-${index}`,
      reason: `Reason ${index}`,
    }));
    await saveGraphSnapshot(
      { ...snapshot, nodes: [...snapshot.nodes, ...extraNodes], parserFailures, retrievalReasons },
      1
    );
    expect(graphStore).toHaveProperty('getGraphOverview');
    const first = await graphStore.getGraphOverview('local-1', 'revision-a', null);
    expect(first).toMatchObject({
      revision: 'revision-a',
      rootNodeId: 'revision',
      nodeCount: 123,
      relationshipCount: 2,
      parserFailureCount: 25,
    });
    expect(first?.nodes).toHaveLength(50);
    expect(first?.parserFailures).toHaveLength(20);
    expect(first?.retrievalReasons).toHaveLength(3);
    expect(first?.nextCursor).toBeTruthy();
    const plan = fixture.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id, length(cast(payload as blob)) FROM tracemind_graph_nodes WHERE project_id = ? AND revision = ? AND id > ? ORDER BY id LIMIT 51'
      )
      .all('local-1', 'revision-a', 'node-010') as { detail: string }[];
    expect(
      plan.some((entry) => entry.detail.includes('sqlite_autoindex_tracemind_graph_nodes_1'))
    ).toBe(true);
    expect(plan.some((entry) => entry.detail.includes('TEMP B-TREE'))).toBe(false);
    const second = await graphStore.getGraphOverview('local-1', 'revision-a', first!.nextCursor);
    expect(second?.nodes).toHaveLength(50);
    expect(second?.nodes.some((node) => first?.nodes.some((prior) => prior.id === node.id))).toBe(
      false
    );
    const third = await graphStore.getGraphOverview('local-1', 'revision-a', second!.nextCursor);
    expect(third?.nodes).toHaveLength(23);
    expect(third?.nextCursor).toBeNull();
    expect(await graphStore.getGraphOverview('other', 'revision-a', null)).toBeNull();
    await expect(
      graphStore.getGraphOverview('local-1', 'revision-a', 'x'.repeat(513))
    ).rejects.toThrow();
  });
  it('rejects an oversized stored node before loading its payload into the overview', async () => {
    await saveGraphSnapshot(snapshot, 1);
    fixture.sqlite
      .prepare('UPDATE tracemind_graph_nodes SET payload = ? WHERE id = ?')
      .run('x'.repeat(131_073), 'file');
    await expect(graphStore.getGraphOverview('local-1', 'revision-a', null)).rejects.toThrow(
      'Graph node preview size limit exceeded'
    );
  });
  it('rejects a node preview whose indexed metadata disagrees with its payload', async () => {
    await saveGraphSnapshot(snapshot, 1);
    fixture.sqlite
      .prepare('UPDATE tracemind_graph_nodes SET label = ? WHERE id = ?')
      .run('forged', 'file');
    await expect(graphStore.getGraphOverview('local-1', 'revision-a', null)).rejects.toThrow(
      'Stored graph node index mismatch'
    );
  });
  it('does not materialize an oversized node outside the requested page', async () => {
    const extraNodes = Array.from({ length: 60 }, (_, index) => ({
      ...snapshot.nodes[0]!,
      id: `node-${String(index).padStart(3, '0')}`,
      kind: 'observation' as const,
      label: `Observation ${index}`,
    }));
    const lateNode = { ...extraNodes[0]!, id: 'zzz', label: 'Late node' };
    await saveGraphSnapshot(
      { ...snapshot, nodes: [...snapshot.nodes, ...extraNodes, lateNode] },
      1
    );
    fixture.sqlite
      .prepare('UPDATE tracemind_graph_nodes SET payload = ? WHERE id = ?')
      .run('x'.repeat(131_073), 'zzz');
    const first = await graphStore.getGraphOverview('local-1', 'revision-a', null);
    expect(first?.nodes).toHaveLength(50);
    expect(first?.nextCursor).toBeTruthy();
    await expect(
      graphStore.getGraphOverview('local-1', 'revision-a', first!.nextCursor)
    ).rejects.toThrow('Graph node preview size limit exceeded');
  });
  it('persists revision metadata, nodes and relationships in queryable SQLite tables', async () => {
    await saveGraphSnapshot(snapshot, 1);
    const tables = fixture.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tracemind_graph_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual([
      'tracemind_graph_nodes',
      'tracemind_graph_parser_failures',
      'tracemind_graph_relationships',
      'tracemind_graph_retrieval_reasons',
      'tracemind_graph_revisions',
    ]);
    expect(
      fixture.sqlite
        .prepare('SELECT COUNT(*) AS count FROM tracemind_graph_nodes WHERE project_id = ?')
        .get('local-1')
    ).toEqual({ count: 3 });
    expect(
      fixture.sqlite
        .prepare('SELECT COUNT(*) AS count FROM tracemind_graph_relationships WHERE project_id = ?')
        .get('local-1')
    ).toEqual({ count: 2 });
    const plan = fixture.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id, target_id, length(payload) FROM tracemind_graph_relationships WHERE project_id = ? AND revision = ? AND source_id = ? ORDER BY ordinal LIMIT ?'
      )
      .all('local-1', 'revision-a', 'revision', 64) as { detail: string }[];
    expect(
      plan.some((entry) => entry.detail.includes('idx_tracemind_graph_relationships_source_order'))
    ).toBe(true);
  });
  it('migrates a legacy KV graph into normalized tables without losing the snapshot', async () => {
    const legacyKey = 'tracemind:graph:local-1:revision-a';
    const legacyValue = JSON.stringify({ ...snapshot, schemaVersion: 1, capturedAt: 1 });
    await fixture.db.insert(schema.kv).values({ key: legacyKey, value: legacyValue, updatedAt: 1 });
    expect(await graphStore.getGraphOverview('local-1', 'revision-a', null)).toMatchObject({
      rootNodeId: 'revision',
      nodeCount: 3,
    });
    expect(await getGraphSnapshot('local-1', 'revision-a')).toMatchObject(snapshot);
    expect(
      fixture.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(legacyKey)
    ).toBeUndefined();
    expect(
      fixture.sqlite
        .prepare('SELECT COUNT(*) AS count FROM tracemind_graph_nodes WHERE project_id = ?')
        .get('local-1')
    ).toEqual({ count: 3 });
  });
  it('reads the latest captured revision for an incremental index run', async () => {
    await saveGraphSnapshot(snapshot, 1);
    await saveGraphSnapshot(
      {
        ...snapshot,
        revision: 'revision-b',
        nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'revision-b' })),
        relationships: snapshot.relationships.map((relationship) => ({
          ...relationship,
          revision: 'revision-b',
        })),
        retrievalReasons: snapshot.retrievalReasons.map((reason) => ({
          ...reason,
          revision: 'revision-b',
        })),
      },
      2
    );
    expect(await getLatestGraphSnapshot('local-1')).toMatchObject({ revision: 'revision-b' });
  });
  it('persists versioned nodes, provenance, source locations, retrieval reasons and bounded inspection', async () => {
    await saveGraphSnapshot(snapshot, 1);
    expect(await getGraphSnapshot('local-1', 'revision-a')).toMatchObject({
      ...snapshot,
      schemaVersion: 1,
      nodes: snapshot.nodes.map((node) => ({ ...node, schemaVersion: 1 })),
      relationships: snapshot.relationships.map((relationship) => ({
        ...relationship,
        schemaVersion: 1,
      })),
    });
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getGraphSnapshot('local-1', 'revision-a')).toMatchObject(snapshot);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
    const inspected = await inspectGraph('local-1', 'revision-a', 'revision', {
      maxDepth: 2,
      maxResults: 5,
      maxEdges: 10,
      maxTimeMs: 100,
    });
    expect(inspected.nodes.map((node) => node.id)).toEqual(['revision', 'file']);
    expect(inspected.relationships.map((relationship) => relationship.relation)).toEqual([
      'CONTAINS',
    ]);
    expect(
      await inspectGraph('local-1', 'revision-a', 'revision', {
        maxDepth: 2,
        maxResults: 5,
        maxEdges: 10,
        maxTimeMs: 100,
        maxMemoryBytes: 1,
      })
    ).toMatchObject({
      nodes: [],
      relationships: [],
      truncated: true,
      stopReason: 'memory_limit',
    });
    expect(await benchmarkGraphAdapter('local-1', 'revision-a')).toMatchObject({
      adapter: 'sqlite-normalized',
      nodes: 3,
      relationships: 2,
      traversalNodes: 2,
      traversalRelationships: 1,
      truncated: false,
      stopReason: null,
    });
  });

  it('reports an empty graph benchmark as a complete zero-result traversal', async () => {
    await saveGraphSnapshot(
      {
        projectId: 'local-1',
        revision: 'empty-revision',
        nodes: [],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      1
    );
    expect(await benchmarkGraphAdapter('local-1', 'empty-revision')).toMatchObject({
      adapter: 'sqlite-normalized',
      nodes: 0,
      relationships: 0,
      traversalNodes: 0,
      traversalRelationships: 0,
      truncated: false,
      stopReason: null,
    });
    expect(await graphStore.getGraphOverview('local-1', 'empty-revision', null)).toMatchObject({
      rootNodeId: null,
      nodeCount: 0,
      relationshipCount: 0,
      nodes: [],
      nextCursor: null,
    });
  });

  it('traverses a small reachable subgraph without materializing unrelated graph rows', async () => {
    const disconnectedNodes = Array.from({ length: 2_000 }, (_, index) => ({
      id: `unrelated-${index}`,
      projectId: 'local-1',
      revision: 'revision-a',
      kind: 'observation' as const,
      label: `unrelated observation ${index}`,
      source: null,
      extractionMethod: 'test-fixture',
      provenance: 'test-fixture',
      stale: false,
      createdAt: 1,
    }));
    await saveGraphSnapshot({ ...snapshot, nodes: [...snapshot.nodes, ...disconnectedNodes] }, 1);

    const inspected = await inspectGraph('local-1', 'revision-a', 'revision', {
      maxDepth: 2,
      maxResults: 5,
      maxEdges: 10,
      maxTimeMs: 1_000,
      maxMemoryBytes: 8_192,
    });

    expect(inspected.nodes.map((node) => node.id)).toEqual(['revision', 'file']);
    expect(inspected.relationships.map((relationship) => relationship.id)).toEqual(['contains']);
    expect(inspected.truncated).toBe(false);
  });

  it('applies depth, edge, result and wall-clock limits without false edge truncation', async () => {
    const exactEdge = await saveGraphSnapshot(snapshot, 1);
    const exactlyBounded = await inspectGraph('local-1', 'revision-a', 'revision', {
      maxDepth: 2,
      maxResults: 5,
      maxEdges: 1,
      maxTimeMs: 1_000,
    });
    expect(exactlyBounded.truncated).toBe(false);
    expect(exactEdge.relationships).toHaveLength(2);

    const secondRootEdge = {
      ...snapshot.relationships[0]!,
      id: 'contains-evidence',
      targetId: 'evidence',
    };
    await saveGraphSnapshot(
      { ...snapshot, relationships: [...snapshot.relationships, secondRootEdge] },
      2
    );
    const edgeLimited = await inspectGraph('local-1', 'revision-a', 'revision', {
      maxDepth: 2,
      maxResults: 5,
      maxEdges: 1,
      maxTimeMs: 1_000,
    });
    expect(edgeLimited).toMatchObject({ truncated: true, stopReason: 'edge_limit' });

    const resultLimited = await inspectGraph('local-1', 'revision-a', 'revision', {
      maxDepth: 2,
      maxResults: 1,
      maxEdges: 10,
      maxTimeMs: 1_000,
    });
    expect(resultLimited).toMatchObject({ truncated: true, stopReason: 'result_limit' });

    let clockCalls = 0;
    const timeLimited = await inspectGraph(
      'local-1',
      'revision-a',
      'revision',
      { maxDepth: 2, maxResults: 5, maxEdges: 10, maxTimeMs: 1_000 },
      () => (clockCalls++ === 0 ? 0 : 1_000)
    );
    expect(timeLimited).toMatchObject({ truncated: true, stopReason: 'time_limit' });
  });
  it('records contradictory investigation evidence without discarding its rationale', async () => {
    await saveGraphSnapshot(snapshot, 1);
    const updated = await appendGraphRecord('local-1', 'revision-a', {
      kind: 'evidence',
      label: 'Counterexample',
      targetNodeId: 'file',
      relation: 'CONTRADICTS',
      reason: 'Retrieved because the failing test disagrees with the source claim.',
    });
    expect(updated.relationships.at(-1)).toMatchObject({
      relation: 'CONTRADICTS',
      targetId: 'file',
    });
    expect(updated.retrievalReasons.at(-1)?.reason).toContain('failing test');
    expect(
      (await getGraphSnapshot('local-1', 'revision-a'))?.relationships.some(
        (item) => item.relation === 'CONTRADICTS'
      )
    ).toBe(true);
  });

  it('appends an investigation record without rewriting the existing graph', async () => {
    await saveGraphSnapshot(snapshot, 1);
    fixture.sqlite.exec(
      "CREATE TRIGGER forbid_graph_delete BEFORE DELETE ON tracemind_graph_nodes BEGIN SELECT RAISE(ABORT, 'graph rewrite'); END"
    );
    expect(graphStore).toHaveProperty('appendGraphRecordBounded');
    await graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
      kind: 'evidence',
      label: 'Counterexample',
      targetNodeId: 'file',
      relation: 'CONTRADICTS',
      reason: 'Contradictory test evidence.',
    });
    const stored = await getGraphSnapshot('local-1', 'revision-a');
    expect(stored?.capturedAt).toBe(1);
    expect(stored?.relationships.some((edge) => edge.relation === 'CONTRADICTS')).toBe(true);
    expect(
      stored?.retrievalReasons.some((reason) => reason.reason === 'Contradictory test evidence.')
    ).toBe(true);
    fixture.sqlite.exec(
      "CREATE TRIGGER forbid_graph_edge BEFORE INSERT ON tracemind_graph_relationships BEGIN SELECT RAISE(ABORT, 'edge rejected'); END"
    );
    await expect(
      graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
        kind: 'observation',
        label: 'Must roll back',
        targetNodeId: 'file',
        relation: 'SUPPORTS',
        reason: 'Test',
      })
    ).rejects.toThrow('edge rejected');
    expect(
      (await getGraphSnapshot('local-1', 'revision-a'))?.nodes.some(
        (node) => node.label === 'Must roll back'
      )
    ).toBe(false);
  });
  it('validates bounded append targets and preserves concurrent records', async () => {
    await saveGraphSnapshot(snapshot, 1);
    await Promise.all([
      graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
        kind: 'observation',
        label: 'First',
        reason: 'Observed',
      }),
      graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
        kind: 'hypothesis',
        label: 'Second',
        reason: 'Proposed',
      }),
    ]);
    await expect(
      graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
        kind: 'evidence',
        label: 'Invalid',
        reason: 'Test',
        targetNodeId: 'missing',
        relation: 'SUPPORTS',
      })
    ).rejects.toThrow('Graph target node not found');
    await expect(
      graphStore.appendGraphRecordBounded('other', 'revision-a', {
        kind: 'observation',
        label: 'Invalid',
        reason: 'Test',
      })
    ).rejects.toThrow('Graph revision not found');
    await expect(
      graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
        kind: 'evidence',
        label: 'Invalid',
        reason: 'Test',
        source: { path: 'src/a.ts', startLine: 5, endLine: 4 },
      })
    ).rejects.toThrow();
    const stored = await getGraphSnapshot('local-1', 'revision-a');
    expect(stored?.nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining(['First', 'Second'])
    );
    expect(stored?.nodes.some((node) => node.label === 'Invalid')).toBe(false);
  });

  it('does not make an edited historical revision the newest audit revision', async () => {
    await saveGraphSnapshot(snapshot, 1);
    await saveGraphSnapshot(
      {
        ...snapshot,
        revision: 'revision-b',
        nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'revision-b' })),
        relationships: snapshot.relationships.map((edge) => ({ ...edge, revision: 'revision-b' })),
        retrievalReasons: snapshot.retrievalReasons.map((reason) => ({
          ...reason,
          revision: 'revision-b',
        })),
      },
      2
    );
    await graphStore.appendGraphRecordBounded('local-1', 'revision-a', {
      kind: 'observation',
      label: 'Historical note',
      reason: 'Recorded later',
    });
    expect(await getLatestGraphSnapshot('local-1')).toMatchObject({ revision: 'revision-b' });
  });

  it('does not lose concurrent investigation records', async () => {
    await saveGraphSnapshot(snapshot, 1);
    await Promise.all([
      appendGraphRecord('local-1', 'revision-a', {
        kind: 'observation',
        label: 'First concurrent note',
        reason: 'Recorded from the first observation.',
      }),
      appendGraphRecord('local-1', 'revision-a', {
        kind: 'hypothesis',
        label: 'Second concurrent note',
        reason: 'Recorded from the second observation.',
      }),
    ]);
    const stored = await getGraphSnapshot('local-1', 'revision-a');
    expect(stored?.nodes.map((node) => node.label)).toContain('First concurrent note');
    expect(stored?.nodes.map((node) => node.label)).toContain('Second concurrent note');
  });

  it('marks changed source nodes and incident relationships stale persistently', async () => {
    await saveGraphSnapshot(snapshot, 1);
    expect(await markGraphStale('local-1', ['src/a.ts'])).toEqual({
      revisions: 1,
      nodes: 2,
      relationships: 2,
    });
    const changed = await getGraphSnapshot('local-1', 'revision-a');
    expect(changed?.nodes.filter((node) => node.stale).map((node) => node.id)).toEqual([
      'file',
      'evidence',
    ]);
    expect(changed?.relationships.every((relationship) => relationship.stale)).toBe(true);
  });

  it('applies source invalidation and the next revision atomically', async () => {
    await saveGraphSnapshot(snapshot, 1);
    const duplicateNodeSnapshot = {
      ...snapshot,
      revision: 'revision-b',
      nodes: [
        ...snapshot.nodes.map((node) => ({ ...node, revision: 'revision-b' })),
        { ...snapshot.nodes[0]!, revision: 'revision-b' },
      ],
      relationships: snapshot.relationships.map((relationship) => ({
        ...relationship,
        revision: 'revision-b',
      })),
      retrievalReasons: snapshot.retrievalReasons.map((reason) => ({
        ...reason,
        revision: 'revision-b',
      })),
    };
    await expect(
      saveGraphSnapshotAndMarkStale(duplicateNodeSnapshot, ['src/a.ts'], 2)
    ).rejects.toThrow('Duplicate graph node');
    const previous = await getGraphSnapshot('local-1', 'revision-a');
    expect(previous?.nodes.some((node) => node.stale)).toBe(false);
    expect(await getGraphSnapshot('local-1', 'revision-b')).toBeNull();
  });

  it('rejects a graph snapshot above the persisted payload budget', async () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `large-${index}`,
      projectId: 'local-1',
      revision: 'revision-a',
      kind: 'observation' as const,
      label: 'x'.repeat(6144),
      source: null,
      extractionMethod: 'test',
      provenance: 'test',
      stale: false,
      createdAt: 1,
    }));
    await expect(
      saveGraphSnapshot({ ...snapshot, nodes: [...snapshot.nodes, ...nodes] }, 1)
    ).rejects.toThrow('Graph snapshot size limit');
  });

  it('enforces the bounded per-project revision history on graph writes', async () => {
    await fixture.db.insert(schema.tracemindGraphRevisions).values(
      Array.from({ length: 1_000 }, (_, index) => ({
        projectId: 'local-1',
        revision: `existing-${index}`,
        schemaVersion: 1,
        capturedAt: index,
      }))
    );
    await expect(saveGraphSnapshot(snapshot, 1)).rejects.toThrow('Too many graph revisions');
  });

  it('benchmarks a medium repository graph over the normalized SQLite adapter', async () => {
    const size = 5_000;
    const nodes = [
      snapshot.nodes[0]!,
      ...Array.from({ length: size }, (_, index) => ({
        id: `file-${index}`,
        projectId: 'local-1',
        revision: 'revision-a',
        kind: 'file' as const,
        label: `src/module-${index}.ts`,
        source: { path: `src/module-${index}.ts`, startLine: 1, endLine: 80 },
        extractionMethod: 'benchmark-fixture',
        provenance: `audit:benchmark:${index}`,
        stale: false,
        createdAt: 1,
      })),
    ];
    const relationships = Array.from({ length: size * 2 - 1 }, (_, index) => {
      const sourceId = index < size ? 'revision' : `file-${index - size}`;
      const targetIndex = index < size ? index : index - size + 1;
      return {
        id: `edge-${index}`,
        projectId: 'local-1',
        revision: 'revision-a',
        sourceId,
        targetId: `file-${targetIndex}`,
        relation: index < size ? ('CONTAINS' as const) : ('CALLS' as const),
        source: { path: `src/module-${targetIndex}.ts`, startLine: 3, endLine: 4 },
        extractionMethod: 'benchmark-fixture',
        provenance: `benchmark:${index}`,
        stale: false,
        createdAt: 1,
      };
    });
    await saveGraphSnapshot(
      {
        projectId: 'local-1',
        revision: 'revision-a',
        nodes,
        relationships,
        retrievalReasons: [],
        parserFailures: [],
      },
      1
    );
    const result = await benchmarkGraphAdapter('local-1', 'revision-a');
    expect(result).toMatchObject({
      adapter: 'sqlite-normalized',
      nodes: size + 1,
      relationships: size * 2 - 1,
      traversalNodes: expect.any(Number),
      traversalRelationships: expect.any(Number),
      truncated: true,
      stopReason: expect.stringMatching(/^(time_limit|edge_limit|result_limit|memory_limit)$/),
    });
    console.info(`TraceMind normalized SQLite benchmark: ${JSON.stringify(result)}`);
  });
});
