import { describe, expect, it, vi } from 'vitest';
import { discoverPackageChecks } from './command-contract';
import { DiscoveryCache } from './discovery-cache';
const auditId = '00000000-0000-4000-8000-000000000001';
const proposal = () =>
  discoverPackageChecks('{"scripts":{"test":"echo test"}}', '.', `audit:${auditId}`)[0]!;
describe('bounded discovery cache', () => {
  it('saves only a scoped, unmodified, once-claimed candidate', async () => {
    const cache = new DiscoveryCache();
    const candidate = proposal();
    const token = cache.issue('project-1', auditId, [candidate]);
    candidate.declaredScripts.test = 'tampered';
    const save = vi.fn(async (item) => item);
    await expect(cache.save('project-2', auditId, token, 0, save)).rejects.toThrow();
    const actual = await cache.save('project-1', auditId, token, 0, save);
    expect(actual.declaredScripts.test).toBe('echo test');
    await expect(cache.save('project-1', auditId, token, 0, save)).rejects.toThrow();
    expect(save).toHaveBeenCalledOnce();
  });
  it('rejects expiration, invalid selection and concurrent replay', async () => {
    let now = 10;
    const cache = new DiscoveryCache(() => now);
    const token = cache.issue('project-1', auditId, [proposal()]);
    await expect(
      cache.save('project-1', auditId, token, 1, async (item) => item)
    ).rejects.toThrow();
    let release: () => void = () => {};
    const first = cache.save('project-1', auditId, token, 0, async (item) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return item;
    });
    await expect(
      cache.save('project-1', auditId, token, 0, async (item) => item)
    ).rejects.toThrow();
    release();
    await expect(first).resolves.toMatchObject({ workingDirectory: '.' });
    const expired = cache.issue('project-1', auditId, [proposal()]);
    now += 300_000;
    await expect(
      cache.save('project-1', auditId, expired, 0, async (item) => item)
    ).rejects.toThrow();
  });
  it('allows retry after storage failure and bounds cached sessions', async () => {
    const cache = new DiscoveryCache(() => 10);
    const token = cache.issue('project-1', auditId, [proposal()]);
    await expect(
      cache.save('project-1', auditId, token, 0, async () => {
        throw new Error('write');
      })
    ).rejects.toThrow('write');
    await expect(
      cache.save('project-1', auditId, token, 0, async (item) => item)
    ).resolves.toMatchObject({ workingDirectory: '.' });
    for (let index = 0; index < 16; index++) cache.issue('project-1', auditId, [proposal()]);
    await expect(
      cache.save('project-1', auditId, token, 0, async (item) => item)
    ).rejects.toThrow();
  });
});
