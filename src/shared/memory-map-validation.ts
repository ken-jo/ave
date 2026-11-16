import { z } from 'zod';
export const MemoryMapScopeSchema = z.object({ projectRoot: z.string().trim().min(1).max(2048).optional(), projectName: z.string().trim().min(1).max(120).optional(), includeUnscoped: z.boolean().optional() }).strict();
export const MemoryMapFiltersSchema = z.object({ sources: z.array(z.enum(['user','assistant','import','capture','unknown'])).max(5).optional(), projectIds: z.array(z.string().min(1).max(128)).max(100).optional(), playbookIds: z.array(z.string().min(1).max(128)).max(100).optional(), text: z.string().max(500).optional() }).strict();
export const MemoryRetrievalSchema = z.object({ scope: MemoryMapScopeSchema.optional(), question: z.string().trim().min(1).max(2000), filters: MemoryMapFiltersSchema, snapshotId: z.string().min(1).max(128), queryId: z.string().min(1).max(128) }).strict();
export const MemoryEmbeddingSettingsSchema = z.object({ source: z.enum(['local', 'provider']) }).strict();
export const MemoryMapProgressSchema = z.object({ jobId: z.string().max(128), phase: z.enum(['embedding','neighbours','projection']), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), memoryId: z.string().max(128).optional() }).strict();
export const MemoryModelStatusSchema = z.object({ status: z.enum(['unconfigured','downloading','ready','failed']), error: z.enum(['model-download-failed','model-integrity-failed','model-folder-invalid','model-cancelled']).optional(), receivedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(), completedFiles: z.number().int().nonnegative(), totalFiles: z.number().int().nonnegative() }).strict();

const SourceSchema = z.enum(['user','assistant','import','capture','unknown']);
const NamespaceSchema = z.object({ source: z.enum(['local','provider']), providerId: z.string().optional(), modelId: z.string(), modelRevision: z.string(), preprocessingRevision: z.string(), dimensions: z.number().int().positive() }).strict();
export const StoredMemoryGraphSchema = z.object({
  cache: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.array(z.number().finite()).length(384).refine(vector => Math.abs(Math.hypot(...vector) - 1) < 0.001)),
  snapshot: z.object({
    snapshotId: z.string(), catalogRevision: z.string(), authorizationScopeId: z.string(),
    model: z.object({ id: z.string(), revision: z.string(), dimensions: z.number().int().positive(), preprocessingRevision: z.string(), namespace: NamespaceSchema }).strict(),
    projection: z.object({ algorithm: z.literal('umap'), dimensions: z.literal(2), version: z.string(), seed: z.number().int(), parameters: z.object({ nNeighbors: z.number().int().nonnegative(), minDist: z.number().finite(), nEpochs: z.number().int().positive() }).strict() }).strict(),
    status: z.literal('ready'), coverage: z.object({ eligible: z.number().int().nonnegative(), embedded: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), excluded: z.number().int().nonnegative() }).strict(),
    points: z.array(z.object({ memoryId: z.string(), contentRevision: z.string(), title: z.string(), sourceKind: SourceSchema, projectId: z.string().optional(), projectName: z.string().optional(), x: z.number().finite(), y: z.number().finite() }).strict()),
    edges: z.array(z.object({ a: z.string(), b: z.string(), similarity: z.number().min(-1).max(1), kind: z.literal('semantic-neighbour') }).strict()).max(17000),
  }).strict().nullable(),
}).strict();
