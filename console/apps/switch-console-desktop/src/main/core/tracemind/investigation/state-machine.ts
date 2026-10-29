/** Investigation states describe recorded progress, not confidence in model output. */
export type InvestigationState =
  | 'reported'
  | 'queued'
  | 'gathering_evidence'
  | 'forming_hypotheses'
  | 'planning_checks'
  | 'awaiting_approval'
  | 'executing_checks'
  | 'evaluating_evidence'
  | 'supported_finding'
  | 'verification'
  | 'verified'
  | 'failed'
  | 'unverified'
  | 'cancelled';

export type CheckOutcome =
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'denied'
  | 'interrupted';

const transitions: Record<InvestigationState, readonly InvestigationState[]> = {
  reported: ['queued', 'cancelled'],
  queued: ['gathering_evidence', 'cancelled'],
  gathering_evidence: ['forming_hypotheses', 'unverified', 'cancelled'],
  forming_hypotheses: ['planning_checks', 'unverified', 'cancelled'],
  planning_checks: ['awaiting_approval', 'executing_checks', 'unverified', 'cancelled'],
  awaiting_approval: ['planning_checks', 'unverified', 'cancelled'],
  executing_checks: ['evaluating_evidence', 'unverified', 'cancelled'],
  evaluating_evidence: ['forming_hypotheses', 'supported_finding', 'unverified', 'cancelled'],
  supported_finding: ['verification', 'unverified', 'cancelled'],
  verification: ['verified', 'failed', 'unverified', 'cancelled'],
  verified: [],
  failed: [],
  unverified: [],
  cancelled: [],
};

/** The caller must derive check outcomes from recorded execution and explicit criteria. */
export function transitionInvestigation(
  current: InvestigationState,
  next: InvestigationState,
  outcome?: CheckOutcome
): InvestigationState {
  if (!transitions[current].includes(next)) {
    throw new Error(`Invalid investigation transition: ${current} -> ${next}`);
  }
  if (next === 'verified' && outcome !== 'passed') {
    throw new Error('Verification requires a passed check');
  }
  if (next === 'failed' && outcome !== 'failed') {
    throw new Error('A failed verification requires a failed check');
  }
  return next;
}
