import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNativeProjectFs, resolveNativeProjectFsPath } from './native-loader';

describe('TraceMind native filesystem loader', () => {
  it('loads the app build from its trusted development path', () => {
    const native = loadNativeProjectFs({
      platform: process.platform,
      packaged: false,
      appPath: process.cwd(),
      resourcesPath: '',
    });
    expect(typeof native.openRoot).toBe('function');
    expect(typeof native.identity).toBe('function');
    expect(typeof native.close).toBe('function');
    if (process.platform === 'win32') {
      expect(typeof native.stat).toBe('function');
      expect(typeof native.read).toBe('function');
    }
  });
  it('loads from the packaged resources layout', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'tracemind-resource-'));
    try {
      await mkdir(join(resourcesPath, 'dist-tracemind-native'));
      const fixturePath = join(resourcesPath, 'dist-tracemind-native', 'tracemind_fs.node');
      await copyFile(
        join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node'),
        fixturePath
      );
      const options = {
        platform: process.platform,
        packaged: true,
        appPath: '',
        resourcesPath,
      } as const;
      expect(resolveNativeProjectFsPath(options)).toBe(fixturePath);
      if (process.platform === 'win32') {
        // Windows keeps a loaded .node DLL locked. Load the packaged copy in a
        // short-lived child so the fixture can be removed after that process exits.
        const probe = spawnSync(
          process.execPath,
          [
            '-e',
            "const addon = require(process.argv[1]); if (typeof addon.list !== 'function' || typeof addon.identity !== 'function' || typeof addon.close !== 'function' || (process.platform === 'win32' && (typeof addon.stat !== 'function' || typeof addon.read !== 'function'))) process.exit(2)",
            fixturePath,
          ],
          { encoding: 'utf8', windowsHide: true }
        );
        expect(probe.status, probe.stderr).toBe(0);
      } else {
        const native = loadNativeProjectFs(options);
        expect(typeof native.list).toBe('function');
        expect(typeof native.identity).toBe('function');
        expect(typeof native.close).toBe('function');
      }
    } finally {
      await rm(resourcesPath, { recursive: true, force: true });
    }
  });
  it('rejects unsupported platforms and missing packaged module', () => {
    expect(() =>
      loadNativeProjectFs({
        platform: 'aix',
        packaged: false,
        appPath: process.cwd(),
        resourcesPath: '',
      })
    ).toThrow('unavailable');
    expect(() =>
      loadNativeProjectFs({
        platform: 'darwin',
        packaged: true,
        appPath: '',
        resourcesPath: join(process.cwd(), 'does-not-exist'),
      })
    ).toThrow();
  });
});
