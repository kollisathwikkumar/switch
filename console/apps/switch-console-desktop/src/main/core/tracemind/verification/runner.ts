import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import type { ValidatedApproval } from './approval-service';
import {
  ResourceLimitRefusalError,
  type ProcessInput,
  type ProcessResult,
} from './process-adapter';
import type { StoredRunProposal } from './run-store';
import { createWindowsApprovedRootHandoff } from './windows-handoff';

/** Trusted main-process dependencies; this class is not an IPC authorization boundary. */
export interface RunnerDependencies {
  consume: (projectId: string, runId: string) => Promise<ValidatedApproval | null>;
  open: (approval: ValidatedApproval) => { fd: number; identity: string };
  release: (fd: number) => void;
  claim: (projectId: string, runId: string, version: number) => Promise<StoredRunProposal>;
  markUnknown: (projectId: string, runId: string, version: number) => Promise<StoredRunProposal>;
  cancelPending: (projectId: string, runId: string, version: number) => Promise<StoredRunProposal>;
  /** Durable app-wide single-flight lease; retain it until termination is confirmed. */
  acquireReservation: (owner: string, projectId: string) => Promise<boolean>;
  releaseReservation: (owner: string) => Promise<boolean>;
  /** Trusted runtime paths configured by the main process, never renderer input. */
  npmExecutable: string;
  helperExecutable: string;
  execute: (input: ProcessInput) => Promise<ProcessResult>;
  /** Persists a typed pre-spawn refusal without treating it as an uncertain run. */
  refuse?: (
    projectId: string,
    runId: string,
    version: number,
    result: ProcessResult
  ) => Promise<StoredRunProposal>;
  finish: (
    projectId: string,
    runId: string,
    version: number,
    result: ProcessResult
  ) => Promise<StoredRunProposal>;
}

function createResourceLimitRefusalResult(
  error: ResourceLimitRefusalError,
  input: ProcessInput
): ProcessResult {
  const now = Date.now();
  const emptyHash = createHash('sha256').update('').digest('hex');
  return {
    status: 'resource_limit_refused',
    resourceLimitRefusal: {
      platform: error.platform,
      missingControls: [...error.missingControls],
      reason: error.message,
    },
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutHash: emptyHash,
    stderrHash: emptyHash,
    stdoutTruncated: false,
    stderrTruncated: false,
    capturedComplete: false,
    terminationUnconfirmed: false,
    sandboxMode: 'unavailable',
    startedAt: now,
    endedAt: now,
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
      executable: input.executable,
      args: [...input.args],
      cwd: input.cwd,
      environmentKeys: [],
      ...(input.runtimeDirectory ? { runtimeDirectory: input.runtimeDirectory } : {}),
      timeoutMs: input.timeoutMs,
      outputBytes: input.outputBytes,
      spawned: false,
      workingDirectoryBinding: input.windowsHandoff
        ? 'approved-root-handoff'
        : input.pinnedCwd
          ? 'descriptor'
          : 'path',
      targetHandoff: 'not_started',
    },
  };
}

/** Keeps a single operation active, including approval revalidation and persistence. */
export class VerificationRunner {
  private active: { projectId: string; runId: string; controller: AbortController } | null = null;
  private quarantined = false;
  constructor(
    private readonly deps: RunnerDependencies,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}
  async run(projectId: string, runId: string): Promise<StoredRunProposal> {
    if (this.quarantined)
      throw new Error('Verification runner unavailable after an uncertain outcome');
    if (this.active) throw new Error('A verification is already running');
    const active = { projectId, runId, controller: new AbortController() };
    this.active = active;
    try {
      const approval = await this.deps.consume(projectId, runId);
      if (
        !approval ||
        approval.run.projectId !== projectId ||
        approval.run.id !== runId ||
        approval.run.state !== 'proposed' ||
        approval.run.verified
      )
        throw new Error('Valid check approval required');
      if (active.controller.signal.aborted) {
        await this.deps.cancelPending(projectId, runId, approval.run.version);
        throw new Error('Verification cancelled before claim');
      }
      if (!approval.snapshot.runtimeDirectory)
        throw new Error('Approved runtime directory required');
      const windowsHandoff =
        this.platform === 'win32'
          ? createWindowsApprovedRootHandoff({
              projectId,
              auditId: approval.run.auditId,
              runId,
              proposalVersion: approval.run.version,
              rootPath: approval.snapshot.root,
              rootIdentity: approval.snapshot.identity,
              proposal: approval.run.proposal,
            })
          : undefined;
      const directory = this.deps.open(approval);
      try {
        if (active.controller.signal.aborted) {
          await this.deps.cancelPending(projectId, runId, approval.run.version);
          throw new Error('Verification cancelled before claim');
        }
        if (
          !isAbsolute(this.deps.npmExecutable) ||
          basename(this.deps.npmExecutable) !== 'npm' ||
          !isAbsolute(this.deps.helperExecutable) ||
          this.deps.npmExecutable !== approval.snapshot.npmExecutable ||
          this.deps.helperExecutable !== approval.snapshot.helperExecutable
        )
          throw new Error('Invalid trusted executable configuration');
        // Reserve durably before claiming or spawning. Ambiguous failures keep
        // the reservation so a new instance cannot silently start another run.
        const reservationOwner = runId;
        if (!(await this.deps.acquireReservation(reservationOwner, projectId)))
          throw new Error('Verification reservation is already held');
        // A rejected or ambiguous claim may have committed. Never issue another
        // run from this instance until the owning service resolves that state.
        this.quarantined = true;
        const claimed = await this.deps.claim(projectId, runId, approval.run.version);
        if (
          claimed.id !== runId ||
          claimed.projectId !== projectId ||
          claimed.auditId !== approval.run.auditId ||
          claimed.state !== 'running' ||
          claimed.version !== approval.run.version + 1 ||
          JSON.stringify(claimed.proposal) !== JSON.stringify(approval.run.proposal)
        )
          throw new Error('Claimed run differs from approved proposal');
        const proposal = approval.run.proposal;
        const expectedCwd =
          proposal.workingDirectory === '.'
            ? approval.snapshot.root
            : join(approval.snapshot.root, proposal.workingDirectory);
        const processInput: ProcessInput = {
          executable: this.deps.npmExecutable,
          args: [...proposal.args],
          cwd: expectedCwd,
          env: {},
          runtimeDirectory: approval.snapshot.runtimeDirectory,
          timeoutMs: proposal.limits.timeoutMs,
          cpuTimeSeconds: Math.max(1, Math.ceil(proposal.limits.timeoutMs / 1000)),
          processCount: proposal.limits.processCount,
          memoryBytes: proposal.limits.memoryBytes,
          outputBytes: proposal.limits.outputBytes,
          sandboxMode: proposal.sandboxMode,
          ...(windowsHandoff
            ? {}
            : { pinnedCwd: { ...directory, helperExecutable: this.deps.helperExecutable } }),
          ...(windowsHandoff ? { windowsHandoff } : {}),
          signal: active.controller.signal,
        };
        let result: ProcessResult;
        try {
          result = await this.deps.execute(processInput);
        } catch (error) {
          if (error instanceof ResourceLimitRefusalError && this.deps.refuse) {
            let refused: StoredRunProposal;
            try {
              refused = await this.deps.refuse(
                projectId,
                runId,
                claimed.version,
                createResourceLimitRefusalResult(error, processInput)
              );
            } catch (persistError) {
              try {
                await this.deps.markUnknown(projectId, runId, claimed.version);
              } catch {
                throw new Error('Resource-limit refusal could not be persisted', {
                  cause: persistError,
                });
              }
              throw persistError;
            }
            if (!(await this.deps.releaseReservation(reservationOwner)))
              throw new Error(
                'Resource-limit refusal was recorded but its reservation remains held'
              );
            this.quarantined = false;
            return refused;
          }
          // The executor may have started a process before failing. Record that
          // uncertainty without claiming the process or its descendants stopped.
          try {
            await this.deps.markUnknown(projectId, runId, claimed.version);
          } catch {
            throw new Error('Execution outcome unknown and could not be persisted', {
              cause: error,
            });
          }
          throw error;
        }
        const execution = result.execution;
        const mismatch =
          execution.executable !== this.deps.npmExecutable ||
          execution.executable !== approval.snapshot.npmExecutable ||
          JSON.stringify(execution.args) !== JSON.stringify(proposal.args) ||
          execution.cwd !== expectedCwd ||
          execution.workingDirectoryBinding !==
            (windowsHandoff ? 'approved-root-handoff' : 'descriptor') ||
          execution.timeoutMs !== proposal.limits.timeoutMs ||
          execution.outputBytes !== proposal.limits.outputBytes ||
          execution.runtimeDirectory !== approval.snapshot.runtimeDirectory ||
          result.effectiveLimits.cpuTimeSeconds !==
            Math.max(1, Math.ceil(proposal.limits.timeoutMs / 1000)) ||
          result.effectiveLimits.processCount !== proposal.limits.processCount ||
          result.effectiveLimits.memory !== proposal.limits.memoryBytes ||
          result.sandboxMode !== proposal.sandboxMode ||
          execution.environmentKeys.some(
            (key) =>
              key !== 'PATH' &&
              key !== 'HOME' &&
              key !== 'TMPDIR' &&
              !proposal.environmentAllowlist.some((allowed) => allowed === key)
          );
        let finished: StoredRunProposal;
        try {
          finished = await this.deps.finish(projectId, runId, claimed.version, {
            ...result,
            effectiveLimits: {
              ...result.effectiveLimits,
              concurrency: 'durable-single-flight',
            },
            executionMatchesProposal: !mismatch,
          });
        } catch (error) {
          // The write may have committed despite an error. This conditional
          // transition only changes the exact still-running version; it cannot
          // overwrite a committed result or imply that descendants stopped.
          try {
            await this.deps.markUnknown(projectId, runId, claimed.version);
          } catch {
            throw new Error('Result persistence uncertain; run state requires reconciliation', {
              cause: error,
            });
          }
          throw error;
        }
        // An adapter may have returned while detached descendants remain alive.
        if (!result.terminationUnconfirmed) {
          if (!(await this.deps.releaseReservation(reservationOwner)))
            throw new Error('Verification reservation could not be released');
          this.quarantined = false;
        }
        return finished;
      } finally {
        this.deps.release(directory.fd);
      }
    } finally {
      this.active = null;
    }
  }
  cancel(projectId: string, runId: string): boolean {
    if (!this.active || this.active.projectId !== projectId || this.active.runId !== runId)
      return false;
    this.active.controller.abort();
    return true;
  }
}
