import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { AuditRecord } from '../audit/audit-store';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const graphStore = await import('./graph-store');
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
    filesDiscovered: 2,
    filesParsed: 2,
    skipped: 0,
    inventoryComplete: true,
    errors: [],
    languages: [],
    manifests: [],
    limitations: [],
  },
});

describe('freshness after graph indexing failure', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fixture.close();
    mocks.db = undefined;
  });
  it('keeps unchanged paths fresh and marks omitted or removed paths stale with a partial fingerprint', async () => {
    const firstId = '00000000-0000-4000-8000-000000000201';
    const secondId = '00000000-0000-4000-8000-000000000202';
    const files = [
      { path: 'src/a.ts', fingerprint: 'a'.repeat(64), content: 'export function a() {}' },
      { path: 'src/b.ts', fingerprint: 'b'.repeat(64), content: 'export function b() {}' },
    ];
    await indexAuditGraph(audit(firstId), files);
    await indexAuditGraph({ ...audit(secondId), fingerprint: null }, [files[0]!]);
    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'src/a.ts')
        ?.stale
    ).toBe(false);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'src/b.ts')
        ?.stale
    ).toBe(true);
    const partial = await graphStore.getGraphSnapshot('local-1', `audit:${secondId}`);
    expect(partial?.nodes.some((node) => node.kind === 'symbol' && node.label.includes('a'))).toBe(
      true
    );
    expect(partial?.nodes.some((node) => node.source?.path === 'src/b.ts')).toBe(false);
  });
  it('persists path-only metadata for a budget-excluded file and keeps processable siblings fresh', async () => {
    const firstId = '00000000-0000-4000-8000-000000000210';
    const secondId = '00000000-0000-4000-8000-000000000211';
    const previousFiles = [
      { path: 'large.ts', fingerprint: 'a'.repeat(64), content: 'export function large() {}' },
      { path: 'small.ts', fingerprint: 'b'.repeat(64), content: 'export function small() {}' },
    ];
    await indexAuditGraph(audit(firstId), previousFiles);
    const partialAudit: AuditRecord = {
      ...audit(secondId),
      fingerprint: null,
      inventory: {
        ...audit(secondId).inventory,
        filesParsed: 1,
        graphCoverage: { status: 'partial', omittedFiles: 1 },
      },
    };
    const result = await indexAuditGraph(partialAudit, [
      {
        path: 'large.ts',
        fingerprint: null,
        content: null,
        omissionReason: 'fingerprint_limit',
      },
      { path: 'small.ts', fingerprint: 'c'.repeat(64), content: 'export function small() {}' },
    ]);
    const current = await graphStore.getGraphSnapshot('local-1', `audit:${secondId}`);
    const largeNode = current?.nodes.find(
      (node) => node.kind === 'file' && node.label === 'large.ts'
    );
    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    expect(result).toMatchObject({ omittedFiles: 1, filesParsed: 1 });
    expect(largeNode).toBeDefined();
    expect(
      current?.relationships.some(
        (edge) => edge.relation === 'CONTAINS' && edge.targetId === largeNode?.id
      )
    ).toBe(true);
    expect(
      current?.nodes.some((node) => node.kind === 'symbol' && node.label === 'small.ts:small')
    ).toBe(true);
    expect(current?.parserFailures).toEqual([
      expect.objectContaining({ path: 'large.ts', language: 'audit-file' }),
    ]);
    expect(
      current?.nodes.some((node) => node.kind === 'evidence' && node.source?.path === 'large.ts')
    ).toBe(false);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'large.ts')
        ?.stale
    ).toBe(true);
  });
  it('keeps verified sibling evidence fresh when one oversized file has no usable fingerprint', async () => {
    const firstId = '00000000-0000-4000-8000-000000000220';
    const secondId = '00000000-0000-4000-8000-000000000221';
    const files = [
      { path: 'src/large.ts', fingerprint: 'a'.repeat(64), content: 'export function large() {}' },
      { path: 'src/small.ts', fingerprint: 'b'.repeat(64), content: 'export function small() {}' },
    ];
    await indexAuditGraph(audit(firstId), files);
    const partialAudit = {
      ...audit(secondId),
      fingerprint: null,
      inventory: {
        ...audit(secondId).inventory,
        graphCoverage: { status: 'partial' as const, omittedFiles: 1 },
      },
    };

    await indexAuditGraph(partialAudit, [
      {
        path: 'src/large.ts',
        fingerprint: null,
        content: null,
        omissionReason: 'fingerprint_limit',
      },
      files[1]!,
    ]);

    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    const current = await graphStore.getGraphSnapshot('local-1', `audit:${secondId}`);
    expect(
      previous?.nodes.find(
        (node) => node.kind === 'evidence' && node.source?.path === 'src/large.ts'
      )?.stale
    ).toBe(true);
    expect(
      previous?.nodes.find(
        (node) => node.kind === 'evidence' && node.source?.path === 'src/small.ts'
      )?.stale
    ).toBe(false);
    expect(
      current?.nodes.find((node) => node.kind === 'symbol' && node.label === 'src/small.ts:small')
        ?.stale
    ).toBe(false);
    expect(current?.parserFailures).toContainEqual(
      expect.objectContaining({ path: 'src/large.ts', language: 'audit-file' })
    );
  });
  it('marks changed historical evidence and edges stale when replacement persistence fails', async () => {
    const firstId = '00000000-0000-4000-8000-000000000101';
    const secondId = '00000000-0000-4000-8000-000000000102';
    const files = [
      { path: 'src/a.ts', fingerprint: 'a'.repeat(64), content: 'export function a() {}' },
      { path: 'src/b.ts', fingerprint: 'b'.repeat(64), content: 'export function b() {}' },
    ];
    await indexAuditGraph(audit(firstId), files);
    fixture.sqlite.exec(
      "CREATE TRIGGER reject_graph_revision BEFORE INSERT ON tracemind_graph_revisions BEGIN SELECT RAISE(ABORT, 'replacement write failed'); END"
    );
    await expect(
      indexAuditGraph(audit(secondId), [
        { ...files[0]!, fingerprint: 'c'.repeat(64), content: 'export function changed() {}' },
        files[1]!,
      ])
    ).rejects.toThrow('replacement write failed');
    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'src/a.ts')
        ?.stale
    ).toBe(true);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'src/b.ts')
        ?.stale
    ).toBe(false);
    expect(
      previous?.relationships.some((edge) => edge.stale && edge.source?.path === 'src/a.ts')
    ).toBe(true);
    expect(await graphStore.getGraphSnapshot('local-1', `audit:${secondId}`)).toBeNull();
  });

  it('invalidates deleted-file evidence when replacement persistence fails', async () => {
    const firstId = '00000000-0000-4000-8000-000000000103';
    const files = [
      { path: 'src/a.ts', fingerprint: 'a'.repeat(64), content: 'export function a() {}' },
      { path: 'src/b.ts', fingerprint: 'b'.repeat(64), content: 'export function b() {}' },
    ];
    await indexAuditGraph(audit(firstId), files);
    vi.spyOn(graphStore, 'saveGraphSnapshotAndMarkStale').mockRejectedValueOnce(new Error('write'));
    await expect(
      indexAuditGraph(audit('00000000-0000-4000-8000-000000000104'), [files[1]!])
    ).rejects.toThrow('write');
    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'src/a.ts')
        ?.stale
    ).toBe(true);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'src/b.ts')
        ?.stale
    ).toBe(false);
  });

  it('keeps indexing other files and invalidates changed evidence when one parser throws', async () => {
    const firstId = '00000000-0000-4000-8000-000000000105';
    const file = {
      path: 'src/a.ts',
      fingerprint: 'a'.repeat(64),
      content: 'export function a() {}',
    };
    await indexAuditGraph(audit(firstId), [file]);
    const parse = parser.parseSource;
    vi.spyOn(parser, 'parseSource').mockImplementation((path, content) => {
      if (path === file.path) throw new Error('parser failed');
      return parse(path, content);
    });
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000106'), [
      { ...file, fingerprint: 'c'.repeat(64) },
      { path: 'src/b.ts', fingerprint: 'b'.repeat(64), content: 'export function b() {}' },
    ]);
    expect(result.parserFailures).toEqual([
      expect.objectContaining({ path: file.path, message: expect.stringContaining('failed') }),
    ]);
    const current = await graphStore.getGraphSnapshot(
      'local-1',
      'audit:00000000-0000-4000-8000-000000000106'
    );
    expect(
      current?.nodes.some((node) => node.kind === 'symbol' && node.label.includes('src/b.ts:b'))
    ).toBe(true);
    expect(current?.parserFailures).toEqual(result.parserFailures);
    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === file.path)
        ?.stale
    ).toBe(true);
  });

  it('reports a failed freshness update and leaves unchanged snapshots untouched', async () => {
    const firstId = '00000000-0000-4000-8000-000000000107';
    const file = {
      path: 'src/a.ts',
      fingerprint: 'a'.repeat(64),
      content: 'export function a() {}',
    };
    await indexAuditGraph(audit(firstId), [file]);
    vi.spyOn(graphStore, 'saveGraphSnapshotAndMarkStale').mockRejectedValue(new Error('write'));
    const mark = vi.spyOn(graphStore, 'markGraphStale').mockRejectedValue(new Error('stale write'));
    await expect(
      indexAuditGraph(audit('00000000-0000-4000-8000-000000000108'), [file])
    ).rejects.toThrow('write');
    expect(mark).not.toHaveBeenCalled();
    await expect(
      indexAuditGraph(audit('00000000-0000-4000-8000-000000000109'), [
        { ...file, fingerprint: 'c'.repeat(64) },
      ])
    ).rejects.toThrow('historical graph freshness could not be updated');
    const previous = await graphStore.getGraphSnapshot('local-1', `audit:${firstId}`);
    expect(
      previous?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === file.path)
        ?.stale
    ).toBe(false);
  });
});
