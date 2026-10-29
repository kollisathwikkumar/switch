import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import { getBootIdentity } from './boot-identity';
import { getRunProposal, interruptRunExecution } from './run-store';

const reservationKey = 'tracemind:verification-execution-reservation:v1';
const ownerSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const storedSchema = z
  .object({
    owner: ownerSchema,
    projectId: ownerSchema,
    host: z.string().regex(/^[a-f0-9]{64}$/),
    boot: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function decode(raw: string): z.infer<typeof storedSchema> | null {
  try {
    const result = storedSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
/** Reconcile only a known run from this machine after its recorded boot has ended. */
export async function acquireExecutionReservation(
  owner: string,
  projectId?: string
): Promise<boolean> {
  ownerSchema.parse(owner);
  if (projectId !== undefined) ownerSchema.parse(projectId);
  const identity = projectId ? await getBootIdentity() : null;
  const [existing] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, reservationKey))
    .limit(1);
  if (existing) {
    const previous = decode(existing.value);
    if (
      !identity ||
      !previous ||
      previous.host !== identity.host ||
      previous.boot === identity.boot
    )
      return false;
    const run = await getRunProposal(previous.projectId, previous.owner);
    if (!run) return false;
    if (run.state === 'running')
      await interruptRunExecution(previous.projectId, previous.owner, run.version);
    const removed = await db
      .delete(kv)
      .where(and(eq(kv.key, reservationKey), eq(kv.value, existing.value)))
      .returning({ key: kv.key });
    if (removed.length !== 1) return false;
  }
  const value = identity && projectId ? JSON.stringify({ owner, projectId, ...identity }) : owner;
  const rows = await db
    .insert(kv)
    .values({ key: reservationKey, value, updatedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ key: kv.key });
  return rows.length === 1;
}
/** Caller must establish that the reserved executor and its descendants have stopped. */
export async function releaseExecutionReservation(owner: string): Promise<boolean> {
  ownerSchema.parse(owner);
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, reservationKey))
    .limit(1);
  if (!row || (decode(row.value)?.owner ?? row.value) !== owner) return false;
  const rows = await db
    .delete(kv)
    .where(and(eq(kv.key, reservationKey), eq(kv.value, row.value)))
    .returning({ key: kv.key });
  return rows.length === 1;
}
export async function isExecutionReservationHeldBy(owner: string): Promise<boolean> {
  ownerSchema.parse(owner);
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, reservationKey))
    .limit(1);
  return !!row && (decode(row.value)?.owner ?? row.value) === owner;
}
