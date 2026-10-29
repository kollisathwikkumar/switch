import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { AuditRecord } from '../audit/audit-store';
import { isExcludedPathEntry } from '../audit/exclusions';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { indexAuditGraph } = await import('./graph-service');
const { benchmarkGraphAdapter } = await import('./benchmark');
const graphStore = await import('./graph-store');

describe('representative TraceMind source workload benchmark', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
    vi.restoreAllMocks();
  });

  it('indexes the full desktop TypeScript source tree through normalized SQLite', async () => {
    const appRoot = process.cwd();
    const roots = [join(appRoot, 'src')];
    const paths: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) await walk(fullPath);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) paths.push(fullPath);
      }
    }
    for (const root of roots) await walk(root);
    paths.sort();
    const files = await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(path, 'utf8');
        return {
          path: relative(appRoot, path).split('\\').join('/'),
          content,
          fingerprint: createHash('sha256').update(content).digest('hex'),
        };
      })
    );
    const sourceBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    const auditId = randomUUID();
    const audit: AuditRecord = {
      id: auditId,
      locationId: 'local-1',
      root: appRoot,
      identity: '1:1',
      revision: null,
      dirty: null,
      fingerprint: createHash('sha256')
        .update(files.map((file) => file.fingerprint).join(''))
        .digest('hex'),
      capturedAt: Date.now(),
      inventory: {
        filesDiscovered: files.length,
        filesParsed: files.length,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [{ language: 'typescript', files: files.length }],
        manifests: [],
        limitations: [],
      },
    };

    const indexStarted = performance.now();
    const indexed = await indexAuditGraph(audit, files);
    const indexMs = performance.now() - indexStarted;
    const benchmark = await benchmarkGraphAdapter('local-1', `audit:${auditId}`);
    const graphPayloadBytes = [
      ...indexed.snapshot.nodes,
      ...indexed.snapshot.relationships,
      ...indexed.snapshot.retrievalReasons,
      ...indexed.snapshot.parserFailures,
    ].reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
    expect(graphPayloadBytes).toBeLessThan(128 * 1024 * 1024);
    expect(files.length).toBeGreaterThan(1_000);
    expect(indexed.snapshot.nodes.length).toBeGreaterThan(files.length);
    expect(indexed.snapshot.relationships.length).toBeGreaterThan(files.length);
    expect(indexed.parserFailures.length).toBeLessThan(files.length);
    expect(benchmark.truncated).toBe(benchmark.stopReason !== null);
    console.info(
      `TraceMind representative source benchmark: ${JSON.stringify({
        sourceRoots: roots.map((root) => relative(appRoot, root)),
        files: files.length,
        sourceBytes,
        graphPayloadBytes,
        parserFailures: indexed.parserFailures.length,
        nodes: benchmark.nodes,
        relationships: benchmark.relationships,
        indexMs,
        readMs: benchmark.readMs,
        traversalMs: benchmark.traversalMs,
        traversalNodes: benchmark.traversalNodes,
        traversalRelationships: benchmark.traversalRelationships,
        truncated: benchmark.truncated,
        stopReason: benchmark.stopReason,
      })}`
    );
  }, 60_000);

  it.skipIf(process.env.TRACEMIND_FULL_REPOSITORY_BENCHMARK !== '1')(
    'benchmarks supported source across the full Switch repository using existing SQLite persistence',
    async () => {
      const appRoot = process.cwd();
      const repositoryRoot = join(appRoot, '../../..');
      const supportedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
      const paths: string[] = [];
      async function walk(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const fullPath = join(directory, entry.name);
          const path = relative(repositoryRoot, fullPath).split('\\').join('/');
          if (
            entry.isSymbolicLink() ||
            isExcludedPathEntry(entry.name, entry.isDirectory(), path)
          ) {
            continue;
          }
          if (entry.isDirectory()) await walk(fullPath);
          else if (entry.isFile() && supportedExtensions.has(extname(entry.name)))
            paths.push(fullPath);
        }
      }
      await walk(repositoryRoot);
      paths.sort();
      const files = await Promise.all(
        paths.map(async (path) => {
          const content = await readFile(path, 'utf8');
          return {
            path: relative(repositoryRoot, path).split('\\').join('/'),
            content,
            fingerprint: createHash('sha256').update(content).digest('hex'),
          };
        })
      );
      const sourceBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
      console.info(
        `TraceMind full repository source corpus: ${JSON.stringify({ files: files.length, sourceBytes })}`
      );
      const auditId = randomUUID();
      const audit: AuditRecord = {
        id: auditId,
        locationId: 'local-switch-root',
        root: repositoryRoot,
        identity: '1:1',
        revision: null,
        dirty: null,
        fingerprint: createHash('sha256')
          .update(files.map((file) => file.fingerprint).join(''))
          .digest('hex'),
        capturedAt: Date.now(),
        inventory: {
          filesDiscovered: files.length,
          filesParsed: files.length,
          skipped: 0,
          inventoryComplete: true,
          errors: [],
          languages: [
            {
              language: 'typescript',
              files: files.filter((file) => /\.tsx?$/.test(file.path)).length,
            },
            {
              language: 'javascript',
              files: files.filter((file) => /\.(?:js|jsx|mjs|cjs)$/.test(file.path)).length,
            },
            { language: 'python', files: files.filter((file) => file.path.endsWith('.py')).length },
          ].filter((language) => language.files > 0),
          manifests: [],
          limitations: [],
        },
      };

      const persistSnapshot = graphStore.saveGraphSnapshotAndMarkStale;
      const persistSpy = vi
        .spyOn(graphStore, 'saveGraphSnapshotAndMarkStale')
        .mockImplementation(async (snapshot, changedPaths, capturedAt) => {
          const graphPayloadBytes = [
            ...snapshot.nodes,
            ...snapshot.relationships,
            ...snapshot.retrievalReasons,
            ...snapshot.parserFailures,
          ].reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
          console.info(
            `TraceMind full repository graph before persistence: ${JSON.stringify({
              nodes: snapshot.nodes.length,
              relationships: snapshot.relationships.length,
              graphPayloadBytes,
            })}`
          );
          return persistSnapshot(snapshot, changedPaths, capturedAt);
        });
      const indexStarted = performance.now();
      let indexed: Awaited<ReturnType<typeof indexAuditGraph>> | null = await indexAuditGraph(
        audit,
        files
      );
      const indexMs = performance.now() - indexStarted;
      const benchmark = await benchmarkGraphAdapter(audit.locationId, `audit:${auditId}`);
      const graphPayloadBytes = [
        ...indexed.snapshot.nodes,
        ...indexed.snapshot.relationships,
        ...indexed.snapshot.retrievalReasons,
        ...indexed.snapshot.parserFailures,
      ].reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
      expect(files.length).toBeGreaterThan(3_000);
      expect(sourceBytes).toBeGreaterThan(25 * 1024 * 1024);
      expect(graphPayloadBytes).toBeLessThan(256 * 1024 * 1024);
      expect(benchmark.truncated).toBe(benchmark.stopReason !== null);
      console.info(
        `TraceMind full repository benchmark: ${JSON.stringify({
          sourceRoots: ['.'],
          files: files.length,
          sourceBytes,
          graphPayloadBytes,
          parserFailures: indexed.parserFailures.length,
          nodes: benchmark.nodes,
          relationships: benchmark.relationships,
          indexMs,
          readMs: benchmark.readMs,
          traversalMs: benchmark.traversalMs,
          traversalNodes: benchmark.traversalNodes,
          traversalRelationships: benchmark.traversalRelationships,
          truncated: benchmark.truncated,
          stopReason: benchmark.stopReason,
        })}`
      );

      const overviewStarted = performance.now();
      const overview = await graphStore.getGraphOverview(
        audit.locationId,
        `audit:${auditId}`,
        null
      );
      const overviewMs = performance.now() - overviewStarted;
      expect(overview?.nodes).toHaveLength(50);
      expect(overview?.nextCursor).toBeTruthy();
      const overviewBytes = Buffer.byteLength(JSON.stringify(overview), 'utf8');
      expect(overviewBytes).toBeLessThan(1024 * 1024);
      const appendStarted = performance.now();
      await graphStore.appendGraphRecordBounded(audit.locationId, `audit:${auditId}`, {
        kind: 'observation',
        label: 'Benchmark observation',
        reason: 'Local benchmark fixture.',
      });
      const appendMs = performance.now() - appendStarted;
      const refreshedOverview = await graphStore.getGraphOverview(
        audit.locationId,
        `audit:${auditId}`,
        null
      );
      expect(refreshedOverview?.nodeCount).toBe(benchmark.nodes + 1);
      console.info(
        `TraceMind full repository bounded view: ${JSON.stringify({ overviewMs, overviewBytes, appendMs, nodesReturned: overview?.nodes.length })}`
      );

      const changedPath =
        'console/apps/switch-console-desktop/src/main/core/tracemind/graph/graph-service.ts';
      const changedFile = files.find((file) => file.path === changedPath);
      const oldEvidenceId = indexed.snapshot.nodes.find(
        (node) => node.kind === 'evidence' && node.source?.path === changedPath
      )?.id;
      expect(changedFile).toBeDefined();
      expect(oldEvidenceId).toBeDefined();
      if (!changedFile || !oldEvidenceId) throw new Error('Benchmark source evidence is missing');
      const changedContent = `${changedFile.content}\n// TraceMind benchmark change\n`;
      const revisedFiles = files.map((file) =>
        file.path === changedPath
          ? {
              ...file,
              content: changedContent,
              fingerprint: createHash('sha256').update(changedContent).digest('hex'),
            }
          : file
      );
      const nextAuditId = randomUUID();
      const nextAudit: AuditRecord = {
        ...audit,
        id: nextAuditId,
        capturedAt: Date.now(),
        fingerprint: createHash('sha256')
          .update(revisedFiles.map((file) => file.fingerprint).join(''))
          .digest('hex'),
      };
      persistSpy.mockClear();
      persistSpy.mockRestore();
      indexed = null;
      const reindexStarted = performance.now();
      const reindexed = await indexAuditGraph(nextAudit, revisedFiles);
      const reindexMs = performance.now() - reindexStarted;
      const oldEvidence = await graphStore.getGraphNode(
        audit.locationId,
        `audit:${auditId}`,
        oldEvidenceId
      );
      const newEvidence = reindexed.snapshot.nodes.find(
        (node) => node.kind === 'evidence' && node.source?.path === changedPath
      );
      expect(oldEvidence?.stale).toBe(true);
      expect(newEvidence?.stale).toBe(false);
      expect(reindexed.invalidated.nodes).toBeGreaterThan(0);
      expect(reindexed.invalidated.relationships).toBeGreaterThan(0);
      console.info(
        `TraceMind full repository incremental benchmark: ${JSON.stringify({
          changedPath,
          reindexMs,
          invalidated: reindexed.invalidated,
          oldEvidenceStale: oldEvidence?.stale,
          newEvidenceStale: newEvidence?.stale,
        })}`
      );
    },
    300_000
  );
});
