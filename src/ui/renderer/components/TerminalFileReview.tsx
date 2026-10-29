import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { TerminalApi, TerminalSessionInfo } from "../../../shared/terminal-session.js";
import type { TerminalFileReviewSnapshot } from "../../../shared/terminal-file-review.js";
import { useTranslation } from "../../../i18n/react.js";
import { FileEditDiff } from "./FileEditDiff.js";
import type { TerminalBlockAnchors } from "./terminal-block-anchors.js";
import { consumeTerminalFileReviewRequest, observeTerminalFileReview, publishTerminalFileReview, useTerminalFileReviewState } from "../preview/terminal-file-review.js";

const REVIEW_REFRESH_MS = 1500;
const ANNOTATION_NAMED_FILES = 2;
const ACTION_CLASS = "rounded px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const ANNOTATION_ACTION_CLASS = "shrink-0 text-warning hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring";
const NO_ANCHORS = { subscribe: () => () => {}, version: () => 0 };

/** Paths inside the terminal's physical cwd read as the user typed them (`Makefile`, `scripts/build.sh`). */
function terminalReviewDisplayPath(path: string, cwd: string): string {
  if (!cwd) return path;
  for (const separator of ["/", "\\"]) {
    const prefix = cwd.endsWith(separator) ? cwd : `${cwd}${separator}`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/** Names in an annotation: two, then `+N`. */
function annotationFiles(names: readonly string[]): string {
  return names.slice(0, ANNOTATION_NAMED_FILES).join(", ") + (names.length > ANNOTATION_NAMED_FILES ? ` +${names.length - ANNOTATION_NAMED_FILES}` : "");
}

/**
 * Changed-file evidence is advisory and read-only; nothing here writes to a shell or records a decision. Each
 * positively matched command gets a one-row annotation drawn as an xterm decoration on its own command row, like a
 * trailing shell comment: it scrolls with its block and never takes rows. Only the latest command's annotation offers
 * [view changes]; once another command runs it stays as dim history. The count of agent-changed files lives only on
 * the terminal's header badge.
 */
export function TerminalFileReview({ terminalApi, session, revision, anchors }: {
  terminalApi: TerminalApi;
  session: TerminalSessionInfo;
  revision: number;
  /** Where block annotations render; null until the terminal is open. */
  anchors: TerminalBlockAnchors | null;
}) {
  const { t, locale } = useTranslation();
  const [snapshot, setSnapshot] = useState<TerminalFileReviewSnapshot>({ cwd: "", latestBlockId: null, files: [], warnings: [] });
  const [open, setOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const tabReview = useTerminalFileReviewState(session.tabId);
  const host = session.lane === "manual" && session.substrate === "host";
  // Re-render when a command row gains or loses its marker (scrollback trim, `clear`).
  const subscribeAnchors = useCallback((listener: () => void) => (anchors ?? NO_ANCHORS).subscribe(listener), [anchors]);
  useSyncExternalStore(subscribeAnchors, () => (anchors ?? NO_ANCHORS).version());

  useEffect(() => {
    if (!host) return;
    const releaseObserver = observeTerminalFileReview(terminalApi, session);
    let cancelled = false;
    let running = false;
    let queued = false;
    const refresh = () => {
      if (cancelled) return;
      if (running) { queued = true; return; }
      running = true;
      void terminalApi.listFileReviews(session).then((result) => {
        if (cancelled) return;
        if (!result.ok) { setRefreshFailed(true); return; }
        setSnapshot(result.snapshot);
        setRefreshFailed(false);
      }).catch(() => { if (!cancelled) setRefreshFailed(true); }).finally(() => {
        running = false;
        if (!cancelled && queued) { queued = false; refresh(); }
      });
    };
    refreshRef.current = refresh;
    refresh();
    const timer = setInterval(refresh, REVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      releaseObserver();
      if (refreshRef.current === refresh) refreshRef.current = () => {};
    };
  }, [terminalApi, session.tabId, session.lane, session.terminalSessionId, host]);

  useEffect(() => { refreshRef.current(); }, [revision]);

  useEffect(() => {
    if (host) publishTerminalFileReview(session.tabId, snapshot.files.length, refreshFailed);
  }, [host, session.tabId, snapshot.files.length, refreshFailed]);

  useEffect(() => {
    if (!host || !tabReview?.requested) return;
    setOpen(true);
    consumeTerminalFileReviewRequest(session.tabId);
  }, [host, session.tabId, tabReview?.requested]);

  if (!host) return null;
  const selected = snapshot.files.find((file) => file.path === diffPath);
  const openDiff = (path: string) => { setDiffPath(path); setOpen(true); };
  const display = (path: string) => terminalReviewDisplayPath(path, snapshot.cwd);
  const annotations = anchors ? snapshot.warnings.flatMap((warning) => {
    // Only a concrete match is a warning; anything else never reaches the terminal, even if a snapshot carried it.
    if (warning.files.length === 0) return [];
    const container = anchors.attach(warning.blockId);
    if (!container) return [];
    const names = warning.files.map(display);
    const actionable = warning.blockId === snapshot.latestBlockId;
    return [createPortal(
      <div className={`flex h-full min-w-0 items-center gap-2 whitespace-nowrap pl-1 font-mono text-[11px] leading-none ${actionable ? "text-muted-foreground" : "text-muted-foreground/(--opacity-strong)"}`}
        title={`$ ${warning.command}\n${names.join("\n")}`}
        data-testid="terminal-file-warning" data-active={actionable ? "true" : "false"}>
        <span className="min-w-0 truncate"># <span className={actionable ? "text-warning" : undefined}>⚠</span> {t("terminalFileReview.annotation", { files: annotationFiles(names) })}</span>
        {actionable ? <button type="button" className={ANNOTATION_ACTION_CLASS} onClick={() => openDiff(warning.files[0]!)}>[{t("terminalFileReview.viewChanges")}]</button> : null}
      </div>,
      container,
      `terminal-file-warning-${warning.blockId}`,
    )];
  }) : [];

  return (
    <>
      {annotations}
      {open && <aside aria-label={t("terminalFileReview.title", { count: snapshot.files.length })} className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border bg-background shadow-lg" data-testid="terminal-file-review-panel">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{t("terminalFileReview.title", { count: snapshot.files.length })}</h3>
          <button type="button" className={ACTION_CLASS} aria-label={t("terminalFileReview.closePanel")} onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="flex-1 space-y-2 overflow-auto p-3">
          {refreshFailed && <p role="status" className="text-xs text-muted-foreground">{t("terminalFileReview.refreshFailed")}</p>}
          {snapshot.files.map((file) => <section key={file.path} className="rounded border border-border px-2 py-1.5" data-testid="terminal-file-review-row">
            <p className="break-all font-mono text-xs" title={file.path}>{display(file.path)}</p>
            <p className={`mt-0.5 break-words text-xs ${file.lastUsed ? "text-warning" : "text-muted-foreground"}`}>{file.lastUsed
              ? t("terminalFileReview.used", { command: file.lastUsed.command, when: new Date(file.lastUsed.when).toLocaleString(locale) })
              : t("terminalFileReview.unused")}</p>
            <div className="mt-1 flex gap-1">
              <button type="button" className={ACTION_CLASS} onClick={() => openDiff(file.path)}>{t("terminalFileReview.openDiff")}</button>
            </div>
          </section>)}
          {selected && <section aria-label={selected.path} data-testid="terminal-file-review-diff">
            <h4 className="mb-2 break-all font-mono text-xs">{display(selected.path)}</h4>
            {selected.diff ? <FileEditDiff data={{ path: selected.path, tool: "edit_file", hunks: [{ oldText: selected.diff.before, newText: selected.diff.after }] }} />
              : <p className="text-xs text-muted-foreground">{t("terminalFileReview.diffUnavailable")}</p>}
          </section>}
        </div>
        <div className="shrink-0 border-t border-border p-2">
          <p className="px-2 text-xs text-muted-foreground">{t("terminalFileReview.advisory")}</p>
        </div>
      </aside>}
    </>
  );
}
