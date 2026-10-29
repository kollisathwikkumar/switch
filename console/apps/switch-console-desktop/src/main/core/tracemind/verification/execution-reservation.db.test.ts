import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';
const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  identity: { host: 'a'.repeat(64), boot: 'b'.repeat(64) },
}));
vi.mock('./boot-identity', () => ({ getBootIdentity: async () => mocks.identity }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { saveAudit } = await import('../audit/audit-store');
const { discoverPackageChecks } = await import('./command-contract');
const { createRunProposal, claimRunExecution, getRunProposal } = await import('./run-store');
const { acquireExecutionReservation, releaseExecutionReservation } =
  await import('./execution-reservation');
describe('durable execution reservation', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    mocks.identity = { host: 'a'.repeat(64), boot: 'b'.repeat(64) };
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });
  it('recovers only after the same host reboots and marks a running check interrupted', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
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
    });
    const proposal = discoverPackageChecks(
      '{"scripts":{"test":"echo ok"}}',
      '.',
      `audit:${audit.id}`
    )[0]!;
    const run = await createRunProposal('project-1', audit.id, proposal);
    expect(await acquireExecutionReservation(run.id, 'project-1')).toBe(true);
    await claimRunExecution('project-1', run.id, 1);
    expect(await acquireExecutionReservation('next-owner', 'project-1')).toBe(false);
    mocks.identity = { host: 'c'.repeat(64), boot: 'd'.repeat(64) };
    expect(await acquireExecutionReservation('next-owner', 'project-1')).toBe(false);
    mocks.identity = { host: 'a'.repeat(64), boot: 'd'.repeat(64) };
    expect(await acquireExecutionReservation('next-owner', 'project-1')).toBe(true);
    expect(await getRunProposal('project-1', run.id)).toMatchObject({
      state: 'interrupted',
      verified: false,
    });
    expect(await releaseExecutionReservation('next-owner')).toBe(true);
  });
  it('survives reopening and prevents a second owner until the matching owner releases it', async () => {
    expect(await acquireExecutionReservation('owner-1')).toBe(true);
    expect(await acquireExecutionReservation('owner-2')).toBe(false);
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await acquireExecutionReservation('owner-2')).toBe(false);
      expect(await releaseExecutionReservation('owner-2')).toBe(false);
      expect(await releaseExecutionReservation('owner-1')).toBe(true);
      expect(await acquireExecutionReservation('owner-2')).toBe(true);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });
});
