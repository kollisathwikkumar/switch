import { performance } from 'node:perf_hooks';

export type GraphRelation =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'CALLS'
  | 'DEPENDS_ON'
  | 'TESTS'
  | 'OBSERVED_IN'
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'VERIFIED_BY'
  | 'CHANGED_IN';

export interface GraphEdge {
  projectId: string;
  revision: string;
  source: string;
  target: string;
  relation: GraphRelation;
  provenance: string;
}

export interface TraversalOptions {
  projectId: string;
  revision: string;
  start: string;
  maxDepth: number;
  maxResults: number;
  /** Maximum number of edge entries inspected, including entries outside the requested scope. */
  maxEdges: number;
  /** Wall-clock budget in milliseconds; defaults to 1000. */
  maxTimeMs?: number;
  /** Budget for traversal-owned queue, visited set, result and relationship storage. */
  maxMemoryBytes?: number;
}

export interface TraversalResult {
  node: string;
  depth: number;
  via: GraphEdge;
}

function validateLimit(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}`);
  }
}

/** Returns a bounded discovery tree and inspected outgoing relationships. */
export function traverseGraph(
  edges: readonly GraphEdge[],
  options: TraversalOptions,
  now: () => number = () => performance.now()
): {
  results: TraversalResult[];
  relationships: GraphEdge[];
  truncated: boolean;
  stopReason: 'time_limit' | 'edge_limit' | 'result_limit' | 'memory_limit' | null;
} {
  validateLimit('maxDepth', options.maxDepth, 0, 100);
  validateLimit('maxResults', options.maxResults, 1, 10_000);
  validateLimit('maxEdges', options.maxEdges, 1, 1_000_000);
  const maxTimeMs = options.maxTimeMs ?? 1000;
  validateLimit('maxTimeMs', maxTimeMs, 1, 30_000);
  const maxMemoryBytes = options.maxMemoryBytes ?? 16 * 1024 * 1024;
  validateLimit('maxMemoryBytes', maxMemoryBytes, 1, 256 * 1024 * 1024);
  // These are conservative upper bounds for JS references/collection slots, not
  // a claim about total process RSS (the caller owns the input edge array).
  const estimatedTraversalBytes = options.maxResults * 128 + options.maxEdges * 16;
  if (estimatedTraversalBytes > maxMemoryBytes) {
    return { results: [], relationships: [], truncated: true, stopReason: 'memory_limit' };
  }
  const deadline = now() + maxTimeMs;

  const visited = new Set([options.start]);
  const queue: { node: string; depth: number }[] = [{ node: options.start, depth: 0 }];
  const result: TraversalResult[] = [];
  const relationships: GraphEdge[] = [];
  let examined = 0;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current || current.depth >= options.maxDepth) continue;
    for (const edge of edges) {
      if (now() >= deadline) {
        return { results: result, relationships, truncated: true, stopReason: 'time_limit' };
      }
      if (examined >= options.maxEdges) {
        return { results: result, relationships, truncated: true, stopReason: 'edge_limit' };
      }
      examined++;
      if (
        edge.projectId !== options.projectId ||
        edge.revision !== options.revision ||
        edge.source !== current.node
      )
        continue;
      relationships.push(edge);
      if (visited.has(edge.target)) continue;
      if (result.length >= options.maxResults) {
        return { results: result, relationships, truncated: true, stopReason: 'result_limit' };
      }
      visited.add(edge.target);
      const depth = current.depth + 1;
      result.push({ node: edge.target, depth, via: edge });
      queue.push({ node: edge.target, depth });
    }
  }
  return { results: result, relationships, truncated: false, stopReason: null };
}
