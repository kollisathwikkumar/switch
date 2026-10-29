import { win32 } from 'node:path';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import {
  validateWindowsApprovedRootHandoff,
  type WindowsApprovedRootHandoffContext,
} from './windows-handoff';

const allowedEnvironment = new Set(['CI', 'NO_COLOR', 'FORCE_COLOR']);
const maxCommandLineLength = 32_767;

export interface WindowsMxcRequestInput {
  nodeExecutable: string;
  args: readonly string[];
  approvedProjectRoot: string;
  workingDirectory: string;
  runtimeDirectory: string;
  systemRoot: string;
  temporaryDirectory: string;
  timeoutMs: number;
  environment: Readonly<Record<string, string>>;
}

export interface WindowsMxcApprovedExecutionInput extends Omit<
  WindowsMxcRequestInput,
  'approvedProjectRoot' | 'workingDirectory' | 'args' | 'timeoutMs'
> {
  handoff: unknown;
  approval: WindowsApprovedRootHandoffContext;
  npmCliPath: string;
}

export type WindowsMxcRequest = ContainerRequest;

function checkedWindowsPath(path: string, field: string): string {
  const components = path.split('\\').slice(1);
  const hasAmbiguousComponent = components.some(
    (part) =>
      part.includes(':') ||
      /[. ]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu.test(part)
  );
  if (
    path.length > 4096 ||
    !win32.isAbsolute(path) ||
    !/^[A-Za-z]:\\/.test(path) ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.includes('/') ||
    hasAmbiguousComponent
  )
    throw new Error('Invalid Windows ' + field);
  const normalized = win32.normalize(path);
  if (
    normalized !== path ||
    path.split('\\').some((part) => part === '.' || part === '..') ||
    path.startsWith('\\\\.\\')
  )
    throw new Error('Invalid Windows ' + field);
  return path;
}

function isWithinWindowsPath(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative))
  );
}

function isStrictlyWithinWindowsPath(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..\\') &&
    !win32.isAbsolute(relative)
  );
}

function pathsOverlapWindowsPath(left: string, right: string): boolean {
  return isWithinWindowsPath(left, right) || isWithinWindowsPath(right, left);
}

function checkedArgs(args: readonly string[]): string[] {
  if (args.length > 128) throw new Error('Too many Windows process arguments');
  return args.map((arg) => {
    if (arg.length > 65_536 || arg.includes('\0'))
      throw new Error('Invalid Windows process argument');
    return arg;
  });
}

/** Quotes argv for a Windows command line consumed by Node, without invoking a shell. */
export function quoteWindowsArgv(args: readonly string[]): string {
  if (args.length === 0) throw new Error('Windows command line requires an executable');
  const encoded = checkedArgs(args)
    .map((arg) => {
      let quoted = '"';
      let backslashes = 0;
      for (const character of arg) {
        if (character === '\\') {
          backslashes++;
          continue;
        }
        if (character === '"') {
          quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
          backslashes = 0;
          continue;
        }
        quoted += '\\'.repeat(backslashes) + character;
        backslashes = 0;
      }
      return quoted + '\\'.repeat(backslashes * 2) + '"';
    })
    .join(' ');
  if (encoded.length > maxCommandLineLength) throw new Error('Windows command line exceeds limit');
  return encoded;
}

function checkedEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  for (const [key, value] of Object.entries(environment)) {
    if (!allowedEnvironment.has(key) || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
      throw new Error('Invalid Windows verification environment');
  }
  return { ...environment };
}

/** Builds the SDK V1 ProcessContainer request with only project/temp writes and no network. */
export function buildWindowsMxcRequest(input: WindowsMxcRequestInput): WindowsMxcRequest {
  const nodeExecutable = checkedWindowsPath(input.nodeExecutable, 'Node executable');
  const projectRoot = checkedWindowsPath(input.approvedProjectRoot, 'project root');
  const workingDirectory = checkedWindowsPath(input.workingDirectory, 'working directory');
  const runtimeDirectory = checkedWindowsPath(input.runtimeDirectory, 'runtime directory');
  const systemRoot = checkedWindowsPath(input.systemRoot, 'system root');
  const temporaryDirectory = checkedWindowsPath(input.temporaryDirectory, 'temporary directory');
  if (!isStrictlyWithinWindowsPath(runtimeDirectory, nodeExecutable))
    throw new Error('Windows Node executable must be inside the runtime directory');
  if (!isWithinWindowsPath(projectRoot, workingDirectory))
    throw new Error('Windows working directory is outside the approved project root');
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000)
    throw new Error('Invalid Windows verification timeout');

  const system32 = win32.join(systemRoot, 'System32');
  for (const writablePath of [projectRoot, temporaryDirectory]) {
    for (const readOnlyPath of [runtimeDirectory, system32]) {
      if (pathsOverlapWindowsPath(writablePath, readOnlyPath))
        throw new Error('Windows writable path overlaps a read-only path');
    }
  }
  const environment: Record<string, string> = {
    ...checkedEnvironment(input.environment),
    APPDATA: temporaryDirectory,
    HOME: temporaryDirectory,
    LOCALAPPDATA: temporaryDirectory,
    NPM_CONFIG_CACHE: win32.join(temporaryDirectory, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: win32.join(temporaryDirectory, 'npmrc'),
    PATH: runtimeDirectory + ';' + system32,
    SystemRoot: systemRoot,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    USERPROFILE: temporaryDirectory,
  };
  return {
    command: quoteWindowsArgv([nodeExecutable, ...checkedArgs(input.args)]),
    containment: { type: 'processcontainer' },
    filesystem: {
      readwritePaths: [projectRoot, temporaryDirectory],
      readonlyPaths: [runtimeDirectory, system32],
      clearPolicyOnExit: true,
    },
    network: {
      egress: { default: 'deny' },
      ingress: { default: 'deny', hostLoopback: 'deny' },
    },
    timeoutMs: input.timeoutMs,
    workingDirectory,
    environment,
    inheritDefaultEnvironment: false,
  };
}

/** Builds MXC's request only after the strict handoff matches consumed main-process approval. */
export function buildWindowsMxcRequestFromHandoff(
  input: WindowsMxcApprovedExecutionInput
): WindowsMxcRequest {
  const handoff = validateWindowsApprovedRootHandoff(input.handoff, input.approval);
  const npmCliPath = checkedWindowsPath(input.npmCliPath, 'npm CLI');
  const runtimeDirectory = checkedWindowsPath(input.runtimeDirectory, 'runtime directory');
  if (!isWithinWindowsPath(runtimeDirectory, npmCliPath))
    throw new Error('Windows npm CLI must be inside the runtime directory');
  const workingDirectory =
    handoff.workingDirectoryComponents.length === 0
      ? handoff.approvedRoot
      : win32.join(handoff.approvedRoot, ...handoff.workingDirectoryComponents);
  return buildWindowsMxcRequest({
    nodeExecutable: input.nodeExecutable,
    args: [npmCliPath, ...handoff.args],
    approvedProjectRoot: handoff.approvedRoot,
    workingDirectory,
    runtimeDirectory,
    systemRoot: input.systemRoot,
    temporaryDirectory: input.temporaryDirectory,
    timeoutMs: handoff.limits.timeoutMs,
    environment: input.environment,
  });
}

/** MXC's one-shot dispatcher writes a final structured error line on launch/policy failure. */
export function parseWindowsMxcDispatchFailure(
  stderr: string
): { code: string; message: string } | null {
  const line = stderr.trimEnd().split(/\r?\n/).at(-1)?.trim();
  if (!line || line.length > 8192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('error' in parsed) ||
    parsed.error === null ||
    typeof parsed.error !== 'object' ||
    !('code' in parsed.error) ||
    !('message' in parsed.error) ||
    typeof parsed.error.code !== 'string' ||
    typeof parsed.error.message !== 'string' ||
    parsed.error.code.length > 128 ||
    parsed.error.message.length > 4096
  )
    return null;
  return { code: parsed.error.code, message: parsed.error.message };
}
