import { describe, expect, it } from 'vitest';
import { evidenceFreshness } from './freshness';

const snapshot = { projectId: 'project-1', revision: 'commit-a', fingerprint: 'tree-a' };

describe('evidence freshness', () => {
  it('marks matching complete snapshots current', () => {
    expect(evidenceFreshness(snapshot, { ...snapshot })).toBe('current');
  });

  it('marks a changed project, revision or fingerprint stale', () => {
    for (const change of [
      { projectId: 'project-2' },
      { revision: 'commit-b' },
      { fingerprint: 'tree-b' },
    ]) {
      expect(evidenceFreshness(snapshot, { ...snapshot, ...change })).toBe('stale');
    }
  });

  it('marks missing identifiers unknown on either side', () => {
    for (const change of [
      { projectId: '' },
      { revision: '' },
      { fingerprint: '' },
      { fingerprint: null },
      { revision: null },
    ]) {
      expect(evidenceFreshness({ ...snapshot, ...change }, snapshot)).toBe('unknown');
      expect(evidenceFreshness(snapshot, { ...snapshot, ...change })).toBe('unknown');
    }
  });
});
