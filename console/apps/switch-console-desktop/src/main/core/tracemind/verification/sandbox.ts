import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, statSync } from 'node:fs';

export const sandboxModes = ['macos-sandbox-exec', 'linux-bubblewrap', 'unavailable'] as const;
export type SandboxMode = (typeof sandboxModes)[number];

const macSandboxExecutable = '/usr/bin/sandbox-exec';
const linuxBubblewrapCandidates = ['/usr/bin/bwrap', '/bin/bwrap'];

function trustedExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    const info = statSync(path);
    return info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function availableMacSandbox(): boolean {
  if (!trustedExecutable(macSandboxExecutable)) return false;
  const probe = spawnSync(
    macSandboxExecutable,
    ['-p', '(version 1) (deny default) (allow file-read*) (allow process-exec)', '/usr/bin/true'],
    { stdio: 'ignore', timeout: 2_000 }
  );
  return !probe.error && probe.status === 0;
}

function availableLinuxBubblewrap(): boolean {
  const executable = linuxBubblewrapCandidates.find(trustedExecutable);
  if (!executable) return false;
  let directoryFd: number | undefined;
  try {
    directoryFd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
    const probe = spawnSync(
      executable,
      [
        '--unshare-user',
        '--unshare-pid',
        '--unshare-net',
        '--die-with-parent',
        '--ro-bind',
        '/',
        '/',
        '--bind-fd',
        '3',
        '/tmp',
        '--chdir',
        '/tmp',
        '--json-status-fd',
        '4',
        '/usr/bin/true',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', directoryFd, 'pipe'], timeout: 2_000 }
    );
    const status = probe.output[4]?.toString() ?? '';
    return (
      !probe.error &&
      probe.status === 0 &&
      status.split('\n').some((line) => line.includes('"exit-code": 0'))
    );
  } catch {
    return false;
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

/** Uses only fixed, root-owned OS sandbox executables; never searches project PATH. */
export function detectSandboxMode(platform = process.platform): SandboxMode {
  if (platform === 'darwin' && availableMacSandbox()) return 'macos-sandbox-exec';
  if (platform === 'linux' && availableLinuxBubblewrap()) return 'linux-bubblewrap';
  return 'unavailable';
}

export function getSandboxExecutable(mode: SandboxMode): string | null {
  if (mode === 'macos-sandbox-exec' && trustedExecutable(macSandboxExecutable))
    return macSandboxExecutable;
  if (mode === 'linux-bubblewrap') return linuxBubblewrapCandidates.find(trustedExecutable) ?? null;
  return null;
}

/** Runs Bubblewrap through the trusted helper when CPU and/or cgroup limits are requested. */
export function linuxBubblewrapHostHelperArgs(
  bubblewrapExecutable: string,
  bubblewrapArgs: readonly string[],
  options: { cgroup: boolean; cpuTimeSeconds?: number }
): string[] {
  if (!bubblewrapExecutable.startsWith('/') || bubblewrapExecutable.includes('\0'))
    throw new Error('Invalid Bubblewrap executable');
  if (
    options.cpuTimeSeconds !== undefined &&
    (!Number.isSafeInteger(options.cpuTimeSeconds) ||
      options.cpuTimeSeconds < 1 ||
      options.cpuTimeSeconds > 600)
  ) {
    throw new Error('Invalid CPU time limit');
  }
  return [
    ...(options.cpuTimeSeconds === undefined
      ? []
      : ['--cpu-seconds', String(options.cpuTimeSeconds)]),
    ...(options.cgroup ? ['--cgroup-procs-fd', '5'] : []),
    '--preserve-helper-fds',
    bubblewrapExecutable,
    ...bubblewrapArgs,
  ];
}

/** Compatibility name for callers that only need the cgroup-host helper. */
export function linuxCgroupHostHelperArgs(
  bubblewrapExecutable: string,
  bubblewrapArgs: readonly string[]
): string[] {
  return linuxBubblewrapHostHelperArgs(bubblewrapExecutable, bubblewrapArgs, { cgroup: true });
}

function profilePath(path: string): string {
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path))
    throw new Error('Invalid sandbox path');
  return JSON.stringify(path);
}

/** Read access remains host-wide; writes are confined to the approved cwd and one private temp dir. */
export function macosSandboxProfile(workingDirectory: string, temporaryDirectory: string): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${profilePath(workingDirectory)}))`,
    `(allow file-write* (subpath ${profilePath(temporaryDirectory)}))`,
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow sysctl-read)',
  ].join(' ');
}

export function linuxBubblewrapArgs(input: {
  workingDirectory: string;
  temporaryDirectory: string;
  pinnedDirectoryFd?: number;
  executable: string;
  args: readonly string[];
}): string[] {
  const pinned = input.pinnedDirectoryFd !== undefined;
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...(pinned
      ? ['--bind-fd', '3', input.workingDirectory]
      : ['--bind', input.workingDirectory, input.workingDirectory]),
    '--bind',
    input.temporaryDirectory,
    input.temporaryDirectory,
    '--chdir',
    input.workingDirectory,
    ...(pinned ? ['--json-status-fd', '4'] : []),
    input.executable,
    ...input.args,
  ];
}
