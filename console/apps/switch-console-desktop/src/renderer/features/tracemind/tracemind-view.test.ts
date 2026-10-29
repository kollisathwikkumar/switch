import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  locations: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listAudits: vi.fn(),
  approve: vi.fn(),
  runAudit: vi.fn(),
  pickProject: vi.fn(),
  evidence: vi.fn(),
  compareEvidence: vi.fn(),
  report: vi.fn(),
  graphs: vi.fn(),
  graph: vi.fn(),
  overview: vi.fn(),
  inspectGraph: vi.fn(),
  benchmarkGraph: vi.fn(),
  recordGraph: vi.fn(),
  discoverChecks: vi.fn(),
  saveCheck: vi.fn(),
  listChecks: vi.fn(),
  cancelCheck: vi.fn(),
  getCheckResult: vi.fn(),
  reviewCheck: vi.fn(),
  runCheck: vi.fn(),
  stopCheck: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    locations: { getLocations: mocks.locations },
    tracemind: {
      listIssues: mocks.list,
      createIssue: mocks.create,
      updateIssue: mocks.update,
      listAudits: mocks.listAudits,
      requestAuditApproval: mocks.approve,
      runAudit: mocks.runAudit,
      pickLocalProject: mocks.pickProject,
      listAuditEvidence: mocks.evidence,
      compareAuditEvidence: mocks.compareEvidence,
      getAuditReport: mocks.report,
      listGraphSnapshots: mocks.graphs,
      getGraphSnapshot: mocks.graph,
      getGraphOverview: mocks.overview,
      inspectGraph: mocks.inspectGraph,
      benchmarkGraphAdapter: mocks.benchmarkGraph,
      recordGraphEntry: mocks.recordGraph,
      discoverAuditChecks: mocks.discoverChecks,
      saveDiscoveredCheck: mocks.saveCheck,
      listCheckProposals: mocks.listChecks,
      cancelCheckProposal: mocks.cancelCheck,
      getCheckResultPreview: mocks.getCheckResult,
      requestCheckApproval: mocks.reviewCheck,
      runApprovedCheck: mocks.runCheck,
      cancelRunningCheck: mocks.stopCheck,
    },
  },
}));
const bootstrap = new JSDOM('<!doctype html>');
vi.stubGlobal('window', bootstrap.window);
vi.stubGlobal('document', bootstrap.window.document);
const { createRoot } = await import('react-dom/client');
const { TraceMindMainPanel } = await import('./tracemind-view');
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.resetAllMocks();
  dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.window.document.querySelector('#root') as HTMLDivElement;
  root = createRoot(container);
  mocks.locations.mockResolvedValue([
    { id: 'local', name: 'Local project', dir: '/repo', sshHost: null },
    { id: 'remote', name: 'Remote project', dir: '/remote', sshHost: 'host' },
  ]);
  mocks.list.mockResolvedValue([]);
  mocks.listAudits.mockResolvedValue([]);
  mocks.listChecks.mockResolvedValue({ items: [], nextCursor: null });
  mocks.evidence.mockResolvedValue({ items: [], nextOffset: null });
  mocks.compareEvidence.mockResolvedValue({ status: 'unavailable' });
  mocks.report.mockResolvedValue('TraceMind local audit report\nFixture evidence');
  mocks.graphs.mockResolvedValue([]);
  mocks.graph.mockResolvedValue(null);
  mocks.overview.mockResolvedValue(null);
  await act(async () => {
    root.render(React.createElement(TraceMindMainPanel));
  });
});

it('offers cancellation for a running check loaded after the view is reopened', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-1',
      locationId: 'local',
      root: '/repo',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'running',
        verified: false,
        version: 2,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: null,
      },
    ],
    nextCursor: null,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const stop = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Cancel running check')
  );
  expect(stop).toBeDefined();
  mocks.stopCheck.mockResolvedValue(true);
  await act(async () => stop?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.stopCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('Cancellation requested');
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'finished',
        verified: false,
        version: 3,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: 'cancelled',
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3200));
  });
  expect(container.textContent).toContain('finished · cancelled');
  expect(container.textContent).toContain('View result');
});

it('shows a bounded check result without treating it as verified', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-1',
      locationId: 'local',
      root: '/repo',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'finished',
        verified: false,
        version: 3,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: 'exited',
      },
    ],
    nextCursor: null,
  });
  const result = {
    outputReferences: [
      { projectId: 'local', auditId: 'audit-1', runId: 'run-1', stream: 'stdout' },
      { projectId: 'local', auditId: 'audit-1', runId: 'run-1', stream: 'stderr' },
    ],
    status: 'exited',
    exitCode: 7,
    signal: null,
    stdout: 'fixture output',
    stderr: 'fixture error',
    stdoutHash: 'a'.repeat(64),
    stderrHash: 'b'.repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutPreviewTruncated: true,
    stderrPreviewTruncated: false,
    capturedComplete: true,
    terminationUnconfirmed: false,
    sandboxMode: 'unavailable',
    durationMs: 25,
    execution: {
      executable: '/fixture/npm',
      args: ['run', 'test'],
      cwd: '/repo',
      environmentKeys: ['PATH'],
      timeoutMs: 60000,
      outputBytes: 1000,
      spawned: true,
      workingDirectoryBinding: 'descriptor',
      targetHandoff: 'exec_handoff',
    },
    effectiveLimits: {
      timeout: 'termination-request',
      output: 'retained-bytes',
      concurrency: 'durable-single-flight',
      cpuTimeSeconds: false,
      processCount: false,
      memory: false,
    },
    executionMismatch: true,
    executionMatchConfirmed: false,
  };
  mocks.getCheckResult.mockResolvedValue(result);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const show = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View result')
  );
  expect(show).toBeDefined();
  await act(async () => show?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.getCheckResult).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('fixture output');
  expect(container.textContent).toContain('/fixture/npm');
  expect(container.textContent).toContain('CPU-time limit: not enforced');
  expect(container.textContent).toContain('Target handoff: exec_handoff');
  expect(container.textContent).toContain(
    'The adapter-reported command or effective resource limits did not match the approved proposal.'
  );
  expect(container.textContent).toContain(
    'Requested caps: process/task limit 1 (Linux counts threads and sandbox helpers) · memory 536,870,912 bytes.'
  );
  expect(container.textContent).toContain('Memory limit: not enforced');
  expect(container.textContent).toContain(
    'Concurrency: one durable check at a time across the application database'
  );
  expect(container.textContent).toContain('Output references');
  expect(container.textContent).toContain('"stream":"stdout"');
  expect(container.textContent).toContain('"stream":"stderr"');
  expect(container.textContent).toContain('preview truncated');
  expect(container.textContent).toContain('not verified');

  mocks.getCheckResult.mockResolvedValueOnce({
    ...result,
    effectiveLimits: {
      ...result.effectiveLimits,
      processCount: 1,
      memory: 536_870_912,
    },
  });
  await act(async () => show?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(container.textContent).toContain('Memory limit: 536,870,912 bytes');
  expect(container.textContent).toContain('Process/task limit: 1 task');
  expect(container.textContent).not.toContain('neither cap is enforced by this runner');
});

it('renders a verified check state from its persisted summary', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-1',
      locationId: 'local',
      root: '/repo',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-verified',
        state: 'finished',
        verified: true,
        version: 3,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'macos-sandbox-exec',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: 'exited',
      },
    ],
    nextCursor: null,
  });
  mocks.getCheckResult.mockResolvedValue({
    outputReferences: [],
    status: 'exited',
    exitCode: 0,
    signal: null,
    stdout: 'passed',
    stderr: '',
    stdoutHash: 'a'.repeat(64),
    stderrHash: 'b'.repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutPreviewTruncated: false,
    stderrPreviewTruncated: false,
    capturedComplete: true,
    terminationUnconfirmed: false,
    sandboxMode: 'unavailable',
    durationMs: 10,
    execution: null,
    effectiveLimits: null,
    executionMismatch: false,
    executionMatchConfirmed: true,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('finished · exited · verified');
  const show = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View result')
  );
  await act(async () => show?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(container.textContent).toContain('· verified');
  expect(container.textContent).toContain('Executed command matched the approved proposal');
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('TraceMind issue workflow', () => {
  it('disables the editor until the selected project issues finish loading', async () => {
    let resolve: (items: never[]) => void = () => {};
    mocks.list.mockImplementationOnce(
      () =>
        new Promise<never[]>((done) => {
          resolve = done;
        })
    );
    const select = container.querySelector('select');
    await act(async () => {
      if (!select) throw new Error('Missing selector');
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    expect(container.querySelector('input')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true
    );
    await act(async () => resolve([]));
    expect(container.querySelector('input')?.disabled).toBe(false);
  });
  it('offers local projects and loads issues on selection', async () => {
    const select = container.querySelector('select');
    expect(select?.textContent).toContain('Local project');
    expect(select?.textContent).not.toContain('Remote project');
    await act(async () => {
      if (select) {
        select.value = 'local';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
    });
    expect(mocks.list).toHaveBeenCalledWith('local');
    expect(container.textContent).toContain('No issues');
  });
});

it('creates and edits an issue using the selected local project', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  const title = container.querySelector('input');
  const description = container.querySelector('textarea');
  const setValue = (
    element: HTMLInputElement | HTMLTextAreaElement | null,
    value: string
  ): void => {
    if (!element) throw new Error('Missing editor');
    const prototype =
      element.tagName === 'INPUT'
        ? dom.window.HTMLInputElement.prototype
        : dom.window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('Missing value setter');
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  await act(async () => {
    setValue(title, 'Bug');
    setValue(description, 'Observed failure');
  });
  const created = {
    id: 'issue',
    locationId: 'local',
    title: 'Bug',
    description: 'Observed failure',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  mocks.create.mockResolvedValue(created);
  mocks.list.mockResolvedValue([created]);
  const form = container.querySelector('form');
  await act(async () => {
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mocks.create).toHaveBeenCalledWith('local', {
    title: 'Bug',
    description: 'Observed failure',
  });
  expect(container.textContent).toContain('Edit issue');
  await act(async () => {
    setValue(title, 'Edited');
  });
  mocks.update.mockResolvedValue({ ...created, title: 'Edited', version: 2 });
  await act(async () => {
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mocks.update).toHaveBeenCalledWith('local', 'issue', 1, {
    title: 'Edited',
    description: 'Observed failure',
  });
});

it('lets a user review a newer issue version without discarding their draft', async () => {
  const original = {
    id: 'issue',
    locationId: 'local',
    title: 'Original',
    description: 'Old',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const latest = {
    ...original,
    title: 'Someone else edited',
    description: 'New details',
    version: 2,
    updatedAt: 2,
  };
  mocks.list.mockResolvedValueOnce([original]);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const issueButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Original'
  );
  await act(async () =>
    issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  const title = container.querySelector('input');
  await act(async () => {
    if (!title) throw new Error('Missing title');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      title,
      'My draft'
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  mocks.update.mockRejectedValueOnce(new Error('Issue has changed'));
  const form = container.querySelector('form');
  await act(async () =>
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(title?.value).toBe('My draft');
  const refresh = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Refresh issue version')
  );
  expect(refresh).toBeDefined();
  mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([latest]);
  await act(async () =>
    refresh?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(title?.value).toBe('My draft');
  expect(container.textContent).toContain('Could not refresh the issue');
  await act(async () =>
    refresh?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(title?.value).toBe('My draft');
  expect(container.textContent).toContain('Someone else edited');
  expect(container.textContent).toContain('New details');
  expect(container.textContent).toContain('overwrites the latest version');
  mocks.update.mockResolvedValueOnce({
    ...latest,
    title: 'My draft',
    description: 'Old',
    version: 3,
  });
  await act(async () =>
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(mocks.update).toHaveBeenLastCalledWith('local', 'issue', 2, {
    title: 'My draft',
    description: 'Old',
  });
});

it('retains a successfully created issue when refreshing the list fails', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  const title = container.querySelector('input');
  await act(async () => {
    if (!title) throw new Error('Missing title');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      title,
      'Bug'
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  mocks.create.mockResolvedValue({
    id: 'issue',
    locationId: 'local',
    title: 'Bug',
    description: '',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  mocks.list.mockRejectedValue(new Error('offline'));
  await act(async () => {
    container
      .querySelector('form')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(container.textContent).toContain('Edit issue');
  expect(container.textContent).toContain('Bug');
});

it('requests approval and shows persisted audit coverage', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  mocks.approve.mockResolvedValue(true);
  mocks.runAudit.mockResolvedValue({
    id: 'audit-1',
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    fingerprint: 'a'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 0,
      skipped: 1,
      skippedEntries: [{ path: '.env', reason: 'excluded' }],
      skipDetailsTruncated: false,
      inventoryComplete: true,
      errors: [],
      languages: [{ language: 'TypeScript', files: 1 }],
      manifests: ['package.json'],
      limitations: ['No parsing'],
    },
  });
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Run audit')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.approve).toHaveBeenCalledWith('local');
  expect(mocks.runAudit).toHaveBeenCalledWith('local');
  expect(container.textContent).toContain('No parsing');
  expect(container.textContent).toContain('TypeScript');
  expect(container.textContent).toContain('1 file');
  expect(container.textContent).toContain('.env');
  expect(container.textContent).toContain('excluded');
  mocks.discoverChecks.mockResolvedValue({
    discoveryId: 'discovery-1',
    candidates: [
      {
        executable: 'npm',
        args: ['run', 'test'],
        workingDirectory: '.',
        sandboxMode: 'macos-sandbox-exec',
        declaredScripts: { test: 'echo test' },
      },
    ],
    limitations: ['Discovery only'],
  });
  const discover = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Discover checks')
  );
  expect(discover).toBeDefined();
  await act(async () =>
    discover?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.discoverChecks).toHaveBeenCalledWith('local', 'audit-1');
  expect(container.textContent).toContain('echo test');
  expect(container.textContent).toContain('Effective sandbox mode: macos-sandbox-exec');
  expect(container.textContent).toContain('Discovery only');
  mocks.saveCheck.mockResolvedValue({ id: 'run-1', state: 'proposed', verified: false });
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'proposed',
        verified: false,
        version: 1,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: null,
      },
    ],
    nextCursor: null,
  });
  const saveCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Save proposal')
  );
  expect(saveCheck).toBeDefined();
  await act(async () =>
    saveCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.saveCheck).toHaveBeenCalledWith('local', 'audit-1', 'discovery-1', 0);
  expect(container.textContent).toContain('run-1');
  expect(container.textContent).toContain('not executed');
  expect(container.textContent).toContain(
    'Requested caps: process/task limit 1 (Linux counts threads and sandbox helpers) · memory 536,870,912 bytes.'
  );
  expect(mocks.listChecks).toHaveBeenCalledWith('local', 'audit-1', null);
  const reviewCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Review check')
  );
  expect(reviewCheck).toBeDefined();
  mocks.reviewCheck.mockResolvedValue('not-approved');
  await act(async () =>
    reviewCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.reviewCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('No check was run');
  mocks.reviewCheck.mockResolvedValue('unavailable');
  await act(async () =>
    reviewCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain(
    'Verification runtime is unavailable on this host. No approval was created and no check was run.'
  );
  expect(mocks.runCheck).not.toHaveBeenCalled();
  mocks.reviewCheck.mockResolvedValue('approved');
  await act(async () =>
    reviewCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.runCheck).not.toHaveBeenCalled();
  const runCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Run approved check')
  );
  expect(runCheck).toBeDefined();
  expect(container.textContent).toContain('later checks remain blocked');
  expect(container.textContent).toContain('Recovery requires a detected reboot');
  mocks.runCheck.mockRejectedValue(new Error('fixture failure'));
  await act(async () =>
    runCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.runCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('fixture failure');
  const cancelCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Cancel proposal')
  );
  expect(cancelCheck).toBeDefined();
  mocks.cancelCheck.mockResolvedValue({ id: 'run-1', state: 'cancelled', version: 2 });
  await act(async () =>
    cancelCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.cancelCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1', 1);
  expect(container.textContent).toContain('cancelled');
  const reportButton = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View audit report')
  );
  expect(reportButton).toBeDefined();
  await act(async () =>
    reportButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.report).toHaveBeenCalledWith('local', 'audit-1');
  expect(container.textContent).toContain('Fixture evidence');
});

it('links an issue to a selected audit and opens the linked historical audit', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: null,
    dirty: null,
    fingerprint: 'a'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', capturedAt: 200 },
    { ...base, id: 'old' },
  ]);
  const project = container.querySelector('select');
  await act(async () => {
    if (!project) throw new Error('Missing project selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const auditSelect = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Related audit"]'
  );
  expect(auditSelect).toBeDefined();
  const title = container.querySelector('input');
  await act(async () => {
    if (!auditSelect || !title) throw new Error('Missing fields');
    auditSelect.value = 'old';
    auditSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      title,
      'Linked issue'
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  mocks.create.mockResolvedValue({
    id: 'issue',
    locationId: 'local',
    title: 'Linked issue',
    description: '',
    auditId: 'old',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  await act(async () =>
    container
      .querySelector('form')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(mocks.create).toHaveBeenCalledWith('local', {
    title: 'Linked issue',
    description: '',
    auditId: 'old',
  });
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View related audit')
  );
  expect(button).toBeDefined();
  await act(async () =>
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Audit to inspect"]')?.value
  ).toBe('old');
});

it('does not run an audit after the user denies approval', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  mocks.approve.mockResolvedValue(false);
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Run audit')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.runAudit).not.toHaveBeenCalled();
  expect(container.textContent).toContain('not approved');
});

it('registers a selected local folder and loads its issues', async () => {
  mocks.pickProject.mockResolvedValue({
    id: 'new-project',
    name: 'New project',
    dir: '/new',
    sshHost: null,
  });
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Add local project')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.pickProject).toHaveBeenCalledOnce();
  expect(mocks.list).toHaveBeenCalledWith('new-project');
  expect(container.querySelector('select')?.value).toBe('new-project');
});

it('shows when successive stored audit fingerprints differ without claiming live freshness', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    identity: '1:42',
    revision: 'a'.repeat(40),
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', fingerprint: 'c'.repeat(64) },
  ]);
  mocks.compareEvidence.mockResolvedValue({
    status: 'compared',
    counts: { changed: 1, removed: 1, added: 0 },
    items: [
      { path: 'src/changed.ts', change: 'changed' },
      { path: 'src/gone.ts', change: 'removed' },
    ],
    truncated: false,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(container.textContent).toContain('Snapshots differ');
  expect(container.textContent).toContain('1 file inventoried · 0 parsed');
  expect(container.textContent).toContain('not a plain file-content SHA-256');
  expect(container.textContent).toContain('current project state is not monitored');
  expect(mocks.compareEvidence).toHaveBeenCalledWith('local', 'old', 'new');
  expect(container.textContent).toContain('src/changed.ts');
  expect(container.textContent).toContain('src/gone.ts');
  expect(container.textContent).toContain('Earlier evidence is stale');
});

it('does not infer a comparison when a prior fingerprint is unavailable', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', fingerprint: null },
  ]);
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(container.textContent).toContain('Comparison unavailable');
  expect(container.textContent).not.toContain('Snapshots differ');
});

it('does not compare fingerprints when a root was replaced at the same path', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', identity: '1:43', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', identity: '1:42', fingerprint: 'b'.repeat(64) },
  ]);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('Comparison unavailable');
  expect(container.textContent).not.toContain('fingerprints match');
});

it('shows captured file evidence and loads additional pages', async () => {
  const base = {
    id: 'audit-1',
    locationId: 'local',
    root: '/repo',
    revision: 'a'.repeat(40),
    dirty: null,
    fingerprint: 'b'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 2,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([base]);
  mocks.evidence
    .mockResolvedValueOnce({
      items: [{ path: 'src/a.ts', fingerprint: 'c'.repeat(64) }],
      nextOffset: 1,
    })
    .mockResolvedValueOnce({
      items: [{ path: 'src/b.ts', fingerprint: 'd'.repeat(64) }],
      nextOffset: null,
    });
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(mocks.evidence).toHaveBeenCalledWith('local', 'audit-1', 0);
  expect(container.textContent).toContain('src/a.ts');
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Load more')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.evidence).toHaveBeenCalledWith('local', 'audit-1', 1);
  expect(container.textContent).toContain('src/b.ts');
});

it('inspects persisted graph relationships and parser limitations for an audit', async () => {
  const audit = {
    id: 'audit-graph',
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: 'a'.repeat(40),
    dirty: false,
    fingerprint: 'b'.repeat(64),
    capturedAt: 1,
    inventory: {
      filesDiscovered: 2,
      filesParsed: 1,
      graphCoverage: { status: 'partial', omittedFiles: 1 },
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  const snapshot = {
    projectId: 'local',
    revision: 'audit:audit-graph',
    capturedAt: 1,
    parserFailures: [
      { path: 'README.md', language: 'plain-text', message: 'No parser adapter is available.' },
    ],
    retrievalReasons: [
      {
        id: 'reason',
        projectId: 'local',
        revision: 'audit:audit-graph',
        evidenceNodeId: 'evidence',
        reason: 'Selected local audit file.',
        retrievedAt: 1,
      },
    ],
    nodes: [
      {
        id: 'root',
        projectId: 'local',
        revision: 'audit:audit-graph',
        kind: 'repository_revision',
        label: audit.revision,
        source: null,
        extractionMethod: 'audit',
        provenance: 'audit:audit-graph',
        stale: false,
        createdAt: 1,
      },
      {
        id: 'stale-evidence',
        projectId: 'local',
        revision: 'audit:audit-graph',
        kind: 'evidence',
        label: 'sha256:stale-content',
        source: { path: 'src/stale.ts', startLine: 4, endLine: 6 },
        extractionMethod: 'typescript-ast-v1',
        provenance: 'audit:audit-previous',
        stale: true,
        createdAt: 1,
      },
    ],
    relationships: [],
  };
  mocks.listAudits.mockResolvedValue([audit]);
  mocks.graph.mockResolvedValue(snapshot);
  mocks.overview.mockResolvedValue({
    revision: snapshot.revision,
    rootNodeId: 'root',
    nodeCount: 2,
    relationshipCount: 0,
    parserFailureCount: 1,
    nodes: snapshot.nodes,
    nextCursor: null,
    parserFailures: snapshot.parserFailures,
    retrievalReasons: snapshot.retrievalReasons,
  });
  mocks.inspectGraph.mockResolvedValue({
    nodes: snapshot.nodes,
    relationships: [
      {
        id: 'contains',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'root',
        targetId: 'root',
        relation: 'CONTAINS',
        source: null,
        extractionMethod: 'audit',
        provenance: 'audit:audit-graph',
        stale: false,
        createdAt: 1,
      },
      {
        id: 'contradicts',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'stale-evidence',
        targetId: 'root',
        relation: 'CONTRADICTS',
        source: null,
        extractionMethod: 'manual',
        provenance: 'investigation',
        stale: false,
        createdAt: 1,
      },
      {
        id: 'supports',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'stale-evidence',
        targetId: 'root',
        relation: 'SUPPORTS',
        source: null,
        extractionMethod: 'manual',
        provenance: 'investigation',
        stale: false,
        createdAt: 1,
      },
    ],
    truncated: false,
    stopReason: null,
  });
  mocks.benchmarkGraph
    .mockResolvedValueOnce({
      adapter: 'sqlite-normalized',
      nodes: 2,
      relationships: 0,
      readMs: 1.2,
      traversalMs: 2.3,
      traversalNodes: 12,
      traversalRelationships: 30,
      truncated: true,
      stopReason: 'time_limit',
    })
    .mockResolvedValueOnce({
      adapter: 'sqlite-normalized',
      nodes: 2,
      relationships: 0,
      readMs: 0.8,
      traversalMs: 1.1,
      traversalNodes: 2,
      traversalRelationships: 1,
      truncated: false,
      stopReason: null,
    });
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(container.textContent).toContain('Evidence graph');
  expect(container.textContent).toContain('2 files inventoried · 1 parsed');
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    'Graph coverage is partial'
  );
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    '1 of 2 inventoried files have parser-derived graph evidence · 1 omitted'
  );
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    'Some evidence may be missing'
  );
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    'must not be treated as up to date'
  );
  expect(container.textContent).toContain('Graph coverage is partial');
  expect(container.textContent).toContain('Some evidence may be missing');
  expect(container.querySelector('[aria-label="Evidence graph"]')?.textContent).toContain(
    '1 of 2 inventoried files have parser-derived graph evidence · 1 omitted'
  );
  expect(container.querySelector('[aria-label="Evidence graph"]')?.textContent).toContain(
    'must not be treated as up to date'
  );
  expect(container.textContent).toContain('No parser adapter is available');
  expect(mocks.overview).toHaveBeenCalledWith('local', 'audit:audit-graph', null);
  expect(mocks.graph).not.toHaveBeenCalled();
  const benchmark = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Benchmark local adapter'
  );
  await act(async () =>
    benchmark?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain('bounded traversal stopped at time_limit');
  await act(async () =>
    benchmark?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain('bounded traversal completed within limits');
  const inspect = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Inspect graph'
  );
  await act(async () =>
    inspect?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.inspectGraph).toHaveBeenCalledWith(
    'local',
    'audit:audit-graph',
    'root',
    expect.objectContaining({ direction: 'both' })
  );
  const start = container.querySelector<HTMLSelectElement>('[aria-label="Graph inspection start"]');
  await act(async () => {
    if (!start) throw new Error('Missing inspection start');
    start.value = 'stale-evidence';
    start.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await act(async () =>
    inspect?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.inspectGraph).toHaveBeenLastCalledWith(
    'local',
    'audit:audit-graph',
    'stale-evidence',
    expect.objectContaining({ direction: 'both' })
  );
  expect(container.textContent).toContain('CONTAINS');
  expect(container.textContent).toContain('SUPPORTS');
  expect(container.textContent).toContain('CONTRADICTS');
  expect(container.querySelector('[aria-label="TraceMind sections"]')).not.toBeNull();
  expect(container.querySelector('svg[aria-label="Inspected evidence graph"]')).not.toBeNull();
  const graphTab = [...container.querySelectorAll('nav button')].find(
    (button) => button.textContent === 'Evidence graph'
  );
  await act(async () =>
    graphTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(graphTab?.getAttribute('aria-current')).toBe('page');
  expect(container.querySelector('[aria-label="Evidence graph"]')?.parentElement?.hidden).toBe(
    false
  );
  const visualNode = container.querySelector<SVGGElement>(
    'svg g[aria-label^="Inspect from evidence:"]'
  );
  await act(async () =>
    visualNode?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(start?.value).toBe('stale-evidence');
  const details = container.querySelector('[aria-label="Selected node details"]');
  expect(details?.textContent).toContain('sha256:stale-content');
  expect(details?.textContent).toContain('typescript-ast-v1');
  expect(details?.textContent).toContain('audit:audit-previous');
  expect(details?.textContent).toContain('CONTRADICTS');
  const graph = container.querySelector('svg[aria-label="Inspected evidence graph"]');
  if (!graph || !visualNode) throw new Error('Missing graph');
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 480,
    width: 800,
    height: 480,
    toJSON: () => ({}),
  });
  const circle = visualNode.querySelector('circle');
  const beforeDrag = circle?.getAttribute('cx');
  await act(async () => {
    visualNode.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      })
    );
    graph.dispatchEvent(
      new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 100 })
    );
    graph.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
  });
  expect(circle?.getAttribute('cx')).not.toBe(beforeDrag);
  const zoomIn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in graph"]');
  const beforeZoom = graph?.getAttribute('viewBox');
  await act(async () =>
    zoomIn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(graph?.getAttribute('viewBox')).not.toBe(beforeZoom);
  await act(async () =>
    visualNode?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    )
  );
  expect(container.querySelector('[aria-label="Selected node details"]')?.textContent).toContain(
    'sha256:stale-content'
  );
  expect(container.textContent).toContain('src/stale.ts:4');
  expect(container.textContent).toContain('stale');
});

it('warns that partial graph omissions can be unquantified', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-partial-unknown',
      locationId: 'local',
      root: '/repo',
      identity: '1:2',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 2,
        filesParsed: 2,
        graphCoverage: { status: 'partial', omittedFiles: 0 },
        skipped: 0,
        inventoryComplete: false,
        errors: [{ path: '', message: 'Time limit reached' }],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing project selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const coverage = container.querySelector('[aria-label="Audit graph coverage"]');
  expect(coverage?.textContent).toContain('Graph coverage is partial');
  expect(coverage?.textContent).toContain(
    'no file-level parser omissions are currently quantified; additional omissions may be unknown'
  );
  expect(coverage?.textContent).toContain('Some evidence may be missing');
  expect(coverage?.textContent).toContain('freshness is not guaranteed');
  expect(coverage?.textContent).toContain('must not be treated as up to date');
});

it('pages graph targets and refreshes only the bounded overview after recording', async () => {
  const audit = {
    id: 'audit-pages',
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: null,
    dirty: false,
    fingerprint: 'b'.repeat(64),
    capturedAt: 1,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 1,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  const base = {
    revision: 'audit:audit-pages',
    rootNodeId: 'root',
    nodeCount: 100_000,
    relationshipCount: 200_000,
    parserFailureCount: 0,
    parserFailures: [],
    retrievalReasons: [],
  };
  mocks.listAudits.mockResolvedValue([audit]);
  mocks.overview.mockImplementation(
    async (_location: string, _revision: string, cursor: string | null) =>
      cursor === 'a'
        ? {
            ...base,
            nodes: [{ id: 'b', kind: 'file', label: 'src/b.ts', stale: false }],
            nextCursor: null,
          }
        : {
            ...base,
            nodes: [{ id: 'a', kind: 'file', label: 'src/a.ts', stale: false }],
            nextCursor: 'a',
          }
  );
  const project = container.querySelector('select');
  await act(async () => {
    if (!project) throw new Error('Missing project selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('Target page 1');
  const next = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Next targets'
  );
  await act(async () => next?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.overview).toHaveBeenCalledWith('local', 'audit:audit-pages', 'a');
  expect(container.textContent).toContain('Target page 2');
  const target = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Graph relationship target"]'
  );
  expect(target?.options).toHaveLength(2);
  await act(async () => {
    if (!target) throw new Error('Missing target selector');
    target.value = 'b';
    target.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const relation = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Graph relationship type"]'
  );
  const label = container.querySelector<HTMLInputElement>(
    'input[aria-label="Investigation entry label"]'
  );
  const reason = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Retrieval or recording rationale"]'
  );
  await act(async () => {
    if (!relation || !label || !reason) throw new Error('Missing entry controls');
    relation.value = 'SUPPORTS';
    relation.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      label,
      'Observation'
    );
    label.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
      reason,
      'Recorded rationale'
    );
    reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const record = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Record entry'
  );
  let finishRecord: () => void = () => {};
  mocks.recordGraph.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRecord = resolve;
      })
  );
  await act(async () => {
    record?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    record?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.recordGraph).toHaveBeenCalledTimes(1);
  expect(record?.disabled).toBe(true);
  await act(async () => finishRecord());
  expect(mocks.recordGraph).toHaveBeenCalledWith('local', 'audit:audit-pages', {
    kind: 'observation',
    label: 'Observation',
    reason: 'Recorded rationale',
    targetNodeId: 'b',
    relation: 'SUPPORTS',
  });
  expect(mocks.overview).toHaveBeenCalledTimes(3);
  expect(mocks.graph).not.toHaveBeenCalled();
  const previous = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Previous targets'
  );
  await act(async () =>
    previous?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain('Target page 1');
});
