import { describe, expect, it } from 'vitest';
import {
  createWindowsApprovedRootHandoff,
  type WindowsApprovedRootHandoffContext,
} from './windows-handoff';
import {
  buildWindowsMxcRequest,
  buildWindowsMxcRequestFromHandoff,
  parseWindowsMxcDispatchFailure,
  quoteWindowsArgv,
} from './windows-mxc';

describe('Windows MXC process-container contract', () => {
  it('quotes argv without passing a shell expression', () => {
    expect(
      quoteWindowsArgv(['C:\\Program Files\\nodejs\\node.exe', 'a b', 'quote"x', 'tail\\'])
    ).toBe('"C:\\Program Files\\nodejs\\node.exe" "a b" "quote\\"x" "tail\\\\"');
  });

  it('creates a deny-by-default request with only approved and runtime paths', () => {
    expect(
      buildWindowsMxcRequest({
        nodeExecutable: 'C:\\Node\\node.exe',
        args: ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'test'],
        approvedProjectRoot: 'C:\\repo',
        workingDirectory: 'C:\\repo',
        runtimeDirectory: 'C:\\Node',
        systemRoot: 'C:\\Windows',
        temporaryDirectory: 'C:\\Temp\\tracemind-run-1',
        timeoutMs: 30_000,
        environment: { CI: 'true', NO_COLOR: '1' },
      })
    ).toEqual({
      command: '"C:\\Node\\node.exe" "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js" "run" "test"',
      containment: { type: 'processcontainer' },
      filesystem: {
        readwritePaths: ['C:\\repo', 'C:\\Temp\\tracemind-run-1'],
        readonlyPaths: ['C:\\Node', 'C:\\Windows\\System32'],
        clearPolicyOnExit: true,
      },
      network: {
        egress: { default: 'deny' },
        ingress: { default: 'deny', hostLoopback: 'deny' },
      },
      timeoutMs: 30_000,
      workingDirectory: 'C:\\repo',
      environment: {
        APPDATA: 'C:\\Temp\\tracemind-run-1',
        CI: 'true',
        HOME: 'C:\\Temp\\tracemind-run-1',
        LOCALAPPDATA: 'C:\\Temp\\tracemind-run-1',
        NO_COLOR: '1',
        NPM_CONFIG_CACHE: 'C:\\Temp\\tracemind-run-1\\npm-cache',
        NPM_CONFIG_USERCONFIG: 'C:\\Temp\\tracemind-run-1\\npmrc',
        PATH: 'C:\\Node;C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp\\tracemind-run-1',
        TMP: 'C:\\Temp\\tracemind-run-1',
        USERPROFILE: 'C:\\Temp\\tracemind-run-1',
      },
      inheritDefaultEnvironment: false,
    });
  });

  it('uses the installed MXC SDK v1 ContainerRequest contract', () => {
    const request = buildWindowsMxcRequest({
      nodeExecutable: 'C:\\Node\\node.exe',
      args: ['-e', 'process.exit(0)'],
      approvedProjectRoot: 'C:\\repo',
      workingDirectory: 'C:\\repo\\packages\\app',
      runtimeDirectory: 'C:\\Node',
      systemRoot: 'C:\\Windows',
      temporaryDirectory: 'C:\\Temp\\run',
      timeoutMs: 1000,
      environment: { CI: 'true' },
    });

    expect(request).toMatchObject({
      command: '"C:\\Node\\node.exe" "-e" "process.exit(0)"',
      containment: { type: 'processcontainer' },
      filesystem: { readwritePaths: ['C:\\repo', 'C:\\Temp\\run'] },
      timeoutMs: 1000,
      workingDirectory: 'C:\\repo\\packages\\app',
      environment: { CI: 'true', PATH: 'C:\\Node;C:\\Windows\\System32' },
      inheritDefaultEnvironment: false,
    });
    expect(request).not.toHaveProperty('version');
    expect(request).not.toHaveProperty('process');
  });

  it('derives the MXC root and working directory from the validated approved-root handoff', () => {
    const approval: WindowsApprovedRootHandoffContext = {
      projectId: 'location_1',
      auditId: '3de3a906-4a75-4fad-8cc3-3f4a4da9a180',
      runId: '0cba5cc4-21e3-4ecd-aa66-a3d89ed28607',
      proposalVersion: 4,
      rootPath: 'C:\\work\\switch',
      rootIdentity: 'win32:0123456789abcdef:00112233445566778899aabbccddeeff',
      proposal: {
        executable: 'npm',
        args: ['run', 'test'],
        declaredScripts: { test: 'node test.js' },
        workingDirectory: 'packages/app',
        revision: 'audit:3de3a906-4a75-4fad-8cc3-3f4a4da9a180',
        environmentAllowlist: [],
        limits: {
          timeoutMs: 30_000,
          outputBytes: 1_000_000,
          processCount: 16,
          memoryBytes: 512 * 1024 * 1024,
        },
        sandboxMode: 'unavailable',
      },
    };
    const request = buildWindowsMxcRequestFromHandoff({
      handoff: createWindowsApprovedRootHandoff(approval),
      approval,
      nodeExecutable: 'C:\\Node\\node.exe',
      npmCliPath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
      runtimeDirectory: 'C:\\Node',
      systemRoot: 'C:\\Windows',
      temporaryDirectory: 'C:\\Temp\\run',
      environment: {},
    });
    expect(request.command).toBe(
      '"C:\\Node\\node.exe" "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js" "run" "test"'
    );
    expect(request.filesystem?.readwritePaths).toEqual(['C:\\work\\switch', 'C:\\Temp\\run']);
    expect(request.workingDirectory).toBe('C:\\work\\switch\\packages\\app');
  });

  it('rejects an unauthorized root before creating an MXC request', () => {
    const approval: WindowsApprovedRootHandoffContext = {
      projectId: 'location_1',
      auditId: '3de3a906-4a75-4fad-8cc3-3f4a4da9a180',
      runId: '0cba5cc4-21e3-4ecd-aa66-a3d89ed28607',
      proposalVersion: 4,
      rootPath: 'C:\\work\\switch',
      rootIdentity: 'win32:0123456789abcdef:00112233445566778899aabbccddeeff',
      proposal: {
        executable: 'npm',
        args: ['run', 'test'],
        declaredScripts: { test: 'node test.js' },
        workingDirectory: '.',
        revision: 'audit:3de3a906-4a75-4fad-8cc3-3f4a4da9a180',
        environmentAllowlist: [],
        limits: {
          timeoutMs: 30_000,
          outputBytes: 1_000_000,
          processCount: 16,
          memoryBytes: 512 * 1024 * 1024,
        },
        sandboxMode: 'unavailable',
      },
    };
    const handoff = createWindowsApprovedRootHandoff(approval);
    expect(() =>
      buildWindowsMxcRequestFromHandoff({
        handoff: { ...handoff, approvedRoot: 'C:\\work\\switch-other' },
        approval,
        nodeExecutable: 'C:\\Node\\node.exe',
        npmCliPath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
        runtimeDirectory: 'C:\\Node',
        systemRoot: 'C:\\Windows',
        temporaryDirectory: 'C:\\Temp\\run',
        environment: {},
      })
    ).toThrow('Windows approved-root handoff does not match the trusted approval');
  });

  it('authorizes a nested working directory but grants writes only to the approved project root', () => {
    const request = buildWindowsMxcRequest({
      nodeExecutable: 'C:\\Node\\node.exe',
      args: ['-e', 'process.exit(0)'],
      approvedProjectRoot: 'C:\\repo',
      workingDirectory: 'C:\\repo\\packages\\app',
      runtimeDirectory: 'C:\\Node',
      systemRoot: 'C:\\Windows',
      temporaryDirectory: 'C:\\Temp\\run',
      timeoutMs: 1000,
      environment: {},
    });

    expect(request.workingDirectory).toBe('C:\\repo\\packages\\app');
    expect(request.filesystem?.readwritePaths).toEqual(['C:\\repo', 'C:\\Temp\\run']);
  });

  it.each(['C:\\outside', 'C:\\repo-sibling\\project', 'D:\\repo\\project'])(
    'rejects a working directory outside the authorized project root (%s)',
    (workingDirectory) => {
      expect(() =>
        buildWindowsMxcRequest({
          nodeExecutable: 'C:\\Node\\node.exe',
          args: ['-e', 'process.exit(0)'],
          approvedProjectRoot: 'C:\\repo',
          workingDirectory,
          runtimeDirectory: 'C:\\Node',
          systemRoot: 'C:\\Windows',
          temporaryDirectory: 'C:\\Temp\\run',
          timeoutMs: 1000,
          environment: {},
        })
      ).toThrow('Windows working directory is outside the approved project root');
    }
  );

  it.each(['relative\\repo', 'C:\\repo\\..\\outside', '\\\\server\\share\\repo'])(
    'rejects a malformed or non-local approved project root (%s)',
    (projectRoot) => {
      expect(() =>
        buildWindowsMxcRequest({
          nodeExecutable: 'C:\\Node\\node.exe',
          args: ['-e', 'process.exit(0)'],
          approvedProjectRoot: projectRoot,
          workingDirectory: 'C:\\repo',
          runtimeDirectory: 'C:\\Node',
          systemRoot: 'C:\\Windows',
          temporaryDirectory: 'C:\\Temp\\run',
          timeoutMs: 1000,
          environment: {},
        })
      ).toThrow('Invalid Windows project root');
    }
  );

  it('rejects a request whose working directory is not an absolute Windows path', () => {
    expect(() =>
      buildWindowsMxcRequest({
        nodeExecutable: 'C:\\Node\\node.exe',
        args: ['C:\\Node\\npm-cli.js', 'run', 'test'],
        approvedProjectRoot: 'C:\\repo',
        workingDirectory: 'C:\\repo\\..\\other',
        runtimeDirectory: 'C:\\Node',
        systemRoot: 'C:\\Windows',
        temporaryDirectory: 'C:\\Temp\\run',
        timeoutMs: 1000,
        environment: {},
      })
    ).toThrow('Invalid Windows working directory');
  });

  it.each(['\\\\server\\share\\repo', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo'])(
    'rejects non-local Windows paths (%s)',
    (workingDirectory) => {
      expect(() =>
        buildWindowsMxcRequest({
          nodeExecutable: 'C:\\Node\\node.exe',
          args: ['-e', 'process.exit(0)'],
          approvedProjectRoot: 'C:\\repo',
          workingDirectory,
          runtimeDirectory: 'C:\\Node',
          systemRoot: 'C:\\Windows',
          temporaryDirectory: 'C:\\Temp\\run',
          timeoutMs: 1000,
          environment: {},
        })
      ).toThrow('Invalid Windows working directory');
    }
  );

  it.each(['C:\\repo:stream', 'C:\\repo\\trailing.', 'C:\\repo\\trailing ', 'C:\\repo\\CON'])(
    'rejects Windows path aliases (%s)',
    (workingDirectory) => {
      expect(() =>
        buildWindowsMxcRequest({
          nodeExecutable: 'C:\\Node\\node.exe',
          args: ['-e', 'process.exit(0)'],
          approvedProjectRoot: 'C:\\repo',
          workingDirectory,
          runtimeDirectory: 'C:\\Node',
          systemRoot: 'C:\\Windows',
          temporaryDirectory: 'C:\\Temp\\run',
          timeoutMs: 1000,
          environment: {},
        })
      ).toThrow('Invalid Windows working directory');
    }
  );

  it('rejects writable paths that overlap the read-only runtime tree', () => {
    expect(() =>
      buildWindowsMxcRequest({
        nodeExecutable: 'C:\\Node\\node.exe',
        args: ['-e', 'process.exit(0)'],
        approvedProjectRoot: 'C:\\Node\\project',
        workingDirectory: 'C:\\Node\\project',
        runtimeDirectory: 'C:\\Node',
        systemRoot: 'C:\\Windows',
        temporaryDirectory: 'C:\\Temp\\run',
        timeoutMs: 1000,
        environment: {},
      })
    ).toThrow('Windows writable path overlaps a read-only path');
  });

  it('requires the Node executable to be contained by the read-only runtime tree', () => {
    expect(() =>
      buildWindowsMxcRequest({
        nodeExecutable: 'C:\\Other\\node.exe',
        args: ['-e', 'process.exit(0)'],
        approvedProjectRoot: 'C:\\repo',
        workingDirectory: 'C:\\repo',
        runtimeDirectory: 'C:\\Node',
        systemRoot: 'C:\\Windows',
        temporaryDirectory: 'C:\\Temp\\run',
        timeoutMs: 1000,
        environment: {},
      })
    ).toThrow('Windows Node executable must be inside the runtime directory');
  });

  it('requires the Node executable to be a file below, not equal to, the runtime directory', () => {
    expect(() =>
      buildWindowsMxcRequest({
        nodeExecutable: 'c:\\node',
        args: ['-e', 'process.exit(0)'],
        approvedProjectRoot: 'C:\\repo',
        workingDirectory: 'C:\\repo',
        runtimeDirectory: 'C:\\Node',
        systemRoot: 'C:\\Windows',
        temporaryDirectory: 'C:\\Temp\\run',
        timeoutMs: 1000,
        environment: {},
      })
    ).toThrow('Windows Node executable must be inside the runtime directory');
  });

  it('recognizes only a final structured MXC dispatch-error envelope', () => {
    expect(
      parseWindowsMxcDispatchFailure(
        'ordinary diagnostic\n{"error":{"code":"backend_unavailable","message":"No supported backend"}}\n'
      )
    ).toEqual({ code: 'backend_unavailable', message: 'No supported backend' });
    expect(
      parseWindowsMxcDispatchFailure('{"error":{"code":"x","message":"y"}}\nuser output')
    ).toBe(null);
    expect(parseWindowsMxcDispatchFailure('test failed\n')).toBeNull();
  });
});
