import { z } from 'zod';

export const maxGraphRelationships = 400_000;

export const graphNodeKindSchema = z.enum([
  'repository_revision',
  'file',
  'symbol',
  'dependency',
  'test',
  'observation',
  'command_run',
  'hypothesis',
  'evidence',
  'finding',
]);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

export const graphRelationSchema = z.enum([
  'CONTAINS',
  'IMPORTS',
  'CALLS',
  'DEPENDS_ON',
  'TESTS',
  'SUPPORTS',
  'CONTRADICTS',
  'VERIFIED_BY',
]);
export type PersistentGraphRelation = z.infer<typeof graphRelationSchema>;

const locationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const graphId = z.string().min(1).max(512);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
const revision = z.string().min(1).max(128);

export const sourceLocationSchema = z
  .object({
    path,
    startLine: z.number().int().positive().max(10_000_000),
    endLine: z.number().int().positive().max(10_000_000),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine);
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

export const graphNodeSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: graphId,
    projectId: locationId,
    revision,
    kind: graphNodeKindSchema,
    label: z.string().min(1).max(8192),
    source: sourceLocationSchema.nullable(),
    extractionMethod: z.string().min(1).max(128),
    provenance: z.string().min(1).max(1024),
    stale: z.boolean(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type PersistentGraphNode = z.infer<typeof graphNodeSchema>;

export const graphRelationshipSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: graphId,
    projectId: locationId,
    revision,
    sourceId: graphId,
    targetId: graphId,
    relation: graphRelationSchema,
    source: sourceLocationSchema.nullable(),
    extractionMethod: z.string().min(1).max(128),
    provenance: z.string().min(1).max(1024),
    stale: z.boolean(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type PersistentGraphRelationship = z.infer<typeof graphRelationshipSchema>;

export const retrievalReasonSchema = z
  .object({
    id: graphId,
    projectId: locationId,
    revision,
    evidenceNodeId: graphId,
    reason: z.string().min(1).max(4096),
    retrievedAt: z.number().int().nonnegative(),
  })
  .strict();
export type RetrievalReason = z.infer<typeof retrievalReasonSchema>;

export const graphSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    projectId: locationId,
    revision,
    nodes: z.array(graphNodeSchema).max(100_000),
    relationships: z.array(graphRelationshipSchema).max(maxGraphRelationships),
    retrievalReasons: z.array(retrievalReasonSchema).max(100_000),
    parserFailures: z
      .array(
        z.object({ path, language: z.string().max(128), message: z.string().max(1024) }).strict()
      )
      .max(10_000),
  })
  .strict();
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>;

export const graphPathSchema = path;
