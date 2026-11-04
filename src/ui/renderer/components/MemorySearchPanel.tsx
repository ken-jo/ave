import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { memoryProjectOptions, useMemorySearch, type NoteResult, type SessionResult } from "../hooks/use-memory-search.js";
import type { AveApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
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

function NoteRow({
  note,
  busy,
  onDelete,
  onAskAveToFix,
}: {
  note: NoteResult;
  busy: boolean;
  onDelete: (note: NoteResult & { filename: string }) => void;
  onAskAveToFix: (note: NoteResult) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="w-full rounded-lg border bg-background shadow-sm transition-shadow hover:shadow-md">
      <button
        type="button"
        className="group w-full px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 line-clamp-1 text-sm font-semibold leading-snug text-foreground">{note.title}</span>
          {note.updatedAt ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(note.updatedAt, RELATIVE_TIME_LABELS)}</span>
          ) : null}
        </div>
        <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-1"}`}>
          {note.excerpt}
        </p>
      </button>
      {expanded && isActionable(note) ? (
        <div className="flex justify-end gap-2 border-t px-3 py-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={t("memorySaveNotice.askAveToFixAriaLabel", { title: note.title })}
            onClick={() => onAskAveToFix(note)}
          >
            {t("memorySaveNotice.askAveToFix")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={t("memorySaveNotice.deleteAriaLabel", { title: note.title })}
            onClick={() => onDelete(note)}
          >
            {t("memorySaveNotice.delete")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SessionRow({
  session,
  onOpenSession,
}: {
  session: SessionResult;
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
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
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  /** A search to open with (a memory notice's 보기); a new nonce applies it again. */
  initialQuery?: { text: string; nonce: number } | null;
  /** Open a new chat whose composer asks Ave to fix this memory; false when it could not open. */
  onAskAveToFix: (memory: { title: string; projectRoot?: string; projectName?: string }) => Promise<boolean>;
}

/** 최근 저장: memories saved in the last week, newest first. */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 5;

type PanelToast =
  | { kind: "deleted"; title: string; undoToken?: string }
  | { kind: "message"; text: string };

export function MemorySearchPanel({ api, project, onOpenSession, initialQuery, onAskAveToFix }: MemorySearchPanelProps) {
  const { t } = useTranslation();
  const { query, setQuery, noteResults, sessionResults, loading, refresh } = useMemorySearch(api, project);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<PanelToast | null>(null);

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery.text);
    // App hands a new object per request, so the same title asked for twice still applies.
  }, [initialQuery, setQuery]);

  const recent = useMemo(() => {
    if (query !== "") return [];
    const since = Date.now() - RECENT_WINDOW_MS;
    return noteResults
      .filter((note) => isActionable(note) && note.updatedAt && Date.parse(note.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!))
      .slice(0, RECENT_LIMIT);
  }, [noteResults, query]);

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
    try {
      const answer = await api.memoryUndo(token);
      setToast({ kind: "message", text: answer.ok ? t("memorySaveNotice.panelRestored", { title }) : t("memorySaveNotice.panelNotRestored") });
      await refresh();
    } catch {
      setToast({ kind: "message", text: t("memorySaveNotice.panelNotRestored") });
    } finally {
      setBusy(false);
    }
  };

  const handleAskAveToFix = async (note: NoteResult) => {
    const opened = await onAskAveToFix({
      title: note.title,
      ...(note.projectRoot ? { projectRoot: note.projectRoot } : {}),
      ...(note.projectName ? { projectName: note.projectName } : {}),
    });
    if (!opened) setToast({ kind: "message", text: t("memorySaveNotice.askAveToFixBusy") });
  };
  return (
    <div
      className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden"
      data-testid="memory-search-panel"
    >
      <p className="pb-4 text-sm text-muted-foreground">{t("memorySearchPanel.panelDescription")}</p>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <Input
          placeholder={t("memorySearchPanel.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="text-sm"
          aria-label={t("memorySearchPanel.searchAriaLabel")}
        />
        {toast ? (
          <div role="status" className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-xs" data-testid="memory-panel-toast">
            <span className="min-w-0 flex-1 truncate">
              {toast.kind === "deleted" ? t("memorySaveNotice.panelDeleted", { title: toast.title }) : toast.text}
            </span>
            {toast.kind === "deleted" && toast.undoToken ? (
              <button
                type="button"
                className="shrink-0 font-medium hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => void handleUndoDelete(toast.title, toast.undoToken!)}
              >
                {t("memorySaveNotice.undo")}
              </button>
            ) : null}
            <button type="button" className="shrink-0 text-muted-foreground" aria-label={t("memorySaveNotice.dismiss")} onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        ) : null}
        {recent.length > 0 ? (
          <section className="min-w-0" aria-label={t("memorySaveNotice.recentTitle")} data-testid="memory-recent-strip">
            <p className="pb-1 text-xs font-semibold text-muted-foreground">{t("memorySaveNotice.recentTitle")} {recent.length}</p>
            <ul className="flex min-w-0 flex-wrap gap-1.5">
              {recent.map((note) => (
                <li key={note.filename}>
                  <button
                    type="button"
                    className="max-w-[16rem] truncate rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
                    onClick={() => setQuery(note.title)}
                  >
                    {note.title}
                  </button>
                </li>
              ))}
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
          <TabsContent value="notes" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border">
            {noteResults.length > 0 && !loading && (
              <div className="flex items-center rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("memorySearchPanel.notesTab")}
                </span>
              </div>
            )}
            <ScrollArea className="h-full pr-2">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
                ) : noteResults.length === 0 ? (
                  <p className="py-4 text-xs text-muted-foreground">
                    {query === "" ? t("memorySearchPanel.noNotesEmpty") : t("memorySearchPanel.noResults")}
                  </p>
                ) : (
                  noteResults.map((n) => (
                    <NoteRow
                      key={(n.filename ?? n.title) + n.updatedAt}
                      note={n}
                      busy={busy}
                      onDelete={(note) => void handleDelete(note)}
                      onAskAveToFix={(note) => void handleAskAveToFix(note)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
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
