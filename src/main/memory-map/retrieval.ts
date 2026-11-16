import type { MemoryMapFilters, MemoryMapRecord, RetrievalAnswer } from '../../shared/memory-map.js';
import { cosine, SIMILARITY_CUTOFF, vectorKey, LOCAL_NAMESPACE, type VectorCache } from './graph.js';
export function matchesFilters(record: MemoryMapRecord, filters: MemoryMapFilters): boolean {
  if (filters.sources && !filters.sources.includes(record.sourceKind)) return false;
  if (filters.projectIds?.length && (!record.projectId || !filters.projectIds.includes(record.projectId))) return false;
  if (filters.playbookIds?.length) return false;
  return !filters.text?.trim() || (record.title + '\n' + record.text).toLocaleLowerCase().includes(filters.text.trim().toLocaleLowerCase());
}
export function retrieveMatches(records: MemoryMapRecord[], cache: VectorCache, questionVector: number[], filters: MemoryMapFilters, identity: Pick<RetrievalAnswer, 'snapshotId' | 'catalogRevision' | 'queryId'>): RetrievalAnswer {
  const candidates = records.filter(record => matchesFilters(record, filters)).map(record => {
    const vector = cache[vectorKey(record, LOCAL_NAMESPACE)];
    if (!vector) throw new Error('Current memory vector is missing');
    return { record, score: cosine(questionVector, vector) };
  }).filter(row => row.score >= SIMILARITY_CUTOFF && row.record.text.trim()).sort((a, b) => b.score - a.score || a.record.memoryId.localeCompare(b.record.memoryId));
  const seen = new Set<string>(); const matches: RetrievalAnswer['matches'] = [];
  for (const { record, score } of candidates) {
    const content = record.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (seen.has(content)) continue;
    seen.add(content);
    matches.push({ memoryId: record.memoryId, contentRevision: record.contentRevision, excerpt: record.text.trim().slice(0, 480), score, citation: matches.length + 1 });
    if (matches.length === 3) break;
  }
  return { ...identity, matches, answerParts: matches.map(match => ({ text: match.excerpt, sourceMemoryIds: [match.memoryId], citation: match.citation })) };
}
