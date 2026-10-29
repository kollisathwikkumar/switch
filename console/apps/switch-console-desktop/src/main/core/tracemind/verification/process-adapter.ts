import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { prepareLinuxCgroupLimits, type PreparedLinuxCgroup } from './linux-cgroup-v2';
import {
  consumeLinuxTargetStatusChunk,
  createLinuxTargetStatusState,
  finishLinuxTargetStatusStream,
} from './linux-target-status';
import {
  detectSandboxMode,
  getSandboxExecutable,
  linuxBubblewrapHostHelperArgs,
  linuxBubblewrapArgs,
  macosSandboxProfile,
  sandboxModes,
  type SandboxMode,
} from './sandbox';
import {
  windowsApprovedRootHandoffSchema,
  type WindowsApprovedRootHandoff,
} from './windows-handoff';

export interface ProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Optional per-process CPU-time cap applied by the trusted POSIX cwd helper. */
  cpuTimeSeconds?: number;
  /** Linux cgroup v2 limits; only reported effective after helper attachment succeeds. */
  processCount?: number;
  memoryBytes?: number;
  outputBytes: number;
  sandboxMode?: SandboxMode;
  signal?: AbortSignal;
  /** Trusted main-process configuration; never derive this from a project or renderer. */
  runtimeDirectory?: string;
  /** Internal callers own and retain this already-confined directory descriptor. */
  pinnedCwd?: { fd: number; identity: string; helperExecutable: string };
  /** Versioned authorization material created from the consumed approval by the main runner. */
  windowsHandoff?: WindowsApprovedRootHandoff;
}
export interface ProcessResult {
  /** The trusted runner records the exact comparison result; absence is not proof of a match. */
  executionMatchesProposal?: boolean;
  /** Actual adapter input, not a claim that it matched an approved proposal. */
  execution: {
    executable: string;
    args: string[];
    cwd: string;
    environmentKeys: string[];
    runtimeDirectory?: string;
    timeoutMs: number;
    outputBytes: number;
    /** Spawn event for the adapter child; with a helper this is not the target. */
    spawned: boolean;
    workingDirectoryBinding: 'path' | 'descriptor' | 'approved-root-handoff';
    targetHandoff: 'direct' | 'exec_handoff' | 'failed' | 'unknown' | 'not_started';
  };
  status:
    | 'exited'
    | 'timed_out'
    | 'cancelled'
    | 'crashed'
    | 'output_limit'
    | 'spawn_error'
    | 'resource_limit_refused';
  /** Present only when a mandatory resource control was unavailable before spawn. */
  resourceLimitRefusal?: {
    platform: string;
    missingControls: Array<'memoryBytes' | 'processCount'>;
    reason: string;
  };
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Digests describe the bytes observed before the process streams closed. */
  stdoutHash: string;
  stderrHash: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  capturedComplete: boolean;
  /** No process-tree isolation means termination of descendants cannot be confirmed. */
  terminationUnconfirmed: boolean;
  sandboxMode: SandboxMode;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  effectiveLimits: {
    timeout: 'termination-request';
    output: 'retained-bytes';
    concurrency: 'per-instance' | 'durable-single-flight';
    cpuTimeSeconds: number | false;
    processCount: number | false;
    memory: number | false;
  };
}

/** A typed, pre-spawn refusal; it never means that a process or target was started. */
export class ResourceLimitRefusalError extends Error {
  readonly missingControls: Array<'memoryBytes' | 'processCount'>;

  constructor(
    readonly platform: string,
    missingControls: readonly ('memoryBytes' | 'processCount')[]
  ) {
    const controls = [...new Set(missingControls)];
    const descriptions = controls.map((control) =>
      control === 'memoryBytes'
        ? 'memoryBytes (no verified OS memory controller)'
        : 'processCount (no verified OS process-count controller)'
    );
    super(`Resource limits fail closed on ${platform}: ${descriptions.join(', ')}`);
    this.name = 'ResourceLimitRefusalError';
    this.missingControls = controls;
  }
}

export interface LinuxBubblewrapStatusState {
  hostHelperReady: boolean;
  cgroupAttached: boolean;
  childStarted: boolean;
  childExitCode: number | null;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Consumes one JSON-lines record; unknown Bubblewrap records are forward-compatible. */
export function consumeLinuxBubblewrapStatusLine(
  line: string,
  state: LinuxBubblewrapStatusState
): boolean {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(line) as JsonValue;
  } catch {
    return false;
  }
  if (!isJsonRecord(parsed)) return false;
  const hasHelperReady = Object.hasOwn(parsed, 'tracemind-host-helper-ready');
  const hasCgroupAttached = Object.hasOwn(parsed, 'tracemind-cgroup-attached');
  if (hasHelperReady || hasCgroupAttached) {
    if (
      !hasHelperReady ||
      !hasCgroupAttached ||
      parsed['tracemind-host-helper-ready'] !== true ||
      typeof parsed['tracemind-cgroup-attached'] !== 'boolean' ||
      state.hostHelperReady
    ) {
      return false;
    }
    state.hostHelperReady = true;
    state.cgroupAttached = parsed['tracemind-cgroup-attached'];
    return true;
  }
  const hasChildPid = Object.hasOwn(parsed, 'child-pid');
  const hasExitCode = Object.hasOwn(parsed, 'exit-code');
  if (!hasChildPid && !hasExitCode) return true;
  if (hasChildPid && hasExitCode) return false;
  if (hasChildPid) {
    const childPid = parsed['child-pid'];
    if (
      typeof childPid !== 'number' ||
      !Number.isSafeInteger(childPid) ||
      childPid <= 0 ||
      state.childStarted ||
      state.childExitCode !== null
    ) {
      return false;
    }
    state.childStarted = true;
    return true;
  }
  const exitCode = parsed['exit-code'];
  if (
    typeof exitCode !== 'number' ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255 ||
    !state.childStarted ||
    state.childExitCode !== null
  ) {
    return false;
  }
  state.childExitCode = exitCode;
  return true;
}

const inputSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !value.includes('\0')),
    args: z
      .array(
        z
          .string()
          .max(65_536)
          .refine((value) => !value.includes('\0'))
      )
      .max(128),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !value.includes('\0')),
    env: z.partialRecord(
      z.enum(['CI', 'NO_COLOR', 'FORCE_COLOR']),
      z
        .string()
        .max(128)
        .refine((value) => !/[\x00-\x1f\x7f]/.test(value))
    ),
    timeoutMs: z.number().int().min(1).max(600_000),
    cpuTimeSeconds: z.number().int().min(1).max(600).optional(),
    processCount: z.number().int().min(1).max(128).optional(),
    memoryBytes: z.number().int().min(1).max(2_147_483_648).optional(),
    outputBytes: z.number().int().min(1).max(10_000_000),
    sandboxMode: z.enum(sandboxModes).default('unavailable'),
    runtimeDirectory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !/[\x00-\x1f\x7f:]/.test(value))
      .optional(),
    pinnedCwd: z
      .object({
        fd: z.number().int().min(0),
        identity: z.string().regex(/^\d{1,40}:\d{1,40}$/),
        helperExecutable: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => isAbsolute(value) && !value.includes('\0')),
      })
      .strict()
      .optional(),
    windowsHandoff: windowsApprovedRootHandoffSchema.optional(),
  })
  .strict();

/** Internal adapter; it applies the proposal's OS sandbox but is not an authorization boundary. */
export class ProcessAdapter {
  private active = false;
  private quarantined = false;

  async run(input: ProcessInput): Promise<ProcessResult> {
    const { signal: abortSignal, ...raw } = input;
    const spec = inputSchema.parse(raw);
    if (spec.runtimeDirectory && process.platform === 'win32')
      throw new Error('Explicit runtime path unavailable on this platform');
    if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal)) {
      throw new Error('Invalid cancellation signal');
    }
    if (process.platform !== 'linux') {
      const missingControls: Array<'memoryBytes' | 'processCount'> = [
        ...(spec.memoryBytes === undefined ? [] : (['memoryBytes'] as const)),
        ...(spec.processCount === undefined ? [] : (['processCount'] as const)),
      ];
      if (missingControls.length > 0) {
        throw new ResourceLimitRefusalError(process.platform, missingControls);
      }
    }
    if (process.platform === 'win32' && !spec.windowsHandoff)
      throw new Error('Validated Windows approved-root handoff required');
    if (process.platform !== 'win32' && spec.windowsHandoff)
      throw new Error('Windows approved-root handoff supplied on a non-Windows host');
    if (process.platform === 'win32') {
      throw new ResourceLimitRefusalError('win32', ['memoryBytes', 'processCount']);
    }
    if (this.quarantined)
      throw new Error('Verification adapter unavailable after unconfirmed termination');
    if (this.active) throw new Error('A verification process is already running');
    if (spec.pinnedCwd) {
      if (process.platform !== 'darwin' && process.platform !== 'linux')
        throw new Error('Descriptor-bound execution unavailable');
      const stat = fstatSync(spec.pinnedCwd.fd, { bigint: true });
      if (!stat.isDirectory() || `${stat.dev}:${stat.ino}` !== spec.pinnedCwd.identity)
        throw new Error('Working directory descriptor changed');
    }
    this.active = true;
    try {
      const result = await execute(spec, abortSignal);
      if (result.terminationUnconfirmed) this.quarantined = true;
      return result;
    } finally {
      this.active = false;
    }
  }
}

type ProcessSpec = z.infer<typeof inputSchema>;
async function execute(
  spec: ProcessSpec,
  abortSignal: AbortSignal | undefined
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const started = performance.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let retained = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let stop: 'timed_out' | 'cancelled' | 'output_limit' | null = abortSignal?.aborted
    ? 'cancelled'
    : null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let spawnFailed = false;
  let spawned = false;
  let handoffFailure = false;
  let handoffEnded = false;
  let handoffMarker = '';
  let linuxStatusBuffer = '';
  let linuxStatusTailIncomplete = false;
  const linuxTargetStatus = createLinuxTargetStatusState();
  let linuxTargetStreamEnded = false;
  const linuxStatus: LinuxBubblewrapStatusState = {
    hostHelperReady: false,
    cgroupAttached: false,
    childStarted: false,
    childExitCode: null,
  };
  let terminationUnconfirmed = false;
  let child: ChildProcess | undefined;
  let actualSandboxMode: SandboxMode = 'unavailable';
  let preparedSandboxMode: SandboxMode = 'unavailable';
  let sandboxTempDirectory: string | undefined;
  let linuxCgroup: PreparedLinuxCgroup | null = null;
  const kill = () => {
    linuxCgroup?.terminate();
    if (!child) return;
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch {
        /* Process may have already exited. */
      }
    }
    child.kill('SIGKILL');
  };
  if (!stop) {
    try {
      if (
        spec.pinnedCwd &&
        spec.sandboxMode === 'linux-bubblewrap' &&
        spec.processCount !== undefined &&
        spec.memoryBytes !== undefined
      ) {
        linuxCgroup = await prepareLinuxCgroupLimits({
          processCount: spec.processCount,
          memoryBytes: spec.memoryBytes,
        });
      }
      const targetExecutable = spec.pinnedCwd?.helperExecutable ?? spec.executable;
      const targetArgs = spec.pinnedCwd
        ? [
            ...(spec.cpuTimeSeconds === undefined
              ? []
              : ['--cpu-seconds', String(spec.cpuTimeSeconds)]),
            spec.executable,
            ...spec.args,
          ]
        : spec.args;
      const baseEnvironment = {
        ...spec.env,
        ...(spec.runtimeDirectory ? { PATH: `${spec.runtimeDirectory}:/usr/bin:/bin` } : {}),
      };
      let adapterExecutable = targetExecutable;
      let adapterArgs = targetArgs;
      let adapterCwd = spec.pinnedCwd ? '/' : spec.cwd;
      let adapterEnvironment: Record<string, string> = baseEnvironment;
      if (spec.sandboxMode !== 'unavailable') {
        if (detectSandboxMode() !== spec.sandboxMode)
          throw new Error('Approved OS sandbox is no longer available');
        sandboxTempDirectory = await mkdtemp(join(tmpdir(), 'tracemind-run-'));
        sandboxTempDirectory = await realpath(sandboxTempDirectory);
        const workingDirectory = await realpath(spec.cwd);
        const workingDirectoryStat = await stat(workingDirectory, { bigint: true });
        const pinnedDirectoryStat = spec.pinnedCwd
          ? fstatSync(spec.pinnedCwd.fd, { bigint: true })
          : null;
        if (
          spec.pinnedCwd &&
          (`${workingDirectoryStat.dev}:${workingDirectoryStat.ino}` !== spec.pinnedCwd.identity ||
            !pinnedDirectoryStat?.isDirectory() ||
            `${pinnedDirectoryStat.dev}:${pinnedDirectoryStat.ino}` !== spec.pinnedCwd.identity)
        )
          throw new Error('Approved working directory changed before sandbox setup');
        adapterEnvironment = {
          ...baseEnvironment,
          HOME: sandboxTempDirectory,
          TMPDIR: sandboxTempDirectory,
        };
        if (spec.sandboxMode === 'macos-sandbox-exec') {
          const sandboxExecutable = getSandboxExecutable(spec.sandboxMode);
          if (!sandboxExecutable) throw new Error('macOS sandbox executable is unavailable');
          adapterExecutable = sandboxExecutable;
          adapterArgs = [
            '-p',
            macosSandboxProfile(workingDirectory, sandboxTempDirectory),
            targetExecutable,
            ...targetArgs,
          ];
          adapterCwd = spec.pinnedCwd ? '/' : workingDirectory;
        } else {
          if (!spec.pinnedCwd)
            throw new Error('Linux Bubblewrap requires descriptor-bound target status helper');
          const sandboxExecutable = getSandboxExecutable(spec.sandboxMode);
          if (!sandboxExecutable) throw new Error('Linux bubblewrap executable is unavailable');
          const bubblewrapArgs = linuxBubblewrapArgs({
            workingDirectory,
            temporaryDirectory: sandboxTempDirectory,
            pinnedDirectoryFd: spec.pinnedCwd.fd,
            executable: spec.pinnedCwd.helperExecutable,
            args: ['--target-wrapper', spec.executable, ...spec.args],
          });
          if (spec.pinnedCwd && (linuxCgroup !== null || spec.cpuTimeSeconds !== undefined)) {
            // Apply CPU limits and optional cgroup membership before Bubblewrap starts.
            // Bubblewrap binds fd 3 directly and reports successful command exec via fd 4.
            adapterExecutable = spec.pinnedCwd.helperExecutable;
            adapterArgs = linuxBubblewrapHostHelperArgs(sandboxExecutable, bubblewrapArgs, {
              cgroup: linuxCgroup !== null,
              ...(spec.cpuTimeSeconds === undefined ? {} : { cpuTimeSeconds: spec.cpuTimeSeconds }),
            });
          } else {
            adapterExecutable = sandboxExecutable;
            adapterArgs = bubblewrapArgs;
          }
          adapterCwd = '/';
        }
        preparedSandboxMode = spec.sandboxMode;
      }
      const childStdio: (number | 'ignore' | 'pipe')[] = ['ignore', 'pipe', 'pipe'];
      if (spec.pinnedCwd) childStdio.push(spec.pinnedCwd.fd, 'pipe');
      if (linuxCgroup) childStdio.push(linuxCgroup.procsFd);
      child = spawn(adapterExecutable, adapterArgs, {
        cwd: adapterCwd,
        env: adapterEnvironment,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: childStdio,
      });
      const running = child;
      let completionConfirmed = false;
      if (spec.pinnedCwd) {
        const handoff = running.stdio[4];
        if (!handoff || !('on' in handoff)) handoffFailure = true;
        else if (spec.sandboxMode === 'linux-bubblewrap') {
          handoff.on('data', (chunk: Buffer | string) => {
            const incoming = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
            if (linuxStatusBuffer.length + incoming.length > 4_096) {
              handoffFailure = true;
              return;
            }
            linuxStatusBuffer += incoming;
            let newline = linuxStatusBuffer.indexOf('\n');
            while (newline !== -1) {
              const line = linuxStatusBuffer.slice(0, newline).trim();
              linuxStatusBuffer = linuxStatusBuffer.slice(newline + 1);
              if (line && !consumeLinuxBubblewrapStatusLine(line, linuxStatus))
                handoffFailure = true;
              newline = linuxStatusBuffer.indexOf('\n');
            }
          });
          handoff.on('end', () => {
            if (linuxStatusBuffer.trim()) linuxStatusTailIncomplete = true;
          });
          handoff.on('error', () => {
            handoffFailure = true;
          });
        } else {
          handoff.on('data', (chunk: Buffer | string) => {
            const incoming = Buffer.isBuffer(chunk) ? chunk.toString('ascii') : chunk;
            if (handoffMarker.length + incoming.length > 1) handoffFailure = true;
            handoffMarker = (handoffMarker + incoming).slice(0, 2);
            if (handoffMarker !== 'S' && handoffMarker !== 'E') handoffFailure = true;
          });
          handoff.on('end', () => {
            handoffEnded = true;
            if (handoffMarker !== 'S') handoffFailure = true;
          });
          handoff.on('error', () => {
            handoffFailure = true;
          });
        }
      }
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveCompletion: () => void = () => {};
      let closed = false;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
        running.once('spawn', () => {
          spawned = true;
          actualSandboxMode = preparedSandboxMode;
        });
        running.once('error', () => {
          spawnFailed = true;
        });
        running.once('close', (code, signal) => {
          if (closed) return;
          closed = true;
          completionConfirmed = true;
          exitCode = code;
          exitSignal = signal;
          resolve();
        });
      });
      const forceFinish = () => {
        if (closed) return;
        closed = true;
        terminationUnconfirmed = true;
        running.stdout?.off('data', onStdout);
        running.stderr?.off('data', onStderr);
        running.stdout?.destroy();
        running.stderr?.destroy();
        running.unref();
        resolveCompletion();
      };
      const requestStop = (reason: 'timed_out' | 'cancelled' | 'output_limit') => {
        if (stop) return;
        stop = reason;
        // Closing pipes and killing the process group cannot prove that a detached
        // descendant stopped. Preserve uncertainty and quarantine this adapter.
        if (running.pid !== undefined && preparedSandboxMode !== 'linux-bubblewrap' && !linuxCgroup)
          terminationUnconfirmed = true;
        kill();
        forceTimer = setTimeout(forceFinish, 250);
      };
      const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        (stream === 'stdout' ? stdoutHash : stderrHash).update(chunk);
        const remaining = Math.max(0, spec.outputBytes - retained);
        const kept = chunk.subarray(0, remaining);
        if (kept.length) (stream === 'stdout' ? stdout : stderr).push(kept);
        retained += kept.length;
        if (kept.length < chunk.length) {
          if (stream === 'stdout') stdoutTruncated = true;
          else stderrTruncated = true;
          requestStop('output_limit');
        }
      };
      const onStdout = (chunk: Buffer) => {
        if (preparedSandboxMode === 'linux-bubblewrap' && spec.pinnedCwd) {
          if (!consumeLinuxTargetStatusChunk(chunk, linuxTargetStatus, capture))
            handoffFailure = true;
          return;
        }
        capture('stdout', chunk);
      };
      const onStderr = (chunk: Buffer) => capture('stderr', chunk);
      running.stdout?.on('data', onStdout);
      running.stdout?.on('end', () => {
        if (preparedSandboxMode === 'linux-bubblewrap' && spec.pinnedCwd)
          linuxTargetStreamEnded = true;
      });
      running.stderr?.on('data', onStderr);
      const cancel = () => requestStop('cancelled');
      abortSignal?.addEventListener('abort', cancel, { once: true });
      if (abortSignal?.aborted) cancel();
      const timer = setTimeout(() => requestStop('timed_out'), spec.timeoutMs);
      timer.unref();
      try {
        await completion;
        if (preparedSandboxMode === 'linux-bubblewrap' && !completionConfirmed)
          terminationUnconfirmed = true;
        if (preparedSandboxMode === 'linux-bubblewrap' && spec.pinnedCwd && !handoffFailure) {
          const targetStreamComplete =
            linuxTargetStreamEnded && finishLinuxTargetStatusStream(linuxTargetStatus);
          if (linuxStatusTailIncomplete && exitSignal === null && stop === null) {
            handoffFailure = true;
          }
          if (stop === null) {
            const targetResultComplete =
              targetStreamComplete &&
              linuxTargetStatus.complete &&
              linuxTargetStatus.wrapperError === null &&
              !linuxTargetStatus.invalid;
            const expectedBubblewrapExit =
              linuxTargetStatus.exitCode ??
              (linuxTargetStatus.signal === null ? null : 128 + linuxTargetStatus.signal);
            if (
              linuxTargetStatus.wrapperError !== null ||
              !targetResultComplete ||
              expectedBubblewrapExit === null ||
              linuxStatus.childExitCode !== expectedBubblewrapExit ||
              exitSignal !== null ||
              exitCode !== expectedBubblewrapExit
            ) {
              handoffFailure = true;
            } else {
              handoffEnded = true;
            }
          } else if (linuxTargetStatus.started && linuxTargetStatus.complete) {
            handoffEnded = true;
          }
          if (stop === null && !linuxStatus.childStarted) {
            handoffFailure = true;
          }
          if (handoffFailure) handoffEnded = false;
        }
      } finally {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        abortSignal?.removeEventListener('abort', cancel);
      }
    } catch {
      spawnFailed = true;
      kill();
    }
  }
  const cgroupAttached = Boolean(
    linuxCgroup &&
    spawned &&
    linuxStatus.hostHelperReady &&
    linuxStatus.cgroupAttached &&
    String(actualSandboxMode) === 'linux-bubblewrap'
  );
  if (linuxCgroup) {
    const cgroupEmpty = await linuxCgroup.cleanup();
    if (!cgroupEmpty) terminationUnconfirmed = true;
    else if (cgroupAttached) terminationUnconfirmed = false;
  }
  // macOS's profile and the unsandboxed fallback do not contain a process tree.
  // Bubblewrap's PID namespace or a confirmed-empty cgroup does.
  if (spawned && String(actualSandboxMode) !== 'linux-bubblewrap' && !cgroupAttached)
    terminationUnconfirmed = true;
  const linuxTargetContract =
    preparedSandboxMode === 'linux-bubblewrap' && spec.pinnedCwd !== undefined;
  const linuxTargetSignal = linuxTargetContract ? linuxTargetStatus.signal : null;
  const linuxTargetExitCode = linuxTargetContract ? linuxTargetStatus.exitCode : null;
  const status: ProcessResult['status'] =
    stop ??
    (spawnFailed
      ? 'spawn_error'
      : linuxTargetContract
        ? handoffFailure || !handoffEnded || linuxTargetStatus.wrapperError !== null
          ? 'spawn_error'
          : linuxTargetSignal !== null
            ? 'crashed'
            : linuxTargetExitCode === null
              ? 'spawn_error'
              : 'exited'
        : exitSignal !== null || exitCode === null
          ? 'crashed'
          : spec.pinnedCwd && (handoffFailure || !handoffEnded)
            ? 'spawn_error'
            : 'exited');
  if (sandboxTempDirectory) {
    try {
      await rm(sandboxTempDirectory, { recursive: true, force: true });
    } catch {
      /* A temporary-directory cleanup failure does not change the process outcome. */
    }
  }
  return {
    execution: {
      executable: spec.executable,
      args: spec.args,
      cwd: spec.cwd,
      environmentKeys: [
        ...Object.keys(spec.env),
        ...(spec.runtimeDirectory ? ['PATH'] : []),
        ...(actualSandboxMode !== 'unavailable' ? ['HOME', 'TMPDIR'] : []),
      ].sort(),
      ...(spec.runtimeDirectory ? { runtimeDirectory: spec.runtimeDirectory } : {}),
      timeoutMs: spec.timeoutMs,
      outputBytes: spec.outputBytes,
      spawned,
      workingDirectoryBinding: spec.windowsHandoff
        ? 'approved-root-handoff'
        : spec.pinnedCwd
          ? 'descriptor'
          : 'path',
      targetHandoff: !spec.pinnedCwd
        ? 'direct'
        : handoffFailure
          ? 'failed'
          : handoffEnded
            ? 'exec_handoff'
            : 'unknown',
    },
    status,
    exitCode:
      status === 'spawn_error' || linuxTargetSignal !== null
        ? null
        : linuxTargetContract
          ? linuxTargetExitCode
          : exitCode,
    signal:
      status === 'spawn_error'
        ? null
        : linuxTargetContract
          ? linuxTargetSignal === null
            ? null
            : (Object.entries(osConstants.signals).find(
                ([, value]) => value === linuxTargetSignal
              )?.[0] ?? `SIG${linuxTargetSignal}`)
          : exitSignal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdoutHash: stdoutHash.digest('hex'),
    stderrHash: stderrHash.digest('hex'),
    stdoutTruncated,
    stderrTruncated,
    capturedComplete:
      status === 'exited' && !terminationUnconfirmed && !stdoutTruncated && !stderrTruncated,
    terminationUnconfirmed,
    sandboxMode: actualSandboxMode,
    startedAt,
    endedAt: Date.now(),
    durationMs: Math.max(0, performance.now() - started),
    effectiveLimits: {
      timeout: 'termination-request',
      output: 'retained-bytes',
      concurrency: 'per-instance',
      cpuTimeSeconds:
        spec.pinnedCwd && handoffEnded && !handoffFailure ? (spec.cpuTimeSeconds ?? false) : false,
      processCount: cgroupAttached ? (spec.processCount ?? false) : false,
      memory: cgroupAttached ? (spec.memoryBytes ?? false) : false,
    },
  };
}
