import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import { getAudit } from '../audit/audit-store';
import { canVerifyRun, commandProposalSchema, type CommandProposal } from './command-contract';
import type { ProcessResult } from './process-adapter';
import { sandboxModes } from './sandbox';

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const idSchema = z.string().uuid();
// Older stored proposals did not capture lifecycle scripts. Keep them readable
// and cancellable, but the stricter command contract is required for approval.
const storedProposalSchema = commandProposalSchema.extend({
  declaredScripts: commandProposalSchema.shape.declaredScripts.optional(),
});
const resultSchema = z
  .object({
    executionMatchesProposal: z.boolean().optional(),
    // Older result records predate adapter command recording and stay readable.
    execution: z
      .object({
        executable: z.string().min(1).max(4096),
        args: z.array(z.string().max(65_536)).max(128),
        cwd: z.string().min(1).max(4096),
        environmentKeys: z
          .array(z.enum(['CI', 'NO_COLOR', 'FORCE_COLOR', 'PATH', 'HOME', 'TMPDIR']))
          .max(6),
        runtimeDirectory: z.string().min(1).max(4096).optional(),
        timeoutMs: z.number().int().min(1).max(600_000),
        outputBytes: z.number().int().min(1).max(10_000_000),
        spawned: z.boolean(),
        workingDirectoryBinding: z.enum(['path', 'descriptor', 'approved-root-handoff']).optional(),
        targetHandoff: z
          .enum(['direct', 'exec_handoff', 'failed', 'unknown', 'not_started'])
          .optional(),
      })
      .strict()
      .optional(),
    status: z.enum([
      'exited',
      'timed_out',
      'cancelled',
      'crashed',
      'output_limit',
      'spawn_error',
      'resource_limit_refused',
    ]),
    resourceLimitRefusal: z
      .object({
        platform: z.string().min(1).max(32),
        missingControls: z
          .array(z.enum(['memoryBytes', 'processCount']))
          .min(1)
          .max(2),
        reason: z.string().min(1).max(512),
      })
      .strict()
      .optional(),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(128).nullable(),
    stdout: z.string().max(10_000_000),
    stderr: z.string().max(10_000_000),
    stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
    stderrHash: z.string().regex(/^[a-f0-9]{64}$/),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    capturedComplete: z.boolean(),
    terminationUnconfirmed: z.boolean(),
    sandboxMode: z.enum(sandboxModes),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
    effectiveLimits: z
      .object({
        timeout: z.literal('termination-request'),
        output: z.literal('retained-bytes'),
        concurrency: z.enum(['per-instance', 'durable-single-flight']),
        cpuTimeSeconds: z.union([z.literal(false), z.number().int().min(1).max(600)]).optional(),
        processCount: z.union([z.literal(false), z.number().int().min(1).max(128)]),
        memory: z.union([z.literal(false), z.number().int().min(1).max(2_147_483_648)]),
      })
      .strict(),
  })
  .strict()
  .refine(
    (result) =>
      !result.capturedComplete ||
      (result.status === 'exited' &&
        !result.terminationUnconfirmed &&
        !result.stdoutTruncated &&
        !result.stderrTruncated)
  )
  .refine(
    (result) => result.status !== 'exited' || (result.exitCode !== null && result.signal === null)
  )
  .refine((result) => result.status !== 'exited' || !result.execution || result.execution.spawned)
  .refine(
    (result) =>
      result.execution?.workingDirectoryBinding !== 'descriptor' ||
      result.status !== 'exited' ||
      result.execution.targetHandoff === 'exec_handoff'
  )
  .refine(
    (result) =>
      result.execution?.workingDirectoryBinding !== 'path' ||
      result.execution.targetHandoff === 'direct'
  )
  .refine(
    (result) =>
      result.execution?.workingDirectoryBinding !== 'approved-root-handoff' ||
      result.status !== 'exited' ||
      result.execution.targetHandoff === 'exec_handoff'
  )
  .refine(
    (result) =>
      result.status !== 'spawn_error' || (result.exitCode === null && result.signal === null)
  )
  .refine(
    (result) =>
      result.status !== 'resource_limit_refused' ||
      (result.resourceLimitRefusal !== undefined &&
        result.exitCode === null &&
        result.signal === null &&
        result.execution?.spawned === false &&
        result.execution.targetHandoff === 'not_started' &&
        !result.terminationUnconfirmed &&
        result.effectiveLimits.memory === false &&
        result.effectiveLimits.processCount === false)
  )
  .refine(
    (result) =>
      result.status === 'resource_limit_refused' || result.resourceLimitRefusal === undefined
  );

function effectiveLimitsMatchProposal(
  result: { effectiveLimits: z.infer<typeof resultSchema>['effectiveLimits'] },
  proposal: Pick<CommandProposal, 'limits'>
): boolean {
  return (
    result.effectiveLimits.cpuTimeSeconds ===
      Math.max(1, Math.ceil(proposal.limits.timeoutMs / 1000)) &&
    result.effectiveLimits.processCount === proposal.limits.processCount &&
    result.effectiveLimits.memory === proposal.limits.memoryBytes
  );
}

function resultCanBeVerified(
  result: unknown,
  approved: boolean,
  proposal: Pick<CommandProposal, 'limits'>
): boolean {
  const validation = resultSchema.safeParse(result);
  if (!validation.success) return false;
  const checked = validation.data;
  if (checked.status === 'resource_limit_refused') return false;
  if (!effectiveLimitsMatchProposal(checked, proposal)) return false;
  const state =
    checked.status === 'exited'
      ? 'exited'
      : checked.status === 'timed_out'
        ? 'timed_out'
        : checked.status === 'cancelled'
          ? 'cancelled'
          : checked.status === 'output_limit'
            ? 'interrupted'
            : 'crashed';
  return canVerifyRun({
    state,
    exitCode: checked.exitCode,
    signal: checked.signal,
    stdoutTruncated: checked.stdoutTruncated,
    stderrTruncated: checked.stderrTruncated,
    isolation: checked.sandboxMode,
    approved,
    capturedComplete: checked.capturedComplete,
    executionMatchesProposal: checked.executionMatchesProposal,
    terminationUnconfirmed: checked.terminationUnconfirmed,
  });
}

const recordSchema = z
  .object({
    id: idSchema,
    projectId: projectIdSchema,
    auditId: idSchema,
    proposal: storedProposalSchema,
    state: z.enum([
      'proposed',
      'denied',
      'cancelled',
      'running',
      'finished',
      'refused',
      'interrupted',
      'outcome_unknown',
    ]),
    result: resultSchema.optional(),
    verified: z.boolean(),
    version: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine((record) => record.proposal.revision === `audit:${record.auditId}`)
  .refine(
    (record) =>
      (record.state === 'finished' || record.state === 'refused') === (record.result !== undefined)
  )
  .refine(
    (record) => record.state !== 'refused' || record.result?.status === 'resource_limit_refused'
  )
  .refine(
    (record) => record.result?.status !== 'resource_limit_refused' || record.state === 'refused'
  )
  .refine(
    (record) =>
      !record.verified ||
      (record.state === 'finished' &&
        record.result !== undefined &&
        resultCanBeVerified(record.result, true, record.proposal))
  );
export type StoredRunProposal = z.infer<typeof recordSchema>;

const summarySchema = z
  .object({
    id: idSchema,
    projectId: projectIdSchema,
    auditId: idSchema,
    state: z.enum([
      'proposed',
      'denied',
      'cancelled',
      'running',
      'finished',
      'refused',
      'interrupted',
      'outcome_unknown',
    ]),
    resultStatus: z
      .enum([
        'exited',
        'timed_out',
        'cancelled',
        'crashed',
        'output_limit',
        'spawn_error',
        'resource_limit_refused',
      ])
      .nullable(),
    verified: z.union([z.literal(0), z.literal(1)]),
    version: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    executable: z.literal('npm'),
    workingDirectory: z.string().min(1).max(4096),
    sandboxMode: z.enum(sandboxModes),
    processCount: z.number().int().min(1).max(128).nullish(),
    memoryBytes: z.number().int().min(1).max(2_147_483_648).nullish(),
  })
  .strict()
  .refine(
    (value) =>
      (value.state === 'finished' || value.state === 'refused') === (value.resultStatus !== null)
  );
export type RunProposalSummary = Omit<z.infer<typeof summarySchema>, 'verified'> & {
  verified: boolean;
};

function key(projectId: string, runId: string): string {
  return `tracemind:verification:${projectIdSchema.parse(projectId)}:${idSchema.parse(runId)}`;
}

/** SQL-side fail-closed projection for legacy records read without materializing output. */
function effectiveLimitMatchSql() {
  return sql`json_extract(${kv.value}, '$.result.effectiveLimits.cpuTimeSeconds') = max(1, cast((json_extract(${kv.value}, '$.proposal.limits.timeoutMs') + 999) / 1000 as integer))
    AND json_extract(${kv.value}, '$.result.effectiveLimits.processCount') = json_extract(${kv.value}, '$.proposal.limits.processCount')
    AND json_extract(${kv.value}, '$.result.effectiveLimits.memory') = json_extract(${kv.value}, '$.proposal.limits.memoryBytes')`;
}

function parseStored(raw: string, projectId: string, runId: string): StoredRunProposal {
  const decoded: unknown = JSON.parse(raw);
  let normalized = decoded;
  if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
    const candidate = { ...(decoded as Record<string, unknown>) };
    const proposal = storedProposalSchema.safeParse(candidate.proposal);
    const result = resultSchema.safeParse(candidate.result);
    if (proposal.success && result.success) {
      const limitsMatch = effectiveLimitsMatchProposal(result.data, proposal.data);
      if (!limitsMatch) candidate.result = { ...result.data, executionMatchesProposal: false };
      if (
        candidate.verified === true &&
        (!limitsMatch || !resultCanBeVerified(result.data, true, proposal.data))
      ) {
        candidate.verified = false;
      }
    }
    normalized = candidate;
  }
  const record = recordSchema.parse(normalized);
  if (record.projectId !== projectId || record.id !== runId)
    throw new Error('Stored run identity mismatch');
  return record;
}

/** Persistence alone confers no permission to execute the proposed command. */
export async function createRunProposal(
  projectId: string,
  auditId: string,
  proposal: CommandProposal
): Promise<StoredRunProposal> {
  projectIdSchema.parse(projectId);
  idSchema.parse(auditId);
  const validated = commandProposalSchema.parse(proposal);
  if (validated.revision !== `audit:${auditId}`)
    throw new Error('Proposal revision does not match audit');
  if (!(await getAudit(projectId, auditId))) throw new Error('Project audit not found');
  const now = Date.now();
  const record = recordSchema.parse({
    id: randomUUID(),
    projectId,
    auditId,
    proposal: validated,
    state: 'proposed',
    verified: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(kv)
    .values({ key: key(projectId, record.id), value: JSON.stringify(record), updatedAt: now });
  return record;
}

export async function getRunProposal(
  projectId: string,
  runId: string
): Promise<StoredRunProposal | null> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key(projectId, runId)))
    .limit(1);
  return row ? parseStored(row.value, projectId, runId) : null;
}

const executionPreviewSchema = z
  .object({
    executable: z.string().max(4096),
    args: z.array(z.string().max(4096)).max(16),
    cwd: z.string().max(4096),
    environmentKeys: z
      .array(z.enum(['CI', 'NO_COLOR', 'FORCE_COLOR', 'PATH', 'HOME', 'TMPDIR']))
      .max(6),
    runtimeDirectory: z.string().max(4096).optional(),
    timeoutMs: z.number().int().positive(),
    outputBytes: z.number().int().positive(),
    spawned: z.boolean(),
    workingDirectoryBinding: z.enum(['path', 'descriptor', 'approved-root-handoff']).optional(),
    targetHandoff: z
      .enum(['direct', 'exec_handoff', 'failed', 'unknown', 'not_started'])
      .optional(),
  })
  .strict();
const effectiveLimitsPreviewSchema = z
  .object({
    timeout: z.literal('termination-request'),
    output: z.literal('retained-bytes'),
    concurrency: z.enum(['per-instance', 'durable-single-flight']),
    cpuTimeSeconds: z.union([z.literal(false), z.number().int().min(1).max(600)]).optional(),
    processCount: z.union([z.literal(false), z.number().int().min(1).max(128)]),
    memory: z.union([z.literal(false), z.number().int().min(1).max(2_147_483_648)]),
  })
  .strict();
function parsePreview<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Bounded output projection; hashes describe observed bytes, not necessarily the preview. */
export async function getRunResultPreview(projectId: string, auditId: string, runId: string) {
  idSchema.parse(auditId);
  const [row] = await db
    .select({
      projectId: sql<string>`json_extract(${kv.value}, '$.projectId')`,
      auditId: sql<string>`json_extract(${kv.value}, '$.auditId')`,
      id: sql<string>`json_extract(${kv.value}, '$.id')`,
      state: sql<string>`json_extract(${kv.value}, '$.state')`,
      status: sql<string>`json_extract(${kv.value}, '$.result.status')`,
      exitCode: sql<number | null>`json_extract(${kv.value}, '$.result.exitCode')`,
      signal: sql<string | null>`json_extract(${kv.value}, '$.result.signal')`,
      stdout: sql<string>`substr(json_extract(${kv.value}, '$.result.stdout'), 1, 16384)`,
      stderr: sql<string>`substr(json_extract(${kv.value}, '$.result.stderr'), 1, 16384)`,
      stdoutBytes: sql<number>`length(cast(json_extract(${kv.value}, '$.result.stdout') as blob))`,
      stderrBytes: sql<number>`length(cast(json_extract(${kv.value}, '$.result.stderr') as blob))`,
      stdoutHash: sql<string>`json_extract(${kv.value}, '$.result.stdoutHash')`,
      stderrHash: sql<string>`json_extract(${kv.value}, '$.result.stderrHash')`,
      stdoutTruncated: sql<number>`json_extract(${kv.value}, '$.result.stdoutTruncated')`,
      stderrTruncated: sql<number>`json_extract(${kv.value}, '$.result.stderrTruncated')`,
      capturedComplete: sql<number>`json_extract(${kv.value}, '$.result.capturedComplete')`,
      terminationUnconfirmed: sql<number>`json_extract(${kv.value}, '$.result.terminationUnconfirmed')`,
      sandboxMode: sql<string>`json_extract(${kv.value}, '$.result.sandboxMode')`,
      startedAt: sql<number>`json_extract(${kv.value}, '$.result.startedAt')`,
      endedAt: sql<number>`json_extract(${kv.value}, '$.result.endedAt')`,
      durationMs: sql<number>`json_extract(${kv.value}, '$.result.durationMs')`,
      refusalJson: sql<
        string | null
      >`CASE WHEN length(CAST(json_extract(${kv.value}, '$.result.resourceLimitRefusal') AS BLOB)) <= 1024 THEN json_extract(${kv.value}, '$.result.resourceLimitRefusal') ELSE NULL END`,
      mismatch: sql<number | null>`CASE
        WHEN json_extract(${kv.value}, '$.result.executionMatchesProposal') IS NULL THEN NULL
        WHEN json_extract(${kv.value}, '$.result.executionMatchesProposal') = 1
          AND ${effectiveLimitMatchSql()}
        THEN 1 ELSE 0 END`,
      executionJson: sql<
        string | null
      >`CASE WHEN length(CAST(json_extract(${kv.value}, '$.result.execution') AS BLOB)) <= 16384 THEN json_extract(${kv.value}, '$.result.execution') ELSE NULL END`,
      limitsJson: sql<
        string | null
      >`CASE WHEN length(CAST(json_extract(${kv.value}, '$.result.effectiveLimits') AS BLOB)) <= 1024 THEN json_extract(${kv.value}, '$.result.effectiveLimits') ELSE NULL END`,
    })
    .from(kv)
    .where(eq(kv.key, key(projectId, runId)))
    .limit(1);
  if (
    !row ||
    row.projectId !== projectId ||
    row.auditId !== auditId ||
    row.id !== runId ||
    (row.state !== 'finished' && row.state !== 'refused')
  )
    return null;
  const parsed = z
    .object({
      status: z.enum([
        'exited',
        'timed_out',
        'cancelled',
        'crashed',
        'output_limit',
        'spawn_error',
        'resource_limit_refused',
      ]),
      exitCode: z.number().int().nullable(),
      signal: z.string().max(128).nullable(),
      stdout: z.string().max(32768),
      stderr: z.string().max(32768),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
      stderrHash: z.string().regex(/^[a-f0-9]{64}$/),
      stdoutTruncated: z.union([z.literal(0), z.literal(1)]),
      stderrTruncated: z.union([z.literal(0), z.literal(1)]),
      capturedComplete: z.union([z.literal(0), z.literal(1)]),
      terminationUnconfirmed: z.union([z.literal(0), z.literal(1)]),
      sandboxMode: z.enum(sandboxModes),
      startedAt: z.number().int().nonnegative(),
      endedAt: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      refusalJson: z.string().max(1024).nullable(),
      mismatch: z.union([z.literal(0), z.literal(1), z.null()]),
      executionJson: z.string().max(16384).nullable(),
      limitsJson: z.string().max(1024).nullable(),
    })
    .parse(row);
  const { executionJson, limitsJson, refusalJson, ...resultFields } = parsed;
  return {
    ...resultFields,
    resourceLimitRefusal: parsePreview(
      refusalJson,
      z
        .object({
          platform: z.string().min(1).max(32),
          missingControls: z
            .array(z.enum(['memoryBytes', 'processCount']))
            .min(1)
            .max(2),
          reason: z.string().min(1).max(512),
        })
        .strict()
    ),
    execution: parsePreview(executionJson, executionPreviewSchema),
    effectiveLimits: parsePreview(limitsJson, effectiveLimitsPreviewSchema),
    outputReferences: [
      { projectId, auditId, runId, stream: 'stdout' as const },
      { projectId, auditId, runId, stream: 'stderr' as const },
    ],
    stdoutTruncated: parsed.stdoutTruncated === 1,
    stderrTruncated: parsed.stderrTruncated === 1,
    capturedComplete: parsed.capturedComplete === 1,
    terminationUnconfirmed: parsed.terminationUnconfirmed === 1,
    executionMismatch: parsed.mismatch === 0,
    executionMatchConfirmed: parsed.mismatch === 1,
    stdoutPreviewTruncated: Buffer.byteLength(parsed.stdout) < parsed.stdoutBytes,
    stderrPreviewTruncated: Buffer.byteLength(parsed.stderr) < parsed.stderrBytes,
  };
}

const outputReferenceSchema = z
  .object({
    projectId: projectIdSchema,
    auditId: idSchema,
    runId: idSchema,
    stream: z.enum(['stdout', 'stderr']),
  })
  .strict();
export type RunOutputReference = z.infer<typeof outputReferenceSchema>;

/** Resolves a scoped reference to the bounded stored UTF-8 preview, not raw process bytes. */
export async function getRunOutputArtifact(input: RunOutputReference) {
  const reference = outputReferenceSchema.parse(input);
  const result = await getRunResultPreview(reference.projectId, reference.auditId, reference.runId);
  if (!result) return null;
  const isStdout = reference.stream === 'stdout';
  return {
    reference,
    representation: 'stored-utf8-preview' as const,
    text: isStdout ? result.stdout : result.stderr,
    observedHash: isStdout ? result.stdoutHash : result.stderrHash,
    captureTruncated: isStdout ? result.stdoutTruncated : result.stderrTruncated,
    previewTruncated: isStdout ? result.stdoutPreviewTruncated : result.stderrPreviewTruncated,
    capturedComplete: result.capturedComplete,
  };
}

/** Keyset-paginated metadata only: captured stdout/stderr never leave SQLite for this listing. */
export async function listRunProposals(
  projectId: string,
  auditId: string,
  cursor: string | null,
  limit = 50
): Promise<{ items: RunProposalSummary[]; nextCursor: string | null }> {
  projectIdSchema.parse(projectId);
  idSchema.parse(auditId);
  if (cursor !== null) idSchema.parse(cursor);
  z.number().int().min(1).max(50).parse(limit);
  const prefix = `tracemind:verification:${projectId}:`;
  const rows = await db
    .select({
      key: kv.key,
      id: sql<string>`json_extract(${kv.value}, '$.id')`,
      projectId: sql<string>`json_extract(${kv.value}, '$.projectId')`,
      auditId: sql<string>`json_extract(${kv.value}, '$.auditId')`,
      state: sql<string>`json_extract(${kv.value}, '$.state')`,
      resultStatus: sql<string | null>`json_extract(${kv.value}, '$.result.status')`,
      verified: sql<number>`CASE WHEN json_extract(${kv.value}, '$.verified') = 1
        AND json_extract(${kv.value}, '$.state') = 'finished'
        AND json_extract(${kv.value}, '$.result.status') = 'exited'
        AND json_extract(${kv.value}, '$.result.exitCode') = 0
        AND json_extract(${kv.value}, '$.result.signal') IS NULL
        AND json_extract(${kv.value}, '$.result.capturedComplete') = 1
        AND json_extract(${kv.value}, '$.result.stdoutTruncated') = 0
        AND json_extract(${kv.value}, '$.result.stderrTruncated') = 0
        AND json_extract(${kv.value}, '$.result.terminationUnconfirmed') = 0
        AND json_extract(${kv.value}, '$.result.sandboxMode') != 'unavailable'
        AND json_extract(${kv.value}, '$.result.executionMatchesProposal') = 1
        AND ${effectiveLimitMatchSql()}
        THEN 1 ELSE 0 END`,
      version: sql<number>`json_extract(${kv.value}, '$.version')`,
      createdAt: sql<number>`json_extract(${kv.value}, '$.createdAt')`,
      executable: sql<string>`json_extract(${kv.value}, '$.proposal.executable')`,
      workingDirectory: sql<string>`json_extract(${kv.value}, '$.proposal.workingDirectory')`,
      sandboxMode: sql<string>`coalesce(json_extract(${kv.value}, '$.proposal.sandboxMode'), 'unavailable')`,
      processCount: sql<number>`json_extract(${kv.value}, '$.proposal.limits.processCount')`,
      memoryBytes: sql<number>`json_extract(${kv.value}, '$.proposal.limits.memoryBytes')`,
    })
    .from(kv)
    .where(
      and(
        cursor === null ? gte(kv.key, prefix) : gt(kv.key, `${prefix}${cursor}`),
        lt(kv.key, `${prefix}\uffff`),
        eq(sql<string>`json_extract(${kv.value}, '$.auditId')`, auditId)
      )
    )
    .orderBy(asc(kv.key))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(({ key: rowKey, ...raw }) => {
    const item = summarySchema.parse(raw);
    if (
      item.projectId !== projectId ||
      item.auditId !== auditId ||
      rowKey !== `${prefix}${item.id}`
    )
      throw new Error('Stored run identity mismatch');
    return { ...item, verified: item.verified === 1 };
  });
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

/** Only a pending proposal can be denied/cancelled; terminal records cannot be promoted. */
export async function closeRunProposal(
  projectId: string,
  runId: string,
  version: number,
  state: 'denied' | 'cancelled'
): Promise<StoredRunProposal> {
  z.number().int().positive().parse(version);
  z.enum(['denied', 'cancelled']).parse(state);
  const recordKey = key(projectId, runId);
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, recordKey)).limit(1);
  if (!row) throw new Error('Run proposal not found');
  const current = parseStored(row.value, projectId, runId);
  if (current.version !== version || current.state !== 'proposed')
    throw new Error('Run proposal changed or is terminal');
  const updated = recordSchema.parse({
    ...current,
    state,
    version: current.version + 1,
    updatedAt: Date.now(),
  });
  const result = await db
    .update(kv)
    .set({ value: JSON.stringify(updated), updatedAt: updated.updatedAt })
    .where(and(eq(kv.key, recordKey), eq(kv.value, row.value)))
    .returning({ key: kv.key });
  if (result.length !== 1) throw new Error('Run proposal changed');
  return updated;
}

/** Internal persistence primitives, not approval or authorization to spawn. */
async function transitionExecution(
  projectId: string,
  runId: string,
  version: number,
  from: 'proposed' | 'running',
  state: 'running' | 'finished' | 'refused' | 'interrupted' | 'outcome_unknown',
  result?: ProcessResult
): Promise<StoredRunProposal> {
  z.number().int().positive().parse(version);
  const recordKey = key(projectId, runId);
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, recordKey)).limit(1);
  if (!row) throw new Error('Run proposal not found');
  const current = parseStored(row.value, projectId, runId);
  if (current.version !== version || current.state !== from)
    throw new Error('Run proposal changed or is terminal');
  if (state === 'running' && !commandProposalSchema.safeParse(current.proposal).success)
    throw new Error('Run proposal lacks a complete command preview');
  const recordedResult =
    result === undefined
      ? undefined
      : {
          ...result,
          // Never trust an adapter-provided match flag when the requested
          // resource limits were not actually enforced.
          executionMatchesProposal:
            result.executionMatchesProposal === true &&
            effectiveLimitsMatchProposal(result, current.proposal),
        };
  const updated = recordSchema.parse({
    ...current,
    state,
    ...(recordedResult === undefined ? {} : { result: recordedResult }),
    verified:
      state === 'finished' &&
      recordedResult !== undefined &&
      resultCanBeVerified(recordedResult, true, current.proposal),
    version: version + 1,
    updatedAt: Date.now(),
  });
  const changed = await db
    .update(kv)
    .set({ value: JSON.stringify(updated), updatedAt: updated.updatedAt })
    .where(and(eq(kv.key, recordKey), eq(kv.value, row.value)))
    .returning({ key: kv.key });
  if (changed.length !== 1) throw new Error('Run proposal changed');
  return updated;
}

export async function claimRunExecution(
  projectId: string,
  runId: string,
  version: number
): Promise<StoredRunProposal> {
  return transitionExecution(projectId, runId, version, 'proposed', 'running');
}
export async function finishRunExecution(
  projectId: string,
  runId: string,
  version: number,
  result: ProcessResult
): Promise<StoredRunProposal> {
  return transitionExecution(projectId, runId, version, 'running', 'finished', result);
}
/** Records a pre-spawn resource refusal with explicit evidence that no target started. */
export async function recordResourceLimitRefusal(
  projectId: string,
  runId: string,
  version: number,
  result: ProcessResult
): Promise<StoredRunProposal> {
  if (result.status !== 'resource_limit_refused' || result.execution.spawned)
    throw new Error('Expected a resource-limit refusal before spawn');
  return transitionExecution(projectId, runId, version, 'running', 'refused', result);
}
/** Only call after verifying the previous executor is no longer live. */
export async function interruptRunExecution(
  projectId: string,
  runId: string,
  version: number
): Promise<StoredRunProposal> {
  return transitionExecution(projectId, runId, version, 'running', 'interrupted');
}

/** Records uncertainty without asserting that any process or descendant stopped. */
export async function markRunOutcomeUnknown(
  projectId: string,
  runId: string,
  version: number
): Promise<StoredRunProposal> {
  return transitionExecution(projectId, runId, version, 'running', 'outcome_unknown');
}
