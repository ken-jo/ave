import type { MemoryManager, NoteEntry, ProjectScopedMemoryOptions } from '../../memory/memory-manager.js';
import type { MemoryFacets, MemoryMapRecord } from '../../shared/memory-map.js';
import { projectRootKey } from '../../shared/project-identity.js';
import { digest } from './graph.js';
export interface MemoryMapCatalog {
  records: MemoryMapRecord[];
  excluded: number;
  authorizationScopeId: string;
}
export type ReadMemoryMapCatalog = (() => MemoryMapCatalog) & {
  recordsAreCurrent?: (scopeId: string, records: readonly MemoryMapRecord[]) => boolean;
};
export function memoryMapScopeId(options: ProjectScopedMemoryOptions): string {
  return digest(JSON.stringify([options.projectRoot ? projectRootKey(options.projectRoot) : 'global', options.includeUnscoped === true]));
}
export function isGraphMemory(note: NoteEntry | undefined): note is NoteEntry & { id: string } {
  return Boolean(note?.id && note.origin?.store !== 'subagent' && (note.state === undefined || note.state === 'active'));
}
export function graphMemoryRevision(note: NoteEntry): string {
  return digest(`${note.title}\n${note.content}`);
}
export function matchesGraphRecord(note: NoteEntry | undefined, record: MemoryMapRecord): boolean {
  if (!isGraphMemory(note)) return false;
  const projectKey = projectRootKey(note.projectRoot);
  return (projectKey ? digest(projectKey) : undefined) === record.projectId
    && graphMemoryRevision(note) === record.contentRevision;
}
export function readGraphCatalog(manager: MemoryManager, options: ProjectScopedMemoryOptions, defaultProjectRoot: string, filenames?: Map<string, string>): MemoryMapCatalog {
  const { notes } = manager.readMemoryPanelCatalog(options, defaultProjectRoot);
  const records = notes.flatMap<MemoryMapRecord>(note => {
    if (!isGraphMemory(note)) return [];
    filenames?.set(note.id, note.filename);
    return [{ memoryId: note.id, contentRevision: graphMemoryRevision(note), title: note.title, text: note.content, sourceKind: note.source ?? 'unknown',
      ...(note.projectRoot ? { projectId: digest(projectRootKey(note.projectRoot) as string), projectName: note.projectName ?? note.projectRoot.split(/[\\/]/).slice(-1)[0] } : {}) }];
  }).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  return { records, excluded: notes.length - records.length, authorizationScopeId: memoryMapScopeId(options) };
}
export function memoryFacets(records: MemoryMapRecord[]): MemoryFacets {
  const sources = new Map<MemoryMapRecord['sourceKind'], number>(); const projects = new Map<string, { name: string; count: number }>();
  for (const record of records) {
    sources.set(record.sourceKind, (sources.get(record.sourceKind) ?? 0) + 1);
    if (record.projectId) { const prior = projects.get(record.projectId); projects.set(record.projectId, { name: record.projectName as string, count: (prior?.count ?? 0) + 1 }); }
  }
  return { sources: [...sources].map(([sourceKind, count]) => ({ sourceKind, count })), projects: [...projects].map(([projectId, row]) => ({ projectId, ...row })), playbooks: [] };
}
