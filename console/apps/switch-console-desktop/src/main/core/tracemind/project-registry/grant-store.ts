import { isAbsolute } from 'node:path';
import { authorizeProjectOperation, type ProjectConsent } from './consent';

export interface AuditProject {
  locationId: string;
  root: string;
}

/** Main-process, ephemeral, one-use approvals; callers supply the trusted native dialog. */
export class AuditGrantStore {
  private readonly grants = new Map<string, ProjectConsent>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  async request(
    project: AuditProject,
    approve: (project: AuditProject) => Promise<boolean>
  ): Promise<boolean> {
    const selected = { locationId: project.locationId, root: project.root };
    if (!selected.locationId.trim() || !isAbsolute(selected.root)) return false;
    this.revoke(selected.locationId);
    const version = this.versions.get(selected.locationId);
    const approved = await approve({ ...selected });
    if (!approved || version !== this.versions.get(selected.locationId)) return false;
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0) return false;
    this.grants.set(selected.locationId, {
      ...selected,
      operations: ['audit'],
      expiresAt: now + 60_000,
      revoked: false,
    });
    return true;
  }

  consume(project: AuditProject): boolean {
    const grant = this.grants.get(project.locationId) ?? null;
    if (!authorizeProjectOperation(grant, { ...project, operation: 'audit' }, this.clock())) {
      return false;
    }
    this.revoke(project.locationId);
    return true;
  }

  revoke(locationId: string): void {
    this.grants.delete(locationId);
    this.versions.set(locationId, (this.versions.get(locationId) ?? 0) + 1);
  }
}
