import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintOpenedFiles } from './fingerprint';

describe('opened-file fingerprint', () => {
  it('hashes real file contents deterministically independent of input order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-fingerprint-'));
    try {
      await writeFile(join(root, 'a'), 'alpha');
      await writeFile(join(root, 'b'), 'beta');
      const a = await open(join(root, 'a'), 'r');
      const b = await open(join(root, 'b'), 'r');
      try {
        const one = await fingerprintOpenedFiles(
          [
            { path: 'b', handle: b },
            { path: 'a', handle: a },
          ],
          100
        );
        const two = await fingerprintOpenedFiles(
          [
            { path: 'a', handle: a },
            { path: 'b', handle: b },
          ],
          100
        );
        expect(one.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(one).toEqual(two);
        await writeFile(join(root, 'a'), 'other');
        const changed = await fingerprintOpenedFiles(
          [
            { path: 'a', handle: a },
            { path: 'b', handle: b },
          ],
          100
        );
        expect(changed.fingerprint).not.toEqual(one.fingerprint);
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not produce a partial fingerprint when the byte budget is exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-fingerprint-'));
    try {
      await writeFile(join(root, 'a'), 'hello');
      const handle = await open(join(root, 'a'), 'r');
      try {
        expect(await fingerprintOpenedFiles([{ path: 'a', handle }], 4)).toEqual({
          fingerprint: null,
          reason: 'byte_limit',
        });
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects duplicate and escaping paths and invalid budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-fingerprint-'));
    try {
      await writeFile(join(root, 'a'), 'a');
      const handle = await open(join(root, 'a'), 'r');
      try {
        await expect(fingerprintOpenedFiles([{ path: '../a', handle }], 10)).rejects.toThrow();
        await expect(
          fingerprintOpenedFiles(
            [
              { path: 'a', handle },
              { path: 'a', handle },
            ],
            10
          )
        ).rejects.toThrow();
        await expect(fingerprintOpenedFiles([{ path: 'a', handle }], 0)).rejects.toThrow();
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
