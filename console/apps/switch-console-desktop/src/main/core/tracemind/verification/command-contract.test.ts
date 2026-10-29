import { describe, expect, it } from 'vitest';
import { discoverPackageChecks, classifyProposal, canVerifyRun } from './command-contract';

describe('verification command contracts', () => {
  it('discovers package test candidates as structured proposals without executing script text', () => {
    const checks = discoverPackageChecks(
      '{"scripts":{"test":"echo unsafe && rm -rf important","lint":"eslint ."}}',
      'packages/app',
      'revision-1'
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      executable: 'npm',
      args: ['run', 'test'],
      workingDirectory: 'packages/app',
      revision: 'revision-1',
      environmentAllowlist: [],
      sandboxMode: 'unavailable',
      limits: {
        timeoutMs: 60_000,
        outputBytes: 1_000_000,
        processCount: 32,
        memoryBytes: 1_073_741_824,
      },
    });
    expect(classifyProposal(checks[0]!)).toBe('explicit-approval-required');
  });
  it('never verifies denied, incomplete, truncated, crashed, timed-out or cancelled runs', () => {
    const passed = {
      state: 'exited' as const,
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      isolation: 'linux-bubblewrap' as const,
      approved: true,
      capturedComplete: true,
      executionMatchesProposal: true,
      terminationUnconfirmed: false,
    };
    expect(canVerifyRun(passed)).toBe(true);
    expect(canVerifyRun({ ...passed, isolation: 'unavailable' })).toBe(false);
    expect(
      canVerifyRun({ ...passed, isolation: 'macos-sandbox-exec', terminationUnconfirmed: true })
    ).toBe(false);
    for (const state of ['denied', 'interrupted', 'timed_out', 'cancelled', 'crashed'] as const) {
      expect(canVerifyRun({ ...passed, state })).toBe(false);
    }
    expect(canVerifyRun({ ...passed, exitCode: 1 })).toBe(false);
    expect(canVerifyRun({ ...passed, stdoutTruncated: true })).toBe(false);
    expect(canVerifyRun({ ...passed, capturedComplete: false })).toBe(false);
    expect(canVerifyRun({ ...passed, approved: false })).toBe(false);
  });
  it('requires explicit proof of command match and process-tree termination', () => {
    const incompleteRecord = {
      state: 'exited' as const,
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      isolation: 'linux-bubblewrap' as const,
      approved: true,
      capturedComplete: true,
    };
    // Legacy records without both fields are not proof.
    expect(canVerifyRun(incompleteRecord)).toBe(false);
    const proven = {
      ...incompleteRecord,
      executionMatchesProposal: true,
      terminationUnconfirmed: false,
    };
    expect(canVerifyRun(proven)).toBe(true);
    expect(canVerifyRun({ ...proven, executionMatchesProposal: false })).toBe(false);
    expect(canVerifyRun({ ...proven, terminationUnconfirmed: true })).toBe(false);
  });
  it('rejects traversal, malformed or oversized manifests and non-test scripts', () => {
    expect(() =>
      discoverPackageChecks('{"scripts":{"test":"echo ok"}}', '../escape', 'rev')
    ).toThrow();
    expect(() => discoverPackageChecks('not json', '.', 'rev')).toThrow();
    expect(() => discoverPackageChecks('x'.repeat(1_000_001), '.', 'rev')).toThrow('limit');
    expect(discoverPackageChecks('{"scripts":{"build":"echo ok"}}', '.', 'rev')).toEqual([]);
  });
  it('rejects forged or structurally invalid outcome records', () => {
    const forged = JSON.parse(
      '{"state":"exited","exitCode":0,"signal":null,"stdoutTruncated":false,"stderrTruncated":false,"isolation":"unavailable","approved":"yes","capturedComplete":true}'
    );
    expect(canVerifyRun(forged)).toBe(false);
  });
  it('captures lifecycle hooks in the proposal instead of hiding executed scripts', () => {
    const [proposal] = discoverPackageChecks(
      '{"scripts":{"pretest":"echo before","test":"echo run","posttest":"echo after"}}',
      '.',
      'rev'
    );
    expect(proposal?.declaredScripts).toEqual({
      pretest: 'echo before',
      test: 'echo run',
      posttest: 'echo after',
    });
  });
});
