const magic = Buffer.from('TMX1');
const headerBytes = 9;
const maxFrameBytes = 65_536;

export interface LinuxTargetStatusState {
  buffer: Buffer;
  started: boolean;
  exitCode: number | null;
  signal: number | null;
  wrapperError: number | null;
  complete: boolean;
  invalid: boolean;
}

export function createLinuxTargetStatusState(): LinuxTargetStatusState {
  return {
    buffer: Buffer.alloc(0),
    started: false,
    exitCode: null,
    signal: null,
    wrapperError: null,
    complete: false,
    invalid: false,
  };
}

/** Parses the trusted native wrapper's framed stdout/stderr and raw wait status. */
export function consumeLinuxTargetStatusChunk(
  chunk: Buffer,
  state: LinuxTargetStatusState,
  capture: (stream: 'stdout' | 'stderr', data: Buffer) => void
): boolean {
  if (state.invalid || state.complete || state.wrapperError !== null) return false;
  state.buffer = Buffer.concat([state.buffer, chunk]);
  let offset = 0;
  while (state.buffer.length - offset >= headerBytes) {
    const frame = state.buffer.subarray(offset);
    if (!frame.subarray(0, 4).equals(magic)) {
      state.invalid = true;
      return false;
    }
    const type = String.fromCharCode(frame[4] ?? 0);
    const length = frame.readUInt32BE(5);
    if (length > maxFrameBytes) {
      state.invalid = true;
      return false;
    }
    if (frame.length < headerBytes + length) break;
    const payload = frame.subarray(headerBytes, headerBytes + length);
    if (type === 'H' && length === 0 && !state.started && !state.complete) {
      state.started = true;
    } else if ((type === 'O' || type === 'E') && length > 0 && state.started) {
      capture(type === 'O' ? 'stdout' : 'stderr', payload);
    } else if (type === 'R' && length === 5 && state.started) {
      const kind = payload[0];
      const value = payload.readUInt32BE(1);
      if (kind === 0 && value <= 255) state.exitCode = value;
      else if (kind === 1 && value > 0 && value <= 64) state.signal = value;
      else {
        state.invalid = true;
        return false;
      }
      state.complete = true;
    } else if (type === 'F' && length === 4) {
      const error = payload.readUInt32BE(0);
      if (error === 0 || error > 4095) {
        state.invalid = true;
        return false;
      }
      state.wrapperError = error;
    } else {
      state.invalid = true;
      return false;
    }
    offset += headerBytes + length;
    if (state.complete || state.wrapperError !== null) {
      if (offset !== state.buffer.length) {
        state.invalid = true;
        return false;
      }
      break;
    }
  }
  state.buffer = state.buffer.subarray(offset);
  if (state.buffer.length > headerBytes + maxFrameBytes) {
    state.invalid = true;
    return false;
  }
  return true;
}

export function finishLinuxTargetStatusStream(state: LinuxTargetStatusState): boolean {
  if (state.invalid || state.buffer.length > 0) return false;
  return state.complete || state.wrapperError !== null;
}
