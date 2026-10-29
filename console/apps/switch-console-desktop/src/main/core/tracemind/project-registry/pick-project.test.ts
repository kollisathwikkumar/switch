import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(), window: vi.fn(), ensure: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: mocks.open } }));
vi.mock('@main/app/window', () => ({ getMainWindow: mocks.window }));
vi.mock('@main/core/locations/store', () => ({ ensureLocation: mocks.ensure }));
const { pickLocalProject } = await import('./pick-project');
beforeEach(() => vi.resetAllMocks());
describe('native project picker', () => {
  it('registers the canonical directory selected by the user without approving an audit', async () => {
    const path = await mkdtemp(join(tmpdir(), 'tracemind-picked-'));
    try {
      const canonical = await realpath(path);
      mocks.window.mockReturnValue({});
      mocks.open.mockResolvedValue({ canceled: false, filePaths: [path] });
      mocks.ensure.mockResolvedValue({
        id: 'local',
        dir: canonical,
        sshHost: null,
        name: basename(canonical),
      });
      const result = await pickLocalProject();
      expect(result?.id).toBe('local');
      expect(mocks.ensure).toHaveBeenCalledWith({
        sshHost: null,
        dir: canonical,
        name: basename(canonical),
      });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
  it('does not register anything when cancelled or no app window exists', async () => {
    mocks.window.mockReturnValue({});
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await pickLocalProject()).toBeNull();
    mocks.window.mockReturnValue(null);
    expect(await pickLocalProject()).toBeNull();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
