import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNativeProjectFs } from './native-loader';

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
  });
  it('loads from the packaged resources layout', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'tracemind-resource-'));
    try {
      await mkdir(join(resourcesPath, 'dist-tracemind-native'));
      await copyFile(
        join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node'),
        join(resourcesPath, 'dist-tracemind-native', 'tracemind_fs.node')
      );
      const native = loadNativeProjectFs({
        platform: process.platform,
        packaged: true,
        appPath: '',
        resourcesPath,
      });
      expect(typeof native.list).toBe('function');
      expect(typeof native.identity).toBe('function');
      expect(typeof native.close).toBe('function');
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
