import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLocationById: vi.fn(),
  getMainWindow: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock('@main/core/locations/store', () => ({ getLocationById: mocks.getLocationById }));
vi.mock('@main/app/window', () => ({ getMainWindow: mocks.getMainWindow }));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));

const { AuditApprovalService } = await import('./approval-service');

beforeEach(() => vi.resetAllMocks());

describe('native audit approval', () => {
  it('allows only one pending native prompt and releases the slot after denial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-'));
    try {
      mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
      mocks.getMainWindow.mockReturnValue({});
      let dismiss: (choice: { response: number }) => void = () => {};
      mocks.showMessageBox.mockResolvedValue({ response: 0 }).mockImplementationOnce(
        () =>
          new Promise<{ response: number }>((resolve) => {
            dismiss = resolve;
          })
      );
      const service = new AuditApprovalService();
      const pending = service.request('p');
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
      expect(await service.request('p')).toBe(false);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      dismiss({ response: 0 });
      expect(await pending).toBe(false);
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
      expect(await service.request('p')).toBe(true);
      expect(await service.consume('p')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases the prompt slot when the native dialog fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-'));
    try {
      mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
      mocks.getMainWindow.mockReturnValue({});
      mocks.showMessageBox.mockRejectedValueOnce(new Error('dialog failed'));
      const service = new AuditApprovalService();
      await expect(service.request('p')).rejects.toThrow('dialog failed');
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
      expect(await service.request('p')).toBe(true);
      expect(await service.consume('p')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('asks the user about the resolved root and consumes approval only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-'));
    try {
      mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
      const win = {};
      mocks.getMainWindow.mockReturnValue(win);
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const service = new AuditApprovalService();
      expect(await service.request('p')).toBe(true);
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        win,
        expect.objectContaining({ detail: expect.stringContaining(await realpath(root)) })
      );
      expect(await service.consume('p')).toBe(true);
      expect(await service.consume('p')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects denied prompts and fails closed when the window is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-'));
    try {
      mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
      mocks.getMainWindow.mockReturnValue({});
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const service = new AuditApprovalService();
      expect(await service.request('p')).toBe(false);
      expect(await service.consume('p')).toBe(false);
      mocks.getMainWindow.mockReturnValue(null);
      expect(await service.request('p')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('rejects a directory replaced after approval at the same path', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'tracemind-replacement-'));
  const root = join(parent, 'project');
  const { mkdir, rename } = await import('node:fs/promises');
  try {
    await mkdir(root);
    mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
    mocks.getMainWindow.mockReturnValue({});
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    const service = new AuditApprovalService();
    expect(await service.request('p')).toBe(true);
    await rename(root, join(parent, 'old'));
    await mkdir(root);
    expect(await service.consume('p')).toBe(false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it('returns a one-use approved root and filesystem identity for an audit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-'));
  try {
    mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
    mocks.getMainWindow.mockReturnValue({});
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    const { stat } = await import('node:fs/promises');
    const info = await stat(root, { bigint: true });
    const service = new AuditApprovalService();
    expect(await service.request('p')).toBe(true);
    expect(await service.consumeProject('p')).toEqual({
      locationId: 'p',
      root: await realpath(root),
      identity: `${info.dev}:${info.ino}`,
    });
    expect(await service.consumeProject('p')).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the injected native identity resolver for a one-use approved root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracemind-native-approval-'));
  const identity = 'win32:0123456789abcdef:00112233445566778899aabbccddeeff';
  const resolveIdentity = vi.fn(async () => identity);
  try {
    mocks.getLocationById.mockResolvedValue({ id: 'p', dir: root, sshHost: null });
    mocks.getMainWindow.mockReturnValue({});
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    const service = new AuditApprovalService({ directoryIdentity: resolveIdentity });
    expect(await service.request('p')).toBe(true);
    expect(await service.consumeProject('p')).toEqual({
      locationId: 'p',
      root: await realpath(root),
      identity,
    });
    expect(resolveIdentity).toHaveBeenCalledTimes(3);
    expect(resolveIdentity).toHaveBeenCalledWith(await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
