import { describe, expect, it } from 'vitest';
import { transitionInvestigation } from './state-machine';

describe('investigation transitions', () => {
  it('allows a documented transition and rejects an invalid one', () => {
    expect(transitionInvestigation('reported', 'queued')).toBe('queued');
    expect(() => transitionInvestigation('reported', 'verified')).toThrow(
      'Invalid investigation transition'
    );
  });

  it('requires a passed check to verify', () => {
    for (const outcome of ['failed', 'timed_out', 'cancelled', 'denied', 'interrupted'] as const) {
      expect(() => transitionInvestigation('verification', 'verified', outcome)).toThrow();
    }
    expect(() => transitionInvestigation('verification', 'verified')).toThrow();
    expect(transitionInvestigation('verification', 'verified', 'passed')).toBe('verified');
  });

  it('distinguishes failed and inconclusive checks', () => {
    expect(transitionInvestigation('verification', 'failed', 'failed')).toBe('failed');
    expect(transitionInvestigation('verification', 'unverified', 'timed_out')).toBe('unverified');
    expect(() => transitionInvestigation('verification', 'failed', 'passed')).toThrow();
  });
});
