import { describe, expect, it } from 'vitest';
import { retrieveMatches } from '../retrieval.js';
import { LOCAL_NAMESPACE, vectorKey, type VectorCache } from '../graph.js';
import type { MemoryMapRecord } from '../../../shared/memory-map.js';
const vector = (x = 1) => [x, Math.sqrt(1-x*x), ...Array<number>(382).fill(0)];
const identity = { snapshotId: 'snapshot', catalogRevision: 'revision', queryId: 'query' };
const record = (i: number): MemoryMapRecord => ({ memoryId: String(i), contentRevision: 'revision-' + i, title: 'Title', text: 'Memory text ' + i, sourceKind: 'user', projectId: 'alpha', projectName: 'Alpha' });
describe('extractive memory retrieval', () => {
  it('filters before ranking, returns three distinct bounded excerpts and host citation numbers', () => {
    const records = Array.from({ length: 7 }, (_, i) => record(i));
    records[0]!.projectId = 'other'; records[1]!.sourceKind = 'assistant'; records[3]!.text = records[2]!.text; records[4]!.text = 'x'.repeat(900);
    const cache: VectorCache = Object.fromEntries(records.map(r => [vectorKey(r, LOCAL_NAMESPACE), vector()]));
    const answer = retrieveMatches(records, cache, vector(), { projectIds: ['alpha'], sources: ['user'] }, identity);
    expect(answer.matches.map(m => m.memoryId)).toEqual(['2','4','5']);
    expect(answer.matches.map(m => m.citation)).toEqual([1,2,3]);
    expect(answer.matches[1]!.excerpt).toHaveLength(480);
    expect(answer.matches[0]!.contentRevision).toBe('revision-2');
    for (const part of answer.answerParts) { expect(answer.matches.some(m => m.memoryId === part.sourceMemoryIds[0] && m.excerpt === part.text && m.citation === part.citation)).toBe(true); }
  });
  it('has no answer for insufficient support, empty source selection or unbacked playbook filters', () => {
    const records = [record(0)]; const cache = { [vectorKey(records[0]!, LOCAL_NAMESPACE)]: vector(0) };
    expect(retrieveMatches(records, cache, vector(), {}, identity).answerParts).toEqual([]);
    expect(retrieveMatches(records, {}, vector(), { sources: [] }, identity).matches).toEqual([]);
    expect(retrieveMatches(records, {}, vector(), { playbookIds: ['unassigned'] }, identity).matches).toEqual([]);
    expect(retrieveMatches(records, {}, vector(), { text: 'absent' }, identity).matches).toEqual([]);
  });
});
