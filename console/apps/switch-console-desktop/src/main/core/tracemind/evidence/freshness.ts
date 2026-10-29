/** Fingerprints must cover all inputs relevant to the evidence. */
export interface EvidenceSnapshot {
  projectId: string | null;
  revision: string | null;
  fingerprint: string | null;
}

export type EvidenceFreshness = 'current' | 'stale' | 'unknown';

/** Compares recorded snapshots; it does not inspect the repository or generate fingerprints. */
export function evidenceFreshness(
  recorded: EvidenceSnapshot,
  current: EvidenceSnapshot
): EvidenceFreshness {
  const values = [
    recorded.projectId,
    recorded.revision,
    recorded.fingerprint,
    current.projectId,
    current.revision,
    current.fingerprint,
  ];
  if (values.some((value) => value === null || value.trim() === '')) return 'unknown';
  if (
    recorded.projectId !== current.projectId ||
    recorded.revision !== current.revision ||
    recorded.fingerprint !== current.fingerprint
  )
    return 'stale';
  return 'current';
}
