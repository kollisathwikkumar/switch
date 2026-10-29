import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { AuditInput } from '../audit/audit-store';
import type { NativeProjectFs } from '../native/access-registry';
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { runLocalAudit } = await import('../audit/audit-service');
const { saveAudit } = await import('../audit/audit-store');
const { discoverPackageChecks } = await import('./command-contract');
const { VerificationApprovalService } = await import('./approval-service');
const { verifyApprovalSnapshot } = await import('./snapshot-verifier');
const { openVerifiedWorkingDirectory } = await import('./pinned-working-directory');
const { ProcessAdapter } = await import('./process-adapter');
const store = await import('./run-store');
const { VerificationRunner } = await import('./runner');
const { fingerprintRuntime } = await import('./runtime-fingerprint');
const reservation = await import('./execution-reservation');
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'runner with SQLite and real process',
  () => {
    let fixture: Awaited<ReturnType<typeof openFixture>>;
    let root: string;
    beforeEach(async () => {
      fixture = await openFixture('empty');
      mocks.db = fixture.db;
      root = await mkdtemp(join(tmpdir(), 'tracemind-runner-'));
    });
    afterEach(async () => {
      fixture.close();
      mocks.db = undefined;
      await rm(root, { recursive: true, force: true });
    });
    it('runs actual npm lifecycle hooks in a temporary approved project and persists the outcome', async () => {
      const resultMarker = join(root, 'actual-npm-test-started');
      const native = createRequire(import.meta.url)(
        join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
      ) as NativeProjectFs;
      const manifest = JSON.stringify({
        scripts: {
          pretest: 'touch actual-npm-test-started && printf pre-hook',
          test: 'printf actual-npm-test',
          posttest: 'printf post-hook',
        },
      });
      await writeFile(join(root, 'package.json'), manifest);
      const canonical = await realpath(root);
      const info = await stat(canonical, { bigint: true });
      const audit = await runLocalAudit('project-1', {
        consume: async () => ({
          locationId: 'project-1',
          root: canonical,
          identity: `${info.dev}:${info.ino}`,
        }),
        native,
        save: (input: AuditInput, evidence) => saveAudit(input, evidence),
      });
      const proposal = discoverPackageChecks(manifest, '.', `audit:${audit.id}`)[0]!;
      const created = await store.createRunProposal('project-1', audit.id, proposal);
      const helper = join(root, '..', `tracemind-runner-helper-${created.id}`);
      const fakeNpm = join(root, '..', `npm-${created.id}`, 'npm');
      let runtimeFingerprint: string | undefined;
      const approvals = new VerificationApprovalService({
        load: store.getRunProposal,
        snapshot: async (_project, _audit, input) => {
          const snapshot = await verifyApprovalSnapshot(audit, input, native);
          return snapshot
            ? {
                ...snapshot,
                runtimeDirectory: dirname(process.execPath),
                npmExecutable: fakeNpm,
                helperExecutable: helper,
                ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
              }
            : null;
        },
        confirm: async () => 'approve',
        deny: async () => {},
        now: Date.now,
      });
      expect(await approvals.request('project-1', created.id)).toBe(true);
      execFileSync('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
        '-o',
        helper,
      ]);
      await import('node:fs/promises').then(({ mkdir }) =>
        mkdir(join(root, '..', `npm-${created.id}`))
      );
      const npm = execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim();
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const temporaryHome = join(root, '..', `npm-${created.id}`);
      await writeFile(
        fakeNpm,
        `#!/bin/sh\nexport HOME=${quote(temporaryHome)}\nexport npm_config_cache=${quote(join(temporaryHome, 'cache'))}\nexec ${quote(npm)} "$@"\n`
      );
      await chmod(fakeNpm, 0o700);
      try {
        const adapter = new ProcessAdapter();
        let saveMode: 'normal' | 'before' | 'after' = 'normal';
        const makeRunner = () =>
          new VerificationRunner({
            consume: (project, id) => approvals.consumeForExecution(project, id),
            open: (approval) =>
              openVerifiedWorkingDirectory(approval.snapshot, approval.run.proposal, native),
            release: closeSync,
            claim: store.claimRunExecution,
            acquireReservation: async () => true,
            releaseReservation: async () => true,
            cancelPending: (project, id, version) =>
              store.closeRunProposal(project, id, version, 'cancelled'),
            markUnknown: store.markRunOutcomeUnknown,
            refuse: store.recordResourceLimitRefusal,
            finish: async (...args) => {
              if (saveMode === 'before') throw new Error('result write failed');
              const result = await store.finishRunExecution(...args);
              if (saveMode === 'after') throw new Error('result write acknowledgement lost');
              return result;
            },
            npmExecutable: fakeNpm,
            helperExecutable: helper,
            execute: (input) => new ProcessAdapter().run(input),
          });
        const runner = makeRunner();
        if (process.platform !== 'linux') {
          const refused = await runner.run('project-1', created.id);
          expect(refused).toMatchObject({
            state: 'refused',
            verified: false,
            result: {
              status: 'resource_limit_refused',
              resourceLimitRefusal: {
                platform: process.platform,
                missingControls: ['memoryBytes', 'processCount'],
                reason: expect.stringContaining('no verified OS memory controller'),
              },
              exitCode: null,
              signal: null,
              terminationUnconfirmed: false,
              execution: { spawned: false, targetHandoff: 'not_started' },
            },
          });
          expect(await store.getRunProposal('project-1', created.id)).toEqual(refused);
          expect(await store.getRunResultPreview('project-1', audit.id, created.id)).toMatchObject({
            status: 'resource_limit_refused',
            resourceLimitRefusal: {
              platform: process.platform,
              missingControls: ['memoryBytes', 'processCount'],
              reason: expect.stringContaining('no verified OS process-count controller'),
            },
            exitCode: null,
          });
          await expect(readFile(resultMarker)).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        const result = await runner.run('project-1', created.id);
        if (result.result?.exitCode !== 0)
          throw new Error(`npm fixture failed: ${result.result?.stderr}`);
        expect(result).toMatchObject({
          state: 'finished',
          verified: false,
          result: {
            status: 'exited',
            exitCode: 0,
            stdout: expect.stringContaining('actual-npm-test'),
            execution: {
              executable: fakeNpm,
              args: ['run', 'test'],
              workingDirectoryBinding: 'descriptor',
              targetHandoff: 'exec_handoff',
            },
          },
        });
        expect(result.result?.stdout).toContain('pre-hook');
        expect(result.result?.stdout).toContain('post-hook');
        expect(await readFile(resultMarker, 'utf8')).toBe('');
        expect(result.result?.stdoutHash).toBe(
          createHash('sha256')
            .update(result.result?.stdout ?? '')
            .digest('hex')
        );
        expect(await store.getRunProposal('project-1', created.id)).toEqual(result);
        await expect(runner.run('project-1', created.id)).rejects.toThrow('unavailable');

        const second = await store.createRunProposal('project-1', audit.id, proposal);
        expect(await approvals.request('project-1', second.id)).toBe(true);
        saveMode = 'before';
        const secondRunner = makeRunner();
        await expect(secondRunner.run('project-1', second.id)).rejects.toThrow(
          'result write failed'
        );
        expect(await store.getRunProposal('project-1', second.id)).toMatchObject({
          state: 'outcome_unknown',
          verified: false,
        });
        expect((await store.getRunProposal('project-1', second.id))?.result).toBeUndefined();
        await expect(secondRunner.run('project-1', second.id)).rejects.toThrow('unavailable');

        const third = await store.createRunProposal('project-1', audit.id, proposal);
        expect(await approvals.request('project-1', third.id)).toBe(true);
        saveMode = 'after';
        const thirdRunner = makeRunner();
        await expect(thirdRunner.run('project-1', third.id)).rejects.toThrow(
          'Result persistence uncertain; run state requires reconciliation'
        );
        expect(await store.getRunProposal('project-1', third.id)).toMatchObject({
          state: 'finished',
          verified: false,
          result: { status: 'exited', exitCode: 0 },
        });
        await expect(thirdRunner.run('project-1', third.id)).rejects.toThrow('unavailable');

        const fourth = await store.createRunProposal('project-1', audit.id, proposal);
        expect(await approvals.request('project-1', fourth.id)).toBe(true);
        const validated = await approvals.consumeForExecution('project-1', fourth.id);
        expect(validated).not.toBeNull();
        expect(await reservation.acquireExecutionReservation('other-owner')).toBe(true);
        const competingClaim = vi.fn(store.claimRunExecution);
        const competingExecution = vi.fn((input) => adapter.run(input));
        const competitor = new VerificationRunner({
          consume: async () => validated,
          open: (approval) =>
            openVerifiedWorkingDirectory(approval.snapshot, approval.run.proposal, native),
          release: closeSync,
          claim: competingClaim,
          cancelPending: (project, id, version) =>
            store.closeRunProposal(project, id, version, 'cancelled'),
          acquireReservation: reservation.acquireExecutionReservation,
          releaseReservation: reservation.releaseExecutionReservation,
          markUnknown: store.markRunOutcomeUnknown,
          refuse: store.recordResourceLimitRefusal,
          finish: store.finishRunExecution,
          npmExecutable: fakeNpm,
          helperExecutable: helper,
          execute: competingExecution,
        });
        await expect(competitor.run('project-1', fourth.id)).rejects.toThrow('reservation');
        expect(competingClaim).not.toHaveBeenCalled();
        expect(competingExecution).not.toHaveBeenCalled();
        expect(await reservation.releaseExecutionReservation('other-owner')).toBe(true);

        let releaseValidation: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          releaseValidation = resolve;
        });
        const claim = vi.fn(store.claimRunExecution);
        const execute = vi.fn((input) => adapter.run(input));
        const cancellingRunner = new VerificationRunner({
          consume: async () => {
            await gate;
            return validated;
          },
          open: (approval) =>
            openVerifiedWorkingDirectory(approval.snapshot, approval.run.proposal, native),
          release: closeSync,
          claim,
          acquireReservation: async () => true,
          releaseReservation: async () => true,
          cancelPending: (project, id, version) =>
            store.closeRunProposal(project, id, version, 'cancelled'),
          markUnknown: store.markRunOutcomeUnknown,
          refuse: store.recordResourceLimitRefusal,
          finish: store.finishRunExecution,
          npmExecutable: fakeNpm,
          helperExecutable: helper,
          execute,
        });
        const pending = cancellingRunner.run('project-1', fourth.id);
        expect(cancellingRunner.cancel('project-1', fourth.id)).toBe(true);
        releaseValidation();
        await expect(pending).rejects.toThrow('cancelled before claim');
        expect(await store.getRunProposal('project-1', fourth.id)).toMatchObject({
          state: 'cancelled',
          verified: false,
          version: fourth.version + 1,
        });
        expect(claim).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();

        const { createLocalVerificationRunner } = await import('./local-runner');
        const fifth = await store.createRunProposal('project-1', audit.id, proposal);
        expect(await approvals.request('project-1', fifth.id)).toBe(true);
        const localRunner = createLocalVerificationRunner({
          approvals,
          native,
          npmExecutable: fakeNpm,
          helperExecutable: helper,
        });
        await expect(localRunner.run('project-1', fifth.id)).rejects.toThrow('approval');
        expect(await store.getRunProposal('project-1', fifth.id)).toMatchObject({
          state: 'proposed',
        });
        runtimeFingerprint = await fingerprintRuntime([fakeNpm, process.execPath, helper]);
        expect(await approvals.request('project-1', fifth.id)).toBe(true);
        const originalNpm = await readFile(fakeNpm);
        await writeFile(fakeNpm, Buffer.concat([originalNpm, Buffer.from('\n')]));
        await expect(localRunner.run('project-1', fifth.id)).rejects.toThrow('approval');
        expect(await store.getRunProposal('project-1', fifth.id)).toMatchObject({
          state: 'proposed',
        });
        await writeFile(fakeNpm, originalNpm);
        runtimeFingerprint = await fingerprintRuntime([fakeNpm, process.execPath, helper]);
        expect(await approvals.request('project-1', fifth.id)).toBe(true);
        expect(await localRunner.run('project-1', fifth.id)).toMatchObject({
          state: 'finished',
          verified: false,
          result: {
            status: 'exited',
            exitCode: 0,
            terminationUnconfirmed: true,
            capturedComplete: false,
          },
        });
        expect(await reservation.isExecutionReservationHeldBy(fifth.id)).toBe(true);
        const sixth = await store.createRunProposal('project-1', audit.id, proposal);
        expect(await approvals.request('project-1', sixth.id)).toBe(true);
        const otherRunner = createLocalVerificationRunner({
          approvals,
          native,
          npmExecutable: fakeNpm,
          helperExecutable: helper,
        });
        await expect(otherRunner.run('project-1', sixth.id)).rejects.toThrow('reservation');
        expect(await store.getRunProposal('project-1', sixth.id)).toMatchObject({
          state: 'proposed',
          verified: false,
        });
      } finally {
        await rm(helper, { force: true });
        await rm(join(root, '..', `npm-${created.id}`), { recursive: true, force: true });
      }
    });
  }
);
