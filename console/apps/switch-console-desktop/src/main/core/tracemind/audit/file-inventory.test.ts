import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inventoryFiles } from './file-inventory';

describe('file inventory', () => {
  it('skips excluded directories, secret filenames and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-inventory-'));
    try {
      await mkdir(join(root, 'src'));
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, 'src', 'index.ts'), 'content');
      await writeFile(join(root, '.env'), 'secret');
      await symlink(tmpdir(), join(root, 'outside'));
      const result = await inventoryFiles(root, 100);
      expect(result.files).toEqual(['src/index.ts']);
      expect(result.skipped).toBe(3);
      expect(result.complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips packaged outputs and common language build environments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-generated-inventory-'));
    const generatedDirectories = [
      'release',
      'out',
      'dist-local-server',
      'dist-sidecar',
      '.venv',
      'venv',
      '__pycache__',
      '.cache',
      'target',
    ];
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'index.ts'), 'source');
      for (const directory of generatedDirectories) {
        await mkdir(join(root, directory));
        await writeFile(join(root, directory, 'generated.py'), 'compiled or vendored output');
      }

      const result = await inventoryFiles(root, 100);

      expect(result.files).toEqual(['src/index.ts']);
      expect(result.skipped).toBe(generatedDirectories.length);
      expect(result.complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports budget exhaustion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-inventory-'));
    try {
      await writeFile(join(root, 'a'), 'a');
      await writeFile(join(root, 'b'), 'b');
      const result = await inventoryFiles(root, 1);
      expect(result.complete).toBe(false);
      expect(result.files).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid budgets', async () => {
    await expect(inventoryFiles(tmpdir(), 0)).rejects.toThrow('Invalid inventory entry limit');
    await expect(inventoryFiles(tmpdir(), Infinity)).rejects.toThrow(
      'Invalid inventory entry limit'
    );
  });
});
