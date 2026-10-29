import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  ensureGraphRevision,
  getGraphNode,
  getGraphNodePayloadBytes,
  getGraphOutgoingIndexPage,
  getGraphIncomingIndexPage,
  getGraphRelationship,
  type GraphAdjacencyIndexRow,
} from './graph-store';
import type { PersistentGraphNode, PersistentGraphRelationship } from './model';

const limitSchema = z
  .object({
    direction: z.enum(['outgoing', 'both']).default('outgoing'),
    maxDepth: z.number().int().min(0).max(64),
    maxResults: z.number().int().min(1).max(1000),
    maxEdges: z.number().int().min(1).max(100_000),
    maxTimeMs: z.number().int().min(1).max(10_000),
    maxMemoryBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024 * 1024)
      .default(16 * 1024 * 1024),
  })
  .strict();
export interface GraphInspection {
  nodes: PersistentGraphNode[];
  relationships: PersistentGraphRelationship[];
  truncated: boolean;
  stopReason: 'time_limit' | 'edge_limit' | 'result_limit' | 'memory_limit' | null;
}

const maxAdjacencyPage = 64;
const bytesPerJsonByte = 4;
const nodeOverheadBytes = 512;
const relationshipOverheadBytes = 512;
const adjacencyMetadataBytes = 2048;

function estimatedRecordBytes(payloadBytes: number, overhead: number): number {
  return payloadBytes * bytesPerJsonByte + overhead;
}

function stopped(
  nodes: ReadonlyMap<string, PersistentGraphNode>,
  relationships: ReadonlyMap<string, PersistentGraphRelationship>,
  stopReason: NonNullable<GraphInspection['stopReason']>
): GraphInspection {
  return {
    nodes: [...nodes.values()],
    relationships: [...relationships.values()],
    truncated: true,
    stopReason,
  };
}

/** Traverses the indexed adjacency rows directly so unrelated graph payloads are never loaded. */
export async function inspectGraph(
  projectId: string,
  revision: string,
  startNodeId: string,
  limits: z.input<typeof limitSchema>,
  now: () => number = () => performance.now()
): Promise<GraphInspection> {
  const options = limitSchema.parse(limits);
  const startedAt = now();
  const deadline = startedAt + options.maxTimeMs;
  const exists = await ensureGraphRevision(projectId, revision);
  if (now() >= deadline) {
    return stopped(new Map(), new Map(), 'time_limit');
  }
  if (!exists) throw new Error('Graph revision not found');

  const rootPayloadBytes = await getGraphNodePayloadBytes(projectId, revision, startNodeId);
  if (rootPayloadBytes === null) throw new Error('Graph start node not found');
  const rootBytes = estimatedRecordBytes(rootPayloadBytes, nodeOverheadBytes) + 128;
  if (rootBytes > options.maxMemoryBytes) return stopped(new Map(), new Map(), 'memory_limit');
  const root = await getGraphNode(projectId, revision, startNodeId);
  if (!root) throw new Error('Graph start node not found');

  const nodes = new Map<string, PersistentGraphNode>([[root.id, root]]);
  const relationships = new Map<string, PersistentGraphRelationship>();
  const visited = new Set([root.id]);
  const queue: { nodeId: string; depth: number }[] = [{ nodeId: root.id, depth: 0 }];
  let memoryUsed = rootBytes;
  let examinedEdges = 0;
  const timeExpired = (): boolean => now() >= deadline;

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    if (timeExpired()) return stopped(nodes, relationships, 'time_limit');
    const current = queue[queueIndex];
    if (!current || current.depth >= options.maxDepth) continue;
    const pages =
      options.direction === 'both'
        ? [getGraphOutgoingIndexPage, getGraphIncomingIndexPage]
        : [getGraphOutgoingIndexPage];
    for (const getPage of pages) {
      let offset = 0;
      while (true) {
        if (timeExpired()) return stopped(nodes, relationships, 'time_limit');
        const edgeBudget = options.maxEdges - examinedEdges;
        const remainingMemory = options.maxMemoryBytes - memoryUsed;
        if (edgeBudget <= 0) {
          const next = await getPage(projectId, revision, current.nodeId, offset, 1);
          if (timeExpired()) return stopped(nodes, relationships, 'time_limit');
          if (next.length) return stopped(nodes, relationships, 'edge_limit');
          break;
        }
        const pageSize = Math.min(
          maxAdjacencyPage,
          edgeBudget,
          Math.floor(remainingMemory / adjacencyMetadataBytes)
        );
        if (pageSize < 1) return stopped(nodes, relationships, 'memory_limit');

        const page: GraphAdjacencyIndexRow[] = await getPage(
          projectId,
          revision,
          current.nodeId,
          offset,
          pageSize
        );
        if (timeExpired()) return stopped(nodes, relationships, 'time_limit');
        if (page.length === 0) break;
        const pageMemory = page.length * adjacencyMetadataBytes;
        memoryUsed += pageMemory;

        for (const row of page) {
          if (timeExpired()) return stopped(nodes, relationships, 'time_limit');
          examinedEdges++;
          if (relationships.has(row.id)) continue;
          const relationshipBytes = estimatedRecordBytes(
            row.payloadBytes,
            relationshipOverheadBytes
          );
          if (memoryUsed + relationshipBytes > options.maxMemoryBytes) {
            return stopped(nodes, relationships, 'memory_limit');
          }
          const relationship = await getGraphRelationship(projectId, revision, row.id);
          if (!relationship) throw new Error('Graph relationship disappeared during traversal');
          relationships.set(relationship.id, relationship);
          memoryUsed += relationshipBytes + 128;

          if (visited.has(row.targetId)) continue;
          if (nodes.size - 1 >= options.maxResults) {
            return stopped(nodes, relationships, 'result_limit');
          }
          const targetPayloadBytes = await getGraphNodePayloadBytes(
            projectId,
            revision,
            row.targetId
          );
          if (targetPayloadBytes === null) throw new Error('Graph relationship target is missing');
          const targetBytes = estimatedRecordBytes(targetPayloadBytes, nodeOverheadBytes) + 128;
          if (memoryUsed + targetBytes > options.maxMemoryBytes) {
            return stopped(nodes, relationships, 'memory_limit');
          }
          const target = await getGraphNode(projectId, revision, row.targetId);
          if (!target) throw new Error('Graph relationship target is missing');
          nodes.set(target.id, target);
          visited.add(target.id);
          memoryUsed += targetBytes;
          queue.push({ nodeId: target.id, depth: current.depth + 1 });
        }

        memoryUsed -= pageMemory;
        offset += page.length;
        if (page.length < pageSize) break;
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    relationships: [...relationships.values()],
    truncated: false,
    stopReason: null,
  };
}
