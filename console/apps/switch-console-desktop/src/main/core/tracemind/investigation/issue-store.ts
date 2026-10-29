import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import { getAudit } from '../audit/audit-store';

const locationSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const idSchema = z.string().uuid();
const contentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    auditId: idSchema.nullable().optional(),
  })
  .strict();
const issueSchema = contentSchema.extend({
  id: idSchema,
  locationId: locationSchema,
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type IssueInput = z.infer<typeof contentSchema>;
export type TraceMindIssue = z.infer<typeof issueSchema>;

function prefix(locationId: string): string {
  return `tracemind:issue:${locationSchema.parse(locationId)}:`;
}

function key(locationId: string, id: string): string {
  return `${prefix(locationId)}${idSchema.parse(id)}`;
}

function parseIssue(raw: string, locationId: string): TraceMindIssue {
  const issue = issueSchema.parse(JSON.parse(raw));
  if (issue.locationId !== locationId) throw new Error('Stored issue project mismatch');
  return issue;
}

async function validateAudit(
  locationId: string,
  auditId: string | null | undefined
): Promise<void> {
  if (auditId && !(await getAudit(locationId, auditId))) throw new Error('Related audit not found');
}

export async function createIssue(locationId: string, input: IssueInput): Promise<TraceMindIssue> {
  const validated = contentSchema.parse(input);
  locationSchema.parse(locationId);
  await validateAudit(locationId, validated.auditId);
  const now = Date.now();
  const issue: TraceMindIssue = {
    ...validated,
    id: randomUUID(),
    locationId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(kv)
    .values({ key: key(locationId, issue.id), value: JSON.stringify(issue), updatedAt: now });
  return issue;
}

export async function getIssue(locationId: string, id: string): Promise<TraceMindIssue | null> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key(locationId, id)))
    .limit(1);
  return row ? parseIssue(row.value, locationId) : null;
}

export async function listIssues(locationId: string): Promise<TraceMindIssue[]> {
  const start = prefix(locationId);
  const rows = await db
    .select({ value: kv.value })
    .from(kv)
    .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)));
  return rows
    .map((row) => parseIssue(row.value, locationId))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function updateIssue(
  locationId: string,
  id: string,
  version: number,
  input: IssueInput
): Promise<TraceMindIssue> {
  const validated = contentSchema.parse(input);
  const issueKey = key(locationId, id);
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, issueKey)).limit(1);
  if (!row) throw new Error('Issue not found');
  const current = parseIssue(row.value, locationId);
  if (current.id !== id || current.version !== version) throw new Error('Issue has changed');
  await validateAudit(locationId, validated.auditId);
  const updated: TraceMindIssue = {
    ...current,
    ...validated,
    version: current.version + 1,
    updatedAt: Date.now(),
  };
  const result = await db
    .update(kv)
    .set({ value: JSON.stringify(updated), updatedAt: updated.updatedAt })
    .where(and(eq(kv.key, issueKey), eq(kv.value, row.value)))
    .returning({ key: kv.key });
  if (result.length !== 1) throw new Error('Issue has changed');
  return updated;
}
