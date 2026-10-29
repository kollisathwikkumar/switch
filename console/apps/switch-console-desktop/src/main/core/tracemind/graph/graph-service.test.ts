import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '../audit/audit-store';
import type { StoredGraphSnapshot } from './graph-store';
import { graphSnapshotSchema, type GraphSnapshot } from './model';

const mocks = vi.hoisted(() => ({
  snapshots: [] as StoredGraphSnapshot[],
  commit: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('./graph-store', () => ({
  getLatestGraphSnapshot: async () =>
    [...mocks.snapshots].sort((left, right) => right.capturedAt - left.capturedAt)[0] ?? null,
  markGraphStale: async (projectId: string, paths: readonly string[]) => {
    mocks.invalidate(projectId, paths);
    return { revisions: 0, nodes: 0, relationships: 0 };
  },
  saveGraphSnapshotAndMarkStale: async (
    snapshot: GraphSnapshot,
    changedPaths: readonly string[],
    capturedAt: number
  ): Promise<{
    snapshot: StoredGraphSnapshot;
    invalidated: { revisions: number; nodes: number; relationships: number };
  }> => {
    const stored = { ...snapshot, capturedAt };
    mocks.snapshots.push(stored);
    mocks.commit(snapshot, changedPaths);
    return { snapshot: stored, invalidated: { revisions: 0, nodes: 0, relationships: 0 } };
  },
}));

const { indexAuditGraph } = await import('./graph-service');
const parser = await import('./parser-adapters');

const audit = (id: string): AuditRecord => ({
  id,
  locationId: 'local-1',
  root: '/repo',
  identity: '1:2',
  revision: null,
  dirty: null,
  fingerprint: 'a'.repeat(64),
  capturedAt: 1,
  inventory: {
    filesDiscovered: 1,
    filesParsed: 1,
    skipped: 0,
    inventoryComplete: true,
    errors: [],
    languages: [{ language: 'TypeScript', files: 1 }],
    manifests: [],
    limitations: [],
  },
});

describe('incremental graph indexing', () => {
  beforeEach(() => {
    mocks.snapshots = [];
    mocks.commit.mockClear();
    mocks.invalidate.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reuses unchanged file extraction under the new revision without reparsing', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const file = {
      path: 'src/a.ts',
      fingerprint: 'b'.repeat(64),
      content: 'export function retained() { return 1; }',
    };
    const first = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000001'), [file]);
    expect(first.snapshot.nodes.some((node) => node.label === 'src/a.ts:retained')).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);

    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000002'), [file]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(second.snapshot.revision).toBe('audit:00000000-0000-4000-8000-000000000002');
    expect(second.snapshot.nodes.some((node) => node.label === 'src/a.ts:retained')).toBe(true);
    expect(second.snapshot.nodes.every((node) => node.revision === second.snapshot.revision)).toBe(
      true
    );
    expect(
      second.snapshot.relationships.every((edge) => edge.revision === second.snapshot.revision)
    ).toBe(true);
    expect(
      second.snapshot.nodes.find((node) => node.label === 'src/a.ts:retained')?.extractionMethod
    ).toContain('reused');
    const third = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000003'), [file]);
    const retained = third.snapshot.nodes.find((node) => node.label === 'src/a.ts:retained');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(retained?.extractionMethod).toBe('reused-typescript-ast-v1');
    expect(retained?.provenance.length).toBeLessThan(256);
  });

  it('keeps files without a fingerprint visible and conservatively invalidates prior paths', async () => {
    const firstId = '00000000-0000-4000-8000-000000000010';
    const secondId = '00000000-0000-4000-8000-000000000011';
    const priorFiles = [
      { path: 'large.ts', fingerprint: 'a'.repeat(64), content: 'export const large = 1;' },
      { path: 'small.ts', fingerprint: 'b'.repeat(64), content: 'export const small = 1;' },
    ];
    await indexAuditGraph(audit(firstId), priorFiles);

    const nextAudit = {
      ...audit(secondId),
      fingerprint: null,
      inventory: {
        ...audit(secondId).inventory,
        filesDiscovered: 2,
        filesParsed: 1,
        graphCoverage: { status: 'partial' as const, omittedFiles: 1 },
      },
    };
    const result = await indexAuditGraph(nextAudit, [
      {
        path: 'large.ts',
        fingerprint: null,
        content: null,
        omissionReason: 'fingerprint_limit',
      },
      {
        path: 'small.ts',
        fingerprint: 'c'.repeat(64),
        content: 'export function small() { return 2; }',
      },
    ]);

    expect(
      result.snapshot.nodes.some((node) => node.kind === 'file' && node.label === 'large.ts')
    ).toBe(true);
    const largeNode = result.snapshot.nodes.find(
      (node) => node.kind === 'file' && node.label === 'large.ts'
    );
    expect(
      result.snapshot.relationships.some(
        (edge) => edge.relation === 'CONTAINS' && edge.targetId === largeNode?.id
      )
    ).toBe(true);
    expect(
      result.snapshot.nodes.some(
        (node) => node.kind === 'evidence' && node.source?.path === 'large.ts'
      )
    ).toBe(false);
    expect(result.snapshot.nodes.some((node) => node.label === 'small.ts:small')).toBe(true);
    expect(result.parserFailures).toContainEqual(
      expect.objectContaining({
        path: 'large.ts',
        language: 'audit-file',
        message: expect.stringContaining('fingerprint byte budget'),
      })
    );
    expect(mocks.commit.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['large.ts', 'small.ts'])
    );
  });

  it('bounds persisted diagnostics without dropping file nodes or omission coverage', async () => {
    const files = Array.from({ length: 10_001 }, (_, index) => ({
      path: `large/file-${index}.ts`,
      fingerprint: null,
      content: null,
      omissionReason: 'large_file' as const,
    }));
    const result = await indexAuditGraph(
      {
        ...audit('00000000-0000-4000-8000-000000000013'),
        fingerprint: null,
        inventory: {
          ...audit('00000000-0000-4000-8000-000000000013').inventory,
          filesDiscovered: files.length,
          filesParsed: 0,
          graphCoverage: { status: 'partial', omittedFiles: files.length },
        },
      },
      files
    );
    const { capturedAt: _capturedAt, ...snapshot } = result.snapshot;
    expect(graphSnapshotSchema.parse(snapshot)).toBeDefined();
    expect(result.snapshot.nodes.filter((node) => node.kind === 'file')).toHaveLength(files.length);
    expect(result.snapshot.parserFailures).toHaveLength(10_000);
    expect(result.snapshot.parserFailures.at(-1)?.language).toBe('diagnostics-limit');
    expect(result.omittedFiles).toBe(files.length);
    expect(result.filesParsed).toBe(0);
  });

  it('indexes the previous revision once rather than rescanning it for each unchanged file', async () => {
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      fingerprint: index.toString(16).padStart(64, '0'),
      content: `export function function_${index}() { return ${index}; }`,
    }));
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000004'), files);
    const previous = mocks.snapshots[0]!;
    const findNodes = vi.spyOn(previous.nodes, 'find');
    const mapNodes = vi.spyOn(previous.nodes, 'map');

    const next = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000005'), files);

    expect(findNodes).toHaveBeenCalledTimes(0);
    expect(mapNodes).toHaveBeenCalledTimes(0);
    expect(
      next.snapshot.nodes.filter((node) => node.extractionMethod === 'reused-typescript-ast-v1')
    ).toHaveLength(files.length);
  });

  it('retains a parser diagnostic when its unchanged file extraction is reused', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const file = { path: 'README.md', fingerprint: 'e'.repeat(64), content: 'unsupported' };
    const first = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000006'), [file]);
    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000007'), [file]);
    expect(first.parserFailures).toHaveLength(1);
    expect(second.parserFailures).toEqual(first.parserFailures);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('reparses changed content and invalidates the prior source relationships', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const firstFile = {
      path: 'src/a.ts',
      fingerprint: 'b'.repeat(64),
      content: 'export function original() { return 1; }',
    };
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000011'), [firstFile]);

    const changedFile = {
      ...firstFile,
      fingerprint: 'c'.repeat(64),
      content: 'export function replacement() { return 2; }',
    };
    const changed = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000012'), [
      changedFile,
    ]);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledWith(expect.any(Object), ['src/a.ts']);
    expect(changed.snapshot.nodes.some((node) => node.label === 'src/a.ts:replacement')).toBe(true);
    expect(changed.snapshot.nodes.some((node) => node.label === 'src/a.ts:original')).toBe(false);
    expect(changed.snapshot.relationships.some((edge) => edge.stale)).toBe(false);
  });

  it('resolves imports, calls and test relationships to indexed source nodes', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000021'), [
      {
        path: 'src/run.ts',
        fingerprint: '1'.repeat(64),
        content: "import { helper } from './helper';\nexport function run() { helper(); }",
      },
      {
        path: 'src/helper.ts',
        fingerprint: '2'.repeat(64),
        content: 'export function helper() { return 1; }',
      },
      {
        path: 'src/run.test.ts',
        fingerprint: '3'.repeat(64),
        content: "import { run } from './run';\ntest('runs', () => run());",
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const importEdge = result.snapshot.relationships.find(
      (edge) => edge.relation === 'IMPORTS' && nodesById.get(edge.sourceId)?.label === 'src/run.ts'
    );
    expect(nodesById.get(importEdge?.targetId ?? '')).toMatchObject({
      kind: 'file',
      label: 'src/helper.ts',
    });
    const callEdge = result.snapshot.relationships.find(
      (edge) => edge.relation === 'CALLS' && edge.source?.path === 'src/run.ts'
    );
    expect(nodesById.get(callEdge?.sourceId ?? '')?.label).toBe('src/run.ts:run');
    expect(nodesById.get(callEdge?.targetId ?? '')?.label).toBe('src/helper.ts:helper');
    const testEdge = result.snapshot.relationships.find(
      (edge) => edge.relation === 'TESTS' && edge.source?.path === 'src/run.test.ts'
    );
    expect(nodesById.get(testEdge?.sourceId ?? '')?.label).toBe('src/run.test.ts:runs');
    expect(nodesById.get(testEdge?.targetId ?? '')?.label).toBe('src/run.ts:run');
  });

  it('attributes calls to the narrowest containing symbol in nested source ranges', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000022'), [
      {
        path: 'src/nested.ts',
        fingerprint: '7'.repeat(64),
        content: 'function outer() {\n  function inner() {\n    missing();\n  }\n  missing();\n}',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const calls = result.snapshot.relationships
      .filter((edge) => edge.relation === 'CALLS')
      .sort((left, right) => (left.source?.startLine ?? 0) - (right.source?.startLine ?? 0));

    expect(calls).toHaveLength(2);
    expect(nodesById.get(calls[0]!.sourceId)?.label).toBe('src/nested.ts:inner');
    expect(nodesById.get(calls[1]!.sourceId)?.label).toBe('src/nested.ts:outer');
  });

  it('prefers a unique local symbol when the same name exists in another file', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000024'), [
      {
        path: 'src/a.ts',
        fingerprint: '1'.repeat(64),
        content: 'function helper() {}\nexport function run() { helper(); }',
      },
      {
        path: 'src/b.ts',
        fingerprint: '2'.repeat(64),
        content: 'export function helper() {}',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const call = result.snapshot.relationships.find((edge) => edge.relation === 'CALLS');
    expect(nodesById.get(call?.targetId ?? '')?.label).toBe('src/a.ts:helper');
  });

  it('matches a naive interval lookup for overlapping, expired and tied symbol ranges', async () => {
    const path = 'src/generated.ts';
    const symbols = Array.from({ length: 100 }, (_, index) => {
      const startLine = 1 + ((index * 17) % 80);
      return {
        name: `symbol_${index}`,
        kind: 'function' as const,
        source: { path, startLine, endLine: startLine + (index % 16) },
      };
    });
    const references = Array.from({ length: 120 }, (_, index) => {
      const line = 1 + ((index * 29) % 110);
      return {
        target: `missing_${index}`,
        relation: 'CALLS' as const,
        source: { path, startLine: line, endLine: line },
      };
    }).reverse();
    vi.spyOn(parser, 'parseSource').mockReturnValue({
      language: 'TypeScript',
      symbols,
      references,
    });
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000023'), [
      { path, fingerprint: '8'.repeat(64), content: '' },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const callsByTarget = new Map(
      result.snapshot.relationships
        .filter((edge) => edge.relation === 'CALLS')
        .map((edge) => [nodesById.get(edge.targetId)?.label, edge])
    );
    for (const reference of references) {
      const line = reference.source.startLine;
      const expected = symbols
        .filter((symbol) => symbol.source.startLine <= line && symbol.source.endLine >= line)
        .sort(
          (left, right) =>
            left.source.endLine -
            left.source.startLine -
            (right.source.endLine - right.source.startLine)
        )[0];
      const call = callsByTarget.get(reference.target);
      expect(call).toBeDefined();
      expect(nodesById.get(call!.sourceId)?.label).toBe(
        expected ? `${path}:${expected.name}` : path
      );
    }
  });

  it('re-resolves unchanged importers to changed dependency nodes in the new revision', async () => {
    const firstFiles = [
      {
        path: 'src/run.ts',
        fingerprint: '4'.repeat(64),
        content: "import { helper } from './helper';\nexport function run() { helper(); }",
      },
      {
        path: 'src/helper.ts',
        fingerprint: '5'.repeat(64),
        content: 'export function helper() { return 1; }',
      },
    ];
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000031'), firstFiles);
    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000032'), [
      firstFiles[0]!,
      {
        ...firstFiles[1]!,
        fingerprint: '6'.repeat(64),
        content: 'export function helper() { return 2; }',
      },
    ]);
    const nodesById = new Map(second.snapshot.nodes.map((node) => [node.id, node]));
    const callEdge = second.snapshot.relationships.find(
      (edge) => edge.relation === 'CALLS' && edge.source?.path === 'src/run.ts'
    );
    expect(nodesById.get(callEdge?.targetId ?? '')).toMatchObject({
      label: 'src/helper.ts:helper',
      revision: second.snapshot.revision,
      extractionMethod: 'typescript-ast-v1',
    });
    expect(
      second.snapshot.nodes.find((node) => node.label === 'src/run.ts:run')?.extractionMethod
    ).toBe('reused-typescript-ast-v1');
  });

  it('re-resolves test relationships when a tested symbol disappears', async () => {
    const testFile = {
      path: 'src/run.test.ts',
      fingerprint: '9'.repeat(64),
      content: "test('runs', () => run());",
    };
    const sourceFile = {
      path: 'src/run.ts',
      fingerprint: 'a'.repeat(64),
      content: 'export function run() { return 1; }',
    };
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000041'), [testFile, sourceFile]);
    const next = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000042'), [
      testFile,
      {
        ...sourceFile,
        fingerprint: 'b'.repeat(64),
        content: 'export function replacement() { return 2; }',
      },
    ]);
    const nodesById = new Map(next.snapshot.nodes.map((node) => [node.id, node]));
    const testTargets = next.snapshot.relationships
      .filter((edge) => edge.relation === 'TESTS' && edge.source?.path === testFile.path)
      .map((edge) => nodesById.get(edge.targetId)?.label);

    expect(testTargets).toEqual(['run']);
    expect(next.snapshot.nodes.some((node) => node.label === 'src/run.ts:run')).toBe(false);
  });
});
