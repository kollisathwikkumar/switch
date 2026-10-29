import { closeSync, existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeNativeFileHandle,
  openProjectFileHandle,
  scanProject,
  type NativeProjectFs,
} from './access-registry';

const built = join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node');
const path = process.env.TRACEMIND_NATIVE_PATH ?? (existsSync(built) ? built : undefined);
function getNative(): NativeProjectFs {
  if (!path) throw new Error('TRACEMIND_NATIVE_PATH is required');
  return createRequire(import.meta.url)(path) as NativeProjectFs;
}
async function identity(root: string): Promise<string> {
  if (path) {
    const native = getNative();
    const fd = native.openRoot(await realpath(root));
    try {
      return native.identity ? native.identity(fd) : fallbackIdentity(root);
    } finally {
      if (native.close) native.close(fd);
      else closeSync(fd);
    }
  }
  return fallbackIdentity(root);
}
async function fallbackIdentity(root: string): Promise<string> {
  const info = await stat(root, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

describe.skipIf(!path)('descriptor-relative project scan', () => {
  it('reads the already-open file handle after its original path is replaced', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tracemind-open-file-'));
    const native = getNative();
    let rootFd = -1;
    let fileFd = -1;
    try {
      const filePath = join(parent, 'source.ts');
      await writeFile(filePath, 'approved bytes');
      rootFd = native.openRoot(await realpath(parent));
      fileFd = native.openFile(rootFd, Buffer.from('source.ts'));
      let pathReplaced = false;
      try {
        await rename(filePath, join(parent, 'moved.ts'));
        await writeFile(filePath, 'replacement bytes');
        pathReplaced = true;
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      }

      const handle = openProjectFileHandle(fileFd, native);
      fileFd = -1;
      const info = await handle.stat({ bigint: true });
      const buffer = Buffer.alloc(Number(info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      expect(bytesRead).toBe('approved bytes'.length);
      expect(buffer.toString('utf8')).toBe('approved bytes');
      if (pathReplaced) expect(await readFile(filePath, 'utf8')).toBe('replacement bytes');
      await handle.close();
    } finally {
      if (fileFd >= 0) closeNativeFileHandle(native, fileFd);
      if (rootFd >= 0) closeNativeFileHandle(native, rootFd);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('visits regular files and skips excluded directories, secret files and symlinks', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tracemind-scan-'));
    try {
      const root = join(parent, 'project');
      await mkdir(root);
      await mkdir(join(root, 'src'));
      await mkdir(join(root, 'node_modules'));
      await mkdir(join(root, 'release'));
      await mkdir(join(root, 'dist-local-server'));
      await mkdir(join(root, '.venv'));
      await writeFile(join(root, 'src', 'a.ts'), 'hello');
      await writeFile(join(root, '.env'), 'secret');
      await writeFile(join(root, 'release', 'bundle.js'), 'generated');
      await writeFile(join(root, 'dist-local-server', 'module.py'), 'generated');
      await writeFile(join(root, '.venv', 'module.py'), 'installed');
      await symlink(parent, join(root, 'outside'));
      const visited: string[] = [];
      const result = await scanProject(
        getNative(),
        await realpath(root),
        await identity(root),
        { maxEntries: 100, maxDepth: 10 },
        async (path, handle) => {
          const info = await handle.stat({ bigint: true });
          const bytes = Buffer.alloc(Number(info.size));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          expect(bytes.subarray(0, bytesRead).toString('utf8')).toBe('hello');
          visited.push(path);
        }
      );
      expect(visited).toEqual(['src/a.ts']);
      expect(result.complete).toBe(true);
      expect(result.skipped).toBe(6);
      expect(result.skippedEntries).toEqual(
        expect.arrayContaining([
          { path: 'node_modules', reason: 'excluded' },
          { path: 'release', reason: 'excluded' },
          { path: 'dist-local-server', reason: 'excluded' },
          { path: '.venv', reason: 'excluded' },
          { path: '.env', reason: 'excluded' },
          { path: 'outside', reason: 'symlink' },
        ])
      );
      expect(result.skipDetailsTruncated).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  it('rejects a root replaced at the same path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tracemind-scan-'));
    try {
      const root = join(parent, 'project');
      await mkdir(root);
      const original = await identity(root);
      await rename(root, join(parent, 'old'));
      await mkdir(root);
      await expect(
        scanProject(getNative(), root, original, { maxEntries: 100, maxDepth: 10 }, async () => {})
      ).rejects.toThrow('changed');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  it('reports entry-budget truncation without pretending coverage is complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-scan-'));
    try {
      await writeFile(join(root, 'a'), 'a');
      await writeFile(join(root, 'b'), 'b');
      const result = await scanProject(
        getNative(),
        await realpath(root),
        await identity(root),
        { maxEntries: 1, maxDepth: 10 },
        async () => {}
      );
      expect(result.complete).toBe(false);
      expect(result.entriesExamined).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('continues past an unprocessable file and keeps its path in the incomplete inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-scan-file-error-'));
    try {
      await writeFile(join(root, 'a-problem.ts'), 'problem');
      await writeFile(join(root, 'b-good.ts'), 'good');
      const native = getNative();
      const ordered: NativeProjectFs = {
        openRoot: native.openRoot,
        openDirectory: native.openDirectory,
        openFile: native.openFile,
        classify: native.classify,
        identity: native.identity,
        close: native.close,
        list(fd, limit) {
          const listing = native.list(fd, limit);
          listing.names.sort((left, right) => left.toString().localeCompare(right.toString()));
          return listing;
        },
      };
      const visited: string[] = [];
      const result = await scanProject(
        ordered,
        await realpath(root),
        await identity(root),
        { maxEntries: 100, maxDepth: 10 },
        async (path) => {
          if (path === 'a-problem.ts') throw new Error('fixture read failure');
          visited.push(path);
        }
      );
      expect(visited).toEqual(['b-good.ts']);
      expect(result.files).toEqual(['a-problem.ts', 'b-good.ts']);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'a-problem.ts',
        message: 'File could not be processed',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.skipIf(!path)(
  'does not follow a directory swapped for a symlink after classification',
  async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tracemind-race-'));
    try {
      const root = join(parent, 'project');
      const outside = join(parent, 'outside');
      await mkdir(root);
      await mkdir(outside);
      await mkdir(join(root, 'src'));
      await writeFile(join(outside, 'secret'), 'secret');
      const { renameSync, symlinkSync } = await import('node:fs');
      const native = getNative();
      const raced: NativeProjectFs = {
        openRoot: native.openRoot,
        openDirectory: native.openDirectory,
        openFile: native.openFile,
        list: native.list,
        identity: native.identity,
        close: native.close,
        classify(fd, name) {
          const kind = native.classify(fd, name);
          if (name.toString() === 'src') {
            renameSync(join(root, 'src'), join(root, 'old'));
            symlinkSync(outside, join(root, 'src'));
          }
          return kind;
        },
      };
      const visited: string[] = [];
      const result = await scanProject(
        raced,
        await realpath(root),
        await identity(root),
        { maxEntries: 100, maxDepth: 10 },
        async (path) => {
          visited.push(path);
        }
      );
      expect(result.complete).toBe(false);
      expect(visited).not.toContain('src/secret');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
);

it.skipIf(!path)('does not open common credential files or directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracemind-secrets-'));
  try {
    await mkdir(join(root, '.ssh'));
    await mkdir(join(root, '.aws'));
    await mkdir(join(root, '.kube'));
    await writeFile(join(root, '.ssh', 'id_ed25519'), 'private');
    await writeFile(join(root, '.aws', 'credentials'), 'private');
    await writeFile(join(root, '.kube', 'config'), 'private');
    await writeFile(join(root, '.npmrc'), 'private');
    await writeFile(join(root, 'id_rsa'), 'private');
    await writeFile(join(root, 'cert.p12'), 'private');
    await writeFile(join(root, 'main.ts'), 'source');
    const visited: string[] = [];
    const result = await scanProject(
      getNative(),
      await realpath(root),
      await identity(root),
      { maxEntries: 100, maxDepth: 10 },
      async (name) => {
        visited.push(name);
      }
    );
    expect(visited).toEqual(['main.ts']);
    expect(result.skipped).toBe(6);
    expect(result.complete).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!path)('bounds pending entries across nested directory frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracemind-buffer-'));
  try {
    await mkdir(join(root, 'src'));
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, name), 'x');
    for (const name of ['d', 'e', 'f', 'g']) await writeFile(join(root, 'src', name), 'x');
    const native = getNative();
    const limits: number[] = [];
    const monitored: NativeProjectFs = {
      openRoot: native.openRoot,
      openDirectory: native.openDirectory,
      openFile: native.openFile,
      classify: native.classify,
      identity: native.identity,
      close: native.close,
      list(fd, limit) {
        limits.push(limit);
        const result = native.list(fd, limit);
        result.names.sort((a, b) => (a.toString() === 'src' ? -1 : b.toString() === 'src' ? 1 : 0));
        return result;
      },
    };
    const result = await scanProject(
      monitored,
      await realpath(root),
      await identity(root),
      { maxEntries: 6, maxDepth: 10 },
      async () => {}
    );
    expect(limits).toEqual([6, 3]);
    expect(result.complete).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!path)('bounds recorded skipped paths without hiding the total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracemind-skip-limit-'));
  try {
    await Promise.all(
      Array.from({ length: 205 }, (_, index) => writeFile(join(root, `.env.${index}`), 'secret'))
    );
    const result = await scanProject(
      getNative(),
      await realpath(root),
      await identity(root),
      { maxEntries: 500, maxDepth: 2 },
      async () => {}
    );
    expect(result.skipped).toBe(205);
    expect(result.skippedEntries).toHaveLength(200);
    expect(result.skipDetailsTruncated).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!path)('marks the scan incomplete when its cooperative deadline expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracemind-time-'));
  try {
    await writeFile(join(root, 'a'), 'a');
    await writeFile(join(root, 'b'), 'b');
    let now = 0;
    const result = await scanProject(
      getNative(),
      await realpath(root),
      await identity(root),
      { maxEntries: 100, maxDepth: 10, maxDurationMs: 10 },
      async () => {
        now = 10;
      },
      () => now
    );
    expect(result.complete).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.errors.some((item) => item.message === 'Time limit reached')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
