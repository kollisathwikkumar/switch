import { createHash } from 'node:crypto';
import type { ProjectFileHandle } from '../native/access-registry';

export interface OpenedProjectFile {
  /** Project-relative path with forward slashes, supplied by the access registry. */
  path: string;
  /** Opened and confined by the caller; this function does not own or close it. */
  handle: ProjectFileHandle;
}

export type FingerprintResult =
  | { fingerprint: string; reason: null }
  | { fingerprint: null; reason: 'byte_limit' | 'file_changed' | 'not_regular_file' };

function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new Error('Invalid project-relative path');
}

/** Hashes already-open handles only; the caller must ensure complete, confined input. */
export async function fingerprintOpenedFiles(
  input: readonly OpenedProjectFile[],
  maxBytes: number
): Promise<FingerprintResult> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1_073_741_824 ||
    input.length > 100_000
  ) {
    throw new Error('Invalid fingerprint limits');
  }
  const files = [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set<string>();
  for (const file of files) {
    validatePath(file.path);
    if (paths.has(file.path)) throw new Error('Duplicate file path');
    paths.add(file.path);
  }
  const tree = createHash('sha256');
  tree.update('tracemind-files-v1\0');
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (const file of files) {
    const before = await file.handle.stat({ bigint: true });
    if (!before.isFile()) return { fingerprint: null, reason: 'not_regular_file' };
    if (before.size > BigInt(maxBytes - bytes)) return { fingerprint: null, reason: 'byte_limit' };
    const digest = createHash('sha256');
    let position = 0;
    while (true) {
      const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) return { fingerprint: null, reason: 'byte_limit' };
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(position) !== after.size
    ) {
      return { fingerprint: null, reason: 'file_changed' };
    }
    tree.update(JSON.stringify([file.path, digest.digest('hex')]));
    tree.update('\n');
  }
  return { fingerprint: tree.digest('hex'), reason: null };
}
