import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  closeNativeFileHandle,
  nativeFileIdentity,
  type NativeProjectFs,
} from '../native/access-registry';

const maxStatusBytes = 4 * 1024 * 1024;
const statusTimeoutMs = 10_000;

export type GitDirtyState =
  | { dirty: boolean; reason: null }
  | { dirty: null; reason: 'unsupported' | 'git_failed' | 'timeout' | 'output_limit' };

/** Reads bounded porcelain Git status without optional index writes. */
export async function readGitDirtyState(
  native: NativeProjectFs,
  root: string,
  expectedIdentity: string,
  helperExecutable = join(process.cwd(), 'dist-tracemind-native', 'tracemind_git_cwd')
): Promise<GitDirtyState> {
  const rootFd = native.openRoot(root);
  let gitFd = -1;
  try {
    if (nativeFileIdentity(native, rootFd) !== expectedIdentity)
      throw new Error('Project root changed after approval');
    try {
      gitFd = native.openDirectory(rootFd, Buffer.from('.git'));
    } catch {
      return { dirty: null, reason: 'unsupported' };
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      return { dirty: null, reason: 'unsupported' };

    let timedOut = false;
    let outputLimited = false;
    let outputBytes = 0;
    const child = spawn(
      helperExecutable,
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
        '--ignore-submodules=all',
        '--no-renames',
      ],
      {
        cwd: '/',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'ignore', rootFd] as const,
      }
    );
    const stdout = child.stdout;
    if (!stdout) {
      child.kill('SIGKILL');
      throw new Error('Git status output stream unavailable');
    }
    stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxStatusBytes) {
        outputLimited = true;
        child.kill('SIGKILL');
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, statusTimeoutMs);
    timer.unref();
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } catch {
      assertRootIdentity(native, root, expectedIdentity);
      return { dirty: null, reason: 'git_failed' };
    } finally {
      clearTimeout(timer);
    }
    assertRootIdentity(native, root, expectedIdentity);
    if (timedOut) return { dirty: null, reason: 'timeout' };
    if (outputLimited) return { dirty: null, reason: 'output_limit' };
    if (exitCode !== 0) return { dirty: null, reason: 'git_failed' };
    return { dirty: outputBytes > 0, reason: null };
  } finally {
    if (gitFd >= 0) closeNativeFileHandle(native, gitFd);
    closeNativeFileHandle(native, rootFd);
  }
}

function assertRootIdentity(native: NativeProjectFs, root: string, expectedIdentity: string): void {
  const rootFd = native.openRoot(root);
  try {
    if (nativeFileIdentity(native, rootFd) !== expectedIdentity)
      throw new Error('Project root changed during Git status');
  } finally {
    closeNativeFileHandle(native, rootFd);
  }
}
