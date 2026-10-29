import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { commandProposalSchema, type CommandProposal } from './command-contract';
import type { StoredRunProposal } from './run-store';

/** Main-process verifier must compare a fresh confined scan against the saved audit before returning this. */
export interface Snapshot {
  root: string;
  identity: string;
  workingDirectoryIdentity: string;
  fingerprint: string;
  /** Trusted runtime selection; absence permits preview only, not execution. */
  runtimeDirectory?: string;
  npmExecutable?: string;
  helperExecutable?: string;
  runtimeFingerprint?: string;
}
export type ApprovalDecision = 'approve' | 'deny' | 'cancel';
export interface ApprovalDependencies {
  load: (projectId: string, runId: string) => Promise<StoredRunProposal | null>;
  snapshot: (
    projectId: string,
    auditId: string,
    proposal: CommandProposal
  ) => Promise<Snapshot | null>;
  /** Must be an application-owned native dialog, never a renderer assertion. */
  confirm: (preview: string) => Promise<ApprovalDecision>;
  deny: (projectId: string, runId: string, version: number) => Promise<void>;
  now: () => number;
}
const projectSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const idSchema = z.string().uuid();
const filesystemIdentitySchema = z
  .string()
  .regex(/^(?:\d{1,40}:\d{1,40}|win32:[a-f0-9]{16}:[a-f0-9]{32})$/);
const snapshotSchema = z
  .object({
    root: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)),
    identity: filesystemIdentitySchema,
    workingDirectoryIdentity: filesystemIdentitySchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeDirectory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !/[\x00-\x1f\x7f:]/.test(value))
      .optional(),
    npmExecutable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value))
      .optional(),
    runtimeFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    helperExecutable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value))
      .optional(),
  })
  .strict();
type Checked = {
  run: StoredRunProposal & { proposal: CommandProposal };
  snapshot: Snapshot;
  digest: string;
};
export type ValidatedApproval = {
  run: StoredRunProposal & { proposal: CommandProposal };
  snapshot: Snapshot;
};
type Grant = { digest: string; issuedAt: number; expiresAt: number };
function display(value: string): string {
  return JSON.stringify(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}
function preview(checked: Checked): string {
  const { proposal } = checked.run;
  const sandboxAvailable = proposal.sandboxMode !== 'unavailable';
  return [
    'Project-defined scripts can change files and access the network.',
    'The audit fingerprint excludes excluded files and dependencies; those files may still be executed or changed.',
    `Effective sandbox mode: ${proposal.sandboxMode}.`,
    sandboxAvailable
      ? 'The OS sandbox blocks network access and limits writes to the approved working directory and a private temporary directory. Host file reads remain available.'
      : 'No OS sandbox is available; a second separate approval is required to continue.',
    `Requested process/task cap: ${proposal.limits.processCount}; Linux cgroup v2 pids.max counts tasks, including threads and sandbox helpers. Enforced only with Linux Bubblewrap plus writable delegated cgroup v2 support, otherwise unavailable and unverified.`,
    `Requested memory cap: ${proposal.limits.memoryBytes} bytes; enforced only with Linux Bubblewrap plus writable delegated cgroup v2 support, otherwise unavailable and unverified.`,
    'Bubblewrap isolation does not itself enforce resource caps; Linux pids.max and memory.max are separate cgroup controls.',
    process.platform === 'win32'
      ? 'Per-process CPU-time cap is unavailable on Windows because descriptor-bound helper execution is unavailable.'
      : checked.snapshot.helperExecutable
        ? `Per-process CPU-time cap: ${Math.max(1, Math.ceil(proposal.limits.timeoutMs / 1000))} seconds via the trusted helper; child processes inherit the cap, but it is not an aggregate process-tree CPU budget.`
        : 'Per-process CPU-time cap is unavailable because the trusted descriptor-bound helper is not configured.',
    'Concurrency: a durable application-database reservation allows one verification run at a time and remains held while process-tree termination is uncertain.',
    process.platform === 'win32'
      ? 'Descriptor-bound working-directory execution is unavailable on Windows; this check cannot start.'
      : 'Execution will bind to the approved working-directory identity.',
    `Project root: ${display(checked.snapshot.root)}`,
    `Working directory: ${display(proposal.workingDirectory)}`,
    `Executable: ${display(proposal.executable)}`,
    `Configured npm path: ${checked.snapshot.npmExecutable ? display(checked.snapshot.npmExecutable) : '(not configured)'}`,
    `Runtime fingerprint: ${checked.snapshot.runtimeFingerprint ?? '(not captured)'}`,
    `Configured helper path: ${checked.snapshot.helperExecutable ? display(checked.snapshot.helperExecutable) : '(not configured)'}`,
    `Arguments: ${JSON.stringify(proposal.args)}`,
    `Pretest script: ${proposal.declaredScripts.pretest === undefined ? '(none)' : display(proposal.declaredScripts.pretest)}`,
    `Test script: ${display(proposal.declaredScripts.test)}`,
    `Posttest script: ${proposal.declaredScripts.posttest === undefined ? '(none)' : display(proposal.declaredScripts.posttest)}`,
    `Revision: ${display(proposal.revision)}`,
    `Audit fingerprint: ${checked.snapshot.fingerprint}`,
    `Environment allowlist: ${proposal.environmentAllowlist.join(', ') || '(none)'}`,
    `Runtime PATH: ${checked.snapshot.runtimeDirectory ? display(`${checked.snapshot.runtimeDirectory}:/usr/bin:/bin`) : '(not configured; check execution unavailable)'}`,
    `Requested timeout: ${proposal.limits.timeoutMs} ms; requested output cap: ${proposal.limits.outputBytes} bytes.`,
    'Timeout requests termination but cannot guarantee complete process-tree cleanup.',
    'After a check starts without a Linux PID namespace, later checks remain blocked because process-tree termination cannot be confirmed. Recovery requires a detected reboot on the same host; older reservations may still require manual investigation.',
    'Approval is for this exact proposed check once; it does not approve other commands.',
  ].join('\n');
}

/** Ephemeral approval; no execution, IPC endpoint, or filesystem trust is provided here. */
export class VerificationApprovalService {
  private readonly grants = new Map<string, Grant>();
  private pending = false;
  private generation = 0;
  constructor(private readonly deps: ApprovalDependencies) {}

  /** Invalidate outstanding grants and any in-flight approval checks. */
  revoke(projectId: string, runId: string): void {
    projectSchema.parse(projectId);
    idSchema.parse(runId);
    this.grants.delete(`${projectId}:${runId}`);
    this.generation++;
  }

  private async check(projectId: string, runId: string): Promise<Checked | null> {
    projectSchema.parse(projectId);
    idSchema.parse(runId);
    const run = await this.deps.load(projectId, runId);
    if (
      !run ||
      run.projectId !== projectId ||
      run.id !== runId ||
      run.state !== 'proposed' ||
      run.verified ||
      !Number.isSafeInteger(run.version) ||
      run.version < 1
    )
      return null;
    idSchema.parse(run.auditId);
    const parsedProposal = commandProposalSchema.safeParse(run.proposal);
    if (!parsedProposal.success) return null;
    const proposal = parsedProposal.data;
    if (proposal.revision !== `audit:${run.auditId}`) return null;
    const parsed = snapshotSchema.safeParse(
      await this.deps.snapshot(projectId, run.auditId, proposal)
    );
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    const digest = createHash('sha256')
      .update(JSON.stringify([projectId, runId, run.auditId, run.version, proposal, snapshot]))
      .digest('hex');
    return { run: { ...run, proposal }, snapshot, digest };
  }

  async request(projectId: string, runId: string): Promise<boolean> {
    projectSchema.parse(projectId);
    idSchema.parse(runId);
    const key = `${projectId}:${runId}`;
    this.revoke(projectId, runId);
    if (this.pending) return false;
    const generation = this.generation;
    this.pending = true;
    try {
      const before = await this.check(projectId, runId);
      if (!before || generation !== this.generation) return false;
      const accepted = await this.deps.confirm(preview(before));
      if (generation !== this.generation) return false;
      if (accepted === 'cancel') return false;
      if (accepted === 'deny') {
        // Denial rejects the displayed proposal; it does not authorize access
        // to the changed project. The store closes only its exact pending version.
        await this.deps.deny(projectId, runId, before.run.version);
        return false;
      }
      if (accepted !== 'approve') return false;
      if (before.run.proposal.sandboxMode === 'unavailable') {
        const finalDecision = await this.deps.confirm(
          `${preview(before)}\n\nFINAL CONFIRMATION REQUIRED: run this exact check without OS isolation. Approve only if you accept the unisolated execution and its remaining host access.`
        );
        if (generation !== this.generation) return false;
        if (finalDecision === 'deny') {
          await this.deps.deny(projectId, runId, before.run.version);
          return false;
        }
        if (finalDecision !== 'approve') return false;
      }
      const after = await this.check(projectId, runId);
      if (!after || after.digest !== before.digest || generation !== this.generation) return false;
      const now = this.deps.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 60_000)
        return false;
      this.grants.set(key, { digest: before.digest, issuedAt: now, expiresAt: now + 60_000 });
      return true;
    } finally {
      this.pending = false;
    }
  }

  async consume(projectId: string, runId: string): Promise<boolean> {
    return (await this.consumeForExecution(projectId, runId)) !== null;
  }

  /** Internal one-use handoff; callers must still atomically claim the matching run version. */
  async consumeForExecution(projectId: string, runId: string): Promise<ValidatedApproval | null> {
    projectSchema.parse(projectId);
    idSchema.parse(runId);
    const key = `${projectId}:${runId}`;
    const generation = this.generation;
    const grant = this.grants.get(key);
    this.grants.delete(key);
    if (!grant) return null;
    const validTime = () => {
      const now = this.deps.now();
      return Number.isSafeInteger(now) && now >= grant.issuedAt && now < grant.expiresAt;
    };
    if (!validTime()) return null;
    const checked = await this.check(projectId, runId);
    if (
      !checked ||
      checked.digest !== grant.digest ||
      !validTime() ||
      generation !== this.generation
    )
      return null;
    return { run: checked.run, snapshot: checked.snapshot };
  }
}
