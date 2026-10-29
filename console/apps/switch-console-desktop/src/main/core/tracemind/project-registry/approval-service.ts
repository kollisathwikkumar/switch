import { stat } from 'node:fs/promises';
import { dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { getLocationById } from '@main/core/locations/store';
import { AuditGrantStore } from './grant-store';
import { resolveSelectedLocalProject } from './selected-project';

/** Owns main-process, one-use audit approval. */
export class AuditApprovalService {
  private readonly grants = new AuditGrantStore();
  private readonly identities = new Map<string, string>();
  private requesting = false;
  private readonly directoryIdentity: (root: string) => Promise<string>;

  constructor(options: { directoryIdentity?: (root: string) => Promise<string> } = {}) {
    this.directoryIdentity = options.directoryIdentity ?? directoryIdentity;
  }

  async request(
    locationId: string,
    purpose: 'audit' | 'check-discovery' | 'check-preview' = 'audit'
  ): Promise<boolean> {
    if (this.requesting) return false;
    this.requesting = true;
    try {
      return await this.requestOnce(locationId, purpose);
    } finally {
      this.requesting = false;
    }
  }

  private async requestOnce(
    locationId: string,
    purpose: 'audit' | 'check-discovery' | 'check-preview'
  ): Promise<boolean> {
    this.grants.revoke(locationId);
    this.identities.delete(locationId);
    const project = await resolveSelectedLocalProject(locationId, getLocationById);
    const identity = await this.directoryIdentity(project.root);
    const window = getMainWindow();
    if (!window) return false;
    const approved = await this.grants.request(project, async ({ root }) => {
      const choice = await dialog.showMessageBox(window, {
        type: 'question',
        title:
          purpose === 'audit'
            ? 'Allow TraceMind audit?'
            : purpose === 'check-preview'
              ? 'Allow check review scan?'
              : 'Allow check discovery?',
        message:
          purpose === 'audit'
            ? 'Allow TraceMind to inspect this local project?'
            : purpose === 'check-preview'
              ? 'Allow TraceMind to rescan this project for a check review?'
              : 'Allow TraceMind to inspect this project for candidate test commands?',
        detail:
          purpose === 'audit'
            ? `${root}\n\nThis approval is for one local audit.`
            : purpose === 'check-preview'
              ? `${root}\n\nTraceMind will rescan before and after review. This request does not run a check.`
              : `${root}\n\nThis approval is for one local scan. No test commands will be executed.`,
        buttons: [
          'Cancel',
          purpose === 'audit'
            ? 'Allow audit'
            : purpose === 'check-preview'
              ? 'Allow review scan'
              : 'Allow discovery',
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice.response !== 1) return false;
      const current = await resolveSelectedLocalProject(locationId, getLocationById);
      return current.root === root && (await this.directoryIdentity(root)) === identity;
    });
    if (approved) this.identities.set(locationId, identity);
    return approved;
  }

  async consume(locationId: string): Promise<boolean> {
    return (await this.consumeProject(locationId)) !== null;
  }

  async consumeProject(
    locationId: string
  ): Promise<{ locationId: string; root: string; identity: string } | null> {
    const identity = this.identities.get(locationId);
    this.identities.delete(locationId);
    if (!identity) {
      this.grants.revoke(locationId);
      return null;
    }
    try {
      const project = await resolveSelectedLocalProject(locationId, getLocationById);
      if (
        (await this.directoryIdentity(project.root)) !== identity ||
        !this.grants.consume(project)
      ) {
        this.grants.revoke(locationId);
        return null;
      }
      return { ...project, identity };
    } catch {
      this.grants.revoke(locationId);
      return null;
    }
  }
}

async function directoryIdentity(root: string): Promise<string> {
  const info = await stat(root, { bigint: true });
  if (!info.isDirectory()) throw new Error('Location is not a directory');
  return `${info.dev}:${info.ino}`;
}
