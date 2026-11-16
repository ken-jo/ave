export interface MemoryEmbeddingConfig { localModelPath: string }
export function normalizeMemoryEmbeddingConfig(value: unknown): MemoryEmbeddingConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'localModelPath') || typeof record.localModelPath !== 'string' || !record.localModelPath || record.localModelPath.length > 32768 || record.localModelPath.includes('\0')) return undefined;
  return { localModelPath: record.localModelPath };
}
