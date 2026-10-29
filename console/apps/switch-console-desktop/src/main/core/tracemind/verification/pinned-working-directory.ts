import { fstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  closeNativeFileHandle,
  nativeFileIdentity,
  type NativeProjectFs,
} from '../native/access-registry';
import type { Snapshot } from './approval-service';
import { commandProposalSchema, type CommandProposal } from './command-contract';

const identitySchema = z.string().regex(/^(?:\d{1,40}:\d{1,40}|win32:[a-f0-9]{16}:[a-f0-9]{32})$/);
function descriptorIdentity(native: NativeProjectFs, fd: number): string {
  if (native.stat) {
    if (!native.stat(fd).directory) throw new Error('Working directory is not a directory');
  } else if (!fstatSync(fd, { bigint: true }).isDirectory()) {
    throw new Error('Working directory is not a directory');
  }
  return nativeFileIdentity(native, fd);
}
/** Returns an owned fd; callers must close it, and must retain it until the child is spawned. */
export function openVerifiedWorkingDirectory(
  snapshot: Snapshot,
  input: CommandProposal,
  native: NativeProjectFs
): { fd: number; identity: string } {
  if (!isAbsolute(snapshot.root) || /[\x00-\x1f\x7f]/.test(snapshot.root))
    throw new Error('Invalid project root');
  identitySchema.parse(snapshot.identity);
  identitySchema.parse(snapshot.workingDirectoryIdentity);
  const proposal = commandProposalSchema.parse(input);
  const parts = proposal.workingDirectory === '.' ? [] : proposal.workingDirectory.split('/');
  if (parts.length > 48) throw new Error('Working directory depth exceeds audit limit');
  let fd = native.openRoot(snapshot.root);
  try {
    if (descriptorIdentity(native, fd) !== snapshot.identity)
      throw new Error('Project root changed');
    for (const part of parts) {
      const next = native.openDirectory(fd, Buffer.from(part, 'utf8'));
      const previous = fd;
      fd = next;
      closeNativeFileHandle(native, previous);
    }
    const identity = descriptorIdentity(native, fd);
    if (identity !== snapshot.workingDirectoryIdentity)
      throw new Error('Working directory changed');
    return { fd, identity };
  } catch (error) {
    closeNativeFileHandle(native, fd);
    throw error;
  }
}
