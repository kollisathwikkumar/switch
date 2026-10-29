import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  consumeLinuxTargetStatusChunk,
  createLinuxTargetStatusState,
  finishLinuxTargetStatusStream,
} from './linux-target-status';

function frame(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(9);
  header.write('TMX1', 0, 'ascii');
  header.write(type, 4, 'ascii');
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

function resultFrame(kind: 0 | 1, value: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = kind;
  payload.writeUInt32BE(value, 1);
  return frame('R', payload);
}

it('parses framed target output and status across split reads and validates malformed streams', () => {
  const state = createLinuxTargetStatusState();
  const observed: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  const capture = (stream: 'stdout' | 'stderr', bytes: Buffer) =>
    observed[stream].push(bytes.toString());
  const stream = Buffer.concat([
    frame('H'),
    frame('O', Buffer.from('out')),
    frame('E', Buffer.from('err')),
    resultFrame(0, 137),
  ]);
  expect(consumeLinuxTargetStatusChunk(stream.subarray(0, 7), state, capture)).toBe(true);
  expect(consumeLinuxTargetStatusChunk(stream.subarray(7, 20), state, capture)).toBe(true);
  expect(consumeLinuxTargetStatusChunk(stream.subarray(20), state, capture)).toBe(true);
  expect(finishLinuxTargetStatusStream(state)).toBe(true);
  expect(state).toMatchObject({ started: true, exitCode: 137, signal: null, complete: true });
  expect(observed).toEqual({ stdout: ['out'], stderr: ['err'] });

  const signaled = createLinuxTargetStatusState();
  expect(
    consumeLinuxTargetStatusChunk(
      Buffer.concat([frame('H'), resultFrame(1, 15)]),
      signaled,
      capture
    )
  ).toBe(true);
  expect(finishLinuxTargetStatusStream(signaled)).toBe(true);
  expect(signaled).toMatchObject({ exitCode: null, signal: 15, complete: true });

  const wrapperFailure = createLinuxTargetStatusState();
  const errno = Buffer.alloc(4);
  errno.writeUInt32BE(2);
  expect(consumeLinuxTargetStatusChunk(frame('F', errno), wrapperFailure, capture)).toBe(true);
  expect(finishLinuxTargetStatusStream(wrapperFailure)).toBe(true);
  expect(wrapperFailure.wrapperError).toBe(2);

  const malformed = createLinuxTargetStatusState();
  expect(consumeLinuxTargetStatusChunk(Buffer.from('not-a-frame'), malformed, capture)).toBe(false);
  expect(malformed.invalid).toBe(true);
  const truncated = createLinuxTargetStatusState();
  expect(consumeLinuxTargetStatusChunk(frame('H').subarray(0, 7), truncated, capture)).toBe(true);
  expect(finishLinuxTargetStatusStream(truncated)).toBe(false);
});

it('captures the trusted native wrapper actual exit 137, target signal, output, and exec failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracemind-target-status-'));
  const helper = join(directory, 'verification-cwd');
  try {
    execFileSync('cc', [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
      '-o',
      helper,
    ]);
    const run = (target: string, args: string[]) => {
      const result = spawnSync(helper, ['--target-wrapper', target, ...args], {
        encoding: 'buffer',
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      const state = createLinuxTargetStatusState();
      const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
      expect(
        consumeLinuxTargetStatusChunk(result.stdout, state, (stream, bytes) =>
          output[stream].push(bytes)
        )
      ).toBe(true);
      expect(finishLinuxTargetStatusStream(state)).toBe(true);
      return { ...result, state, output };
    };

    const exit137 = run('/bin/sh', ['-c', 'printf target-out; printf target-err >&2; exit 137']);
    expect(exit137.status).toBe(137);
    expect(exit137.signal).toBeNull();
    expect(exit137.state).toMatchObject({
      started: true,
      exitCode: 137,
      signal: null,
      wrapperError: null,
    });
    expect(Buffer.concat(exit137.output.stdout).toString()).toBe('target-out');
    expect(Buffer.concat(exit137.output.stderr).toString()).toBe('target-err');

    const signal = run('/bin/sh', ['-c', 'kill -TERM $$']);
    expect(signal.status).toBe(143);
    expect(signal.state).toMatchObject({
      started: true,
      exitCode: null,
      signal: 15,
      wrapperError: null,
    });

    const killed = run('/bin/sh', ['-c', 'kill -KILL $$']);
    expect(killed.status).toBe(137);
    expect(killed.state).toMatchObject({
      started: true,
      exitCode: null,
      signal: 9,
      wrapperError: null,
    });

    const missing = run('/no/such/tracemind-target', []);
    expect(missing.status).toBe(125);
    expect(missing.state).toMatchObject({
      started: false,
      exitCode: null,
      signal: null,
      wrapperError: 2,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
