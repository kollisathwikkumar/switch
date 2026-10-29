import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSelectedLocalProject, type LocalLocationCandidate } from './selected-project';

const lookup = (location: LocalLocationCandidate | undefined) => async (id: string) =>
  location?.id === id ? location : undefined;

describe('selected local project', () => {
  it('resolves a selected local location to its canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-location-'));
    try {
      expect(
        await resolveSelectedLocalProject('id', lookup({ id: 'id', dir: root, sshHost: null }))
      ).toEqual({ locationId: 'id', root: await realpath(root) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, remote and relative locations', async () => {
    await expect(resolveSelectedLocalProject('missing', lookup(undefined))).rejects.toThrow(
      'not found'
    );
    await expect(
      resolveSelectedLocalProject('id', lookup({ id: 'id', dir: tmpdir(), sshHost: 'remote' }))
    ).rejects.toThrow('local');
    await expect(
      resolveSelectedLocalProject('id', lookup({ id: 'id', dir: 'relative', sshHost: null }))
    ).rejects.toThrow('absolute');
  });

  it('rejects files and missing directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-location-'));
    try {
      const file = join(root, 'file');
      await writeFile(file, 'x');
      await expect(
        resolveSelectedLocalProject('id', lookup({ id: 'id', dir: file, sshHost: null }))
      ).rejects.toThrow('directory');
      await expect(
        resolveSelectedLocalProject(
          'id',
          lookup({ id: 'id', dir: join(root, 'missing'), sshHost: null })
        )
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
