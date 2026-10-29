import { describe, expect, it } from 'vitest';
import type { CommandProposal } from './command-contract';
import {
  createWindowsApprovedRootHandoff,
  validateWindowsApprovedRootHandoff,
  type WindowsApprovedRootHandoffContext,
} from './windows-handoff';

const context: WindowsApprovedRootHandoffContext = {
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
  } satisfies CommandProposal,
};

describe('Windows approved-root execution handoff', () => {
  it('binds the strict handoff to the approved project, run, root identity, command, and limits', () => {
    expect(createWindowsApprovedRootHandoff(context)).toEqual({
      version: 1,
      projectId: context.projectId,
      auditId: context.auditId,
      runId: context.runId,
      proposalVersion: context.proposalVersion,
      approvedRoot: context.rootPath,
      rootFileIdentity: context.rootIdentity,
      workingDirectoryComponents: ['packages', 'app'],
      command: 'npm',
      args: ['run', 'test'],
      limits: {
        timeoutMs: 30_000,
        outputBytes: 1_000_000,
        processCount: 16,
        memoryBytes: 512 * 1024 * 1024,
      },
    });
  });

  it('accepts case-only path spelling while still requiring the same root identity', () => {
    const handoff = createWindowsApprovedRootHandoff(context);
    expect(
      validateWindowsApprovedRootHandoff(handoff, {
        ...context,
        rootPath: 'c:\\WORK\\Switch',
      }).approvedRoot
    ).toBe(context.rootPath);
  });

  it('rejects an unauthorized root even when it is a lexical sibling', () => {
    const handoff = createWindowsApprovedRootHandoff(context);
    expect(() =>
      validateWindowsApprovedRootHandoff(handoff, {
        ...context,
        rootPath: 'C:\\work\\switch-other',
      })
    ).toThrow('Windows approved-root handoff does not match the trusted approval');
  });

  it('rejects a changed root file identity', () => {
    const handoff = createWindowsApprovedRootHandoff(context);
    expect(() =>
      validateWindowsApprovedRootHandoff(handoff, {
        ...context,
        rootIdentity: 'win32:0123456789abcdef:ffeeddccbbaa99887766554433221100',
      })
    ).toThrow('Windows approved-root handoff does not match the trusted approval');
  });

  it.each(['..', '.', 'nested\\child', 'file:stream', 'CON', 'trailing.'])(
    'rejects an unsafe Windows working-directory component (%s)',
    (component) => {
      const handoff = createWindowsApprovedRootHandoff(context);
      expect(() =>
        validateWindowsApprovedRootHandoff(
          { ...handoff, workingDirectoryComponents: [component] },
          context
        )
      ).toThrow();
    }
  );

  it('rejects UNC, device, traversal, and non-canonical roots', () => {
    const handoff = createWindowsApprovedRootHandoff(context);
    for (const rootPath of [
      '\\\\server\\share\\project',
      '\\\\.\\C:\\project',
      'C:\\work\\..\\secret',
      'C:/work/switch',
    ]) {
      expect(() =>
        validateWindowsApprovedRootHandoff({ ...handoff, approvedRoot: rootPath }, context)
      ).toThrow();
    }
  });

  it('rejects malformed IDs, file identities, limits, and extra fields', () => {
    const handoff = createWindowsApprovedRootHandoff(context);
    expect(() =>
      validateWindowsApprovedRootHandoff({ ...handoff, runId: 'run-1' }, context)
    ).toThrow();
    expect(() =>
      validateWindowsApprovedRootHandoff({ ...handoff, rootFileIdentity: '1:2' }, context)
    ).toThrow();
    expect(() =>
      validateWindowsApprovedRootHandoff(
        { ...handoff, limits: { ...handoff.limits, processCount: 0 } },
        context
      )
    ).toThrow();
    expect(() =>
      validateWindowsApprovedRootHandoff({ ...handoff, rendererRoot: context.rootPath }, context)
    ).toThrow();
  });
});
