import { closeSync, fstatSync, read as readFd } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { isExcludedPathEntry } from '../audit/exclusions';
import type { SkippedEntry } from '../audit/file-inventory';

export interface NativeProjectFs {
  openRoot(path: string): number;
  openDirectory(parent: number, name: Buffer): number;
  openFile(parent: number, name: Buffer): number;
  classify(parent: number, name: Buffer): 'directory' | 'file' | 'symlink' | 'other';
  list(parent: number, limit: number): { names: Buffer[]; complete: boolean };
  /** Native file identity and close operations are mandatory in platform builds; optional only for legacy test fixtures. */
  identity?(fd: number): string;
  close?(fd: number): void;
  /** Windows returns file metadata from the retained HANDLE, never from a CRT fd. */
  stat?(fd: number): NativeProjectFileStat;
  /** Windows reads from the retained HANDLE at an explicit offset. */
  read?(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
}

export interface NativeProjectFileStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  file: boolean;
  directory: boolean;
}

export interface ProjectFileStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** Async, descriptor-backed reader; it never reopens a file by its project path. */
export interface ProjectFileHandle {
  stat(options: { bigint: true }): Promise<ProjectFileStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

/** Adapts an already-confined descriptor to the reader shape used by audit code. */
export function nativeFileIdentity(native: NativeProjectFs, fd: number): string {
  if (native.identity) return native.identity(fd);
  if (process.platform === 'win32') throw new Error('Native Windows file identity is unavailable');
  const info = fstatSync(fd, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

export function closeNativeFileHandle(native: NativeProjectFs, fd: number): void {
  if (native.close) {
    native.close(fd);
    return;
  }
  if (process.platform === 'win32') throw new Error('Native Windows handle cleanup is unavailable');
  closeSync(fd);
}

export function openProjectFileHandle(fd: number, native?: NativeProjectFs): ProjectFileHandle {
  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new Error('Project file handle is closed');
  };
  return {
    async stat(options) {
      ensureOpen();
      if (native?.stat) {
        const value = native.stat(fd);
        return {
          ...value,
          isFile: () => value.file,
          isDirectory: () => value.directory,
        };
      }
      if (process.platform === 'win32')
        throw new Error('Native Windows handle metadata is unavailable');
      return fstatSync(fd, options);
    },
    read(buffer, offset, length, position) {
      if (native?.read) {
        if (closed) return Promise.reject(new Error('Project file handle is closed'));
        try {
          const bytesRead = native.read(fd, buffer, offset, length, position);
          return Promise.resolve({ bytesRead, buffer });
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (process.platform === 'win32')
        return Promise.reject(new Error('Native Windows handle reading is unavailable'));
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error('Project file handle is closed'));
          return;
        }
        readFd(fd, buffer, offset, length, position, (error, bytesRead, resultBuffer) => {
          if (error) reject(error);
          else resolve({ bytesRead, buffer: resultBuffer });
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (native) closeNativeFileHandle(native, fd);
      else closeSync(fd);
    },
  };
}

export interface ScanResult {
  files: string[];
  skipped: number;
  skippedEntries: SkippedEntry[];
  skipDetailsTruncated: boolean;
  entriesExamined: number;
  complete: boolean;
  errors: { path: string; message: string }[];
}

interface Frame {
  fd: number;
  path: string;
  depth: number;
  names: (Buffer | undefined)[];
  index: number;
  complete: boolean;
}

/** Walks pinned directories with no-follow openat; visitor must not retain handles. */
export async function scanProject(
  native: NativeProjectFs,
  root: string,
  expectedIdentity: string,
  limits: { maxEntries: number; maxDepth: number; maxDurationMs?: number },
  visit: (path: string, file: ProjectFileHandle, parentDirectoryFd: number) => Promise<void>,
  now: () => number = () => performance.now()
): Promise<ScanResult> {
  const maxDurationMs = limits.maxDurationMs ?? 30_000;
  if (
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 120_000 ||
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    limits.maxEntries > 100_000 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    limits.maxDepth > 64
  )
    throw new Error('Invalid scan limits');
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32')
    throw new Error('Native project scanning is unavailable');
  const deadline = now() + maxDurationMs;
  const rootFd = native.openRoot(root);
  const stack: Frame[] = [];
  const result: ScanResult = {
    files: [],
    skipped: 0,
    skippedEntries: [],
    skipDetailsTruncated: false,
    entriesExamined: 0,
    complete: true,
    errors: [],
  };
  const error = (path: string, message: string): void => {
    result.complete = false;
    result.errors.push({ path, message });
  };
  try {
    if (nativeFileIdentity(native, rootFd) !== expectedIdentity)
      throw new Error('Project root changed after approval');
    const rootList = native.list(rootFd, limits.maxEntries);
    let bufferedNames = rootList.names.length;
    stack.push({
      fd: rootFd,
      path: '',
      depth: 0,
      names: rootList.names,
      index: 0,
      complete: rootList.complete,
    });
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      if (now() >= deadline) {
        error(frame.path, 'Time limit reached');
        break;
      }
      if (frame.index >= frame.names.length) {
        if (!frame.complete) error(frame.path, 'Entry limit reached');
        stack.pop();
        if (frame.fd !== rootFd) closeNativeFileHandle(native, frame.fd);
        continue;
      }
      if (result.entriesExamined >= limits.maxEntries) {
        error(frame.path, 'Entry limit reached');
        break;
      }
      const index = frame.index++;
      const bytes = frame.names[index];
      frame.names[index] = undefined;
      bufferedNames--;
      if (!bytes) throw new Error('Invalid directory entry');
      result.entriesExamined++;
      const name = bytes.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(bytes) || name.includes('\\')) {
        error(frame.path, 'Unsupported filename');
        continue;
      }
      const path = frame.path ? `${frame.path}/${name}` : name;
      let kind: ReturnType<NativeProjectFs['classify']>;
      try {
        kind = native.classify(frame.fd, bytes);
      } catch {
        error(path, 'Entry could not be inspected');
        continue;
      }
      if (
        isExcludedPathEntry(name, kind === 'directory', path) ||
        kind === 'symlink' ||
        kind === 'other'
      ) {
        result.skipped++;
        const reason = kind === 'symlink' ? 'symlink' : kind === 'other' ? 'special' : 'excluded';
        if (result.skippedEntries.length < 200 && path.length <= 4096) {
          result.skippedEntries.push({ path, reason });
        } else {
          result.skipDetailsTruncated = true;
        }
        continue;
      }
      if (kind === 'directory') {
        if (frame.depth >= limits.maxDepth) {
          error(path, 'Depth limit reached');
          continue;
        }
        let fd = -1;
        try {
          fd = native.openDirectory(frame.fd, bytes);
          const remaining = Math.min(
            limits.maxEntries - result.entriesExamined,
            limits.maxEntries - bufferedNames
          );
          if (!remaining) {
            closeNativeFileHandle(native, fd);
            fd = -1;
            error(path, 'Entry limit reached');
            continue;
          }
          const listing = native.list(fd, remaining);
          bufferedNames += listing.names.length;
          stack.push({
            fd,
            path,
            depth: frame.depth + 1,
            names: listing.names,
            index: 0,
            complete: listing.complete,
          });
        } catch {
          if (fd >= 0) closeNativeFileHandle(native, fd);
          error(path, 'Directory could not be opened');
        }
      } else {
        // Inventory the eligible path before opening/processing it. A file-level
        // failure must not erase its presence or stop later files from scanning.
        result.files.push(path);
        let fd = -1;
        let handle: ProjectFileHandle | null = null;
        try {
          fd = native.openFile(frame.fd, bytes);
          handle = openProjectFileHandle(fd, native);
          fd = -1;
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile()) throw new Error('Opened project entry is not a regular file');
        } catch {
          if (handle) await handle.close();
          if (fd >= 0) closeNativeFileHandle(native, fd);
          error(path, 'File could not be opened');
          continue;
        }
        try {
          await visit(path, handle, frame.fd);
        } catch {
          error(path, 'File could not be processed');
        } finally {
          try {
            await handle.close();
          } catch {
            error(path, 'File handle could not be closed');
          }
        }
      }
    }
  } finally {
    for (const frame of stack) if (frame.fd !== rootFd) closeNativeFileHandle(native, frame.fd);
    closeNativeFileHandle(native, rootFd);
  }
  result.files.sort();
  return result;
}
