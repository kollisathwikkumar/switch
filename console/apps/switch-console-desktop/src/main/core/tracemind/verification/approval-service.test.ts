import { describe, expect, it, vi } from 'vitest';
import {
  VerificationApprovalService,
  type ApprovalDependencies,
  type ApprovalDecision,
} from './approval-service';
import { commandProposalSchema, discoverPackageChecks } from './command-contract';
import type { StoredRunProposal } from './run-store';
const auditId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
function fixture() {
  const proposal = discoverPackageChecks(
    '{"scripts":{"test":"echo test && echo verify"}}',
    '.',
    `audit:${auditId}`
  )[0]!;
  const run: StoredRunProposal = {
    id: runId,
    projectId: 'project-1',
    auditId,
    proposal,
    state: 'proposed',
    verified: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const deps: ApprovalDependencies = {
    load: vi.fn(async () => structuredClone(run)),
    snapshot: vi.fn(async () => ({
      root: '/fixture',
      identity: '1:2',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
      helperExecutable: '/trusted/verification-cwd',
    })),
    confirm: vi.fn(async () => 'approve' as const),
    deny: vi.fn(async () => {}),
    now: () => 1000,
  };
  return { run, deps, service: new VerificationApprovalService(deps) };
}
describe('verification approval boundary', () => {
  it('shows the exact script, no sandbox, and issues only a one-use matching approval', async () => {
    const { service, deps, run } = fixture();
    expect(await service.request('project-1', runId)).toBe(true);
    expect(deps.snapshot).toHaveBeenCalledWith('project-1', auditId, run.proposal);
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('echo test && echo verify'));
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('No OS sandbox is available')
    );
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        process.platform === 'win32'
          ? 'Descriptor-bound working-directory execution is unavailable on Windows; this check cannot start.'
          : 'Execution will bind to the approved working-directory identity.'
      )
    );
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('later checks remain blocked')
    );
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('excluded files'));
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        'Requested process/task cap: 32; Linux cgroup v2 pids.max counts tasks, including threads and sandbox helpers. Enforced only with Linux Bubblewrap plus writable delegated cgroup v2 support'
      )
    );
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        'Requested memory cap: 1073741824 bytes; enforced only with Linux Bubblewrap plus writable delegated cgroup v2 support'
      )
    );
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        process.platform === 'win32'
          ? 'Per-process CPU-time cap is unavailable on Windows'
          : 'Per-process CPU-time cap: 60 seconds via the trusted helper'
      )
    );
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        'Concurrency: a durable application-database reservation allows one verification run at a time'
      )
    );
    expect(await service.consume('project-1', runId)).toBe(true);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('requires the second distinct confirmation when sandbox isolation is unavailable', async () => {
    const { service, deps, run } = fixture();
    vi.mocked(deps.confirm).mockImplementation(async (text) =>
      text.includes('FINAL CONFIRMATION REQUIRED') ? 'deny' : 'approve'
    );
    expect(await service.request('project-1', runId)).toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
    expect(deps.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('FINAL CONFIRMATION REQUIRED')
    );
    expect(deps.deny).toHaveBeenCalledWith('project-1', run.id, run.version);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('rejects a changed process or memory cap after the user reviews the proposal', async () => {
    const { service, deps, run } = fixture();
    const approvals: ((decision: ApprovalDecision) => void)[] = [];
    vi.mocked(deps.confirm).mockImplementation(
      () => new Promise((resolve) => approvals.push(resolve))
    );
    const pending = service.request('project-1', runId);
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledTimes(1));
    approvals[0]?.('approve');
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledTimes(2));
    run.proposal.limits.memoryBytes *= 2;
    approvals[1]?.('approve');
    expect(await pending).toBe(false);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('returns the freshly revalidated proposal and directory identity to a one-use execution handoff', async () => {
    const { service, run } = fixture();
    expect(await service.request('project-1', runId)).toBe(true);
    const validated = await service.consumeForExecution('project-1', runId);
    expect(validated).toMatchObject({
      run: { id: run.id, version: run.version, proposal: run.proposal },
      snapshot: { identity: '1:2', workingDirectoryIdentity: '1:2' },
    });
    expect(await service.consumeForExecution('project-1', runId)).toBeNull();
  });
  it('displays the configured runtime and rejects a runtime change after approval', async () => {
    const { service, deps } = fixture();
    vi.mocked(deps.snapshot).mockResolvedValue({
      root: '/fixture',
      identity: '1:2',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
      runtimeDirectory: '/trusted/node-bin',
    });
    expect(await service.request('project-1', runId)).toBe(true);
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('/trusted/node-bin'));
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('/trusted/node-bin:/usr/bin:/bin')
    );
    vi.mocked(deps.snapshot).mockResolvedValue({
      root: '/fixture',
      identity: '1:2',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
      runtimeDirectory: '/different/node-bin',
    });
    expect(await service.consumeForExecution('project-1', runId)).toBeNull();
  });
  it('displays executable paths and rejects changed executable configuration', async () => {
    const { service, deps } = fixture();
    const snapshot = {
      root: '/fixture',
      identity: '1:2',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
      runtimeDirectory: '/trusted/bin',
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
    };
    vi.mocked(deps.snapshot).mockResolvedValue(snapshot);
    expect(await service.request('project-1', runId)).toBe(true);
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('/trusted/npm'));
    vi.mocked(deps.snapshot).mockResolvedValue({ ...snapshot, npmExecutable: '/other/npm' });
    expect(await service.consumeForExecution('project-1', runId)).toBeNull();
  });
  it('rejects a changed runtime fingerprint on the same executable paths', async () => {
    const { service, deps } = fixture();
    const snapshot = {
      root: '/fixture',
      identity: '1:2',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
      runtimeFingerprint: 'b'.repeat(64),
      runtimeDirectory: '/trusted/bin',
      npmExecutable: '/trusted/npm',
      helperExecutable: '/trusted/helper',
    };
    vi.mocked(deps.snapshot).mockResolvedValue(snapshot);
    expect(await service.request('project-1', runId)).toBe(true);
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('b'.repeat(64)));
    vi.mocked(deps.snapshot).mockResolvedValue({ ...snapshot, runtimeFingerprint: 'c'.repeat(64) });
    expect(await service.consumeForExecution('project-1', runId)).toBeNull();
  });
  it('rejects changed scripts and project snapshots after approval', async () => {
    const a = fixture();
    expect(await a.service.request('project-1', runId)).toBe(true);
    a.run.proposal.args = ['run', 'test'];
    a.run.version++;
    expect(await a.service.consume('project-1', runId)).toBe(false);
    const b = fixture();
    expect(await b.service.request('project-1', runId)).toBe(true);
    vi.mocked(b.deps.snapshot).mockResolvedValue({
      root: '/fixture',
      identity: '1:3',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
    });
    expect(await b.service.consume('project-1', runId)).toBe(false);
  });
  it('rejects changed scripts during the dialog even if the version does not change', async () => {
    const { service, deps, run } = fixture();
    let release: (value: ApprovalDecision) => void = () => {};
    vi.mocked(deps.confirm).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = service.request('project-1', runId);
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalled());
    release('approve');
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledTimes(2));
    if (!run.proposal.declaredScripts) throw new Error('Missing fixture scripts');
    run.proposal.declaredScripts.test = 'changed';
    release('approve');
    expect(await pending).toBe(false);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('does not display a dialog for another project or an invalid snapshot', async () => {
    const a = fixture();
    expect(await a.service.request('project-2', runId)).toBe(false);
    expect(a.deps.confirm).not.toHaveBeenCalled();
    const b = fixture();
    vi.mocked(b.deps.snapshot).mockResolvedValue({
      root: 'relative',
      identity: '1:2',
      workingDirectoryIdentity: '1:2',
      fingerprint: 'a'.repeat(64),
    });
    expect(await b.service.request('project-1', runId)).toBe(false);
    expect(b.deps.confirm).not.toHaveBeenCalled();
  });
  it('records explicit denial and issues no approval', async () => {
    const { service, deps } = fixture();
    vi.mocked(deps.confirm).mockResolvedValue('deny');
    expect(await service.request('project-1', runId)).toBe(false);
    expect(deps.deny).toHaveBeenCalledWith('project-1', runId, 1);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('does not record denial when the native preview is dismissed', async () => {
    const { service, deps } = fixture();
    vi.mocked(deps.confirm).mockResolvedValue('cancel');
    expect(await service.request('project-1', runId)).toBe(false);
    expect(deps.deny).not.toHaveBeenCalled();
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('records the explicit deny decision from a three-way native dialog', async () => {
    const { service, deps } = fixture();
    vi.mocked(deps.confirm).mockResolvedValue('deny');
    expect(await service.request('project-1', runId)).toBe(false);
    expect(deps.deny).toHaveBeenCalledWith('project-1', runId, 1);
  });
  it('does not grant a cancelled dialog or an expired approval', async () => {
    const a = fixture();
    let resolve: (value: ApprovalDecision) => void = () => {};
    vi.mocked(a.deps.confirm).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = a.service.request('project-1', runId);
    await vi.waitFor(() => expect(a.deps.confirm).toHaveBeenCalled());
    a.service.revoke('project-1', runId);
    resolve('approve');
    expect(await pending).toBe(false);
    expect(await a.service.consume('project-1', runId)).toBe(false);
    const b = fixture();
    let now = 1000;
    b.deps.now = () => now;
    expect(await b.service.request('project-1', runId)).toBe(true);
    now += 60_000;
    expect(await b.service.consume('project-1', runId)).toBe(false);
  });
  it('rejects revocation during post-dialog snapshot validation', async () => {
    const { service, deps, run } = fixture();
    const snapshot = vi.mocked(deps.snapshot);
    const value = await deps.snapshot(
      'project-1',
      auditId,
      commandProposalSchema.parse(run.proposal)
    );
    let release: () => void = () => {};
    snapshot.mockClear();
    snapshot.mockResolvedValueOnce(value).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(value);
        })
    );
    const pending = service.request('project-1', runId);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    service.revoke('project-1', runId);
    release();
    expect(await pending).toBe(false);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
  it('rejects revocation while a one-use grant is being revalidated', async () => {
    const { service, deps, run } = fixture();
    expect(await service.request('project-1', runId)).toBe(true);
    const value = await deps.snapshot(
      'project-1',
      auditId,
      commandProposalSchema.parse(run.proposal)
    );
    let release: () => void = () => {};
    vi.mocked(deps.snapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(value);
        })
    );
    const pending = service.consume('project-1', runId);
    await vi.waitFor(() => expect(deps.snapshot).toHaveBeenCalledTimes(4));
    service.revoke('project-1', runId);
    release();
    expect(await pending).toBe(false);
    expect(await service.consume('project-1', runId)).toBe(false);
  });
});
