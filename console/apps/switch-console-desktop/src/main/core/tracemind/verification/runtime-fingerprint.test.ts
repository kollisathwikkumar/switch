import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fingerprintRuntime } from './runtime-fingerprint';

it('fingerprints bounded executable bytes and detects replacement at the same path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracemind-runtime-'));
  try {
    const npm = join(dir, 'npm');
    const node = join(dir, 'node');
    const helper = join(dir, 'helper');
    await Promise.all([
      writeFile(npm, 'npm-one'),
      writeFile(node, 'node-one'),
      writeFile(helper, 'helper-one'),
    ]);
    const first = await fingerprintRuntime([npm, node, helper]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await fingerprintRuntime([npm, node, helper])).toBe(first);
    await writeFile(npm, 'npm-two');
    expect(await fingerprintRuntime([npm, node, helper])).not.toBe(first);
    const link = join(dir, 'link');
    await symlink(npm, link);
    const linked = await fingerprintRuntime([link, node, helper]);
    expect(linked).toMatch(/^[a-f0-9]{64}$/);
    await unlink(link);
    await symlink(node, link);
    expect(await fingerprintRuntime([link, node, helper])).not.toBe(linked);
    await expect(fingerprintRuntime([npm, node, helper], 1)).rejects.toThrow('limit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rejects a FIFO runtime without waiting for a writer',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracemind-fifo-'));
    const fifo = join(dir, 'npm');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const operation = fingerprintRuntime([fifo, fifo, fifo]).then(
      () => 'accepted',
      () => 'rejected'
    );
    try {
      const result = await Promise.race([
        operation,
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ]);
      expect(result).toBe('rejected');
    } finally {
      const release = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      await operation;
      await release.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
