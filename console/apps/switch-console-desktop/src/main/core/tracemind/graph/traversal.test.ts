import { describe, expect, it } from 'vitest';
import { traverseGraph, type GraphEdge, type TraversalOptions } from './traversal';

const edge = (source: string, target: string, projectId = 'p', revision = 'r'): GraphEdge => ({
  source,
  target,
  projectId,
  revision,
  relation: 'CONTAINS',
  provenance: 'fixture',
});
const edges = [
  edge('a', 'b'),
  edge('b', 'c'),
  edge('c', 'a'),
  edge('a', 'foreign', 'other'),
  edge('a', 'old', 'p', 'old'),
];
const options: TraversalOptions = {
  projectId: 'p',
  revision: 'r',
  start: 'a',
  maxDepth: 4,
  maxResults: 10,
  maxEdges: 100,
};

describe('bounded graph traversal', () => {
  it('stays in scope and does not revisit cycles', () => {
    const output = traverseGraph(edges, options);
    expect(output.results.map((entry) => entry.node)).toEqual(['b', 'c']);
    expect(output.results[0]?.via).toEqual(edges[0]);
    expect(output.truncated).toBe(false);
  });

  it('bounds depth, results and examined entries', () => {
    expect(traverseGraph(edges, { ...options, maxDepth: 0 }).results).toEqual([]);
    expect(traverseGraph(edges, { ...options, maxResults: 1 }).truncated).toBe(true);
    expect(traverseGraph(edges, { ...options, maxEdges: 1 }).truncated).toBe(true);
  });

  it('rejects invalid limits', () => {
    for (const maxDepth of [-1, 1.5, 101, NaN]) {
      expect(() => traverseGraph(edges, { ...options, maxDepth })).toThrow();
    }
    expect(() => traverseGraph(edges, { ...options, maxResults: 10001 })).toThrow();
    expect(() => traverseGraph(edges, { ...options, maxEdges: 0 })).toThrow();
  });
});

describe('retrieved relationships', () => {
  it('preserves supporting and contradicting edges to an already discovered node', () => {
    const supporting: GraphEdge = { ...edge('a', 'b'), relation: 'SUPPORTS' };
    const contradicting: GraphEdge = { ...edge('a', 'b'), relation: 'CONTRADICTS' };
    const result = traverseGraph([supporting, contradicting], { ...options, maxDepth: 1 });
    expect(result.results).toHaveLength(1);
    expect(result.relationships).toEqual([supporting, contradicting]);
    expect(result.truncated).toBe(false);
  });

  it('filters relationship scope and preserves cycles', () => {
    const cycle = edge('a', 'a');
    const result = traverseGraph([cycle, edge('a', 'b', 'other'), edge('a', 'b', 'p', 'old')], {
      ...options,
      maxDepth: 1,
    });
    expect(result.relationships).toEqual([cycle]);
    expect(result.results).toEqual([]);
  });

  it('reports when the edge budget truncates relationship retrieval', () => {
    const result = traverseGraph([edge('a', 'b'), edge('a', 'c')], {
      ...options,
      maxEdges: 1,
    });
    expect(result.relationships).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('stops before allocating traversal indexes when the memory budget is too small', () => {
    const result = traverseGraph([edge('a', 'b')], {
      ...options,
      maxMemoryBytes: 1,
    });
    expect(result).toMatchObject({
      results: [],
      relationships: [],
      truncated: true,
      stopReason: 'memory_limit',
    });
  });
});

describe('traversal time budget', () => {
  it('stops at the deadline and reports why', () => {
    const times = [100, 100, 105];
    const result = traverseGraph(
      [edge('a', 'b'), edge('a', 'c')],
      { ...options, maxTimeMs: 5 },
      () => times.shift() ?? 105
    );
    expect(result.results).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.stopReason).toBe('time_limit');
  });

  it('rejects invalid time budgets', () => {
    for (const maxTimeMs of [0, -1, Infinity, 30001, 1.5]) {
      expect(() => traverseGraph(edges, { ...options, maxTimeMs })).toThrow();
    }
  });

  it('distinguishes a completed traversal from an exhausted edge budget', () => {
    expect(traverseGraph([edge('a', 'b')], options, () => 0).stopReason).toBeNull();
    expect(traverseGraph(edges, { ...options, maxEdges: 1 }, () => 0).stopReason).toBe(
      'edge_limit'
    );
  });
});
