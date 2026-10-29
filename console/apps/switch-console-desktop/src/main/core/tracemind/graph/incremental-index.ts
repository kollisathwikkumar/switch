export interface FileFingerprint {
  /** Project-relative path using forward slashes. */
  path: string;
  /** Content digest computed by the snapshot producer. */
  hash: string;
}

export interface IndexedRecordDependencies {
  id: string;
  /** Every source file whose content can affect this record. */
  paths: readonly string[];
}

export interface IncrementalIndexPlan {
  added: string[];
  changed: string[];
  deleted: string[];
  reindex: string[];
  staleRecordIds: string[];
}

function validatePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid project-relative path');
  }
}

function toFingerprintMap(files: readonly FileFingerprint[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of files) {
    validatePath(file.path);
    if (!file.hash.trim() || result.has(file.path)) throw new Error('Invalid file fingerprint');
    result.set(file.path, file.hash);
  }
  return result;
}

/** Plans invalidation only; the caller must use complete snapshots and execute the plan atomically. */
export function planIncrementalIndex(
  previous: readonly FileFingerprint[],
  current: readonly FileFingerprint[],
  records: readonly IndexedRecordDependencies[]
): IncrementalIndexPlan {
  const before = toFingerprintMap(previous);
  const after = toFingerprintMap(current);
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== hash) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }
  const affected = new Set([...added, ...changed, ...deleted]);
  const stale = new Set<string>();
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.id.trim() || ids.has(record.id)) throw new Error('Invalid record identifier');
    ids.add(record.id);
    for (const path of record.paths) {
      validatePath(path);
      if (affected.has(path)) stale.add(record.id);
    }
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    deleted: deleted.sort(),
    reindex: [...added, ...changed].sort(),
    staleRecordIds: [...stale].sort(),
  };
}
