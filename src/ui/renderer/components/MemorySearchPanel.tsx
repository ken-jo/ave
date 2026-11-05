import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { stripTopHeading, memoryProjectOptions, useMemorySearch, type NoteResult, type SessionResult } from "../hooks/use-memory-search.js";
import { MemoryDetailContent, type OpenMemorySession } from "./MemoryDetailContent.js";
import type { MemoryDetailResult, MemoryListSummary } from "../../../shared/memory-detail.js";
import type { AveApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import { projectRootEquals, type ProjectIdentity } from "../../../shared/project-identity.js";
import { formatRelativeTime, type RelativeTimeLabels } from "../../../shared/format-time.js";
import { shortSessionId } from "../../../shared/session-lookup.js";
import { sessionDisplayTitle } from "../../../shared/suggestions-session.js";

const RELATIVE_TIME_LABELS: RelativeTimeLabels = {
  justNow: () => t("memorySearchPanel.justNow"),
  minutesAgo: (minutes) => t("memorySearchPanel.minutesAgo", { minutes }),
  hoursAgo: (hours) => t("memorySearchPanel.hoursAgo", { hours }),
  daysAgo: (days) => t("memorySearchPanel.daysAgo", { days }),
};

/** A memory the user can act on: a managed note, not the MEMORY.md instructions file. */
function isActionable(note: NoteResult): note is NoteResult & { filename: string } {
  return note.isIndex !== true && typeof note.filename === "string";
}

function isGlobalMemory(note: NoteResult): boolean {
  return note.id !== undefined && !note.projectRoot && !note.isIndex;
}

function NoteRow({ note, selected, summary, onSelect }: {
  note: NoteResult;
  selected: boolean;
  summary?: MemoryListSummary;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const origin = summary?.origin;
  const idleSince = summary?.lastUsedAt ?? summary?.createdAt ?? note.createdAt ?? note.updatedAt;
  const idleDays = idleSince ? Math.max(0, Math.floor((Date.now() - Date.parse(idleSince)) / DAY_MS)) : 0;
  const idle = note.id !== undefined && idleDays >= 30;
  const source = origin?.status === "recorded"
    ? t("memorySearchPanel.learnedIn", { title: origin.title || shortSessionId(origin.sessionId) })
    : origin?.status === "unavailable" ? t("memorySearchPanel.originUnavailable") : note.excerpt;
  return <button type="button" aria-pressed={selected} onClick={onSelect}
    className={`w-full min-w-0 rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-accent" : "bg-background hover:bg-muted"} ${idle ? "border-dashed text-muted-foreground" : ""}`}>
    <div className="flex min-w-0 items-start gap-2">
      {(summary?.kind ?? note.kind) && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">{t(`memorySearchPanel.kind.${summary?.kind ?? note.kind!}`)}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2"><span className="min-w-0 truncate text-sm font-semibold">{note.title}</span>{isGlobalMemory(note) && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("memorySearchPanel.global")}</span>}</div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{idle ? `${t("memorySearchPanel.idleDays", { days: idleDays })} · ` : ""}{source}</p>
      </div>
      {summary && !idle && <span className="shrink-0 text-[10px] text-muted-foreground">{t("memorySearchPanel.useCount", { count: summary.useCount })}{summary.lastUsedAt ? ` · ${formatRelativeTime(summary.lastUsedAt, RELATIVE_TIME_LABELS)}` : ""}</span>}
    </div>
  </button>;
}

function SessionRow({
  session,
  onOpenSession,
}: {
  session: SessionResult;
  onOpenSession?: OpenMemorySession;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleClick = async () => {
    setFailed(false);
    if (!onOpenSession) {
      setExpanded((v) => !v);
      return;
    }
    setLoading(true);
    try {
      const loaded = await onOpenSession(session.sessionId);
      if (loaded === false) {
        setFailed(true);
        setExpanded(true);
      }
    } catch {
      setFailed(true);
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      className="group w-full rounded-lg border bg-background px-3 py-3 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => void handleClick()}
      aria-label={t("memorySearchPanel.openChatAriaLabel", { title: sessionDisplayTitle(session.sessionId, session.title, t) ?? shortSessionId(session.sessionId) })}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 line-clamp-1 text-sm font-semibold leading-snug text-foreground">
          {sessionDisplayTitle(session.sessionId, session.title, t) || t("memorySearchPanel.sessionFallbackTitle", { id: shortSessionId(session.sessionId) })}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(session.timestamp, RELATIVE_TIME_LABELS)}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 line-clamp-1 font-mono text-[10px] text-muted-foreground">
          {shortSessionId(session.sessionId)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {loading ? t("memorySearchPanel.loading") : failed ? t("memorySearchPanel.loadFailed") : onOpenSession ? t("memorySearchPanel.clickToOpen") : t("memorySearchPanel.clickToExpand")}
        </span>
      </div>
      <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-1"}`}>
        {session.matchedMessage}
      </p>
    </button>
  );
}

export interface MemorySearchPanelProps {
  api: AveApi;
  project?: ProjectIdentity;
  defaultProject?: ProjectIdentity;
  onStartConversation?: () => Promise<boolean>;
  onOpenSession?: OpenMemorySession;
  /** A search to open with (a memory notice's 보기); a new nonce applies it again. */
  initialQuery?: { text: string; nonce: number } | null;
  /** Open a new chat whose composer asks Ave to fix this memory; false when it could not open. */
  onAskAveToFix: (memory: { id: string; title: string; content: string; projectRoot?: string; projectName?: string }) => Promise<boolean>;
}

/** 최근 저장: memories saved in the last week, newest first. */
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * DAY_MS;
const RECENT_LIMIT = 5;

type PanelToast =
  /** `undoFailed`: the last undo could not write; the host kept the token, so the same button tries again. */
  | { kind: "deleted"; title: string; undoToken?: string; undoFailed?: true }
  | { kind: "message"; text: string };

export function MemorySearchPanel({ api, project, defaultProject, onStartConversation, onOpenSession, initialQuery, onAskAveToFix }: MemorySearchPanelProps) {
  const { t } = useTranslation();
  const { query, setQuery, summaries, catalogRevision, noteCatalog, noteResults, sessionResults, loading, refresh } = useMemorySearch(api, project);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<PanelToast | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sort, setSort] = useState<"recent" | "kind" | "origin">("recent");
  const [scope, setScope] = useState<"all" | "project" | "global">("all");
  const [originFilter, setOriginFilter] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, MemoryDetailResult>>({});
  const [detailRetry, setDetailRetry] = useState(0);
  const projectKey = `${project?.projectRoot ?? ""}\0${project?.projectName ?? ""}\0${project?.isDefault === true}`;
  const detailCache = useRef({ projectKey, catalogRevision, entries: {} as Record<string, MemoryDetailResult> });
  const summaryById = useMemo(() => new Map(summaries?.ok ? summaries.entries.map((entry) => [entry.id, entry]) : []), [summaries]);
  const selected = [...noteCatalog, ...noteResults].find((note) => (note.filename ?? note.title) === selectedKey);
  const globalNotes = noteCatalog.filter(isGlobalMemory);
  const localNotes = noteCatalog.filter((note) => !note.isIndex && !isGlobalMemory(note));
  const projectEmpty = !!project?.projectRoot && localNotes.length === 0 && !query.trim() && scope !== "global";
  const visibleNotes = [...(originFilter ? noteCatalog.filter((note) => note.origin?.sessionId === originFilter) : noteResults)]
    .filter((note) => scope === "global" ? isGlobalMemory(note) : scope === "project" || projectEmpty ? !isGlobalMemory(note) : true)
    .sort((a, b) => {
      if (sort === "kind") return (a.kind ?? "note").localeCompare(b.kind ?? "note");
      const aSummary = a.id ? summaryById.get(a.id) : undefined;
      const bSummary = b.id ? summaryById.get(b.id) : undefined;
      if (sort === "origin") {
        const sourceTitle = (entry: MemoryListSummary | undefined) => entry?.origin.status === "recorded" ? entry.origin.title ?? entry.origin.sessionId : "";
        return sourceTitle(aSummary).localeCompare(sourceTitle(bSummary));
      }
      return Date.parse(bSummary?.lastUsedAt ?? "1970-01-01") - Date.parse(aSummary?.lastUsedAt ?? "1970-01-01");
    });

  useEffect(() => {
    if (detailCache.current.projectKey !== projectKey || detailCache.current.catalogRevision !== catalogRevision) {
      detailCache.current = { projectKey, catalogRevision, entries: {} };
      setDetails({});
    }
    const id = selected?.id;
    if (!id) return;
    const cache = detailCache.current;
    if (cache.entries[id]?.ok) return;
    void api.memoryGetDetail(id, memoryProjectOptions(project)).then(
      (detail) => {
        if (detailCache.current !== cache) return;
        cache.entries[id] = detail;
        setDetails({ ...cache.entries });
      },
      () => {
        if (detailCache.current !== cache) return;
        cache.entries[id] = { ok: false, error: "read-failed" };
        setDetails({ ...cache.entries });
      },
    );
  }, [api, selected?.id, projectKey, catalogRevision, detailRetry]);

  useEffect(() => {
    setOriginFilter(null);
    setSelectedKey(null);
    setScope("all");
  }, [projectKey]);

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery.text);
      setOriginFilter(null);
      setScope("all");
    }
  }, [initialQuery, setQuery]);

  const recent = useMemo(() => {
    const since = Date.now() - RECENT_WINDOW_MS;
    return noteCatalog.filter((note) => isActionable(note) && note.updatedAt && Date.parse(note.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!)).slice(0, RECENT_LIMIT);
  }, [noteCatalog]);
  const selectNote = (note: NoteResult) => {
    setSelectedKey(note.filename ?? note.title);
    if (note.id && details[note.id]?.ok === false) setDetailRetry((retry) => retry + 1);
  };
  const startConversation = async () => {
    setBusy(true);
    try {
      if (await onStartConversation?.() === false) setToast({ kind: "message", text: t("memorySearchPanel.startConversationFailed") });
    } catch {
      setToast({ kind: "message", text: t("memorySearchPanel.startConversationFailed") });
    } finally { setBusy(false); }
  };

  const handleDelete = async (note: NoteResult & { filename: string }) => {
    setBusy(true);
    try {
      const opts = memoryProjectOptions(project);
      const result = opts ? await api.memoryDeleteEntry(note.filename, opts) : await api.memoryDeleteEntry(note.filename);
      if (!result.ok) {
        setToast({ kind: "message", text: t("memorySaveNotice.panelDeleteFailed", { title: note.title }) });
        return;
      }
      setToast({ kind: "deleted", title: note.title, ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
      await refresh();
    } catch {
      setToast({ kind: "message", text: t("memorySaveNotice.panelDeleteFailed", { title: note.title }) });
    } finally {
      setBusy(false);
    }
  };

  const handleUndoDelete = async (title: string, token: string) => {
    setBusy(true);
    const retryable = () => setToast({ kind: "deleted", title, undoToken: token, undoFailed: true });
    try {
      const answer = await api.memoryUndo(token);
      // Only a write that failed keeps the token for another try; a refused token would be refused again.
      if (!answer.ok && answer.error === "write-failed") {
        retryable();
        return;
      }
      setToast({
        kind: "message",
        text: answer.ok
          ? t("memorySaveNotice.panelRestored", { title })
          : answer.error === "changed"
            ? t("memorySaveNotice.panelNotRestored")
            : t("memorySaveNotice.panelUndoExpired"),
      });
      await refresh();
    } catch {
      retryable();
    } finally {
      setBusy(false);
    }
  };

  const handleAskAveToFix = async (note: NoteResult & { id: string }) => {
    const opened = await onAskAveToFix({
      id: note.id,
      title: note.title,
      content: note.content ? stripTopHeading(note.content) : note.excerpt,
      ...(note.projectRoot ? { projectRoot: note.projectRoot } : {}),
      ...(note.projectName ? { projectName: note.projectName } : {}),
    });
    if (!opened) setToast({ kind: "message", text: t("memorySaveNotice.askAveToFixBusy") });
  };
  if (summaries && !summaries.ok) {
    return (
      <div className="mx-auto w-full max-w-6xl" data-testid="memory-search-panel">
        <p role="alert" className="text-xs text-destructive">{t("memorySearchPanel.summaryFailed")}</p>
      </div>
    );
  }
  return (
    <div
      className="@container mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden"
      data-testid="memory-search-panel"
    >
      <p className="pb-4 text-sm text-muted-foreground">{t("memorySearchPanel.panelDescription")}</p>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <Input
          placeholder={t("memorySearchPanel.searchPlaceholder")}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOriginFilter(null); }}
          className="text-sm"
          aria-label={t("memorySearchPanel.searchAriaLabel")}
        />
        {toast ? (
          <div role="status" className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-xs" data-testid="memory-panel-toast">
            <span className="min-w-0 flex-1 truncate">
              {toast.kind === "deleted"
                ? toast.undoFailed
                  ? t("memorySaveNotice.undoFailed", { title: toast.title })
                  : t("memorySaveNotice.panelDeleted", { title: toast.title })
                : toast.text}
            </span>
            {toast.kind === "deleted" && toast.undoToken ? (
              <button
                type="button"
                className="shrink-0 font-medium hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => void handleUndoDelete(toast.title, toast.undoToken!)}
              >
                {toast.undoFailed ? t("memorySaveNotice.retry") : t("memorySaveNotice.undo")}
              </button>
            ) : null}
            <button type="button" className="shrink-0 text-muted-foreground" aria-label={t("memorySaveNotice.dismiss")} onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        ) : null}
        {summaries?.ok && (summaries.incomplete || summaries.limited) && <p role="status" className="text-xs text-muted-foreground">{t("memorySearchPanel.useIncomplete")}</p>}
        {summaries?.ok && <section className="grid grid-cols-2 gap-2 @[700px]:grid-cols-3" aria-label={t("memorySearchPanel.scopes")}>
          <button type="button" aria-pressed={scope !== "global"} className={`min-w-0 rounded-lg border p-3 text-left ${scope !== "global" ? "border-primary" : ""}`} onClick={() => { setScope(scope === "project" ? "all" : "project"); setSelectedKey(null); }}>
            <span className="flex justify-between gap-2 text-xs font-semibold"><span className="truncate">{project?.projectName ?? t("memorySearchPanel.currentProject")}</span><span>{summaries.scopeCounts.project}</span></span>
            <span className="mt-1 block text-[10px] text-muted-foreground">{t("memorySearchPanel.projectScopeDescription")}</span>
          </button>
          <button type="button" aria-pressed={scope !== "project"} className={`min-w-0 rounded-lg border p-3 text-left ${scope !== "project" ? "border-primary" : ""}`} onClick={() => { setScope(scope === "global" ? "all" : "global"); setSelectedKey(null); }}>
            <span className="flex justify-between gap-2 text-xs font-semibold"><span>{t("memorySearchPanel.global")}</span><span>{summaries.scopeCounts.global}</span></span>
            <span className="mt-1 block text-[10px] text-muted-foreground">{t("memorySearchPanel.globalScopeDescription")}</span>
          </button>
          {defaultProject && !projectRootEquals(defaultProject.projectRoot, project?.projectRoot) && <div className="min-w-0 rounded-lg border p-3 text-left text-muted-foreground">
            <span className="flex justify-between gap-2 text-xs font-semibold"><span>{t("memorySearchPanel.defaultProject")}</span><span>{summaries.scopeCounts.defaultProject}</span></span>
            <span className="mt-1 block text-[10px]">{t("memorySearchPanel.defaultScopeDescription")}</span>
            {!summaries.scopeCounts.defaultProjectApplicable && <span className="block text-[10px]">{t("memorySearchPanel.notAppliedHere")}</span>}
          </div>}
        </section>}
        {recent.length > 0 && !query.trim() ? (
          <section className="min-w-0 rounded-lg border bg-muted/(--opacity-subtle) p-3" aria-label={t("memorySaveNotice.recentTitle")} data-testid="memory-recent-strip">
            <h3 className="pb-2 text-xs font-semibold">{t("memorySaveNotice.recentTitle")} {recent.length} <span className="font-normal text-muted-foreground">{t("memorySearchPanel.recentDescription")}</span></h3>
            <ul className="space-y-1">
              {recent.map((note) => {
                const summary = note.id ? summaryById.get(note.id) : undefined;
                return <li key={note.filename}>
                  <button type="button" className="flex w-full min-w-0 items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-muted" onClick={() => selectNote(note)}>
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{note.title}</span>
                      {summary?.origin.status === "recorded" && <span className="block truncate text-[10px] text-muted-foreground">{summary.origin.title || shortSessionId(summary.origin.sessionId)}</span>}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(note.updatedAt!, RELATIVE_TIME_LABELS)}</span>
                  </button>
                </li>;
              })}
            </ul>
          </section>
        ) : null}
        <Tabs defaultValue="notes" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabsList className="w-full">
            <TabsTrigger value="notes" className="flex-1 gap-1.5">
              {t("memorySearchPanel.notesTab")}
              {noteResults.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                  {noteResults.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="sessions" className="flex-1 gap-1.5">
              {t("memorySearchPanel.sessionsTab")}
              {sessionResults.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                  {sessionResults.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="notes" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border data-[state=active]:flex data-[state=active]:flex-col">
            {noteResults.length > 0 && !loading && (
              <div className="flex items-center rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <span className="flex-1 text-xs font-semibold text-muted-foreground">{t("memorySearchPanel.notesTab")}</span>
                <div className="flex flex-wrap gap-1">
                  {(["recent", "kind", "origin"] as const).map((value) => <button key={value} type="button" aria-pressed={sort === value} onClick={() => setSort(value)} className={`rounded border px-2 py-1 text-xs ${sort === value ? "bg-background text-foreground" : "text-muted-foreground"}`}>{t(`memorySearchPanel.sort.${value}`)}</button>)}
                </div>
              </div>
            )}
            <div className="flex flex-1 min-h-0 min-w-0">
            <ScrollArea className={selected ? "h-full min-w-0 flex-1 hidden @[850px]:block" : "h-full min-w-0 flex-1"}>
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
                ) : (projectEmpty || visibleNotes.filter((note) => !note.isIndex).length === 0) && !query.trim() ? (
                  <div className="flex min-h-64 flex-col items-center justify-center gap-4 px-4 py-8 text-center">
                    <p className="max-w-md text-sm text-muted-foreground">{t("memorySearchPanel.noNotesEmpty")}</p>
                    <Button size="sm" variant="outline" disabled={busy || !onStartConversation} onClick={() => void startConversation()}>{t("memorySearchPanel.startConversation")}</Button>
                  </div>
                ) : visibleNotes.length === 0 ? <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.noResults")}</p> : (
                  <>
                  {originFilter && <Button size="sm" variant="outline" onClick={() => setOriginFilter(null)}>{t("memorySearchPanel.clearOriginFilter")}</Button>}
                  {visibleNotes.map((note, index) => {
                    const summary = note.id ? summaryById.get(note.id) : undefined;
                    return <div key={(note.filename ?? note.title) + note.updatedAt}>
                      {sort === "origin" && (index === 0 || note.origin?.sessionId !== visibleNotes[index - 1]?.origin?.sessionId) && <h3 className="pb-2 pt-3 text-xs font-medium text-muted-foreground">{summary?.origin.status === "recorded" ? summary.origin.title || shortSessionId(summary.origin.sessionId) : summary?.origin.status === "unavailable" ? t("memorySearchPanel.originUnavailable") : t("memorySearchPanel.noOrigin")}</h3>}
                      <NoteRow note={note} selected={(note.filename ?? note.title) === selectedKey} summary={summary} onSelect={() => selectNote(note)} />
                    </div>;
                  })}
                  </>
                )}
              </div>
            </ScrollArea>
            {projectEmpty && !selected && globalNotes.length > 0 && <ScrollArea className="h-full min-w-0 flex-1 border-l">
              <aside className="space-y-3 p-4" aria-label={t("memorySearchPanel.globalMemories")}>
                <h2 className="text-xs font-semibold">{t("memorySearchPanel.globalMemories")} {globalNotes.length}</h2>
                <p className="text-xs text-muted-foreground">{t("memorySearchPanel.globalMemoryExplanation")}</p>
                <ul className="space-y-2">{globalNotes.map((note) => <li key={note.filename}><NoteRow note={note} selected={false} summary={note.id ? summaryById.get(note.id) : undefined} onSelect={() => selectNote(note)} /></li>)}</ul>
                <Button size="sm" variant="ghost" onClick={() => setScope("global")}>{t("memorySearchPanel.manageGlobal")}</Button>
              </aside>
            </ScrollArea>}
            {selected && <ScrollArea className="h-full min-w-0 flex-1 border-l">
              <aside className="space-y-4 p-4" aria-label={t("memorySearchPanel.detailLabel", { title: selected.title })}>
                <Button size="sm" variant="ghost" onClick={() => setSelectedKey(null)}>{t("memorySearchPanel.backToList")}</Button>
                <div className="space-y-2">
                  <h2 className="break-words text-base font-semibold">{selected.title}</h2>
                  <p className="whitespace-pre-wrap break-words text-sm">{selected.content ? stripTopHeading(selected.content) : selected.excerpt}</p>
                  {isActionable(selected) && <div className="flex flex-wrap gap-2">
                    {selected.id && <Button size="sm" variant="outline" disabled={busy} aria-label={t("memorySaveNotice.askAveToFixAriaLabel", { title: selected.title })} onClick={() => void handleAskAveToFix({ ...selected, id: selected.id! })}>{t("memorySaveNotice.askAveToFix")}</Button>}
                    <Button size="sm" variant="outline" disabled={busy} aria-label={t("memorySaveNotice.deleteAriaLabel", { title: selected.title })} onClick={() => void handleDelete(selected)}>{t("memorySaveNotice.delete")}</Button>
                  </div>}
                </div>
                {selected.id && <MemoryDetailContent key={selected.id} detail={details[selected.id]} onOpenSession={onOpenSession} onSameOrigin={(sessionId) => { setQuery(""); setOriginFilter(sessionId); setSelectedKey(null); }} />}
              </aside>
            </ScrollArea>}
            </div>
          </TabsContent>
          <TabsContent value="sessions" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border">
            {sessionResults.length > 0 && !loading && (
              <div className="flex items-center rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("memorySearchPanel.sessionsTab")}
                </span>
              </div>
            )}
            <ScrollArea className="h-full pr-2">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
                ) : sessionResults.length === 0 ? (
                  <p className="py-4 text-xs text-muted-foreground">
                    {query === "" ? t("memorySearchPanel.noSessionsEmpty") : t("memorySearchPanel.noResults")}
                  </p>
                ) : (
                  sessionResults.map((s) => (
                    <SessionRow
                      key={s.sessionId + s.timestamp}
                      session={s}
                      onOpenSession={onOpenSession}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
