import { describe, expect, it } from 'vitest';
import { planIncrementalIndex } from './incremental-index';

describe('incremental index planning', () => {
  it('detects additions, changes, removals and dependent records', () => {
    const before = [
      { path: 'a.ts', hash: '1' },
      { path: 'b.ts', hash: '2' },
      { path: 'gone.ts', hash: '3' },
    ];
    const after = [
      { path: 'a.ts', hash: '4' },
      { path: 'b.ts', hash: '2' },
      { path: 'new.ts', hash: '5' },
    ];
    expect(
      planIncrementalIndex(before, after, [
        { id: 'edge', paths: ['a.ts'] },
        { id: 'evidence', paths: ['gone.ts'] },
        { id: 'unrelated', paths: ['b.ts'] },
      ])
    ).toEqual({
      added: ['new.ts'],
      changed: ['a.ts'],
      deleted: ['gone.ts'],
      reindex: ['a.ts', 'new.ts'],
      staleRecordIds: ['edge', 'evidence'],
    });
  });

  it('leaves records alone when snapshots match', () => {
    const files = [{ path: 'a', hash: '1' }];
    expect(planIncrementalIndex(files, files, [{ id: 'e', paths: ['a'] }])).toEqual({
      added: [],
      changed: [],
      deleted: [],
      reindex: [],
      staleRecordIds: [],
    });
  });

  it('rejects duplicate paths, invalid hashes and escaping paths', () => {
    expect(() =>
      planIncrementalIndex(
        [
          { path: 'a', hash: '1' },
          { path: 'a', hash: '2' },
        ],
        [],
        []
      )
    ).toThrow();
    expect(() => planIncrementalIndex([], [{ path: '../escape', hash: '1' }], [])).toThrow();
    expect(() => planIncrementalIndex([{ path: 'a', hash: '' }], [], [])).toThrow();
    expect(() => planIncrementalIndex([], [], [{ id: 'e', paths: ['/absolute'] }])).toThrow();
  });
});
