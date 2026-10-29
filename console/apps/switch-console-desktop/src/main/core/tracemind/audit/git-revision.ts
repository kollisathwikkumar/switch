import {
  closeNativeFileHandle,
  nativeFileIdentity,
  openProjectFileHandle,
  type NativeProjectFs,
} from '../native/access-registry';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maxMetadataBytes = 1024 * 1024;

async function boundedFile(native: NativeProjectFs, parent: number, name: string): Promise<string> {
  const fd = native.openFile(parent, Buffer.from(name));
  const handle = openProjectFileHandle(fd, native);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxMetadataBytes))
      throw new Error('Metadata limit');
    const buffer = Buffer.alloc(maxMetadataBytes + 1);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      position > maxMetadataBytes ||
      BigInt(position) !== after.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Metadata changed');
    const data = buffer.subarray(0, position);
    const text = data.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(data)) throw new Error('Invalid metadata encoding');
    return text;
  } finally {
    await handle.close();
  }
}

function childExists(native: NativeProjectFs, parent: number, name: string): boolean {
  const listing = native.list(parent, 100_000);
  if (!listing.complete) throw new Error('Metadata directory limit');
  return listing.names.some((entry) => entry.equals(Buffer.from(name)));
}

async function readLooseRef(
  native: NativeProjectFs,
  gitDir: number,
  ref: string
): Promise<string | null> {
  const parts = ref.split('/');
  let parent = gitDir;
  const opened: number[] = [];
  try {
    for (const part of parts.slice(0, -1)) {
      if (!childExists(native, parent, part)) return null;
      parent = native.openDirectory(parent, Buffer.from(part));
      opened.push(parent);
    }
    const name = parts.at(-1);
    if (!name || !childExists(native, parent, name)) return null;
    return (await boundedFile(native, parent, name)).trim();
  } finally {
    for (const fd of opened.reverse()) closeNativeFileHandle(native, fd);
  }
}

async function readResolved(native: NativeProjectFs, gitDir: number): Promise<string | null> {
  const head = (await boundedFile(native, gitDir, 'HEAD')).trim();
  if (objectId.test(head)) return head;
  if (!head.startsWith('ref: ')) return null;
  const ref = head.slice(5);
  if (
    !/^refs\/[A-Za-z0-9._/-]+$/.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    return null;
  const loose = await readLooseRef(native, gitDir, ref);
  if (loose !== null) return objectId.test(loose) ? loose : null;
  if (!childExists(native, gitDir, 'packed-refs')) return null;
  const packed = await boundedFile(native, gitDir, 'packed-refs');
  for (const line of packed.split('\n')) {
    const separator = line.indexOf(' ');
    if (
      separator > 0 &&
      line.slice(separator + 1) === ref &&
      objectId.test(line.slice(0, separator))
    )
      return line.slice(0, separator);
  }
  return null;
}

/** Reads a simple in-root Git HEAD without executing Git; unsupported layouts return null. */
export async function readGitRevision(
  native: NativeProjectFs,
  root: string,
  expectedIdentity: string
): Promise<string | null> {
  const rootFd = native.openRoot(root);
  try {
    if (nativeFileIdentity(native, rootFd) !== expectedIdentity)
      throw new Error('Project root changed after approval');
    let gitDir: number;
    try {
      gitDir = native.openDirectory(rootFd, Buffer.from('.git'));
    } catch {
      return null;
    }
    try {
      const first = await readResolved(native, gitDir);
      const second = await readResolved(native, gitDir);
      return first && first === second ? first : null;
    } catch {
      return null;
    } finally {
      closeNativeFileHandle(native, gitDir);
    }
  } finally {
    closeNativeFileHandle(native, rootFd);
  }
}
