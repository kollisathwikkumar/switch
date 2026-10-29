import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ParsedAuditFile } from '../graph/graph-service';
import { MAX_PARSER_SOURCE_BYTES } from '../graph/parser-adapters';
import type { NativeProjectFs } from '../native/access-registry';
import { runLocalAudit } from './audit-service';
import type { AuditInput, AuditRecord } from './audit-store';

function getNative(): NativeProjectFs {
  return createRequire(import.meta.url)(
    join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
  ) as NativeProjectFs;
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'local audit service',
  () => {
    it('consumes consent, scans real files, fingerprints and persists metadata', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-audit-service-'));
      try {
        await writeFile(join(root, 'main.ts'), 'export const a = 1');
        await writeFile(join(root, '.env'), 'secret');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const consume = vi.fn().mockResolvedValue({
          locationId: 'loc-1',
          root: canonical,
          identity: `${info.dev}:${info.ino}`,
        });
        const save = vi.fn(async (record: AuditInput) => ({ ...record, id: 'audit-id' }));
        const result = await runLocalAudit('loc-1', { consume, native: getNative(), save });
        expect(consume).toHaveBeenCalledWith('loc-1');
        expect(save).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-1' }), [
          expect.objectContaining({
            path: 'main.ts',
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]);
        expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(result.identity).toBe(`${info.dev}:${info.ino}`);
        expect(result.revision).toBeNull();
        expect(result.inventory).toMatchObject({ filesDiscovered: 1, filesParsed: 0, skipped: 1 });
        expect(result.inventory.languages).toEqual([{ language: 'TypeScript', files: 1 }]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('does not scan or persist without approval', async () => {
      const save = vi.fn();
      await expect(
        runLocalAudit('loc-1', { consume: async () => null, native: getNative(), save })
      ).rejects.toThrow('approval');
      expect(save).not.toHaveBeenCalled();
    });
    it('indexes oversized files as partial metadata without claiming complete coverage', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-graph-limit-'));
      try {
        await writeFile(join(root, 'large.ts'), 'a'.repeat(MAX_PARSER_SOURCE_BYTES + 1));
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const save = vi.fn(async (record: AuditInput) => ({ ...record, id: 'audit-id' }));
        const indexGraph = vi.fn();
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save,
          indexGraph,
        });
        expect(indexGraph).toHaveBeenCalledWith(expect.anything(), [
          expect.objectContaining({ path: 'large.ts', content: null }),
        ]);
        expect(audit.inventory.graphCoverage).toEqual({ status: 'partial', omittedFiles: 1 });
        expect(audit.inventory.limitations.join(' ')).toContain('Graph coverage is partial');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('keeps large-file coverage partial even if the graph adapter omits its failure', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-large-coverage-'));
      try {
        await writeFile(join(root, 'large.ts'), 'x'.repeat(MAX_PARSER_SOURCE_BYTES + 1));
        await writeFile(join(root, 'small.ts'), 'export const ok = 1;');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const indexGraph = vi.fn(
          async (_audit: AuditRecord, _files: readonly ParsedAuditFile[]) => ({
            parserFailures: [],
          })
        );
        const recordGraphCoverage = vi.fn(
          async (
            audit: AuditRecord,
            graphCoverage: {
              status: 'complete' | 'partial';
              omittedFiles: number;
              filesParsed: number;
            }
          ) => ({
            ...audit,
            inventory: {
              ...audit.inventory,
              filesParsed: graphCoverage.filesParsed,
              graphCoverage: {
                status: graphCoverage.status,
                omittedFiles: graphCoverage.omittedFiles,
              },
            },
          })
        );
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save: async (record: AuditInput) => ({ ...record, id: 'audit-id' }),
          indexGraph,
          recordGraphCoverage,
        });
        expect(indexGraph.mock.calls[0]?.[1]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'small.ts', content: 'export const ok = 1;' }),
            expect.objectContaining({ path: 'large.ts', content: null }),
          ])
        );
        expect(audit.inventory.graphCoverage).toEqual({ status: 'partial', omittedFiles: 1 });
        expect(audit.inventory.filesParsed).toBe(1);
        expect(recordGraphCoverage).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ status: 'partial', omittedFiles: 1, filesParsed: 1 })
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('keeps graph coverage partial when adapter parsed and omitted counts are inconsistent', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-inconsistent-coverage-'));
      try {
        await writeFile(join(root, 'small.ts'), 'export const ok = 1;');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const recordGraphCoverage = vi.fn(
          async (
            audit: AuditRecord,
            coverage: {
              status: 'complete' | 'partial';
              omittedFiles: number;
              filesParsed: number;
            }
          ) => ({
            ...audit,
            inventory: {
              ...audit.inventory,
              filesParsed: coverage.filesParsed,
              graphCoverage: { status: coverage.status, omittedFiles: coverage.omittedFiles },
            },
          })
        );
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save: async (record: AuditInput) => ({ ...record, id: 'audit-id' }),
          indexGraph: async () => ({ parserFailures: [], omittedFiles: 0, filesParsed: 0 }),
          recordGraphCoverage,
        });
        expect(audit.inventory.graphCoverage).toEqual({ status: 'partial', omittedFiles: 1 });
        expect(audit.inventory.filesParsed).toBe(0);
        expect(recordGraphCoverage).toHaveBeenCalledWith(expect.anything(), {
          status: 'partial',
          omittedFiles: 1,
          filesParsed: 0,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('persists a failed graph-indexing limitation and returns the durable audit', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-graph-error-'));
      try {
        await writeFile(join(root, 'main.ts'), 'export function ok() { return true; }');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const saved = vi.fn(async (record: AuditInput) => ({ ...record, id: 'audit-id' }));
        const recordGraphFailure = vi.fn(async (record: Awaited<ReturnType<typeof saved>>) => ({
          ...record,
          inventory: {
            ...record.inventory,
            limitations: [...record.inventory.limitations, 'Graph indexing failed.'],
          },
        }));
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save: saved,
          indexGraph: async () => {
            throw new Error('database failure');
          },
          recordGraphFailure,
        });
        expect(saved).toHaveBeenCalledOnce();
        expect(recordGraphFailure).toHaveBeenCalledOnce();
        expect(audit.id).toBe('audit-id');
        expect(audit.inventory.limitations).toContain('Graph indexing failed.');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('keeps known parse counts but downgrades coverage when coverage persistence fails', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-coverage-error-'));
      try {
        await writeFile(join(root, 'main.ts'), 'export function ok() {}');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const save = vi.fn(async (record: AuditInput) => ({ ...record, id: 'audit-id' }));
        const recordGraphFailure = vi.fn(
          async (
            record: AuditRecord,
            coverage?: { omittedFiles: number; filesParsed: number }
          ) => ({
            ...record,
            inventory: {
              ...record.inventory,
              filesParsed: coverage?.filesParsed ?? 0,
              graphCoverage: {
                status: 'partial' as const,
                omittedFiles: coverage?.omittedFiles ?? record.inventory.filesDiscovered,
              },
            },
          })
        );
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save,
          indexGraph: async () => ({ parserFailures: [], omittedFiles: 0, filesParsed: 1 }),
          recordGraphCoverage: async () => {
            throw new Error('coverage write failed');
          },
          recordGraphFailure,
        });
        expect(audit.inventory).toMatchObject({
          filesParsed: 1,
          graphCoverage: { status: 'partial', omittedFiles: 0 },
        });
        expect(recordGraphFailure).toHaveBeenCalledWith(expect.anything(), {
          omittedFiles: 0,
          filesParsed: 1,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('does not present a fingerprint when input exceeds the budget', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-audit-service-'));
      try {
        await writeFile(join(root, 'a'), 'too large');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const save = vi.fn(async (record: AuditInput) => ({ ...record, id: 'audit-id' }));
        const result = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save,
          maxBytes: 2,
        });
        expect(result.fingerprint).toBeNull();
        expect(result.inventory.limitations.join(' ')).toContain('byte limit');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('indexes a small file even when another file exceeds the fingerprint budget', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-budget-'));
      try {
        await writeFile(join(root, 'large.ts'), 'x'.repeat(100));
        await writeFile(join(root, 'small.ts'), 'ok');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const indexGraph = vi.fn();
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: getNative(),
          save: async (record: AuditInput) => ({ ...record, id: 'audit-id' }),
          maxBytes: 10,
          indexGraph,
        });
        expect(indexGraph.mock.calls[0]?.[1]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'large.ts',
              fingerprint: null,
              content: null,
              omissionReason: 'fingerprint_limit',
            }),
            expect.objectContaining({ path: 'small.ts', content: 'ok' }),
          ])
        );
        expect(audit.fingerprint).toBeNull();
        expect(audit.inventory.graphCoverage).toEqual({ status: 'partial', omittedFiles: 1 });
        expect(audit.inventory.limitations.join(' ')).toContain('evidence may be missing');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('continues indexing every processable sibling after multiple parser-oversized files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-large-priority-'));
      try {
        const largePaths = Array.from(
          { length: 17 },
          (_, index) => `large-${String(index).padStart(2, '0')}.ts`
        );
        const smallPaths = Array.from(
          { length: 3 },
          (_, index) => `small-${String(index).padStart(2, '0')}.ts`
        );
        for (const path of largePaths)
          await writeFile(join(root, path), 'x'.repeat(MAX_PARSER_SOURCE_BYTES + 1));
        for (const [index, path] of smallPaths.entries()) {
          await writeFile(join(root, path), `export const small${index} = ${index};`);
        }
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const native = getNative();
        const largeFirstNative: NativeProjectFs = {
          openRoot: (path) => native.openRoot(path),
          openDirectory: (parent, name) => native.openDirectory(parent, name),
          openFile: (parent, name) => native.openFile(parent, name),
          classify: (parent, name) => native.classify(parent, name),
          list: (parent, limit) => {
            const listing = native.list(parent, limit);
            listing.names.sort((left, right) => {
              const leftLarge = left.toString().startsWith('large');
              const rightLarge = right.toString().startsWith('large');
              return leftLarge === rightLarge ? 0 : leftLarge ? -1 : 1;
            });
            return listing;
          },
        };
        const indexGraph = vi.fn(
          async (_audit: AuditRecord, _files: readonly ParsedAuditFile[]) => ({
            parserFailures: [] as readonly { path: string }[],
          })
        );
        const recordGraphCoverage = vi.fn(
          async (
            record: AuditRecord,
            coverage: {
              status: 'complete' | 'partial';
              omittedFiles: number;
              filesParsed: number;
            }
          ) => ({
            ...record,
            inventory: {
              ...record.inventory,
              filesParsed: coverage.filesParsed,
              graphCoverage: {
                status: coverage.status,
                omittedFiles: coverage.omittedFiles,
              },
            },
          })
        );
        const audit = await runLocalAudit('loc-1', {
          consume: async () => ({
            locationId: 'loc-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: largeFirstNative,
          save: async (record: AuditInput) => ({ ...record, id: 'audit-id' }),
          indexGraph,
          recordGraphCoverage,
        });
        const indexed = indexGraph.mock.calls[0]?.[1];
        expect(indexed).toEqual(
          expect.arrayContaining(
            smallPaths.map((path, index) =>
              expect.objectContaining({
                path,
                content: `export const small${index} = ${index};`,
              })
            )
          )
        );
        const largeItems = indexed?.filter((file) => largePaths.includes(file.path)) ?? [];
        expect(largeItems).toHaveLength(17);
        expect(largeItems.filter((file) => file.omissionReason === 'large_file')).toHaveLength(16);
        expect(
          largeItems.filter((file) => file.omissionReason === 'fingerprint_limit')
        ).toHaveLength(1);
        expect(
          largeItems.every(
            (file) =>
              file.content === null &&
              (file.omissionReason === 'large_file' || file.omissionReason === 'fingerprint_limit')
          )
        ).toBe(true);
        expect(audit.fingerprint).toBeNull();
        expect(audit.inventory.graphCoverage).toEqual({ status: 'partial', omittedFiles: 17 });
        expect(audit.inventory.filesParsed).toBe(3);
        expect(audit.inventory.limitations.join(' ')).toContain('evidence may be missing');
        expect(audit.inventory.limitations.join(' ')).toContain(
          'Large-file fingerprint allowance reached'
        );
        expect(recordGraphCoverage).toHaveBeenCalledWith(expect.anything(), {
          status: 'partial',
          omittedFiles: 17,
          filesParsed: 3,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'records a stable Git revision alongside the audit',
  async () => {
    const { execFileSync } = await import('node:child_process');
    const root = await mkdtemp(join(tmpdir(), 'tracemind-audit-git-'));
    try {
      const git = (...args: string[]): string =>
        execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        }).trim();
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'Test');
      await writeFile(join(root, 'main.ts'), 'export const a = 1');
      git('add', 'main.ts');
      git('commit', '-qm', 'fixture');
      await writeFile(join(root, 'main.ts'), 'export const a = 2');
      const canonical = await realpath(root);
      const info = await stat(canonical, { bigint: true });
      const save = vi.fn(async (record: AuditInput) => ({ ...record, id: 'audit-id' }));
      const audit = await runLocalAudit('loc-1', {
        consume: async () => ({
          locationId: 'loc-1',
          root: canonical,
          identity: `${info.dev}:${info.ino}`,
        }),
        native: getNative(),
        save,
      });
      expect(audit.revision).toBe(git('rev-parse', 'HEAD'));
      expect(audit.dirty).toBe(true);
      expect(audit.inventory.limitations.join(' ')).toContain(
        'Git dirty status excludes submodule worktree changes.'
      );
      expect(audit.inventory.limitations.join(' ')).not.toContain('path-based subprocess');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
