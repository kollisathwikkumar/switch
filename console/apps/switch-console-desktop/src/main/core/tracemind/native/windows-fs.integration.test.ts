import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProject, type NativeProjectFs } from './access-registry';

const addonPath = join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node');
const native = existsSync(addonPath)
  ? (createRequire(import.meta.url)(addonPath) as NativeProjectFs)
  : undefined;
if (process.env.TRACEMIND_REQUIRE_WINDOWS === '1' && (process.platform !== 'win32' || !native)) {
  throw new Error(
    'TRACEMIND_REQUIRE_WINDOWS=1 requires the Windows runner and built native filesystem addon'
  );
}
const openHandles: number[] = [];
function close(fd: number): void {
  const index = openHandles.indexOf(fd);
  if (index >= 0) openHandles.splice(index, 1);
  native?.close?.(fd);
}
function closeOpenHandles(): void {
  for (const fd of [...openHandles].reverse()) close(fd);
}
afterEach(closeOpenHandles);

describe.skipIf(process.platform !== 'win32' || !native)(
  'Windows native project filesystem',
  () => {
    function openRoot(path: string): number {
      const fd = native!.openRoot(realpathSync(path));
      openHandles.push(fd);
      return fd;
    }

    function openChild(parent: number, name: string, directory: boolean): number {
      const fd = directory
        ? native!.openDirectory(parent, Buffer.from(name, 'utf8'))
        : native!.openFile(parent, Buffer.from(name, 'utf8'));
      openHandles.push(fd);
      return fd;
    }

    it('walks real directories with handle-backed identities and native reads', () => {
      const base = mkdtempSync(join(tmpdir(), 'tracemind-win-fs-'));
      const root = join(base, 'project');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'é.ts'), 'approved bytes');
      try {
        const rootFd = openRoot(root);
        const identity = native!.identity!(rootFd);
        expect(identity).toMatch(/^win32:[a-f0-9]{16}:[a-f0-9]{32}$/);
        expect(native!.list(rootFd, 10).names.map((name) => name.toString('utf8'))).toEqual([
          'src',
        ]);
        const sourceFd = openChild(openChild(rootFd, 'src', true), 'é.ts', false);
        const info = native!.stat!(sourceFd);
        expect(info.file).toBe(true);
        expect(info.directory).toBe(false);
        expect(info.size).toBe(BigInt('approved bytes'.length));
        expect(typeof info.ino).toBe('bigint');
        expect(typeof info.mtimeNs).toBe('bigint');
        const bytes = Buffer.alloc(Number(info.size));
        const bytesRead = native!.read!(sourceFd, bytes, 0, bytes.length, 0);
        expect(bytes.subarray(0, bytesRead).toString('utf8')).toBe('approved bytes');
        expect(native!.identity!(sourceFd)).toMatch(/^win32:[a-f0-9]{16}:[a-f0-9]{32}$/);
        expect(() => native!.stat!(0)).toThrow('Unknown Windows project handle');
        expect(() => native!.read!(0, Buffer.alloc(1), 0, 1, 0)).toThrow(
          'Unknown Windows project handle'
        );
      } finally {
        closeOpenHandles();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('runs the shared TraceMind scanner through the Windows native handle API', async () => {
      const base = mkdtempSync(join(tmpdir(), 'tracemind-win-scan-'));
      const root = join(base, 'project');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node test.js"}}');
      writeFileSync(join(root, 'src', 'test.js'), 'console.log("scan proof")');
      let rootFd = -1;
      try {
        rootFd = openRoot(root);
        const expectedIdentity = native!.identity!(rootFd);
        close(rootFd);
        rootFd = -1;
        const visited: string[] = [];
        const result = await scanProject(
          native!,
          realpathSync(root),
          expectedIdentity,
          { maxEntries: 100, maxDepth: 10 },
          async (path, file) => {
            const info = await file.stat({ bigint: true });
            const bytes = Buffer.alloc(Number(info.size));
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            visited.push(`${path}:${bytes.subarray(0, bytesRead).toString('utf8')}`);
          }
        );
        expect(result.complete).toBe(true);
        expect(result.errors).toEqual([]);
        expect(visited).toEqual([
          'package.json:{"scripts":{"test":"node test.js"}}',
          'src/test.js:console.log("scan proof")',
        ]);
      } finally {
        if (rootFd >= 0) close(rootFd);
        closeOpenHandles();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('rejects reparse points in project roots and child traversal', () => {
      const base = mkdtempSync(join(tmpdir(), 'tracemind-win-reparse-'));
      const project = join(base, 'project');
      const outside = join(base, 'outside');
      mkdirSync(project);
      mkdirSync(outside);
      mkdirSync(join(outside, 'secret-project'));
      const junction = join(project, 'external');
      try {
        symlinkSync(outside, junction, 'junction');
        const rootFd = openRoot(project);
        expect(native!.classify(rootFd, Buffer.from('external'))).toBe('symlink');
        expect(() => native!.openDirectory(rootFd, Buffer.from('external'))).toThrow();
        expect(() => native!.openRoot(junction)).toThrow();
        expect(() => native!.openRoot(join(junction, 'secret-project'))).toThrow();
        expect(() => native!.openDirectory(rootFd, Buffer.from('..'))).toThrow();
        expect(() => native!.openFile(rootFd, Buffer.from('file:stream'))).toThrow();
      } finally {
        closeOpenHandles();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('keeps the approved root and its ancestor chain non-renamable until the last child handle closes', () => {
      const base = mkdtempSync(join(tmpdir(), 'tracemind-win-pinned-'));
      const root = join(base, 'project');
      const moved = join(base, 'moved');
      mkdirSync(join(root, 'src'), { recursive: true });
      try {
        const rootFd = openRoot(root);
        const childFd = openChild(rootFd, 'src', true);
        close(rootFd);
        expect(() => renameSync(root, moved)).toThrow();
        close(childFd);
        renameSync(root, moved);
        expect(existsSync(moved)).toBe(true);
      } finally {
        closeOpenHandles();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('rejects device, UNC, traversal, alternate-stream, and noncanonical root paths', () => {
      const base = mkdtempSync(join(tmpdir(), 'tracemind-win-paths-'));
      const root = join(base, 'project');
      mkdirSync(root);
      try {
        const canonical = realpathSync(root);
        expect(() => native!.openRoot(`${canonical}\\..\\outside`)).toThrow();
        expect(() => native!.openRoot('\\\\server\\share\\project')).toThrow();
        expect(() => native!.openRoot('\\\\?\\C:\\project')).toThrow();
        expect(() => native!.openRoot('C:\\project\\file:stream')).toThrow();
      } finally {
        closeOpenHandles();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
);
