import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authorizeProjectOperation,
  type ProjectConsent,
  type ProjectOperationRequest,
} from './consent';

const root = resolve('fixture-project');
const grant: ProjectConsent = {
  locationId: 'location',
  root,
  operations: ['audit'],
  expiresAt: 200,
  revoked: false,
};
const request: ProjectOperationRequest = { locationId: 'location', root, operation: 'audit' };

describe('project consent', () => {
  it('allows an active exact grant', () => {
    expect(authorizeProjectOperation(grant, request, 100)).toBe(true);
  });

  it('denies mismatches, revoked or expired grants', () => {
    expect(authorizeProjectOperation(grant, { ...request, locationId: 'other' }, 100)).toBe(false);
    expect(authorizeProjectOperation(grant, { ...request, root: resolve('other') }, 100)).toBe(
      false
    );
    expect(authorizeProjectOperation(grant, { ...request, operation: 'execute' }, 100)).toBe(false);
    expect(authorizeProjectOperation({ ...grant, revoked: true }, request, 100)).toBe(false);
    expect(authorizeProjectOperation(grant, request, 200)).toBe(false);
    expect(authorizeProjectOperation(null, request, 100)).toBe(false);
  });

  it('fails closed on invalid scope and time values', () => {
    expect(authorizeProjectOperation(grant, request, NaN)).toBe(false);
    expect(authorizeProjectOperation({ ...grant, expiresAt: Infinity }, request, 100)).toBe(false);
    expect(authorizeProjectOperation({ ...grant, root: '' }, { ...request, root: '' }, 100)).toBe(
      false
    );
    expect(
      authorizeProjectOperation({ ...grant, locationId: '' }, { ...request, locationId: '' }, 100)
    ).toBe(false);
  });
});
