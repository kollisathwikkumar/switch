import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { locations } from '@main/db/schema';
import { MAX_PARSER_SOURCE_BYTES } from '../graph/parser-adapters';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, showMessageBox: vi.fn() }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/app/window', () => ({ getMainWindow: () => ({}) }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
const { tracemindController } = await import('../controller');
const graphStore = await import('../graph/graph-store');

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'TraceMind controller-to-SQLite audit flow',
  () => {
    let fixture: Awaited<ReturnType<typeof openFixture>>;
    let dir: string;
    beforeEach(async () => {
      fixture = await openFixture('empty');
      mocks.db = fixture.db;
      dir = await mkdtemp(join(tmpdir(), 'tracemind-controller-flow-'));
      await fixture.db
        .insert(locations)
        .values({ id: 'local-1', name: 'Fixture', dir, sshHost: '' });
      mocks.showMessageBox.mockReset();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      fixture.close();
      mocks.db = undefined;
      await rm(dir, { recursive: true, force: true });
    });
    it('requires native consent to discover checks without executing scripts and rejects stale audits', async () => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'touch should-not-exist' } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
      expect(await tracemindController.discoverAuditChecks('local-1', audit.id)).toBeNull();
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      expect(checks?.candidates).toEqual([
        expect.objectContaining({ executable: 'npm', args: ['run', 'test'] }),
      ]);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      expect(saved).toMatchObject({
        state: 'proposed',
        verified: false,
        proposal: { declaredScripts: { test: 'touch should-not-exist' } },
      });
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toEqual(saved);
      expect(
        (await tracemindController.listCheckProposals('local-1', audit.id, null)).items
      ).toEqual([expect.objectContaining({ id: saved.id, state: 'proposed', verified: false })]);
      await expect(
        tracemindController.cancelCheckProposal(
          'local-1',
          '00000000-0000-4000-8000-000000000099',
          saved.id,
          saved.version
        )
      ).rejects.toThrow('Audit proposal not found');
      expect(
        await tracemindController.cancelCheckProposal('local-1', audit.id, saved.id, saved.version)
      ).toMatchObject({ state: 'cancelled', verified: false });
      await expect(
        tracemindController.cancelCheckProposal('local-1', audit.id, saved.id, saved.version)
      ).rejects.toThrow();
      await expect(
        tracemindController.saveDiscoveredCheck('local-1', audit.id, checks.discoveryId, 0)
      ).rejects.toThrow();
      await expect(
        import('node:fs/promises').then(({ stat }) => stat(join(dir, 'should-not-exist')))
      ).rejects.toThrow();
      expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ title: 'Allow check discovery?' })
      );
      await writeFile(join(dir, 'package.json'), '{"scripts":{"test":"echo changed"}}');
      await expect(tracemindController.discoverAuditChecks('local-1', audit.id)).rejects.toThrow(
        'changed'
      );
    });
    it('uses a native check preview and persists denial without executing the proposal', async () => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'touch should-not-exist' } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 1 });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'denied'
      );
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
        state: 'denied',
        verified: false,
      });
      expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          title: 'Review proposed check',
          detail: expect.stringContaining('Effective sandbox mode:'),
        })
      );
      await expect(
        import('node:fs/promises').then(({ stat }) => stat(join(dir, 'should-not-exist')))
      ).rejects.toThrow();
    });
    it('does not create a check approval when the platform cannot start descriptor-bound execution', async () => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo must-not-run' } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 2 });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'approved'
      );
      mocks.showMessageBox.mockClear();
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      if (!originalPlatform?.configurable) throw new Error('Platform cannot be simulated here');
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
      try {
        expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
          'unavailable'
        );
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
        expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
          state: 'proposed',
          verified: false,
        });
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      await expect(
        tracemindController.runApprovedCheck('local-1', audit.id, saved.id)
      ).rejects.toThrow('approval');
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
        state: 'proposed',
        verified: false,
      });
    });
    it('records an explicit denial even if the project changes while the review is open', async () => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo test' } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockImplementationOnce(async () => {
          await writeFile(
            join(dir, 'package.json'),
            JSON.stringify({ scripts: { test: 'echo changed' } })
          );
          return { response: 1 };
        });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'denied'
      );
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
        state: 'denied',
        verified: false,
        version: saved.version + 1,
      });
    });
    it('does not overwrite a proposal cancelled while its denial dialog is open', async () => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo test' } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockImplementationOnce(async () => {
          await tracemindController.cancelCheckProposal(
            'local-1',
            audit.id,
            saved.id,
            saved.version
          );
          return { response: 1 };
        });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'not-approved'
      );
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
        state: 'cancelled',
        verified: false,
        version: saved.version + 1,
      });
    });
    it('distinguishes preview dismissal and approval, and refuses a changed snapshot', async () => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo test' } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 0 });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'not-approved'
      );
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
        state: 'proposed',
      });
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 2 });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'approved'
      );
      expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
        state: 'proposed',
        verified: false,
      });
      await writeFile(join(dir, 'package.json'), '{"scripts":{"test":"echo changed"}}');
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
      const calls = mocks.showMessageBox.mock.calls.length;
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'not-approved'
      );
      expect(mocks.showMessageBox.mock.calls.length).toBe(calls + 1);
      expect(
        await tracemindController.cancelCheckProposal('local-1', audit.id, saved.id, 1)
      ).toMatchObject({ state: 'cancelled', verified: false });
    });
    it('runs an approved local npm check and persists its actual unverified result', async () => {
      const resultMarker = join(dir, 'controller-check-ran');
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: `printf controller-check; touch "${resultMarker}"` } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      await expect(
        tracemindController.runApprovedCheck('local-1', audit.id, saved.id)
      ).rejects.toThrow('approval');
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 2 });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'approved'
      );
      if (process.platform !== 'linux') {
        await expect(
          tracemindController.runApprovedCheck('local-1', audit.id, saved.id)
        ).resolves.toMatchObject({ state: 'refused', verified: false });
        expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
          state: 'refused',
          verified: false,
        });
        expect(
          await tracemindController.getCheckResultPreview('local-1', audit.id, saved.id)
        ).toMatchObject({
          status: 'resource_limit_refused',
          resourceLimitRefusal: {
            platform: process.platform,
            reason: expect.stringContaining('no verified OS memory controller'),
          },
          exitCode: null,
          execution: { spawned: false, targetHandoff: 'not_started' },
        });
        await expect(
          import('node:fs/promises').then(({ stat }) => stat(resultMarker))
        ).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      expect(
        await tracemindController.runApprovedCheck('local-1', audit.id, saved.id)
      ).toMatchObject({
        state: 'finished',
        verified: false,
      });
      expect(
        await tracemindController.getCheckResultPreview('local-1', audit.id, saved.id)
      ).toMatchObject({
        status: 'exited',
        exitCode: 0,
        stdout: expect.stringContaining('controller-check'),
        terminationUnconfirmed: true,
      });
      expect(
        await tracemindController.getCheckOutputArtifact('local-1', audit.id, saved.id, 'stdout')
      ).toMatchObject({
        reference: { projectId: 'local-1', auditId: audit.id, runId: saved.id, stream: 'stdout' },
        representation: 'stored-utf8-preview',
        text: expect.stringContaining('controller-check'),
      });
      expect(
        await tracemindController.getCheckOutputArtifact(
          'local-1',
          '00000000-0000-4000-8000-000000000099',
          saved.id,
          'stdout'
        )
      ).toBeNull();
    });
    it('cancels an approved running check and records the cancelled outcome', async () => {
      const resultMarker = join(dir, 'cancel-check-ran');
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: `touch "${resultMarker}" && sleep 10` } })
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const checks = await tracemindController.discoverAuditChecks('local-1', audit.id);
      if (!checks) throw new Error('Discovery missing');
      const saved = await tracemindController.saveDiscoveredCheck(
        'local-1',
        audit.id,
        checks.discoveryId,
        0
      );
      mocks.showMessageBox
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 2 });
      expect(await tracemindController.requestCheckApproval('local-1', audit.id, saved.id)).toBe(
        'approved'
      );
      const pending = tracemindController.runApprovedCheck('local-1', audit.id, saved.id);
      if (process.platform !== 'linux') {
        await expect(pending).resolves.toMatchObject({ state: 'refused', verified: false });
        expect(await tracemindController.getCheckProposal('local-1', saved.id)).toMatchObject({
          state: 'refused',
          verified: false,
        });
        expect(
          await tracemindController.getCheckResultPreview('local-1', audit.id, saved.id)
        ).toMatchObject({
          status: 'resource_limit_refused',
          resourceLimitRefusal: {
            platform: process.platform,
            reason: expect.stringContaining('no verified OS process-count controller'),
          },
          exitCode: null,
          execution: { spawned: false, targetHandoff: 'not_started' },
        });
        await expect(
          import('node:fs/promises').then(({ stat }) => stat(resultMarker))
        ).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      await vi.waitFor(
        async () =>
          expect((await tracemindController.getCheckProposal('local-1', saved.id))?.state).toBe(
            'running'
          ),
        { timeout: 10_000 }
      );
      expect(
        await tracemindController.cancelRunningCheck(
          'local-1',
          '00000000-0000-4000-8000-000000000099',
          saved.id
        )
      ).toBe(false);
      expect(await tracemindController.cancelRunningCheck('local-1', audit.id, saved.id)).toBe(
        true
      );
      expect(await pending).toMatchObject({ state: 'finished', verified: false });
      expect(
        await tracemindController.getCheckResultPreview('local-1', audit.id, saved.id)
      ).toMatchObject({ status: 'cancelled', capturedComplete: false });
    });
    it('indexes processable files and records large-file coverage without claiming a complete graph', async () => {
      await writeFile(join(dir, 'small.ts'), 'export function example() { return 1; }');
      await writeFile(join(dir, 'large.ts'), ' '.repeat(MAX_PARSER_SOURCE_BYTES + 1));
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const graph = await graphStore.getGraphSnapshot('local-1', `audit:${audit.id}`);
      expect(
        graph?.nodes.some((node) => node.kind === 'symbol' && node.label.includes('example'))
      ).toBe(true);
      expect(graph?.nodes.some((node) => node.kind === 'file' && node.label === 'large.ts')).toBe(
        true
      );
      expect(graph?.parserFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'large.ts', language: 'large-file' }),
        ])
      );
      expect(audit.inventory.graphCoverage).toMatchObject({ status: 'partial', omittedFiles: 1 });
      expect(audit.inventory.filesParsed).toBe(1);
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain(
        'Parser coverage: 1 file parsed; graph coverage is partial.'
      );
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain(
        'Graph coverage: partial'
      );
    });
    it('keeps indexing later siblings after large files exhaust their fingerprint allowance', async () => {
      const largePaths = Array.from(
        { length: 17 },
        (_, index) => `${String(index).padStart(2, '0')}-large.ts`
      );
      const smallPaths = Array.from({ length: 3 }, (_, index) => `small-${index}.ts`);
      for (const path of largePaths)
        await writeFile(join(dir, path), 'x'.repeat(MAX_PARSER_SOURCE_BYTES + 1));
      for (const [index, path] of smallPaths.entries()) {
        await writeFile(join(dir, path), `export function sibling${index}() { return ${index}; }`);
      }

      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const graph = await graphStore.getGraphSnapshot('local-1', `audit:${audit.id}`);
      if (!graph) throw new Error('Graph snapshot was not persisted');

      expect(audit.fingerprint).toBeNull();
      expect(audit.inventory).toMatchObject({
        filesDiscovered: 20,
        filesParsed: 3,
        graphCoverage: { status: 'partial', omittedFiles: 17 },
      });
      for (const path of [...largePaths, ...smallPaths]) {
        expect(graph.nodes.some((node) => node.kind === 'file' && node.label === path)).toBe(true);
      }
      for (const [index, path] of smallPaths.entries()) {
        expect(
          graph.nodes.some(
            (node) =>
              node.kind === 'symbol' &&
              node.label === `${path}:sibling${index}` &&
              node.source?.path === path
          )
        ).toBe(true);
      }
      expect(new Set(graph.parserFailures.map((failure) => failure.path))).toEqual(
        new Set(largePaths)
      );
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain(
        'at least 17 eligible files lack parser-derived graph evidence'
      );
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain(
        'missing evidence is possible'
      );
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain(
        'this graph must not be treated as up to date'
      );
    });
    it('persists a partial graph and warning when one real parser fails', async () => {
      await writeFile(join(dir, 'small.ts'), 'export function example() { return 1; }');
      await writeFile(
        join(dir, 'problem.ts'),
        `const x = ${'('.repeat(10000)}1${')'.repeat(10000)}`
      );
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      const graph = await graphStore.getGraphSnapshot('local-1', `audit:${audit.id}`);
      expect(
        graph?.nodes.some((node) => node.kind === 'symbol' && node.label.includes('example'))
      ).toBe(true);
      expect(graph?.parserFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'problem.ts',
            message: expect.stringContaining('failed unexpectedly'),
          }),
        ])
      );
      expect(audit.inventory.graphCoverage).toEqual({ status: 'partial', omittedFiles: 1 });
      expect((await tracemindController.listAudits('local-1'))[0]?.inventory.graphCoverage).toEqual(
        { status: 'partial', omittedFiles: 1 }
      );
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain(
        'missing evidence is possible'
      );
    });
    it('approves, scans, fingerprints, stores and retrieves real repository results and issue edits', async () => {
      const git = (...args: string[]): string =>
        execFileSync('git', args, {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        }).trim();
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      await writeFile(join(dir, 'main.ts'), 'export const answer = 42;');
      await writeFile(join(dir, '.env'), 'secret');
      git('add', 'main.ts');
      git('commit', '-qm', 'fixture');
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const audit = await tracemindController.runAudit('local-1');
      expect(audit.identity).toMatch(/^\d+:\d+$/);
      expect(audit.revision).toBe(git('rev-parse', 'HEAD'));
      expect(audit.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const evidence = await tracemindController.listAuditEvidence('local-1', audit.id, 0);
      expect(await tracemindController.getAuditReport('local-1', audit.id)).toContain('main.ts');
      expect(evidence.items).toEqual([
        { path: 'main.ts', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ]);
      expect(evidence.nextOffset).toBeNull();
      const graphs = await graphStore.listGraphSnapshots('local-1');
      expect(
        await tracemindController.getGraphOverview('local-1', `audit:${audit.id}`, null)
      ).toMatchObject({ nodeCount: expect.any(Number) });
      expect(graphs).toHaveLength(1);
      expect(graphs[0]).toMatchObject({
        projectId: 'local-1',
        revision: `audit:${audit.id}`,
        nodes: expect.arrayContaining([
          expect.objectContaining({ kind: 'repository_revision' }),
          expect.objectContaining({ kind: 'file', label: 'main.ts' }),
          expect.objectContaining({
            kind: 'evidence',
            source: expect.objectContaining({ path: 'main.ts' }),
          }),
        ]),
      });
      expect(audit.inventory).toMatchObject({
        filesDiscovered: 1,
        filesParsed: 1,
        skipped: 2,
        inventoryComplete: true,
      });
      expect(audit.inventory.skippedEntries).toEqual(
        expect.arrayContaining([
          { path: '.git', reason: 'excluded' },
          { path: '.env', reason: 'excluded' },
        ])
      );
      expect(
        (await tracemindController.listAudits('local-1'))[0]?.inventory.skippedEntries
      ).toEqual(audit.inventory.skippedEntries);
      expect(await tracemindController.listAudits('local-1')).toEqual([audit]);
      await writeFile(join(dir, 'main.ts'), 'export const answer = 43;');
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const changedAudit = await tracemindController.runAudit('local-1');
      expect(changedAudit.revision).toBe(audit.revision);
      expect(changedAudit.fingerprint).not.toBe(audit.fingerprint);
      expect(await tracemindController.listAudits('local-1')).toEqual([changedAudit, audit]);
      const updatedGraphs = await graphStore.listGraphSnapshots('local-1');
      expect(updatedGraphs).toHaveLength(2);
      expect(
        updatedGraphs
          .find((graph) => graph.revision === `audit:${audit.id}`)
          ?.nodes.some((node) => node.source?.path === 'main.ts' && node.stale)
      ).toBe(true);
      expect(
        updatedGraphs
          .find((graph) => graph.revision === `audit:${audit.id}`)
          ?.relationships.some((relationship) => relationship.stale)
      ).toBe(true);
      expect(
        await tracemindController.compareAuditEvidence('local-1', audit.id, changedAudit.id)
      ).toEqual({
        status: 'compared',
        counts: { changed: 1, removed: 0, added: 0 },
        items: [{ path: 'main.ts', change: 'changed' }],
        truncated: false,
      });
      const issue = await tracemindController.createIssue('local-1', {
        title: 'Bug',
        description: 'Observed failure',
        auditId: audit.id,
      });
      expect(issue.auditId).toBe(audit.id);
      const edited = await tracemindController.updateIssue('local-1', issue.id, issue.version, {
        title: 'Bug edited',
        description: 'Reproduced',
      });
      expect(edited.auditId).toBe(audit.id);
      expect(await tracemindController.listIssues('local-1')).toEqual([edited]);
      await expect(tracemindController.runAudit('local-1')).rejects.toThrow('approval');
    });
    it('reports a failed graph write and marks changed historical evidence stale', async () => {
      await writeFile(join(dir, 'main.ts'), 'export function original() {}');
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const first = await tracemindController.runAudit('local-1');
      await writeFile(join(dir, 'main.ts'), 'export function changed() {}');
      vi.spyOn(graphStore, 'saveGraphSnapshotAndMarkStale').mockRejectedValueOnce(
        new Error('replacement write failed')
      );
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const second = await tracemindController.runAudit('local-1');
      expect(second.inventory).toMatchObject({
        filesParsed: 0,
        graphCoverage: { status: 'partial', omittedFiles: 1 },
      });
      expect(second.inventory.limitations).toContain(
        'Historical graph freshness may be incomplete after indexing failure.'
      );
      expect(await tracemindController.getAuditReport('local-1', second.id)).toContain(
        'Historical graph freshness may be incomplete'
      );
      expect(await tracemindController.getAuditReport('local-1', second.id)).toContain(
        'at least 1 eligible file lacks parser-derived graph evidence'
      );
      const oldGraph = await graphStore.getGraphSnapshot('local-1', `audit:${first.id}`);
      expect(
        oldGraph?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'main.ts')
          ?.stale
      ).toBe(true);
      expect(
        await tracemindController.getGraphOverview('local-1', `audit:${second.id}`, null)
      ).toBeNull();
    });

    it('surfaces uncertain freshness when historical invalidation also fails', async () => {
      await writeFile(join(dir, 'main.ts'), 'export function original() {}');
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const first = await tracemindController.runAudit('local-1');
      await writeFile(join(dir, 'main.ts'), 'export function changed() {}');
      vi.spyOn(graphStore, 'saveGraphSnapshotAndMarkStale').mockRejectedValueOnce(
        new Error('write')
      );
      vi.spyOn(graphStore, 'markGraphStale').mockRejectedValueOnce(new Error('stale write'));
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const second = await tracemindController.runAudit('local-1');
      expect(second.inventory.limitations).toContain(
        'Historical graph freshness may be incomplete after indexing failure.'
      );
      expect(await tracemindController.getAuditReport('local-1', second.id)).toContain(
        'Historical graph freshness may be incomplete'
      );
      const oldGraph = await graphStore.getGraphSnapshot('local-1', `audit:${first.id}`);
      expect(
        oldGraph?.nodes.find((node) => node.kind === 'evidence' && node.source?.path === 'main.ts')
          ?.stale
      ).toBe(false);
    });

    it('does not persist an audit when approval is denied', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(false);
      await expect(tracemindController.runAudit('local-1')).rejects.toThrow('approval');
      expect(await tracemindController.listAudits('local-1')).toEqual([]);
    });
    it('rejects the project when its root is replaced after approval', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const original = `${dir}-original`;
      await rename(dir, original);
      try {
        await import('node:fs/promises').then(({ mkdir }) => mkdir(dir));
        await expect(tracemindController.runAudit('local-1')).rejects.toThrow('approval');
        expect(await tracemindController.listAudits('local-1')).toEqual([]);
      } finally {
        await rm(original, { recursive: true, force: true });
      }
    });
    it('does not compare two audits across a replaced project root', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      await writeFile(join(dir, 'main.ts'), 'before');
      expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
      const before = await tracemindController.runAudit('local-1');
      const original = `${dir}-original`;
      await rename(dir, original);
      try {
        await import('node:fs/promises').then(({ mkdir }) => mkdir(dir));
        await writeFile(join(dir, 'main.ts'), 'after');
        expect(await tracemindController.requestAuditApproval('local-1')).toBe(true);
        const after = await tracemindController.runAudit('local-1');
        expect(after.root).toBe(before.root);
        expect(after.identity).not.toBe(before.identity);
        expect(
          await tracemindController.compareAuditEvidence('local-1', before.id, after.id)
        ).toEqual({ status: 'unavailable' });
      } finally {
        await rm(original, { recursive: true, force: true });
      }
    });
  }
);
