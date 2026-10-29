import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeProjectFs } from '../native/access-registry';
import { readGitDirtyState } from './git-dirty-state';
import { readGitRevision } from './git-revision';

function getNative(): NativeProjectFs {
  return createRequire(import.meta.url)(
    join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
  ) as NativeProjectFs;
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
async function setup(): Promise<{ root: string; identity: string; expected: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tracemind-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  await writeFile(join(dir, 'file'), 'hello');
  git(dir, 'add', 'file');
  git(dir, 'commit', '-qm', 'fixture');
  const root = await realpath(dir);
  const info = await stat(root, { bigint: true });
  return { root, identity: `${info.dev}:${info.ino}`, expected: git(root, 'rev-parse', 'HEAD') };
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'descriptor-based Git revision',
  () => {
    it('reads a loose and then a packed branch ref', async () => {
      const { root, identity, expected } = await setup();
      try {
        expect(await readGitRevision(getNative(), root, identity)).toBe(expected);
        git(root, 'pack-refs', '--all', '--prune');
        expect(await readGitRevision(getNative(), root, identity)).toBe(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('reads a detached HEAD', async () => {
      const { root, identity, expected } = await setup();
      try {
        git(root, 'checkout', '-q', '--detach');
        expect(await readGitRevision(getNative(), root, identity)).toBe(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('reports clean, tracked-dirty, staged, and untracked repository states', async () => {
      const { root, identity } = await setup();
      try {
        const native = getNative();
        expect(await readGitDirtyState(native, root, identity)).toEqual({
          dirty: false,
          reason: null,
        });
        await writeFile(join(root, 'file'), 'changed');
        expect(await readGitDirtyState(native, root, identity)).toEqual({
          dirty: true,
          reason: null,
        });
        git(root, 'add', 'file');
        expect(await readGitDirtyState(native, root, identity)).toEqual({
          dirty: true,
          reason: null,
        });
        git(root, 'commit', '-qm', 'second');
        await writeFile(join(root, 'new-file'), 'untracked');
        expect(await readGitDirtyState(native, root, identity)).toEqual({
          dirty: true,
          reason: null,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('runs Git from the pinned root descriptor after its pathname is replaced', async () => {
      const { root } = await setup();
      const native = getNative();
      const rootFd = native.openRoot(root);
      const moved = `${root}.pinned`;
      const helper = join(process.cwd(), 'dist-tracemind-native', 'tracemind_git_cwd');
      try {
        await rename(root, moved);
        await mkdir(root);
        const result = spawnSync(helper, ['status', '--porcelain=v1'], {
          cwd: '/',
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' },
          stdio: ['ignore', 'pipe', 'pipe', rootFd],
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
      } finally {
        closeSync(rootFd);
        await rm(root, { recursive: true, force: true });
        await rename(moved, root);
        await rm(root, { recursive: true, force: true });
      }
    });
    it('returns unknown for a non-repository and rejects a wrong root identity', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-git-'));
      try {
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        expect(await readGitRevision(getNative(), canonical, `${info.dev}:${info.ino}`)).toBeNull();
        expect(await readGitDirtyState(getNative(), canonical, `${info.dev}:${info.ino}`)).toEqual({
          dirty: null,
          reason: 'unsupported',
        });
        await expect(readGitRevision(getNative(), canonical, '0:0')).rejects.toThrow('changed');
        await expect(readGitDirtyState(getNative(), canonical, '0:0')).rejects.toThrow('changed');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);
