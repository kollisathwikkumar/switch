import { dirname, join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';
import type { ProcessInput, ProcessResult } from './process-adapter';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { saveAudit } = await import('../audit/audit-store');
const { discoverPackageChecks } = await import('./command-contract');
const { createRunProposal, getRunProposal, closeRunProposal } = await import('./run-store');
const runStore = await import('./run-store');
const { ProcessAdapter } = await import('./process-adapter');
const { VerificationApprovalService } = await import('./approval-service');

describe('durable verification proposals', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });
  it('lists scoped proposal summaries across pages and retains cancellation after reopening', async () => {
    const makeAudit = (locationId: string) =>
      saveAudit({
        locationId,
        root: '/fixture',
        revision: null,
        dirty: null,
        fingerprint: null,
        capturedAt: 1,
        inventory: {
          filesDiscovered: 0,
          filesParsed: 0,
          skipped: 0,
          inventoryComplete: true,
          errors: [],
          languages: [],
          manifests: [],
          limitations: [],
        },
      });
    const audit = await makeAudit('project-1');
    const otherAudit = await makeAudit('project-1');
    const proposal = (id: string) =>
      discoverPackageChecks('{"scripts":{"test":"echo test"}}', '.', `audit:${id}`)[0]!;
    const created = await Promise.all(
      Array.from({ length: 3 }, () => createRunProposal('project-1', audit.id, proposal(audit.id)))
    );
    await createRunProposal('project-1', otherAudit.id, proposal(otherAudit.id));
    const first = await runStore.listRunProposals('project-1', audit.id, null, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await runStore.listRunProposals('project-1', audit.id, first.nextCursor, 2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set(created.map((item) => item.id))
    );
    expect(await runStore.listRunProposals('project-2', audit.id, null, 2)).toMatchObject({
      items: [],
    });
    const cancelled = await closeRunProposal('project-1', created[0]!.id, 1, 'cancelled');
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      const all = await runStore.listRunProposals('project-1', audit.id, null, 50);
      expect(all.items.find((item) => item.id === cancelled.id)).toMatchObject({
        state: 'cancelled',
        verified: false,
      });
      expect(all.items.every((item) => !('result' in item))).toBe(true);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });
  it('marks only a complete, approved, proposal-matched passing result verified', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`,
      'linux-bubblewrap'
    )[0]!;
    const created = await createRunProposal('project-1', audit.id, proposal);
    const running = await runStore.claimRunExecution('project-1', created.id, created.version);
    const result: ProcessResult = {
      executionMatchesProposal: true,
      execution: {
        executable: '/trusted/npm',
        args: ['run', 'test'],
        cwd: '/fixture',
        environmentKeys: [],
        timeoutMs: proposal.limits.timeoutMs,
        outputBytes: proposal.limits.outputBytes,
        spawned: true,
        workingDirectoryBinding: 'descriptor',
        targetHandoff: 'exec_handoff',
      },
      status: 'exited',
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      stdoutHash: 'a'.repeat(64),
      stderrHash: 'b'.repeat(64),
      stdoutTruncated: false,
      stderrTruncated: false,
      capturedComplete: true,
      terminationUnconfirmed: false,
      sandboxMode: 'linux-bubblewrap',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      effectiveLimits: {
        timeout: 'termination-request',
        output: 'retained-bytes',
        concurrency: 'durable-single-flight',
        cpuTimeSeconds: 60,
        processCount: proposal.limits.processCount,
        memory: proposal.limits.memoryBytes,
      },
    };

    const finished = await runStore.finishRunExecution(
      'project-1',
      created.id,
      running.version,
      result
    );
    expect(finished).toMatchObject({ state: 'finished', verified: true });
    expect((await runStore.listRunProposals('project-1', audit.id, null)).items[0]).toMatchObject({
      verified: true,
      resultStatus: 'exited',
      processCount: 32,
      memoryBytes: 1_073_741_824,
    });
    expect(await runStore.getRunResultPreview('project-1', audit.id, created.id)).toMatchObject({
      executionMismatch: false,
      executionMatchConfirmed: true,
      effectiveLimits: { concurrency: 'durable-single-flight' },
    });

    const unboundedProposal = await createRunProposal('project-1', audit.id, proposal);
    const unboundedRunning = await runStore.claimRunExecution(
      'project-1',
      unboundedProposal.id,
      unboundedProposal.version
    );
    const unbounded = await runStore.finishRunExecution(
      'project-1',
      unboundedProposal.id,
      unboundedRunning.version,
      {
        ...result,
        executionMatchesProposal: true,
        effectiveLimits: { ...result.effectiveLimits, processCount: false, memory: false },
      }
    );
    expect(unbounded).toMatchObject({ state: 'finished', verified: false });
    expect(unbounded.result?.executionMatchesProposal).toBe(false);
    expect(
      await runStore.getRunResultPreview('project-1', audit.id, unboundedProposal.id)
    ).toMatchObject({
      executionMismatch: true,
      executionMatchConfirmed: false,
    });
    fixture.sqlite
      .prepare(
        "UPDATE kv SET value = json_set(value, '$.verified', json('true'), '$.result.executionMatchesProposal', json('true')) WHERE key = ?"
      )
      .run(`tracemind:verification:project-1:${unboundedProposal.id}`);
    expect(await getRunProposal('project-1', unboundedProposal.id)).toMatchObject({
      verified: false,
      result: { executionMatchesProposal: false },
    });
    expect((await runStore.listRunProposals('project-1', audit.id, null)).items).toContainEqual(
      expect.objectContaining({ id: unboundedProposal.id, verified: false })
    );
    expect(
      await runStore.getRunResultPreview('project-1', audit.id, unboundedProposal.id)
    ).toMatchObject({
      executionMismatch: true,
      executionMatchConfirmed: false,
    });

    const incompleteProposal = await createRunProposal('project-1', audit.id, proposal);
    const incompleteRunning = await runStore.claimRunExecution(
      'project-1',
      incompleteProposal.id,
      incompleteProposal.version
    );
    const incomplete = await runStore.finishRunExecution(
      'project-1',
      incompleteProposal.id,
      incompleteRunning.version,
      { ...result, capturedComplete: false, terminationUnconfirmed: true }
    );
    expect(incomplete).toMatchObject({ state: 'finished', verified: false });

    const mismatchedProposal = await createRunProposal('project-1', audit.id, proposal);
    const mismatchedRunning = await runStore.claimRunExecution(
      'project-1',
      mismatchedProposal.id,
      mismatchedProposal.version
    );
    const mismatched = await runStore.finishRunExecution(
      'project-1',
      mismatchedProposal.id,
      mismatchedRunning.version,
      { ...result, executionMatchesProposal: false }
    );
    expect(mismatched).toMatchObject({ state: 'finished', verified: false });
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getRunProposal('project-1', created.id)).toEqual(finished);
      expect(
        (await runStore.listRunProposals('project-1', audit.id, null)).items.find(
          (item) => item.id === created.id
        )?.verified
      ).toBe(true);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });
  it('persists the actual failing process result and keeps it unverified', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const created = await createRunProposal('project-1', audit.id, proposal);
    const running = await runStore.claimRunExecution('project-1', created.id, created.version);
    expect(running).toMatchObject({ state: 'running', verified: false, version: 2 });
    await expect(closeRunProposal('project-1', created.id, 1, 'denied')).rejects.toThrow();
    const actual = await new ProcessAdapter().run({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('out');process.stderr.write('err');process.exitCode=7"],
      cwd: process.cwd(),
      env: {},
      ...(process.platform !== 'win32' ? { runtimeDirectory: dirname(process.execPath) } : {}),
      timeoutMs: 5000,
      outputBytes: 1000,
    });
    await expect(
      runStore.finishRunExecution('project-1', created.id, running.version, {
        ...actual,
        execution: { ...actual.execution, spawned: false },
      })
    ).rejects.toThrow();
    await expect(
      runStore.finishRunExecution('project-1', created.id, running.version, {
        ...actual,
        execution: {
          ...actual.execution,
          workingDirectoryBinding: 'descriptor',
          targetHandoff: 'failed',
        },
      })
    ).rejects.toThrow();
    const finished = await runStore.finishRunExecution(
      'project-1',
      created.id,
      running.version,
      actual
    );
    const stdoutRef = {
      projectId: 'project-1',
      auditId: audit.id,
      runId: created.id,
      stream: 'stdout' as const,
    };
    expect(await runStore.getRunOutputArtifact(stdoutRef)).toMatchObject({
      reference: stdoutRef,
      text: 'out',
      observedHash: actual.stdoutHash,
      representation: 'stored-utf8-preview',
      previewTruncated: false,
    });
    expect(await runStore.getRunOutputArtifact({ ...stdoutRef, stream: 'stderr' })).toMatchObject({
      text: 'err',
      observedHash: actual.stderrHash,
    });
    expect(
      await runStore.getRunOutputArtifact({ ...stdoutRef, projectId: 'project-2' })
    ).toBeNull();
    expect(
      await runStore.getRunOutputArtifact({
        ...stdoutRef,
        auditId: '00000000-0000-4000-8000-000000000099',
      })
    ).toBeNull();
    const artifactReopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(artifactReopened, { schema });
      expect(await runStore.getRunOutputArtifact(stdoutRef)).toMatchObject({
        text: 'out',
        reference: stdoutRef,
      });
    } finally {
      artifactReopened.close();
      mocks.db = fixture.db;
    }
    expect(await runStore.getRunResultPreview('project-1', audit.id, created.id)).toMatchObject({
      status: 'exited',
      exitCode: 7,
      stdout: 'out',
      stderr: 'err',
      stdoutHash: actual.stdoutHash,
      stderrHash: actual.stderrHash,
      capturedComplete: false,
      terminationUnconfirmed: true,
      execution: { executable: process.execPath, cwd: process.cwd(), args: actual.execution.args },
      effectiveLimits: { memory: false, processCount: false },
    });
    expect(
      await runStore.getRunResultPreview(
        'project-1',
        '00000000-0000-4000-8000-000000000099',
        created.id
      )
    ).toBeNull();
    expect(await runStore.getRunResultPreview('project-2', audit.id, created.id)).toBeNull();
    const large = await createRunProposal('project-1', audit.id, proposal);
    const largeRunning = await runStore.claimRunExecution('project-1', large.id, 1);
    const largeOutput = await new ProcessAdapter().run({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(20000))"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      outputBytes: 30000,
    });
    await runStore.finishRunExecution('project-1', large.id, largeRunning.version, largeOutput);
    expect(await runStore.getRunOutputArtifact({ ...stdoutRef, runId: large.id })).toMatchObject({
      previewTruncated: true,
      captureTruncated: false,
      text: 'x'.repeat(16384),
    });
    const preview = await runStore.getRunResultPreview('project-1', audit.id, large.id);
    expect(preview).toMatchObject({
      stdoutBytes: 20000,
      stdoutPreviewTruncated: true,
      stdoutTruncated: false,
      stdoutHash: largeOutput.stdoutHash,
    });
    expect(preview?.stdout).toHaveLength(16384);
    if (process.platform !== 'win32')
      expect(finished.result?.execution).toMatchObject({
        runtimeDirectory: dirname(process.execPath),
        environmentKeys: ['PATH'],
      });
    const summary = await runStore.listRunProposals('project-1', audit.id, null);
    expect(summary.items[0]).toMatchObject({
      state: 'finished',
      resultStatus: 'exited',
      verified: false,
    });
    expect(summary.items[0]).not.toHaveProperty('result');
    expect(finished).toMatchObject({
      state: 'finished',
      verified: false,
      result: {
        status: 'exited',
        exitCode: 7,
        stdout: 'out',
        stderr: 'err',
        execution: {
          executable: process.execPath,
          cwd: process.cwd(),
          spawned: true,
          args: ['-e', expect.any(String)],
        },
      },
    });
    await expect(
      runStore.finishRunExecution('project-1', created.id, running.version, actual)
    ).rejects.toThrow();
    expect(await getRunProposal('project-2', created.id)).toBeNull();
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getRunProposal('project-1', created.id)).toEqual(finished);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
    fixture.sqlite
      .prepare('UPDATE kv SET value = json_remove(value, ?) WHERE key = ?')
      .run('$.result.execution', `tracemind:verification:project-1:${created.id}`);
    expect((await getRunProposal('project-1', created.id))?.result?.execution).toBeUndefined();
    expect(
      (await runStore.getRunResultPreview('project-1', audit.id, created.id))?.execution
    ).toBeNull();
  });
  it('persists timeout, cancellation, output-limit and interrupted states without verification', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const controller = new AbortController();
    controller.abort();
    const base = {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 100,
      outputBytes: 100,
    };
    const cases: Array<[ProcessResult['status'], ProcessInput]> = [
      ['timed_out', base],
      ['cancelled', { ...base, signal: controller.signal }],
      [
        'output_limit',
        { ...base, timeoutMs: 5000, args: ['-e', "process.stdout.write('x'.repeat(10000))"] },
      ],
      [
        'spawn_error',
        { ...base, executable: join(process.cwd(), 'nonexistent-tracemind-test-executable') },
      ],
    ];
    for (const [expected, input] of cases) {
      const created = await createRunProposal('project-1', audit.id, proposal);
      const running = await runStore.claimRunExecution('project-1', created.id, 1);
      const actual = await new ProcessAdapter().run(input);
      await expect(
        runStore.finishRunExecution('project-1', created.id, running.version, {
          ...actual,
          capturedComplete: true,
        })
      ).rejects.toThrow();
      const finished = await runStore.finishRunExecution(
        'project-1',
        created.id,
        running.version,
        actual
      );
      expect(finished).toMatchObject({
        state: 'finished',
        verified: false,
        result: { status: expected, capturedComplete: false },
      });
      expect(await getRunProposal('project-1', created.id)).toEqual(finished);
    }
    const created = await createRunProposal('project-1', audit.id, proposal);
    const running = await runStore.claimRunExecution('project-1', created.id, 1);
    const interrupted = await runStore.interruptRunExecution(
      'project-1',
      created.id,
      running.version
    );
    expect(interrupted).toMatchObject({ state: 'interrupted', verified: false });
    const uncertain = await createRunProposal('project-1', audit.id, proposal);
    const claimed = await runStore.claimRunExecution('project-1', uncertain.id, 1);
    const unknown = await runStore.markRunOutcomeUnknown(
      'project-1',
      uncertain.id,
      claimed.version
    );
    expect(unknown).toMatchObject({ state: 'outcome_unknown', verified: false, version: 3 });
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getRunProposal('project-1', uncertain.id)).toEqual(unknown);
      expect((await runStore.listRunProposals('project-1', audit.id, null)).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: uncertain.id, state: 'outcome_unknown', verified: false }),
        ])
      );
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
    await expect(
      runStore.claimRunExecution('project-1', uncertain.id, unknown.version)
    ).rejects.toThrow();
    await expect(
      runStore.claimRunExecution('project-1', created.id, interrupted.version)
    ).rejects.toThrow();
  });
  it('permits only one concurrent claim or denial', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const created = await createRunProposal('project-1', audit.id, proposal);
    const outcomes = await Promise.allSettled([
      runStore.claimRunExecution('project-1', created.id, 1),
      runStore.claimRunExecution('project-1', created.id, 1),
      closeRunProposal('project-1', created.id, 1, 'denied'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await getRunProposal('project-1', created.id))?.verified).toBe(false);
  });
  it('persists denied proposals without executing or marking them verified, and isolates projects', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const created = await createRunProposal('project-1', audit.id, proposal);
    expect(created).toMatchObject({
      projectId: 'project-1',
      auditId: audit.id,
      state: 'proposed',
      version: 1,
      verified: false,
    });
    if (!created) throw new Error('Proposal not stored');
    expect(await getRunProposal('project-2', created.id)).toBeNull();
    await expect(createRunProposal('project-2', audit.id, proposal)).rejects.toThrow('audit');
    const denied = await closeRunProposal('project-1', created.id, 1, 'denied');
    expect(denied).toMatchObject({ state: 'denied', version: 2, verified: false });
    await expect(closeRunProposal('project-1', created.id, 1, 'cancelled')).rejects.toThrow();
    await expect(closeRunProposal('project-1', created.id, 2, 'cancelled')).rejects.toThrow(
      'terminal'
    );
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getRunProposal('project-1', created.id)).toEqual(denied);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });
  it('rejects a proposal bound to a different audit revision', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      'audit:other'
    )[0]!;
    await expect(createRunProposal('project-1', audit.id, proposal)).rejects.toThrow('revision');
  });
  it('allows only one concurrent terminal decision', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const created = await createRunProposal('project-1', audit.id, proposal);
    const results = await Promise.allSettled([
      closeRunProposal('project-1', created.id, 1, 'denied'),
      closeRunProposal('project-1', created.id, 1, 'cancelled'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await getRunProposal('project-1', created.id))?.verified).toBe(false);
  });
  it('reads and cancels legacy records without allowing an incomplete approval preview', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo test"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const created = await createRunProposal('project-1', audit.id, proposal);
    fixture.sqlite
      .prepare('UPDATE kv SET value = json_remove(value, ?) WHERE key = ?')
      .run('$.proposal.declaredScripts', `tracemind:verification:project-1:${created.id}`);
    expect((await getRunProposal('project-1', created.id))?.state).toBe('proposed');
    const confirm = vi.fn(async () => 'approve' as const);
    const service = new VerificationApprovalService({
      load: getRunProposal,
      snapshot: async () => ({
        root: '/fixture',
        identity: '1:2',
        workingDirectoryIdentity: '1:2',
        fingerprint: 'a'.repeat(64),
      }),
      confirm,
      deny: async () => {},
      now: () => 1,
    });
    expect(await service.request('project-1', created.id)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    await expect(runStore.claimRunExecution('project-1', created.id, 1)).rejects.toThrow();
    expect((await closeRunProposal('project-1', created.id, 1, 'cancelled')).state).toBe(
      'cancelled'
    );
  });
});
