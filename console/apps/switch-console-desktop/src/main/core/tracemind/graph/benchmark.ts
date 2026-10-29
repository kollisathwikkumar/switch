import { performance } from 'node:perf_hooks';
import { inspectGraph, type GraphInspection } from './graph-query';
import { ensureGraphRevision, getGraphRevisionCounts, getGraphRootNode } from './graph-store';

export interface GraphAdapterBenchmark {
  adapter: 'sqlite-normalized';
  nodes: number;
  relationships: number;
  readMs: number;
  traversalMs: number;
  traversalNodes: number;
  traversalRelationships: number;
  truncated: boolean;
  stopReason: GraphInspection['stopReason'];
}

/** Measures indexed metadata reads and bounded traversal over the local normalized SQLite adapter. */
export async function benchmarkGraphAdapter(
  projectId: string,
  revision: string
): Promise<GraphAdapterBenchmark> {
  await ensureGraphRevision(projectId, revision);
  const started = performance.now();
  const counts = await getGraphRevisionCounts(projectId, revision);
  const readMs = performance.now() - started;
  if (!counts) throw new Error('Graph revision not found');
  const root = await getGraphRootNode(projectId, revision);
  if (!root) {
    return {
      adapter: 'sqlite-normalized',
      nodes: counts.nodes,
      relationships: counts.relationships,
      readMs,
      traversalMs: 0,
      traversalNodes: 0,
      traversalRelationships: 0,
      truncated: false,
      stopReason: null,
    };
  }
  const traversalStarted = performance.now();
  const traversal = await inspectGraph(projectId, revision, root.id, {
    maxDepth: 4,
    maxResults: 500,
    maxEdges: 20_000,
    maxTimeMs: 1_000,
    maxMemoryBytes: 16 * 1024 * 1024,
  });
  return {
    adapter: 'sqlite-normalized',
    nodes: counts.nodes,
    relationships: counts.relationships,
    readMs,
    traversalMs: performance.now() - traversalStarted,
    traversalNodes: traversal.nodes.length,
    traversalRelationships: traversal.relationships.length,
    truncated: traversal.truncated,
    stopReason: traversal.stopReason,
  };
}
