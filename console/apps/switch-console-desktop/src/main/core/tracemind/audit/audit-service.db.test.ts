import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { MAX_PARSER_SOURCE_BYTES } from '../graph/parser-adapters';
import type { NativeProjectFs } from '../native/access-registry';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { saveAudit, getAudit, getAuditReport, listAuditEvidence, recordGraphCoverage } =
  await import('./audit-store');
const { runLocalAudit } = await import('./audit-service');
const { indexAuditGraph } = await import('../graph/graph-service');
const { getGraphSnapshot } = await import('../graph/graph-store');

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'audit persistence integration',
  () => {
    let fixture: Awaited<ReturnType<typeof openFixture>>;
    beforeEach(async () => {
      fixture = await openFixture('empty');
      mocks.db = fixture.db;
    });
    afterEach(() => {
      fixture.close();
      mocks.db = undefined;
    });
    it('persists a real local scan and fingerprint through SQLite', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tracemind-audit-db-'));
      try {
        await writeFile(join(dir, 'file.ts'), 'let a = 1');
        const root = await realpath(dir);
        const st = await stat(root, { bigint: true });
        const native = createRequire(import.meta.url)(
          join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
        ) as NativeProjectFs;
        const result = await runLocalAudit('loc-1', {
          native,
          consume: async () => ({ locationId: 'loc-1', root, identity: `${st.dev}:${st.ino}` }),
          save: saveAudit,
        });
        expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(await getAudit('loc-1', result.id)).toEqual(result);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it('persists every eligible path and the processable sibling when the fingerprint budget is exhausted', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tracemind-audit-budget-db-'));
      try {
        await writeFile(join(dir, 'large.ts'), 'x'.repeat(100));
        await writeFile(join(dir, 'small.ts'), 'function x(){}');
        const root = await realpath(dir);
        const st = await stat(root, { bigint: true });
        const native = createRequire(import.meta.url)(
          join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
        ) as NativeProjectFs;
        const audit = await runLocalAudit('loc-1', {
          native,
          consume: async () => ({ root, locationId: 'loc-1', identity: `${st.dev}:${st.ino}` }),
          save: saveAudit,
          maxBytes: 16,
          indexGraph: indexAuditGraph,
          recordGraphCoverage: (record, coverage) =>
            recordGraphCoverage(record.locationId, record.id, coverage),
        });
        const graph = await getGraphSnapshot('loc-1', `audit:${audit.id}`);
        const evidence = await listAuditEvidence('loc-1', audit.id, 0, 20);
        expect(audit.fingerprint).toBeNull();
        expect(audit.inventory).toMatchObject({
          filesDiscovered: 2,
          filesParsed: 1,
          graphCoverage: { status: 'partial', omittedFiles: 1 },
        });
        expect(graph?.nodes.some((node) => node.kind === 'file' && node.label === 'large.ts')).toBe(
          true
        );
        expect(graph?.nodes.some((node) => node.kind === 'file' && node.label === 'small.ts')).toBe(
          true
        );
        expect(
          graph?.nodes.some((node) => node.kind === 'symbol' && node.label === 'small.ts:x')
        ).toBe(true);
        expect(graph?.parserFailures).toEqual([
          expect.objectContaining({ path: 'large.ts', message: expect.stringContaining('budget') }),
        ]);
        expect(evidence.items.map((item) => item.path)).toContain('small.ts');
        expect(evidence.items.map((item) => item.path)).not.toContain('large.ts');
        expect(await getAuditReport('loc-1', audit.id)).toContain('Graph coverage: partial');
        expect(await getAuditReport('loc-1', audit.id)).toContain('missing evidence is possible');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it('indexes every processable sibling after multiple parser-oversized files exhaust their allowance', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tracemind-audit-large-priority-db-'));
      try {
        await writeFile(join(dir, 'large.ts'), 'x'.repeat(MAX_PARSER_SOURCE_BYTES + 1));
        await writeFile(join(dir, 'large-too.ts'), 'y'.repeat(MAX_PARSER_SOURCE_BYTES + 1));
        await writeFile(join(dir, 'small.ts'), 'export function retained() { return 42; }');
        await writeFile(join(dir, 'small-too.ts'), 'export function retainedToo() { return 7; }');
        const root = await realpath(dir);
        const st = await stat(root, { bigint: true });
        const native = createRequire(import.meta.url)(
          join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
        ) as NativeProjectFs;
        const largeFirstNative: NativeProjectFs = {
          openRoot: (path) => native.openRoot(path),
          openDirectory: (parent, name) => native.openDirectory(parent, name),
          openFile: (parent, name) => native.openFile(parent, name),
          classify: (parent, name) => native.classify(parent, name),
          list: (parent, limit) => {
            const listing = native.list(parent, limit);
            listing.names.sort((left, right) =>
              left.toString() === 'large.ts' ? -1 : right.toString() === 'large.ts' ? 1 : 0
            );
            return listing;
          },
        };
        const audit = await runLocalAudit('loc-1', {
          native: largeFirstNative,
          consume: async () => ({ root, locationId: 'loc-1', identity: `${st.dev}:${st.ino}` }),
          save: saveAudit,
          maxBytes: 1_000_060,
          indexGraph: indexAuditGraph,
          recordGraphCoverage: (record, coverage) =>
            recordGraphCoverage(record.locationId, record.id, coverage),
        });
        const graph = await getGraphSnapshot('loc-1', `audit:${audit.id}`);
        expect(audit.fingerprint).toBeNull();
        expect(audit.inventory).toMatchObject({
          filesDiscovered: 4,
          filesParsed: 2,
          graphCoverage: { status: 'partial', omittedFiles: 2 },
        });
        expect(
          graph?.nodes.some((node) => node.kind === 'symbol' && node.label === 'small.ts:retained')
        ).toBe(true);
        expect(
          graph?.nodes.some(
            (node) => node.kind === 'symbol' && node.label === 'small-too.ts:retainedToo'
          )
        ).toBe(true);
        expect(graph?.nodes.some((node) => node.kind === 'file' && node.label === 'large.ts')).toBe(
          true
        );
        expect(
          graph?.nodes.some((node) => node.kind === 'file' && node.label === 'large-too.ts')
        ).toBe(true);
        expect(graph?.parserFailures).toEqual([
          expect.objectContaining({
            path: 'large.ts',
            message: expect.stringContaining('allowance'),
          }),
          expect.objectContaining({
            path: 'large-too.ts',
            message: expect.stringContaining('allowance'),
          }),
        ]);
        const report = await getAuditReport('loc-1', audit.id);
        expect(report).toContain('Graph coverage: partial');
        expect(report).toContain('missing evidence is possible');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
);
