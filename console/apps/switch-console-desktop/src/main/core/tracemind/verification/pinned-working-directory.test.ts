import { closeSync, fstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
