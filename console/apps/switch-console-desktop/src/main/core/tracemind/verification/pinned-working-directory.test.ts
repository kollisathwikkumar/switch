import { closeSync, fstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NativeProjectFs } from '../native/access-registry';
import { discoverPackageChecks } from './command-contract';
import { openVerifiedWorkingDirectory } from './pinned-working-directory';
const native = (): NativeProjectFs =>
  createRequire(import.meta.url)(
    join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
  ) as NativeProjectFs;
const identity = async (path: string) => {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}`;
};
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'verified working-directory handoff',
  () => {
    it('opens the approved directory and rejects a replacement or symlink', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-pinned-cwd-'));
      try {
        const base = await realpath(root);
        await mkdir(join(root, 'nested'));
        const snapshot = {
          root: base,
          identity: await identity(root),
          workingDirectoryIdentity: await identity(join(root, 'nested')),
          fingerprint: 'a'.repeat(64),
        };
        const proposal = discoverPackageChecks(
          '{"scripts":{"test":"echo test"}}',
          'nested',
          'audit:fixture'
        )[0]!;
        const opened = openVerifiedWorkingDirectory(snapshot, proposal, native());
        try {
          const info = fstatSync(opened.fd, { bigint: true });
          expect(`${info.dev}:${info.ino}`).toBe(snapshot.workingDirectoryIdentity);
          await rename(join(root, 'nested'), join(root, 'old'));
          await mkdir(join(root, 'nested'));
          const stillPinned = fstatSync(opened.fd, { bigint: true });
          expect(`${stillPinned.dev}:${stillPinned.ino}`).toBe(snapshot.workingDirectoryIdentity);
        } finally {
          closeSync(opened.fd);
        }
        expect(() => openVerifiedWorkingDirectory(snapshot, proposal, native())).toThrow();
        await rm(join(root, 'nested'), { recursive: true });
        await symlink(join(root, 'old'), join(root, 'nested'));
        expect(() => openVerifiedWorkingDirectory(snapshot, proposal, native())).toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);

it('checks Windows working-directory descriptors with native handle metadata', () => {
  const rootIdentity = 'win32:0123456789abcdef:00112233445566778899aabbccddeeff';
  const directoryIdentity = 'win32:1123456789abcdef:10112233445566778899aabbccddeeff';
  const api: NativeProjectFs = {
    openRoot: vi.fn(() => 101),
    openDirectory: vi.fn(() => 102),
    openFile: vi.fn(() => 103),
    classify: vi.fn(() => 'directory' as const),
    list: vi.fn(() => ({ names: [], complete: true })),
    identity: vi.fn((fd) => (fd === 101 ? rootIdentity : directoryIdentity)),
    close: vi.fn(),
    stat: vi.fn(() => ({
      dev: 1n,
      ino: 2n,
      size: 0n,
      mtimeNs: 3n,
      ctimeNs: 4n,
      file: false,
      directory: true,
    })),
  };
  const proposal = discoverPackageChecks(
    '{"scripts":{"test":"echo test"}}',
    'nested',
    'audit:fixture'
  )[0]!;

  const opened = openVerifiedWorkingDirectory(
    {
      root: '/fixture/project',
      identity: rootIdentity,
      workingDirectoryIdentity: directoryIdentity,
      fingerprint: 'a'.repeat(64),
    },
    proposal,
    api
  );

  expect(opened).toEqual({ fd: 102, identity: directoryIdentity });
  expect(api.stat).toHaveBeenNthCalledWith(1, 101);
  expect(api.stat).toHaveBeenNthCalledWith(2, 102);
  expect(api.close).toHaveBeenCalledWith(101);
});
