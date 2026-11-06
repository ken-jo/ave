import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import type { MemorySummariesResult } from "../../../shared/memory-detail.js";
import type { AveApi } from "../types.js";
import type { MemoryKind, MemoryOriginV1 } from "../../../memory/memory-manager.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";

export interface NoteResult {
  kind?: MemoryKind;
  origin?: MemoryOriginV1;
  content?: string;
  title: string;
  excerpt: string;
  updatedAt?: string;
  createdAt?: string;
  filename?: string;
  /** Absent on a legacy note without front matter; such a note can be deleted but not fixed by id. */
  id?: string;
  projectRoot?: string;
  projectName?: string;
  /** The MEMORY.md instructions file shown first; it is edited in 지침, not deleted or fixed from here. */
  isIndex?: true;
}

export interface SessionResult {
  sessionId: string;
  title?: string;
  matchedMessage: string;
  timestamp: string;
}

export function memoryProjectOptions(project: ProjectIdentity | undefined) {
  if (!project?.projectRoot) return undefined;
  return {
    projectRoot: project.projectRoot,
    projectName: project.projectName,
    includeUnscoped: project.isDefault === true,
  };
}

export function stripTopHeading(content: string): string {
  return content.replace(/^#\s+.+(?:\r?\n)+/m, "").trim();
}

function memoryIndexResult(content: string | undefined, query = ""): NoteResult[] {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) return [];
  if (query.trim() && !trimmed.toLowerCase().includes(query.trim().toLowerCase())) return [];
  return [{
    filename: "MEMORY.md",
    title: t("useMemorySearch.memoryIndexTitle"),
    excerpt: stripTopHeading(trimmed),
    isIndex: true,
  }];
}

function memoryGetIndex(api: AveApi, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memoryGetIndex(opts) : api.memoryGetIndex();
}

function memoryGetSummaries(api: AveApi, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memoryGetSummaries(opts) : api.memoryGetSummaries();
}

function memoryListSessions(api: AveApi, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memoryListSessions(opts) : api.memoryListSessions();
}

function memorySearchEntries(api: AveApi, query: string, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memorySearchEntries(query, opts) : api.memorySearchEntries(query);
}

function memorySearchSessions(api: AveApi, query: string, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memorySearchSessions(query, opts) : api.memorySearchSessions(query);
}

/** Memory search hook. Debounces query (200 ms), fires IPC calls, guards post-unmount setState with aliveRef pattern. */
export function useMemorySearch(api: AveApi, project?: ProjectIdentity) {
  const [query, setQuery] = useState("");
  const [summaries, setSummaries] = useState<MemorySummariesResult>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [noteCatalog, setNoteCatalog] = useState<NoteResult[]>([]);
  const [sessionCatalog, setSessionCatalog] = useState<SessionResult[]>([]);
  const [noteResults, setNoteResults] = useState<NoteResult[]>([]);
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);
  const projectKey = `${project?.projectRoot ?? ""}\0${project?.projectName ?? ""}\0${project?.isDefault === true ? "default" : ""}`;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [memoryIndex, summaryResult, sessions] = await Promise.all([
        memoryGetIndex(api, project),
        memoryGetSummaries(api, project),
        memoryListSessions(api, project),
      ]);
      if (!aliveRef.current) return;
      setSummaries(summaryResult);
      const mappedNotes = (summaryResult.ok ? summaryResult.notes : []).map((note) => ({
        ...note,
        filename: note.filename,
        ...(note.id ? { id: note.id } : {}),
        title: note.title,
        excerpt: stripTopHeading(note.content),
        updatedAt: note.updatedAt,
        ...(note.projectRoot ? { projectRoot: note.projectRoot } : {}),
        ...(note.projectName ? { projectName: note.projectName } : {}),
      }));
      const mappedMemory = [...memoryIndexResult(memoryIndex), ...mappedNotes];
      setCatalogRevision((revision) => revision + 1);
      setNoteCatalog(mappedMemory);
      setSessionCatalog(sessions ?? []);
      setNoteResults(mappedMemory);
      setSessionResults(sessions ?? []);
    } catch {
      if (!aliveRef.current) return;
      setSummaries({ ok: false, error: "read-failed" });
      setCatalogRevision((revision) => revision + 1);
      setNoteCatalog([]);
      setSessionCatalog([]);
      setNoteResults([]);
      setSessionResults([]);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [api, projectKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (query.trim() === "") {
      setNoteResults(noteCatalog);
      setSessionResults(sessionCatalog);
      setLoading(false);
      return;
    }
    const timer = setTimeout(async () => {
      if (!aliveRef.current) return;
      setLoading(true);
      try {
        const [memoryIndex, notes, sessions] = await Promise.all([
          memoryGetIndex(api, project),
          memorySearchEntries(api, query, project),
          memorySearchSessions(api, query, project),
        ]);
        if (!aliveRef.current) return;
        setNoteResults([
          ...memoryIndexResult(memoryIndex, query),
          ...(notes ?? []),
        ]);
        setSessionResults(sessions ?? []);
      } catch {
        if (!aliveRef.current) return;
        setNoteResults([]);
        setSessionResults([]);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, api, noteCatalog, sessionCatalog, projectKey]);

  const reset = useCallback(() => {
    setQuery("");
    setNoteResults([]);
    setSessionResults([]);
  }, []);

  return { query, setQuery, summaries, catalogRevision, noteCatalog, noteResults, sessionResults, loading, refresh, reset };
}
