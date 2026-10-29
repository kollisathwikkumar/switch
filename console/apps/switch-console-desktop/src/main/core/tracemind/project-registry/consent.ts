import { isAbsolute } from 'node:path';

export type ProjectOperation = 'audit' | 'execute' | 'modify';

export interface ProjectConsent {
  locationId: string;
  /** Canonical project root captured when the user approved the operation. */
  root: string;
  operations: readonly ProjectOperation[];
  expiresAt: number;
  revoked: boolean;
}

export interface ProjectOperationRequest {
  locationId: string;
  /** The caller must independently resolve this root immediately before use. */
  root: string;
  operation: ProjectOperation;
}

/** The grant must come from a trusted consent store, never renderer-supplied data. */
export function authorizeProjectOperation(
  grant: ProjectConsent | null,
  request: ProjectOperationRequest,
  now: number
): boolean {
  if (
    !grant ||
    grant.revoked ||
    !Number.isFinite(now) ||
    !Number.isFinite(grant.expiresAt) ||
    now < 0 ||
    grant.expiresAt <= now ||
    !grant.locationId.trim() ||
    !grant.root.trim() ||
    !isAbsolute(grant.root)
  )
    return false;
  return (
    grant.locationId === request.locationId &&
    grant.root === request.root &&
    grant.operations.includes(request.operation)
  );
}
