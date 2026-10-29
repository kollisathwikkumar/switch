import { z } from 'zod';
import { sandboxModes, type SandboxMode } from './sandbox';

/** A proposal is data, never an authorization to start a process. */
const safeRelativeDirectory = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (value === '.') return true;
    return (
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    );
  });

export const commandProposalSchema = z
  .object({
    executable: z.literal('npm'),
    args: z.tuple([z.literal('run'), z.literal('test')]),
    declaredScripts: z
      .object({
        pretest: z.string().max(4096).optional(),
        test: z.string().min(1).max(4096),
        posttest: z.string().max(4096).optional(),
      })
      .strict(),
    workingDirectory: safeRelativeDirectory,
    revision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/),
    environmentAllowlist: z.array(z.enum(['CI', 'NO_COLOR', 'FORCE_COLOR'])).max(3),
    limits: z
      .object({
        timeoutMs: z.number().int().min(1).max(600_000),
        outputBytes: z.number().int().min(1).max(10_000_000),
        processCount: z.number().int().min(1).max(128),
        memoryBytes: z.number().int().min(1).max(2_147_483_648),
      })
      .strict(),
    sandboxMode: z.enum(sandboxModes),
  })
  .strict();
export type CommandProposal = z.infer<typeof commandProposalSchema>;

const packageSchema = z
  .object({
    scripts: z
      .object({
        pretest: z.string().max(4096).optional(),
        test: z.string().min(1).max(4096).optional(),
        posttest: z.string().max(4096).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Only identifies a named script; its arbitrary project-controlled contents are never executed here. */
export function discoverPackageChecks(
  manifest: string,
  workingDirectory: string,
  revision: string,
  sandboxMode: SandboxMode = 'unavailable'
): CommandProposal[] {
  if (Buffer.byteLength(manifest, 'utf8') > 1_000_000)
    throw new Error('Manifest exceeds discovery limit');
  let parsed: z.infer<typeof packageSchema>;
  try {
    parsed = packageSchema.parse(JSON.parse(manifest));
  } catch {
    throw new Error('Invalid package manifest');
  }
  if (!parsed.scripts?.test) return [];
  const candidate = commandProposalSchema.parse({
    executable: 'npm',
    args: ['run', 'test'],
    declaredScripts: {
      test: parsed.scripts.test,
      ...(parsed.scripts.pretest !== undefined ? { pretest: parsed.scripts.pretest } : {}),
      ...(parsed.scripts.posttest !== undefined ? { posttest: parsed.scripts.posttest } : {}),
    },
    workingDirectory,
    revision,
    environmentAllowlist: [],
    limits: {
      timeoutMs: 60_000,
      outputBytes: 1_000_000,
      processCount: 32,
      memoryBytes: 1_073_741_824,
    },
    sandboxMode,
  });
  return [candidate];
}

/** Project scripts are untrusted and an ordinary process has no isolation. */
export function classifyProposal(proposal: CommandProposal): 'explicit-approval-required' {
  commandProposalSchema.parse(proposal);
  return 'explicit-approval-required';
}

const recordedRunOutcomeSchema = z
  .object({
    state: z.enum(['exited', 'denied', 'interrupted', 'timed_out', 'cancelled', 'crashed']),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(128).nullable(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    isolation: z.enum(sandboxModes),
    approved: z.boolean(),
    capturedComplete: z.boolean(),
    executionMatchesProposal: z.boolean().optional(),
    terminationUnconfirmed: z.boolean().optional(),
  })
  .strict();
export type RecordedRunOutcome = z.infer<typeof recordedRunOutcomeSchema>;

/** Apply only to trusted, persisted evidence; absent match or termination proof fails closed. */
export function canVerifyRun(outcome: RecordedRunOutcome): boolean {
  const validation = recordedRunOutcomeSchema.safeParse(outcome);
  if (!validation.success) return false;
  outcome = validation.data;
  return (
    outcome.state === 'exited' &&
    outcome.isolation !== 'unavailable' &&
    outcome.exitCode === 0 &&
    outcome.signal === null &&
    outcome.approved &&
    outcome.capturedComplete &&
    outcome.executionMatchesProposal === true &&
    outcome.terminationUnconfirmed === false &&
    !outcome.stdoutTruncated &&
    !outcome.stderrTruncated
  );
}
