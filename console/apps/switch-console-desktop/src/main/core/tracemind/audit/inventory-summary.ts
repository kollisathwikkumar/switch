import { posix } from 'node:path';
import type { FileInventory, SkippedEntry } from './file-inventory';

export interface InventorySummary {
  filesDiscovered: number;
  filesParsed: number;
  graphCoverage?: { status: 'complete' | 'partial'; omittedFiles: number };
  skipped: number;
  skippedEntries?: SkippedEntry[];
  skipDetailsTruncated?: boolean;
  inventoryComplete: boolean;
  errors: { path: string; message: string }[];
  languages: { language: string; files: number }[];
  manifests: string[];
  limitations: string[];
}

const extensions: Readonly<Record<string, string>> = {
  '.c': 'C',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.go': 'Go',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
};
const manifestNames = new Set([
  'Cargo.toml',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
]);

/** Summarizes filename metadata only; it does not parse or read file contents. */
export function summarizeInventory(inventory: FileInventory): InventorySummary {
  const counts = new Map<string, number>();
  const manifests = new Set<string>();
  for (const file of inventory.files) {
    const language = extensions[posix.extname(file).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    if (manifestNames.has(posix.basename(file))) manifests.add(file);
  }
  return {
    filesDiscovered: inventory.files.length,
    filesParsed: 0,
    skipped: inventory.skipped,
    ...(inventory.skippedEntries
      ? {
          skippedEntries: inventory.skippedEntries,
          skipDetailsTruncated: inventory.skipDetailsTruncated ?? false,
        }
      : {}),
    inventoryComplete: inventory.complete && inventory.errors.length === 0,
    errors: inventory.errors.map((error) => ({ ...error })),
    languages: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, files]) => ({ language, files })),
    manifests: [...manifests].sort(),
    limitations: [
      'Languages are inferred from filenames; contents were not parsed.',
      'Excluded paths, unsupported extensions and inaccessible directories are not analyzed.',
      'Common credential paths are excluded; other secrets may not be recognized.',
    ],
  };
}
