import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Resolves links and fingerprints no-follow targets; later path-based execution is not pinned. */
export async function fingerprintRuntime(
  paths: readonly string[],
  maxBytes = 256 * 1024 * 1024
): Promise<string> {
  if (
    paths.length !== 3 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 536_870_912
  )
    throw new Error('Invalid runtime fingerprint limit');
  const digest = createHash('sha256').update('tracemind-runtime-v1\0');
  let remaining = maxBytes;
  for (const path of paths) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid runtime path');
    const resolved = await realpath(path);
    const file = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(remaining))
        throw new Error('Runtime fingerprint limit exceeded');
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      let offset = 0;
      while (offset < Number(before.size)) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - offset),
          offset
        );
        if (!bytesRead) throw new Error('Runtime changed during fingerprint');
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error('Runtime changed during fingerprint');
      if ((await realpath(path)) !== resolved)
        throw new Error('Runtime path changed during fingerprint');
      remaining -= offset;
      digest
        .update(JSON.stringify([path, resolved, `${before.dev}:${before.ino}`, hash.digest('hex')]))
        .update('\n');
    } finally {
      await file.close();
    }
  }
  return digest.digest('hex');
}
