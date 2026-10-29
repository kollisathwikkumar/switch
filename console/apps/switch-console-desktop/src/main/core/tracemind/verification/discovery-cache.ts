import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commandProposalSchema, type CommandProposal } from './command-contract';

const project = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const id = z.string().uuid();
type Entry = {
  projectId: string;
  auditId: string;
  candidates: CommandProposal[];
  issuedAt: number;
  pending: Set<number>;
  saved: Set<number>;
};
/** In-memory capabilities select cached data only; they never authorize execution. */
export class DiscoveryCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  issue(projectId: string, auditId: string, input: readonly CommandProposal[]): string {
    project.parse(projectId);
    id.parse(auditId);
    const candidates = z.array(commandProposalSchema).max(32).parse(input);
    if (candidates.some((item) => item.revision !== `audit:${auditId}`))
      throw new Error('Discovery audit mismatch');
    const issuedAt = this.now();
    if (!Number.isFinite(issuedAt) || issuedAt < 0) throw new Error('Invalid clock');
    while (this.entries.size >= 16) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    const token = randomUUID();
    this.entries.set(token, {
      projectId,
      auditId,
      candidates,
      issuedAt,
      pending: new Set(),
      saved: new Set(),
    });
    return token;
  }

  async save<T>(
    projectId: string,
    auditId: string,
    token: string,
    index: number,
    save: (proposal: CommandProposal) => Promise<T>
  ): Promise<T> {
    project.parse(projectId);
    id.parse(auditId);
    id.parse(token);
    z.number().int().min(0).max(31).parse(index);
    const entry = this.entries.get(token);
    const now = this.now();
    if (
      !entry ||
      entry.projectId !== projectId ||
      entry.auditId !== auditId ||
      !Number.isFinite(now) ||
      now < entry.issuedAt ||
      now - entry.issuedAt >= 300_000 ||
      entry.pending.has(index) ||
      entry.saved.has(index)
    )
      throw new Error('Discovery selection expired or is unavailable');
    const candidate = entry.candidates[index];
    if (!candidate) throw new Error('Discovery selection unavailable');
    entry.pending.add(index);
    try {
      const result = await save(commandProposalSchema.parse(candidate));
      entry.saved.add(index);
      return result;
    } finally {
      entry.pending.delete(index);
    }
  }
}
