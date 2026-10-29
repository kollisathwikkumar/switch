import { join } from 'node:path';
import { closeNativeFileHandle, type NativeProjectFs } from '../native/access-registry';
import type { VerificationApprovalService } from './approval-service';
import { acquireExecutionReservation, releaseExecutionReservation } from './execution-reservation';
import { openVerifiedWorkingDirectory } from './pinned-working-directory';
import { ProcessAdapter } from './process-adapter';
import {
  claimRunExecution,
  closeRunProposal,
  finishRunExecution,
  markRunOutcomeUnknown,
  recordResourceLimitRefusal,
} from './run-store';
import { VerificationRunner } from './runner';
import { fingerprintRuntime } from './runtime-fingerprint';

/** Internal composition only: caller must configure trusted paths and gate all access. */
export function createLocalVerificationRunner(options: {
  approvals: VerificationApprovalService;
  native: NativeProjectFs;
  npmExecutable: string;
  helperExecutable: string;
}): VerificationRunner {
  const adapter = new ProcessAdapter();
  return new VerificationRunner({
    consume: async (projectId, runId) => {
      const approval = await options.approvals.consumeForExecution(projectId, runId);
      if (!approval?.snapshot.runtimeDirectory || !approval.snapshot.runtimeFingerprint)
        return null;
      try {
        const fingerprint = await fingerprintRuntime([
          options.npmExecutable,
          join(approval.snapshot.runtimeDirectory, 'node'),
          options.helperExecutable,
        ]);
        return fingerprint === approval.snapshot.runtimeFingerprint ? approval : null;
      } catch {
        return null;
      }
    },
    open: (approval) =>
      openVerifiedWorkingDirectory(approval.snapshot, approval.run.proposal, options.native),
    release: (fd) => closeNativeFileHandle(options.native, fd),
    claim: claimRunExecution,
    cancelPending: (projectId, runId, version) =>
      closeRunProposal(projectId, runId, version, 'cancelled'),
    markUnknown: markRunOutcomeUnknown,
    acquireReservation: acquireExecutionReservation,
    releaseReservation: releaseExecutionReservation,
    npmExecutable: options.npmExecutable,
    helperExecutable: options.helperExecutable,
    execute: (input) => adapter.run(input),
    finish: finishRunExecution,
    refuse: recordResourceLimitRefusal,
  });
}
