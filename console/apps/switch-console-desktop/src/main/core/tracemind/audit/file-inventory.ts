import { opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isExcludedPathEntry } from './exclusions';

export interface SkippedEntry {
  path: string;
  reason: 'excluded' | 'symlink' | 'special';
}

export interface FileInventory {
  root: string;
  files: string[];
  skipped: number;
  skippedEntries?: SkippedEntry[];
  skipDetailsTruncated?: boolean;
  errors: { path: string; message: string }[];
  complete: boolean;
  entriesExamined: number;
}

/** Inventory names only. The caller must authorize the project before calling. */
export async function inventoryFiles(
  projectRoot: string,
  maxEntries: number
): Promise<FileInventory> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new Error('Invalid inventory entry limit');
  }
  const root = await realpath(projectRoot);
  const result: FileInventory = {
    root,
    files: [],
    skipped: 0,
    errors: [],
    complete: true,
    entriesExamined: 0,
  };
  const directories = [''];
  while (directories.length > 0) {
    const relativeDir = directories.pop();
    if (relativeDir === undefined) break;
    try {
      const directory = await opendir(join(root, relativeDir));
      for await (const entry of directory) {
        if (result.entriesExamined >= maxEntries) {
          result.complete = false;
          break;
        }
        result.entriesExamined++;
        const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (
          entry.isSymbolicLink() ||
          isExcludedPathEntry(entry.name, entry.isDirectory(), relative)
        ) {
          result.skipped++;
        } else if (entry.isDirectory()) {
          directories.push(relative);
        } else if (entry.isFile()) {
          result.files.push(relative);
        } else {
          result.skipped++;
        }
      }
    } catch {
      result.errors.push({ path: relativeDir, message: 'Directory could not be read' });
      result.complete = false;
    }
    if (!result.complete && result.entriesExamined >= maxEntries) break;
  }
  result.files.sort();
  return result;
}
