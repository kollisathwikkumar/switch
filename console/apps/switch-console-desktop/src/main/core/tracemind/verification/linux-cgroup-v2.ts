import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rmdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';

const emptyCheckMs = 1_500;

export interface LinuxCgroupLocation {
  mountPoint: string;
  mountRoot: string;
  processPath: string;
}

export interface LinuxCgroupLimits {
  processCount: number;
  memoryBytes: number;
}

export interface PreparedLinuxCgroup {
  readonly procsFd: number;
  /** Synchronously asks the kernel to SIGKILL every task in the private cgroup. */
  terminate(): void;
  /** Confirms the cgroup is empty and removes only this invocation's cgroup. */
  cleanup(): Promise<boolean>;
}

function unescapeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => {
    switch (code) {
      case '040':
        return ' ';
      case '011':
        return '\t';
      case '012':
        return '\n';
      default:
        return '\\';
    }
  });
}

function isWithin(parent: string, child: string): boolean {
  const relative = posix.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative))
  );
}

/** Resolves this process's cgroup v2 directory from procfs, rejecting paths outside its mount root. */
export function parseLinuxCgroupLocation(
  mountInfo: string,
  cgroupInfo: string
): LinuxCgroupLocation | null {
  const currentLine = cgroupInfo.split('\n').find((line) => line.startsWith('0::'));
  const currentCgroup = currentLine?.slice(3);
  if (!currentCgroup?.startsWith('/') || currentCgroup.includes('\0')) return null;

  for (const line of mountInfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!before || !after) continue;
    const fields = before.split(' ');
    const filesystem = after.split(' ', 1)[0];
    if (filesystem !== 'cgroup2') continue;
    const mountRoot = fields[3] ? unescapeMountField(fields[3]) : null;
    const mountPoint = fields[4] ? unescapeMountField(fields[4]) : null;
    if (!mountRoot?.startsWith('/') || !mountPoint?.startsWith('/')) continue;
    const normalizedRoot = posix.normalize(mountRoot);
    const normalizedCgroup = posix.normalize(currentCgroup);
    if (!isWithin(normalizedRoot, normalizedCgroup)) continue;
    const relativeCgroup = posix.relative(normalizedRoot, normalizedCgroup);
    const processPath = posix.resolve(mountPoint, relativeCgroup);
    if (!isWithin(posix.resolve(mountPoint), processPath)) continue;
    return { mountPoint: posix.resolve(mountPoint), mountRoot: normalizedRoot, processPath };
  }
  return null;
}

async function writeControl(path: string, value: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    await handle.writeFile(`${value}\n`);
  } finally {
    await handle.close();
  }
}

function tryTerminate(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(posix.join(path, 'cgroup.kill'), constants.O_WRONLY | constants.O_NOFOLLOW);
    writeSync(fd, '1\n');
  } catch {
    // Cleanup will report that termination could not be confirmed.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function waitUntilEmpty(path: string): Promise<boolean> {
  const deadline = Date.now() + emptyCheckMs;
  while (Date.now() < deadline) {
    try {
      const events = await readFile(posix.join(path, 'cgroup.events'), 'utf8');
      if (/^populated 0$/m.test(events)) return true;
      if (!/^populated 1$/m.test(events)) return false;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * Creates a private cgroup under the nearest writable delegated ancestor of
 * this process. Both requested controllers must already be enabled there. It
 * never enables controllers on a shared parent or uses per-UID RLIMIT_NPROC.
 */
export async function prepareLinuxCgroupLimits(
  limits: LinuxCgroupLimits
): Promise<PreparedLinuxCgroup | null> {
  if (process.platform !== 'linux') return null;
  if (
    !Number.isSafeInteger(limits.processCount) ||
    limits.processCount < 1 ||
    limits.processCount > 128 ||
    !Number.isSafeInteger(limits.memoryBytes) ||
    limits.memoryBytes < 1 ||
    limits.memoryBytes > 2_147_483_648
  ) {
    throw new Error('Invalid Linux cgroup limits');
  }

  let groupPath: string | undefined;
  let procsHandle: FileHandle | undefined;
  let groupCreated = false;
  try {
    const [mountInfo, cgroupInfo] = await Promise.all([
      readFile('/proc/self/mountinfo', 'utf8'),
      readFile('/proc/self/cgroup', 'utf8'),
    ]);
    const location = parseLinuxCgroupLocation(mountInfo, cgroupInfo);
    if (!location) return null;
    const mountRealPath = await realpath(location.mountPoint);
    const processRealPath = await realpath(location.processPath);
    if (!isWithin(mountRealPath, processRealPath)) return null;
    let candidateParent = processRealPath;
    while (isWithin(mountRealPath, candidateParent) && candidateParent !== mountRealPath) {
      try {
        const [controllers, subtreeControl] = await Promise.all([
          readFile(posix.join(candidateParent, 'cgroup.controllers'), 'utf8'),
          readFile(posix.join(candidateParent, 'cgroup.subtree_control'), 'utf8'),
        ]);
        const available = new Set(controllers.trim().split(/\s+/));
        const enabled = new Set(subtreeControl.trim().split(/\s+/));
        if (
          available.has('memory') &&
          available.has('pids') &&
          enabled.has('memory') &&
          enabled.has('pids')
        ) {
          const proposedPath = posix.join(
            candidateParent,
            `tracemind-${process.pid}-${randomUUID()}`
          );
          try {
            await mkdir(proposedPath, { mode: 0o700 });
            groupPath = proposedPath;
            groupCreated = true;
            break;
          } catch {
            // Try another ancestor only when delegation does not permit this child.
          }
        }
      } catch {
        // Some ancestors may not be readable; continue only within this process's lineage.
      }
      candidateParent = posix.dirname(candidateParent);
    }
    if (!groupPath) return null;
    if (!isWithin(mountRealPath, await realpath(groupPath))) {
      await rmdir(groupPath);
      return null;
    }
    await writeControl(posix.join(groupPath, 'memory.max'), String(limits.memoryBytes));
    // The request is a hard memory cap, not a RAM-only cap that can be bypassed
    // by moving anonymous pages to unlimited swap.
    await writeControl(posix.join(groupPath, 'memory.swap.max'), '0');
    await writeControl(posix.join(groupPath, 'pids.max'), String(limits.processCount));
    await writeControl(posix.join(groupPath, 'memory.oom.group'), '1');
    const [memoryMax, memorySwapMax, pidsMax, oomGroup] = await Promise.all([
      readFile(posix.join(groupPath, 'memory.max'), 'utf8'),
      readFile(posix.join(groupPath, 'memory.swap.max'), 'utf8'),
      readFile(posix.join(groupPath, 'pids.max'), 'utf8'),
      readFile(posix.join(groupPath, 'memory.oom.group'), 'utf8'),
    ]);
    if (
      memoryMax.trim() !== String(limits.memoryBytes) ||
      memorySwapMax.trim() !== '0' ||
      pidsMax.trim() !== String(limits.processCount) ||
      oomGroup.trim() !== '1'
    ) {
      await rmdir(groupPath);
      return null;
    }
    if (
      !(await access(posix.join(groupPath, 'cgroup.kill'), constants.W_OK).then(
        () => true,
        () => false
      ))
    ) {
      await rmdir(groupPath);
      return null;
    }
    procsHandle = await open(
      posix.join(groupPath, 'cgroup.procs'),
      constants.O_WRONLY | constants.O_NOFOLLOW
    );
    const activePath = groupPath;
    const activeProcsHandle = procsHandle;
    let cleaned = false;
    return {
      procsFd: activeProcsHandle.fd,
      terminate: () => tryTerminate(activePath),
      cleanup: async () => {
        if (cleaned) return true;
        cleaned = true;
        try {
          await activeProcsHandle.close();
        } catch {
          return false;
        }
        let empty = await waitUntilEmpty(activePath);
        if (!empty) {
          tryTerminate(activePath);
          empty = await waitUntilEmpty(activePath);
        }
        if (!empty) return false;
        try {
          await rmdir(activePath);
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    if (procsHandle) {
      try {
        await procsHandle.close();
      } catch {
        // Preserve the conservative unavailable result.
      }
    }
    if (groupPath && groupCreated) {
      try {
        await rmdir(groupPath);
      } catch {
        // Never recursively remove cgroup state; a non-empty group remains visible.
      }
    }
    return null;
  }
}
