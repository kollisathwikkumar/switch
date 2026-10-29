import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditGrantStore } from './grant-store';

const project = { locationId: 'project', root: resolve('project') };

describe('audit grant store', () => {
  it('requires an approval and consumes a grant exactly once', async () => {
    const store = new AuditGrantStore(() => 100);
    expect(await store.request(project, async () => false)).toBe(false);
    expect(store.consume(project)).toBe(false);
    expect(await store.request(project, async () => true)).toBe(true);
    expect(store.consume(project)).toBe(true);
    expect(store.consume(project)).toBe(false);
  });

  it('denies expired and mismatched grants without consuming another scope', async () => {
    let now = 100;
    const store = new AuditGrantStore(() => now);
    await store.request(project, async () => true);
    expect(store.consume({ ...project, root: resolve('other') })).toBe(false);
    now += 60_000;
    expect(store.consume(project)).toBe(false);
  });

  it('revokes an existing grant and fails closed if approval errors', async () => {
    const store = new AuditGrantStore(() => 100);
    await store.request(project, async () => true);
    store.revoke(project.locationId);
    expect(store.consume(project)).toBe(false);
    await expect(
      store.request(project, async () => {
        throw new Error('dialog');
      })
    ).rejects.toThrow();
    expect(store.consume(project)).toBe(false);
  });
});
