import { dirname, isAbsolute, join } from 'node:path';
import { app, dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { getLocationById } from '@main/core/locations/store';
import { findExecutableOnPath } from '@main/core/utils/resolve-executable';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { runLocalAudit } from './audit/audit-service';
import {
  compareAuditEvidence,
  getAudit,
  getAuditReport,
  listAuditEvidence,
  listAudits,
  recordGraphIndexFailure,
  recordGraphCoverage,
  saveAudit,
} from './audit/audit-store';
import { benchmarkGraphAdapter } from './graph/benchmark';
import { inspectGraph } from './graph/graph-query';
import { indexAuditGraph } from './graph/graph-service';
import {
  appendGraphRecordBounded,
  getGraphOverview,
  type GraphRecordInput,
} from './graph/graph-store';
import { createIssue, listIssues, updateIssue, type IssueInput } from './investigation/issue-store';
import { closeNativeFileHandle, nativeFileIdentity } from './native/access-registry';
import { loadNativeProjectFs } from './native/native-loader';
import { AuditApprovalService } from './project-registry/approval-service';
import { pickLocalProject } from './project-registry/pick-project';
import { resolveSelectedLocalProject } from './project-registry/selected-project';
import { VerificationApprovalService } from './verification/approval-service';
import { DiscoveryCache } from './verification/discovery-cache';
import { createLocalVerificationRunner } from './verification/local-runner';
import {
  closeRunProposal,
  createRunProposal,
  getRunProposal,
  getRunOutputArtifact,
  getRunResultPreview,
  listRunProposals,
} from './verification/run-store';
import { fingerprintRuntime } from './verification/runtime-fingerprint';
import { detectSandboxMode } from './verification/sandbox';
import { discoverAuditedChecks, verifyApprovalSnapshot } from './verification/snapshot-verifier';

function loadTraceMindNative(): ReturnType<typeof loadNativeProjectFs> {
  return loadNativeProjectFs({
    platform: process.platform,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
}

async function approvedRootIdentity(root: string): Promise<string> {
  const native = loadTraceMindNative();
  const handle = native.openRoot(root);
  try {
    return nativeFileIdentity(native, handle);
  } finally {
    closeNativeFileHandle(native, handle);
  }
}

const rootApprovalOptions = { directoryIdentity: approvedRootIdentity };
const approvals = new AuditApprovalService(rootApprovalOptions);
const discoveryApprovals = new AuditApprovalService(rootApprovalOptions);
const checkScanApprovals = new AuditApprovalService(rootApprovalOptions);
const discoveredChecks = new DiscoveryCache();
let auditRunning = false;
let discoveryRunning = false;
let checkPreviewRunning = false;
const activeCheckRunners = new Map<
  string,
  { locationId: string; auditId: string; runner: ReturnType<typeof createLocalVerificationRunner> }
>();
function checkRuntime() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const npmExecutable = findExecutableOnPath('npm');
  const nodeExecutable = findExecutableOnPath('node');
  if (
    !npmExecutable ||
    !nodeExecutable ||
    !isAbsolute(npmExecutable) ||
    !isAbsolute(nodeExecutable)
  )
    return null;
  const helperExecutable = join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    'dist-tracemind-native',
    'tracemind_verification_cwd'
  );
  return {
    npmExecutable,
    nodeExecutable,
    helperExecutable,
    runtimeDirectory: dirname(nodeExecutable),
  };
}
const checkApprovals = new VerificationApprovalService({
  load: getRunProposal,
  snapshot: async (locationId, auditId, proposal) => {
    const audit = await getAudit(locationId, auditId);
    if (!audit) return null;
    const selected = await resolveSelectedLocalProject(locationId, getLocationById);
    if (selected.root !== audit.root) return null;
    const native = loadTraceMindNative();
    const snapshot = await verifyApprovalSnapshot(audit, proposal, native);
    if (!snapshot) return null;
    const runtime = checkRuntime();
    if (!runtime) return snapshot;
    try {
      return {
        ...snapshot,
        runtimeDirectory: runtime.runtimeDirectory,
        npmExecutable: runtime.npmExecutable,
        helperExecutable: runtime.helperExecutable,
        runtimeFingerprint: await fingerprintRuntime([
          runtime.npmExecutable,
          runtime.nodeExecutable,
          runtime.helperExecutable,
        ]),
      };
    } catch {
      return snapshot;
    }
  },
  confirm: async (preview) => {
    const window = getMainWindow();
    if (!window) return 'cancel';
    const isolationConfirmation = preview.includes('FINAL CONFIRMATION REQUIRED');
    const choice = await dialog.showMessageBox(window, {
      type: 'warning',
      title: isolationConfirmation ? 'Confirm unisolated check' : 'Review proposed check',
      message: isolationConfirmation
        ? 'This is a separate final confirmation to run without OS isolation.'
        : 'No check will run from this review.',
      detail: `${preview}\n\nApproval expires after 60 seconds. A separate action starts the check.`,
      buttons: ['Cancel', 'Deny', isolationConfirmation ? 'Run without isolation' : 'Approve once'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 2 ? 'approve' : choice.response === 1 ? 'deny' : 'cancel';
  },
  deny: async (locationId, runId, version) => {
    await closeRunProposal(locationId, runId, version, 'denied');
  },
  now: Date.now,
});

async function requireLocalLocation(locationId: string): Promise<void> {
  if (typeof locationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(locationId)) {
    throw new Error('Invalid location ID');
  }
  const location = await getLocationById(locationId);
  if (!location || location.id !== locationId || location.sshHost !== null) {
    throw new Error('Registered local location required');
  }
}

export const tracemindController = createRPCController({
  pickLocalProject,
  discoverAuditChecks: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    if (!audit) throw new Error('Project audit not found');
    if (discoveryRunning) throw new Error('Check discovery is already running');
    discoveryRunning = true;
    try {
      if (!(await discoveryApprovals.request(locationId, 'check-discovery'))) return null;
      const project = await discoveryApprovals.consumeProject(locationId);
      if (!project || project.root !== audit.root || project.identity !== audit.identity)
        throw new Error('Project changed since the audit; run a new audit.');
      const native = loadTraceMindNative();
      const result = await discoverAuditedChecks(audit, native, detectSandboxMode());
      if (!result) throw new Error('Project changed or audit is incomplete; run a new audit.');
      return {
        ...result,
        discoveryId: discoveredChecks.issue(locationId, auditId, result.candidates),
      };
    } finally {
      discoveryRunning = false;
    }
  },
  saveDiscoveredCheck: async (
    locationId: string,
    auditId: string,
    discoveryId: string,
    index: number
  ) => {
    await requireLocalLocation(locationId);
    return discoveredChecks.save(locationId, auditId, discoveryId, index, (proposal) =>
      createRunProposal(locationId, auditId, proposal)
    );
  },
  getCheckProposal: async (locationId: string, runId: string) => {
    await requireLocalLocation(locationId);
    return getRunProposal(locationId, runId);
  },
  getCheckResultPreview: async (locationId: string, auditId: string, runId: string) => {
    await requireLocalLocation(locationId);
    return getRunResultPreview(locationId, auditId, runId);
  },
  getCheckOutputArtifact: async (
    locationId: string,
    auditId: string,
    runId: string,
    stream: 'stdout' | 'stderr'
  ) => {
    await requireLocalLocation(locationId);
    return getRunOutputArtifact({ projectId: locationId, auditId, runId, stream });
  },
  listCheckProposals: async (locationId: string, auditId: string, cursor: string | null) => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    return listRunProposals(locationId, auditId, cursor);
  },
  cancelCheckProposal: async (
    locationId: string,
    auditId: string,
    runId: string,
    version: number
  ) => {
    await requireLocalLocation(locationId);
    const record = await getRunProposal(locationId, runId);
    if (!record || record.auditId !== auditId) throw new Error('Audit proposal not found');
    if (record.state !== 'proposed' || record.version !== version)
      throw new Error('Run proposal changed or is terminal');
    checkApprovals.revoke(locationId, runId);
    return closeRunProposal(locationId, runId, version, 'cancelled');
  },
  requestCheckApproval: async (
    locationId: string,
    auditId: string,
    runId: string
  ): Promise<'approved' | 'denied' | 'not-approved' | 'unavailable'> => {
    await requireLocalLocation(locationId);
    const record = await getRunProposal(locationId, runId);
    if (!record || record.auditId !== auditId || record.state !== 'proposed')
      throw new Error('Pending audit proposal not found');
    const audit = await getAudit(locationId, auditId);
    if (!audit) throw new Error('Project audit not found');
    if (checkPreviewRunning) throw new Error('A check review is already running');
    checkPreviewRunning = true;
    try {
      checkApprovals.revoke(locationId, runId);
      // Revoke any prior one-use grant before checking capability. Do not
      // create a new grant for a check this host cannot start; Windows lacks
      // descriptor-bound working-directory handoff.
      if (!checkRuntime()) return 'unavailable';
      if (!(await checkScanApprovals.request(locationId, 'check-preview'))) return 'not-approved';
      const project = await checkScanApprovals.consumeProject(locationId);
      if (!project || project.root !== audit.root || project.identity !== audit.identity)
        throw new Error('Project changed since the audit; run a new audit.');
      if (await checkApprovals.request(locationId, runId)) return 'approved';
      const latest = await getRunProposal(locationId, runId);
      return latest?.state === 'denied' ? 'denied' : 'not-approved';
    } finally {
      checkPreviewRunning = false;
    }
  },
  runApprovedCheck: async (locationId: string, auditId: string, runId: string) => {
    await requireLocalLocation(locationId);
    const record = await getRunProposal(locationId, runId);
    if (!record || record.auditId !== auditId || record.state !== 'proposed')
      throw new Error('Pending audit proposal not found');
    const runtime = checkRuntime();
    if (!runtime) throw new Error('Verification runtime unavailable');
    const native = loadTraceMindNative();
    const runner = createLocalVerificationRunner({
      approvals: checkApprovals,
      native,
      npmExecutable: runtime.npmExecutable,
      helperExecutable: runtime.helperExecutable,
    });
    if (activeCheckRunners.has(runId)) throw new Error('Check is already active');
    activeCheckRunners.set(runId, { locationId, auditId, runner });
    try {
      const result = await runner.run(locationId, runId);
      return {
        id: result.id,
        state: result.state,
        version: result.version,
        verified: result.verified,
      };
    } finally {
      activeCheckRunners.delete(runId);
    }
  },
  cancelRunningCheck: async (locationId: string, auditId: string, runId: string) => {
    await requireLocalLocation(locationId);
    const active = activeCheckRunners.get(runId);
    if (!active || active.locationId !== locationId || active.auditId !== auditId) return false;
    return active.runner.cancel(locationId, runId);
  },
  requestAuditApproval: async (locationId: string): Promise<boolean> => {
    if (typeof locationId !== 'string' || !locationId.trim() || locationId.length > 256) {
      throw new Error('Invalid location ID');
    }
    return approvals.request(locationId);
  },
  listAudits: async (locationId: string) => {
    await requireLocalLocation(locationId);
    return listAudits(locationId);
  },
  listAuditEvidence: async (locationId: string, auditId: string, offset: number) => {
    await requireLocalLocation(locationId);
    return listAuditEvidence(locationId, auditId, offset, 50);
  },
  compareAuditEvidence: async (locationId: string, previousId: string, currentId: string) => {
    await requireLocalLocation(locationId);
    return compareAuditEvidence(locationId, previousId, currentId);
  },
  getAuditReport: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    return getAuditReport(locationId, auditId);
  },
  runAudit: async (locationId: string) => {
    await requireLocalLocation(locationId);
    if (auditRunning) throw new Error('An audit is already running');
    auditRunning = true;
    try {
      const native = loadTraceMindNative();
      return await runLocalAudit(locationId, {
        native,
        gitStatusExecutable: join(
          app.isPackaged ? process.resourcesPath : app.getAppPath(),
          'dist-tracemind-native',
          'tracemind_git_cwd'
        ),
        consume: (id) => approvals.consumeProject(id),
        save: saveAudit,
        recordGraphFailure: (audit, coverage) =>
          recordGraphIndexFailure(audit.locationId, audit.id, coverage),
        recordGraphCoverage: (audit, coverage) =>
          recordGraphCoverage(audit.locationId, audit.id, coverage),
        indexGraph: async (audit, files) => {
          return await indexAuditGraph(audit, files);
        },
      });
    } finally {
      auditRunning = false;
    }
  },
  getGraphOverview: async (locationId: string, revision: string, afterId: string | null) => {
    await requireLocalLocation(locationId);
    return getGraphOverview(locationId, revision, afterId);
  },
  inspectGraph: async (
    locationId: string,
    revision: string,
    startNodeId: string,
    limits: {
      direction?: 'outgoing' | 'both';
      maxDepth: number;
      maxResults: number;
      maxEdges: number;
      maxTimeMs: number;
      maxMemoryBytes?: number;
    }
  ) => {
    await requireLocalLocation(locationId);
    return inspectGraph(locationId, revision, startNodeId, limits);
  },
  benchmarkGraphAdapter: async (locationId: string, revision: string) => {
    await requireLocalLocation(locationId);
    return benchmarkGraphAdapter(locationId, revision);
  },
  recordGraphEntry: async (locationId: string, revision: string, input: GraphRecordInput) => {
    await requireLocalLocation(locationId);
    await appendGraphRecordBounded(locationId, revision, input);
  },
  listIssues: async (locationId: string) => {
    await requireLocalLocation(locationId);
    return listIssues(locationId);
  },
  createIssue: async (locationId: string, input: IssueInput) => {
    await requireLocalLocation(locationId);
    return createIssue(locationId, input);
  },
  updateIssue: async (locationId: string, id: string, version: number, input: IssueInput) => {
    await requireLocalLocation(locationId);
    return updateIssue(locationId, id, version, input);
  },
});
