import { win32 } from 'node:path';
import { z } from 'zod';
import { commandProposalSchema, type CommandProposal } from './command-contract';

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const uuidSchema = z.string().uuid();
const fileIdentitySchema = z.string().regex(/^win32:[a-f0-9]{16}:[a-f0-9]{32}$/);
const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

function isSafeWindowsComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/:]/.test(value) &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    !/[. ]$/.test(value) &&
    !reservedWindowsName.test(value)
  );
}

function isCanonicalLocalRoot(value: string): boolean {
  if (
    value.length > 4096 ||
    !/^[A-Za-z]:\\/.test(value) ||
    value.includes('/') ||
    /[\x00-\x1f\x7f]/.test(value) ||
    win32.normalize(value) !== value
  )
    return false;
  const components = value.slice(3).split('\\');
  return components.length > 0 && components.every(isSafeWindowsComponent);
}

const windowsRootSchema = z.string().refine(isCanonicalLocalRoot, 'Invalid Windows approved root');
const componentSchema = z
  .string()
  .refine(isSafeWindowsComponent, 'Invalid Windows working-directory component');

export const windowsApprovedRootHandoffSchema = z
  .object({
    version: z.literal(1),
    projectId: projectIdSchema,
    auditId: uuidSchema,
    runId: uuidSchema,
    proposalVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    approvedRoot: windowsRootSchema,
    rootFileIdentity: fileIdentitySchema,
    workingDirectoryComponents: z.array(componentSchema).max(48),
    command: z.literal('npm'),
    args: z.tuple([z.literal('run'), z.literal('test')]),
    limits: z
      .object({
        timeoutMs: z.number().int().min(1).max(600_000),
        outputBytes: z.number().int().min(1).max(10_000_000),
        processCount: z.number().int().min(1).max(128),
        memoryBytes: z.number().int().min(1).max(2_147_483_648),
      })
      .strict(),
  })
  .strict();

export type WindowsApprovedRootHandoff = z.infer<typeof windowsApprovedRootHandoffSchema>;

export interface WindowsApprovedRootHandoffContext {
  projectId: string;
  auditId: string;
  runId: string;
  proposalVersion: number;
  rootPath: string;
  rootIdentity: string;
  proposal: CommandProposal;
}

function sameWindowsRoot(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

/** Validates an execution handoff against the one-use, main-process approval context. */
export function validateWindowsApprovedRootHandoff(
  input: unknown,
  context: WindowsApprovedRootHandoffContext
): WindowsApprovedRootHandoff {
  const handoff = windowsApprovedRootHandoffSchema.parse(input);
  const proposal = commandProposalSchema.parse(context.proposal);
  const expectedComponents =
    proposal.workingDirectory === '.' ? [] : proposal.workingDirectory.split('/');
  if (
    !projectIdSchema.safeParse(context.projectId).success ||
    !uuidSchema.safeParse(context.auditId).success ||
    !uuidSchema.safeParse(context.runId).success ||
    !Number.isSafeInteger(context.proposalVersion) ||
    context.proposalVersion < 1 ||
    !windowsRootSchema.safeParse(context.rootPath).success ||
    !fileIdentitySchema.safeParse(context.rootIdentity).success ||
    handoff.projectId !== context.projectId ||
    handoff.auditId !== context.auditId ||
    handoff.runId !== context.runId ||
    handoff.proposalVersion !== context.proposalVersion ||
    !sameWindowsRoot(handoff.approvedRoot, context.rootPath) ||
    handoff.rootFileIdentity !== context.rootIdentity ||
    JSON.stringify(handoff.workingDirectoryComponents) !== JSON.stringify(expectedComponents) ||
    handoff.command !== proposal.executable ||
    JSON.stringify(handoff.args) !== JSON.stringify(proposal.args) ||
    handoff.limits.timeoutMs !== proposal.limits.timeoutMs ||
    handoff.limits.outputBytes !== proposal.limits.outputBytes ||
    handoff.limits.processCount !== proposal.limits.processCount ||
    handoff.limits.memoryBytes !== proposal.limits.memoryBytes
  ) {
    throw new Error('Windows approved-root handoff does not match the trusted approval');
  }
  return handoff;
}

/** Builds the versioned root handoff only from trusted main-process approval data. */
export function createWindowsApprovedRootHandoff(
  context: WindowsApprovedRootHandoffContext
): WindowsApprovedRootHandoff {
  const proposal = commandProposalSchema.parse(context.proposal);
  const handoff: WindowsApprovedRootHandoff = {
    version: 1,
    projectId: context.projectId,
    auditId: context.auditId,
    runId: context.runId,
    proposalVersion: context.proposalVersion,
    approvedRoot: context.rootPath,
    rootFileIdentity: context.rootIdentity,
    workingDirectoryComponents:
      proposal.workingDirectory === '.' ? [] : proposal.workingDirectory.split('/'),
    command: proposal.executable,
    args: [...proposal.args],
    limits: { ...proposal.limits },
  };
  return validateWindowsApprovedRootHandoff(handoff, context);
}
