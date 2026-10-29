import { describe, expect, it, vi } from 'vitest';
import { discoverPackageChecks } from './command-contract';
import { ResourceLimitRefusalError, type ProcessResult } from './process-adapter';
import type { StoredRunProposal } from './run-store';
import { VerificationRunner } from './runner';
const id = '00000000-0000-4000-8000-000000000001';
const proposal = discoverPackageChecks('{"scripts":{"test":"echo test"}}', '.', `audit:${id}`)[0]!;
const validated = {
  run: {
    id,
    projectId: 'project',
    auditId: id,
    version: 1,
    proposal,
    state: 'proposed' as const,
    verified: false as const,
    createdAt: 1,
    updatedAt: 1,
  },
  snapshot: {
    root: '/tmp',
    identity: '1:2',
    workingDirectoryIdentity: '1:2',
    fingerprint: 'a'.repeat(64),
    runtimeDirectory: '/trusted/node-bin',
    npmExecutable: '/trusted/npm',
    helperExecutable: '/trusted/helper',
  },
};
describe('verification execution orchestration', () => {
  it('hands a strict versioned Windows root grant from the consumed approval to the adapter', async () => {
    const rootIdentity = 'win32:0123456789abcdef:00112233445566778899aabbccddeeff';
    const windowsApproval = {
      ...validated,
      snapshot: {
        ...validated.snapshot,
        root: 'C:\\work\\switch',
        identity: rootIdentity,
        workingDirectoryIdentity: rootIdentity,
      },
    };
    const claimed: StoredRunProposal = { ...validated.run, state: 'running', version: 2 };
    const result: ProcessResult = {
      status: 'resource_limit_refused',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutHash: 'a'.repeat(64),
      stderrHash: 'b'.repeat(64),
      stdoutTruncated: false,
      stderrTruncated: false,
      capturedComplete: false,
      terminationUnconfirmed: false,
      sandboxMode: 'unavailable',
      startedAt: 1,
      endedAt: 1,
      durationMs: 0,
      effectiveLimits: {
        timeout: 'termination-request',
        output: 'retained-bytes',
        concurrency: 'durable-single-flight',
        cpuTimeSeconds: false,
        processCount: false,
        memory: false,
      },
      execution: {
        executable: '/trusted/npm',
        args: ['run', 'test'],
        cwd: 'C:\\work\\switch',
        environmentKeys: [],
        runtimeDirectory: '/trusted/node-bin',
        timeoutMs: proposal.limits.timeoutMs,
        outputBytes: proposal.limits.outputBytes,
        spawned: false,
        workingDirectoryBinding: 'approved-root-handoff',
        targetHandoff: 'not_started',
      },
    };
    const execute = vi.fn().mockResolvedValue(result);
    const runner = new VerificationRunner(
      {
        acquireReservation: async () => true,
        releaseReservation: async () => true,
        cancelPending: vi.fn(),
        markUnknown: vi.fn(),
        npmExecutable: '/trusted/npm',
        helperExecutable: '/trusted/helper',
        consume: async () => windowsApproval,
        claim: async () => claimed,
        execute,
        finish: async () => ({ ...claimed, state: 'refused' }) as StoredRunProposal,
        open: () => ({ fd: 10, identity: rootIdentity }),
        release: vi.fn(),
      },
      'win32'
    );

    await runner.run('project', id);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        windowsHandoff: {
          version: 1,
          projectId: 'project',
          auditId: id,
          runId: id,
          proposalVersion: 1,
          approvedRoot: 'C:\\work\\switch',
          rootFileIdentity: rootIdentity,
          workingDirectoryComponents: [],
          command: 'npm',
          args: ['run', 'test'],
          limits: proposal.limits,
        },
      })
    );
    const handedOffInput = execute.mock.calls[0]?.[0];
    expect(handedOffInput).not.toHaveProperty('pinnedCwd');
  });

  it('rejects Windows execution before opening or claiming when no native file identity is bound', async () => {
    const open = vi.fn(() => ({ fd: 10, identity: '1:2' }));
    const claim = vi.fn();
    const execute = vi.fn();
    const runner = new VerificationRunner(
      {
        acquireReservation: async () => true,
        releaseReservation: async () => true,
        cancelPending: vi.fn(),
        markUnknown: vi.fn(),
        npmExecutable: '/trusted/npm',
        helperExecutable: '/trusted/helper',
        consume: async () => validated,
        claim,
        execute,
        finish: vi.fn(),
        open,
        release: vi.fn(),
      },
      'win32'
    );

    await expect(runner.run('project', id)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('records a typed resource refusal as not-started rather than outcome-unknown', async () => {
    const claimed: StoredRunProposal = { ...validated.run, state: 'running', version: 2 };
    const refused = {
      ...validated.run,
      state: 'refused' as const,
      version: 3,
    } as unknown as StoredRunProposal;
    const refusal = new ResourceLimitRefusalError('darwin', ['memoryBytes', 'processCount']);
    const markUnknown = vi.fn();
    const releaseReservation = vi.fn().mockResolvedValue(true);
    const recordRefusal = vi.fn().mockResolvedValue(refused);
    const runner = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation,
      cancelPending: vi.fn(),
      markUnknown,
      refuse: recordRefusal,
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim: async () => claimed,
      execute: async () => {
        throw refusal;
      },
      finish: vi.fn(),
      open: () => ({ fd: 10, identity: '1:2' }),
      release: vi.fn(),
    });

    await expect(runner.run('project', id)).resolves.toEqual(refused);
    expect(recordRefusal).toHaveBeenCalledWith(
      'project',
      id,
      2,
      expect.objectContaining({
        status: 'resource_limit_refused',
        resourceLimitRefusal: {
          platform: 'darwin',
          missingControls: ['memoryBytes', 'processCount'],
          reason:
            'Resource limits fail closed on darwin: memoryBytes (no verified OS memory controller), processCount (no verified OS process-count controller)',
        },
        exitCode: null,
        signal: null,
        terminationUnconfirmed: false,
        execution: expect.objectContaining({ spawned: false, targetHandoff: 'not_started' }),
      })
    );
    expect(markUnknown).not.toHaveBeenCalled();
    expect(releaseReservation).toHaveBeenCalledWith(id);
  });
  it.each([
    ['process-count', { processCount: false, memory: validated.run.proposal.limits.memoryBytes }],
    ['memory', { processCount: validated.run.proposal.limits.processCount, memory: false }],
  ] as const)(
    'does not confirm the proposal when the %s cap is unenforced',
    async (_cap, limits) => {
      const claimed: StoredRunProposal = { ...validated.run, state: 'running', version: 2 };
      const matchingProcess: ProcessResult = {
        status: 'exited',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutHash: 'a'.repeat(64),
        stderrHash: 'b'.repeat(64),
        stdoutTruncated: false,
        stderrTruncated: false,
        capturedComplete: true,
        terminationUnconfirmed: false,
        sandboxMode: validated.run.proposal.sandboxMode,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        effectiveLimits: {
          timeout: 'termination-request',
          output: 'retained-bytes',
          concurrency: 'per-instance',
          cpuTimeSeconds: 60,
          ...limits,
        },
        execution: {
          executable: '/trusted/npm',
          args: [...validated.run.proposal.args],
          cwd: '/tmp',
          environmentKeys: [],
          runtimeDirectory: '/trusted/node-bin',
          timeoutMs: validated.run.proposal.limits.timeoutMs,
          outputBytes: validated.run.proposal.limits.outputBytes,
          spawned: true,
          workingDirectoryBinding: 'descriptor',
          targetHandoff: 'exec_handoff',
        },
      };
      const finish = vi.fn().mockResolvedValue({ ...claimed, state: 'finished' });
      const runner = new VerificationRunner({
        acquireReservation: async () => true,
        releaseReservation: async () => true,
        cancelPending: vi.fn(),
        markUnknown: vi.fn(),
        npmExecutable: '/trusted/npm',
        helperExecutable: '/trusted/helper',
        consume: async () => validated,
        claim: async () => claimed,
        execute: async () => matchingProcess,
        finish,
        open: () => ({ fd: 10, identity: '1:2' }),
        release: vi.fn(),
      });

      await runner.run('project', id);
      expect(finish).toHaveBeenCalledWith(
        'project',
        id,
        2,
        expect.objectContaining({ executionMatchesProposal: false })
      );
    }
  );
  it('requires approval and claims the matching version before running', async () => {
    const consume = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(validated);
    const claimed: StoredRunProposal = { ...validated.run, state: 'running', version: 2 };
    const claim = vi.fn().mockResolvedValue(claimed);
    const result: ProcessResult = {
      status: 'exited',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutHash: 'a'.repeat(64),
      stderrHash: 'a'.repeat(64),
      stdoutTruncated: false,
      stderrTruncated: false,
      capturedComplete: true,
      terminationUnconfirmed: false,
      sandboxMode: 'unavailable',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      effectiveLimits: {
        timeout: 'termination-request',
        output: 'retained-bytes',
        concurrency: 'per-instance',
        cpuTimeSeconds: 60,
        processCount: false,
        memory: false,
      },
      execution: {
        executable: '/node',
        args: [],
        cwd: '/tmp',
        environmentKeys: [],
        timeoutMs: 1,
        outputBytes: 1,
        spawned: true,
        workingDirectoryBinding: 'descriptor',
        targetHandoff: 'exec_handoff',
      },
    };
    const execute = vi.fn().mockResolvedValue(result);
    const finish = vi.fn().mockResolvedValue({ ...claimed, state: 'finished', result });
    const release = vi.fn();
    const runner = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume,
      claim,
      execute,
      finish,
      open: () => ({ fd: 10, identity: '1:2' }),
      release,
    });
    await expect(runner.run('project', id)).rejects.toThrow('approval');
    expect(execute).not.toHaveBeenCalled();
    await expect(runner.run('project', id)).resolves.toMatchObject({ state: 'finished' });
    expect(claim).toHaveBeenCalledWith('project', id, 1);
    expect(finish).toHaveBeenCalledWith(
      'project',
      id,
      2,
      expect.objectContaining({
        effectiveLimits: expect.objectContaining({ concurrency: 'durable-single-flight' }),
      })
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/trusted/npm',
        args: ['run', 'test'],
        cwd: '/tmp',
        timeoutMs: proposal.limits.timeoutMs,
        cpuTimeSeconds: 60,
        outputBytes: proposal.limits.outputBytes,
        sandboxMode: 'unavailable',
        pinnedCwd: { fd: 10, identity: '1:2', helperExecutable: '/trusted/helper' },
        env: {},
        runtimeDirectory: '/trusted/node-bin',
      })
    );
    expect(finish).toHaveBeenCalledWith('project', id, 2, {
      ...result,
      effectiveLimits: { ...result.effectiveLimits, concurrency: 'durable-single-flight' },
      executionMatchesProposal: false,
    });
    expect(release).toHaveBeenCalledWith(10);
    const wrongSandboxResult: ProcessResult = {
      ...result,
      sandboxMode: 'macos-sandbox-exec',
      execution: {
        executable: '/trusted/npm',
        args: ['run', 'test'],
        cwd: '/tmp',
        environmentKeys: ['HOME', 'PATH', 'TMPDIR'],
        runtimeDirectory: '/trusted/node-bin',
        timeoutMs: proposal.limits.timeoutMs,
        outputBytes: proposal.limits.outputBytes,
        spawned: true,
        workingDirectoryBinding: 'descriptor',
        targetHandoff: 'exec_handoff',
      },
    };
    const mismatchFinish = vi.fn().mockResolvedValue({ ...claimed, state: 'finished' });
    const wrongSandbox = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute: async () => wrongSandboxResult,
      finish: mismatchFinish,
      open: () => ({ fd: 10, identity: '1:2' }),
      release,
    });
    await wrongSandbox.run('project', id);
    expect(mismatchFinish).toHaveBeenCalledWith('project', id, 2, {
      ...wrongSandboxResult,
      effectiveLimits: {
        ...wrongSandboxResult.effectiveLimits,
        concurrency: 'durable-single-flight',
      },
      executionMatchesProposal: false,
    });
    const uncertain = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute: async () => ({
        ...result,
        status: 'timed_out',
        capturedComplete: false,
        terminationUnconfirmed: true,
      }),
      finish,
      open: () => ({ fd: 10, identity: '1:2' }),
      release,
    });
    await uncertain.run('project', id);
    await expect(uncertain.run('project', id)).rejects.toThrow('unavailable');
    const failedSave = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute: async () => result,
      finish: async () => {
        throw new Error('storage failure');
      },
      open: () => ({ fd: 10, identity: '1:2' }),
      release,
    });
    await expect(failedSave.run('project', id)).rejects.toThrow('storage failure');
    await expect(failedSave.run('project', id)).rejects.toThrow('unavailable');
  });
  it('does not claim or execute when another runner holds the durable reservation', async () => {
    const claim = vi.fn();
    const execute = vi.fn();
    const runner = new VerificationRunner({
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute,
      acquireReservation: async () => false,
      releaseReservation: vi.fn(),
      finish: vi.fn(),
      open: () => ({ fd: 10, identity: '1:2' }),
      release: vi.fn(),
    });
    await expect(runner.run('project', id)).rejects.toThrow('reservation');
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('cancels during revalidation and rejects concurrent or unrelated requests', async () => {
    let resolve: (value: typeof validated) => void = () => {};
    const consume = vi.fn(
      () =>
        new Promise<typeof validated>((done) => {
          resolve = done;
        })
    );
    const claim = vi.fn();
    const execute = vi.fn();
    const finish = vi.fn();
    const open = vi.fn(() => ({ fd: 10, identity: '1:2' }));
    const runner = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume,
      claim,
      execute,
      finish,
      open,
      release: () => {},
    });
    const pending = runner.run('project', id);
    await expect(runner.run('project', id)).rejects.toThrow('already running');
    expect(runner.cancel('other', id)).toBe(false);
    expect(runner.cancel('project', id)).toBe(true);
    resolve(validated);
    await expect(pending).rejects.toThrow('cancelled');
    expect(open).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a non-npm executable before claiming or running', async () => {
    const claim = vi.fn();
    const execute = vi.fn();
    const release = vi.fn();
    const runner = new VerificationRunner({
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      npmExecutable: '/trusted/node',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute,
      finish: vi.fn(),
      open: () => ({ fd: 10, identity: '1:2' }),
      release,
    });
    await expect(runner.run('project', id)).rejects.toThrow('Invalid trusted executable');
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(10);
  });
  it('rejects a different npm path than the approved path before claiming', async () => {
    const claim = vi.fn();
    const execute = vi.fn();
    const release = vi.fn();
    const runner = new VerificationRunner({
      npmExecutable: '/other/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute,
      finish: vi.fn(),
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      open: () => ({ fd: 10, identity: '1:2' }),
      release,
    });
    await expect(runner.run('project', id)).rejects.toThrow('Invalid trusted executable');
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(10);
  });
  it('does not claim an approval that lacks a bound runtime', async () => {
    const claim = vi.fn();
    const runner = new VerificationRunner({
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => ({
        ...validated,
        snapshot: {
          root: '/tmp',
          identity: '1:2',
          workingDirectoryIdentity: '1:2',
          fingerprint: 'a'.repeat(64),
        },
      }),
      claim,
      execute: vi.fn(),
      finish: vi.fn(),
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown: vi.fn(),
      open: vi.fn(() => ({ fd: 10, identity: '1:2' })),
      release: vi.fn(),
    });
    await expect(runner.run('project', id)).rejects.toThrow('runtime directory required');
    expect(claim).not.toHaveBeenCalled();
  });
  it('quarantines the runner if execution throws after the claim', async () => {
    const claim = vi.fn().mockResolvedValue({ ...validated.run, state: 'running', version: 2 });
    const execute = vi.fn().mockRejectedValue(new Error('adapter failure'));
    const markUnknown = vi
      .fn()
      .mockResolvedValue({ ...validated.run, state: 'outcome_unknown', version: 3 });
    const runner = new VerificationRunner({
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
      consume: async () => validated,
      claim,
      execute,
      acquireReservation: async () => true,
      releaseReservation: async () => true,
      cancelPending: vi.fn(),
      markUnknown,
      finish: vi.fn(),
      open: () => ({ fd: 10, identity: '1:2' }),
      release: () => {},
    });
    await expect(runner.run('project', id)).rejects.toThrow('adapter failure');
    expect(markUnknown).toHaveBeenCalledWith('project', id, 2);
    await expect(runner.run('project', id)).rejects.toThrow('unavailable');
    expect(execute).toHaveBeenCalledOnce();
  });
});
