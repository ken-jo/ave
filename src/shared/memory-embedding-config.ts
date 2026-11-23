import { z } from 'zod';
export const MEMORY_EMBEDDING_CONSENT_VERSION = 2;
const MemoryEmbeddingConsentSchema = z.object({ version: z.literal(MEMORY_EMBEDDING_CONSENT_VERSION), providerId: z.string().min(1).max(128), modelId: z.string().min(1).max(256), endpointId: z.string().regex(/^[a-f0-9]{64}$/), timestamp: z.string().datetime() }).strict();
export type MemoryEmbeddingConsent = z.infer<typeof MemoryEmbeddingConsentSchema>;
const ConfigSchema = z.object({
  localModelPath: z.string().min(1).max(32768).refine(value => !value.includes('\0')).optional(),
  source: z.enum(['local', 'provider']).optional(), providerId: z.string().min(1).max(128).optional(), modelId: z.string().min(1).max(256).optional(),
  consent: z.unknown().transform(value => MemoryEmbeddingConsentSchema.safeParse(value).data).optional(),
}).strict().refine(value => value.source !== 'provider' || Boolean(value.providerId && value.modelId), 'Provider selection is incomplete');
export type MemoryEmbeddingConfig = z.infer<typeof ConfigSchema>;
export function normalizeMemoryEmbeddingConfig(value: unknown): MemoryEmbeddingConfig | undefined {
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { consent, ...config } = parsed.data;
  return consent ? { ...config, consent } : config;
}
