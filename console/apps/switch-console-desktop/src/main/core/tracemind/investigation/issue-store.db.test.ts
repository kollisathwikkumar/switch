import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));

const { createIssue, getIssue, listIssues, updateIssue } = await import('./issue-store');
const { saveAudit } = await import('../audit/audit-store');

describe('TraceMind issue persistence', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('links an issue only to an audit in the same project and persists edits', async () => {
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
    const issue = await createIssue('project-1', {
      title: 'Bug',
      description: '',
      auditId: audit.id,
    });
    expect((await getIssue('project-1', issue.id))?.auditId).toBe(audit.id);
    await expect(
      createIssue('project-2', { title: 'Bug', description: '', auditId: audit.id })
    ).rejects.toThrow('audit');
    await expect(
      updateIssue('project-2', issue.id, 1, { title: 'Bug', description: '', auditId: audit.id })
    ).rejects.toThrow();
    await expect(
      updateIssue('project-1', issue.id, 1, {
        title: 'Bug',
        description: '',
        auditId: '00000000-0000-4000-8000-000000000000',
      })
    ).rejects.toThrow('audit');
    expect((await getIssue('project-1', issue.id))?.auditId).toBe(audit.id);
    const unlinked = await updateIssue('project-1', issue.id, 1, {
      title: 'Bug',
      description: '',
      auditId: null,
    });
    expect(unlinked.auditId).toBeNull();
    expect((await listIssues('project-1'))[0]?.auditId).toBeNull();
  });

  it('persists, lists and edits a project-scoped issue', async () => {
    const created = await createIssue('project-1', {
      title: 'Broken test',
      description: 'Expected success',
    });
    expect(created).toMatchObject({ locationId: 'project-1', title: 'Broken test', version: 1 });
    expect(await getIssue('project-1', created.id)).toEqual(created);
    expect(await listIssues('project-1')).toEqual([created]);
    expect(await listIssues('project-2')).toEqual([]);
    expect(await getIssue('project-2', created.id)).toBeNull();
    const edited = await updateIssue('project-1', created.id, 1, {
      title: 'Updated',
      description: 'Observed failure',
    });
    expect(edited).toMatchObject({ id: created.id, title: 'Updated', version: 2 });
    expect(await getIssue('project-1', created.id)).toEqual(edited);
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getIssue('project-1', created.id)).toEqual(edited);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });

  it('rejects stale edits and invalid project identifiers', async () => {
    const issue = await createIssue('project-1', { title: 'Bug', description: '' });
    await updateIssue('project-1', issue.id, 1, { title: 'First', description: '' });
    await expect(
      updateIssue('project-1', issue.id, 1, { title: 'Second', description: '' })
    ).rejects.toThrow('changed');
    await expect(createIssue('bad:scope', { title: 'Bug', description: '' })).rejects.toThrow();
    await expect(createIssue('project-1', { title: ' ', description: '' })).rejects.toThrow();
  });
});
