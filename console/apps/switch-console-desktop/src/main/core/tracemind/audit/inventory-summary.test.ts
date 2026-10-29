import { describe, expect, it } from 'vitest';
import type { FileInventory } from './file-inventory';
import { summarizeInventory } from './inventory-summary';

const inventory: FileInventory = {
  root: '/fixture',
  files: ['src/app.ts', 'src/view.tsx', 'README.md', 'package.json', 'lib/main.py'],
  skipped: 3,
  errors: [],
  complete: true,
  entriesExamined: 9,
};

describe('inventory summary', () => {
  it('counts inferred languages and manifests without claiming parsing', () => {
    const summary = summarizeInventory(inventory);
    expect(summary.languages).toEqual([
      { language: 'Python', files: 1 },
      { language: 'TypeScript', files: 2 },
    ]);
    expect(summary.manifests).toEqual(['package.json']);
    expect(summary.filesDiscovered).toBe(5);
    expect(summary.filesParsed).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.inventoryComplete).toBe(true);
  });

  it('retains incomplete status and errors', () => {
    const summary = summarizeInventory({
      ...inventory,
      complete: false,
      errors: [{ path: 'blocked', message: 'Directory could not be read' }],
    });
    expect(summary.inventoryComplete).toBe(false);
    expect(summary.errors).toEqual([{ path: 'blocked', message: 'Directory could not be read' }]);
  });

  it('identifies nested manifests by exact filename', () => {
    const summary = summarizeInventory({
      ...inventory,
      files: ['x/package.json', 'package.json.bak', 'pyproject.toml', 'x/package.json'],
    });
    expect(summary.manifests).toEqual(['pyproject.toml', 'x/package.json']);
  });
});
