import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  lookup: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  consume: vi.fn(),
  native: vi.fn(),
  runAudit: vi.fn(),
  listAudits: vi.fn(),
  saveAudit: vi.fn(),
  listEvidence: vi.fn(),
  compareEvidence: vi.fn(),
  getReport: vi.fn(),
  indexGraph: vi.fn(),
  listGraphs: vi.fn(),
  getGraph: vi.fn(),
  overview: vi.fn(),
  inspectGraph: vi.fn(),
  benchmarkGraph: vi.fn(),
  recordGraph: vi.fn(),
  getAudit: vi.fn(),
  getRunProposal: vi.fn(),
  verificationRevoke: vi.fn(),
  verificationRequest: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app' } }));
vi.mock('./audit/audit-service', () => ({ runLocalAudit: mocks.runAudit }));
vi.mock('./audit/audit-store', () => ({
  getAudit: mocks.getAudit,
  listAudits: mocks.listAudits,
  saveAudit: mocks.saveAudit,
  listAuditEvidence: mocks.listEvidence,
  compareAuditEvidence: mocks.compareEvidence,
  getAuditReport: mocks.getReport,
}));
vi.mock('./graph/graph-service', () => ({ indexAuditGraph: mocks.indexGraph }));
vi.mock('./graph/graph-store', () => ({
  appendGraphRecordBounded: mocks.recordGraph,
  getGraphSnapshot: mocks.getGraph,
  getGraphOverview: mocks.overview,
  listGraphSnapshots: mocks.listGraphs,
}));
vi.mock('./graph/graph-query', () => ({ inspectGraph: mocks.inspectGraph }));
vi.mock('./graph/benchmark', () => ({ benchmarkGraphAdapter: mocks.benchmarkGraph }));
vi.mock('./native/native-loader', () => ({ loadNativeProjectFs: mocks.native }));
vi.mock('@main/core/locations/store', () => ({ getLocationById: mocks.lookup }));
vi.mock('./investigation/issue-store', () => ({
  createIssue: mocks.create,
  listIssues: mocks.list,
  updateIssue: mocks.update,
}));
vi.mock('./project-registry/approval-service', () => ({
  AuditApprovalService: class {
    request = mocks.request;
    consumeProject = mocks.consume;
  },
}));
vi.mock('./verification/approval-service', () => ({
  VerificationApprovalService: class {
    request = mocks.verificationRequest;
    revoke = mocks.verificationRevoke;
  },
}));
vi.mock('./verification/run-store', () => ({
  createRunProposal: vi.fn(),
  getRunProposal: mocks.getRunProposal,
  getRunOutputArtifact: vi.fn(),
  getRunResultPreview: vi.fn(),
  listRunProposals: vi.fn(),
  closeRunProposal: vi.fn(),
  claimRunExecution: vi.fn(),
  finishRunExecution: vi.fn(),
  markRunOutcomeUnknown: vi.fn(),
}));
vi.mock('./verification/execution-reservation', () => ({
  acquireExecutionReservation: vi.fn(),
  releaseExecutionReservation: vi.fn(),
}));

const { tracemindController } = await import('./controller');

beforeEach(() => vi.resetAllMocks());

describe('TraceMind approval RPC', () => {
  it('requests native approval for a selected location', async () => {
    mocks.request.mockResolvedValue(true);
    await expect(tracemindController.requestAuditApproval('location-1')).resolves.toBe(true);
    expect(mocks.request).toHaveBeenCalledWith('location-1');
  });

  it('rejects invalid input before invoking the approval service', async () => {
    await expect(tracemindController.requestAuditApproval('')).rejects.toThrow(
      'Invalid location ID'
    );
    await expect(tracemindController.requestAuditApproval(' '.repeat(3))).rejects.toThrow(
      'Invalid location ID'
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== 'win32')(
  'does not prompt or preserve a check approval when execution runtime is unavailable on Windows',
  async () => {
    const runId = '00000000-0000-4000-8000-000000000001';
    const auditId = '00000000-0000-4000-8000-000000000002';
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.getRunProposal.mockResolvedValue({
      id: runId,
      projectId: 'location-1',
      auditId,
      state: 'proposed',
      version: 1,
      verified: false,
    });
    mocks.getAudit.mockResolvedValue({
      id: auditId,
      locationId: 'location-1',
      root: '/project',
      identity: '1:2',
    });

    await expect(
      tracemindController.requestCheckApproval('location-1', auditId, runId)
    ).resolves.toBe('unavailable');
    expect(mocks.verificationRevoke).toHaveBeenCalledWith('location-1', runId);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.verificationRequest).not.toHaveBeenCalled();
  }
);

it('requires a local project before comparing captured evidence', async () => {
  mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
  mocks.compareEvidence.mockResolvedValue({ status: 'unavailable' });
  await expect(
    tracemindController.compareAuditEvidence('location-1', 'old', 'new')
  ).resolves.toEqual({ status: 'unavailable' });
  expect(mocks.compareEvidence).toHaveBeenCalledWith('location-1', 'old', 'new');
  mocks.lookup.mockResolvedValue(undefined);
  await expect(tracemindController.compareAuditEvidence('missing', 'old', 'new')).rejects.toThrow(
    'local'
  );
});

describe('TraceMind issue RPC', () => {
  it('requires a registered local location and delegates issue operations', async () => {
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.create.mockResolvedValue({ id: 'issue' });
    await tracemindController.createIssue('location-1', { title: 'Bug', description: '' });
    expect(mocks.create).toHaveBeenCalledWith('location-1', { title: 'Bug', description: '' });
    await tracemindController.listIssues('location-1');
    expect(mocks.list).toHaveBeenCalledWith('location-1');
    await tracemindController.updateIssue('location-1', 'issue', 1, {
      title: 'Edited',
      description: '',
    });
    expect(mocks.update).toHaveBeenCalledWith('location-1', 'issue', 1, {
      title: 'Edited',
      description: '',
    });
  });

  it('rejects unknown and remote locations', async () => {
    mocks.lookup.mockResolvedValue(undefined);
    await expect(tracemindController.listIssues('missing')).rejects.toThrow('local');
    mocks.lookup.mockResolvedValue({ id: 'remote', sshHost: 'host' });
    await expect(tracemindController.listIssues('remote')).rejects.toThrow('local');
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('TraceMind audit RPC', () => {
  it('runs and lists audits for a registered local location', async () => {
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.native.mockReturnValue({});
    mocks.runAudit.mockResolvedValue({ id: 'audit' });
    await expect(tracemindController.runAudit('location-1')).resolves.toEqual({ id: 'audit' });
    expect(mocks.runAudit).toHaveBeenCalledWith(
      'location-1',
      expect.objectContaining({ consume: expect.any(Function), save: mocks.saveAudit })
    );
    await tracemindController.listAudits('location-1');
    expect(mocks.listAudits).toHaveBeenCalledWith('location-1');
  });
  it('rejects unregistered locations before running an audit', async () => {
    mocks.lookup.mockResolvedValue(undefined);
    await expect(tracemindController.runAudit('missing')).rejects.toThrow('local');
    expect(mocks.runAudit).not.toHaveBeenCalled();
  });
});

it('exposes persistent graph inspection, entry recording and benchmark RPCs locally', async () => {
  mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
  mocks.listGraphs.mockResolvedValue([]);
  mocks.getGraph.mockResolvedValue(null);
  mocks.overview.mockResolvedValue(null);
  mocks.inspectGraph.mockResolvedValue({
    nodes: [],
    relationships: [],
    truncated: false,
    stopReason: null,
  });
  mocks.benchmarkGraph.mockResolvedValue({ adapter: 'sqlite-kv' });
  mocks.recordGraph.mockResolvedValue({ revision: 'r' });
  await tracemindController.getGraphOverview('location-1', 'r', null);
  await tracemindController.inspectGraph('location-1', 'r', 'node', {
    maxDepth: 1,
    maxResults: 1,
    maxEdges: 1,
    maxTimeMs: 1,
  });
  await tracemindController.benchmarkGraphAdapter('location-1', 'r');
  await expect(
    tracemindController.recordGraphEntry('location-1', 'r', {
      kind: 'hypothesis',
      label: 'Theory',
      reason: 'User supplied',
    })
  ).resolves.toBeUndefined();
  expect(mocks.overview).toHaveBeenCalledWith('location-1', 'r', null);
  expect(mocks.inspectGraph).toHaveBeenCalled();
  expect(mocks.benchmarkGraph).toHaveBeenCalledWith('location-1', 'r');
  expect(mocks.recordGraph).toHaveBeenCalled();
  mocks.lookup.mockResolvedValue(undefined);
  await expect(tracemindController.getGraphOverview('missing', 'r', null)).rejects.toThrow('local');
});

it('does not expose full graph snapshots to the renderer', () => {
  expect(tracemindController).not.toHaveProperty('getGraphSnapshot');
  expect(tracemindController).not.toHaveProperty('listGraphSnapshots');
});

it('retrieves an audit evidence page only for a registered local project', async () => {
  mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
  mocks.listEvidence.mockResolvedValue({ items: [], nextOffset: null });
  await expect(tracemindController.listAuditEvidence('location-1', 'audit-id', 0)).resolves.toEqual(
    { items: [], nextOffset: null }
  );
  expect(mocks.listEvidence).toHaveBeenCalledWith('location-1', 'audit-id', 0, 50);
});
