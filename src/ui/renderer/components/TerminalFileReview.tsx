import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { TerminalApi, TerminalSessionInfo } from "../../../shared/terminal-session.js";
import type { TerminalFileReviewSnapshot, TerminalReviewFile } from "../../../shared/terminal-file-review.js";
import { useTranslation } from "../../../i18n/react.js";
import { FileEditDiff } from "./FileEditDiff.js";
import type { TerminalBlockAnchors } from "./terminal-block-anchors.js";
import { consumeTerminalFileReviewRequest, observeTerminalFileReview, publishTerminalFileReview, useTerminalFileReviewState } from "../preview/terminal-file-review.js";

const REVIEW_REFRESH_MS = 1500;
const ANNOTATION_NAMED_FILES = 2;
const ACTION_CLASS = "rounded px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const ANNOTATION_ACTION_CLASS = "shrink-0 text-warning hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-50";
const NO_ANCHORS = { subscribe: () => () => {}, version: () => 0 };

const isReviewableHash = (hash: string): boolean => /^[a-f0-9]{64}$/i.test(hash);

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
 * Review evidence is advisory; none of these actions writes to a shell. Each positively matched command gets a
 * one-row annotation drawn as an xterm decoration on its own command row, like a trailing shell comment: it scrolls
 * with its block and never takes rows. Only the latest command's annotation carries actions; once another command
 * runs it stays as dim history. The pending count lives only on the terminal's header badge.
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
  const [error, setError] = useState<"refreshFailed" | "staleReview" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const mountedRef = useRef(false);
  const tabReview = useTerminalFileReviewState(session.tabId);
  const pending = snapshot.files.filter((file) => !file.reviewed);
  const reviewable = pending.filter((file) => isReviewableHash(file.hash));
  const host = session.lane === "manual" && session.substrate === "host";
  // Re-render when a command row gains or loses its marker (scrollback trim, `clear`).
  const subscribeAnchors = useCallback((listener: () => void) => (anchors ?? NO_ANCHORS).subscribe(listener), [anchors]);
  useSyncExternalStore(subscribeAnchors, () => (anchors ?? NO_ANCHORS).version());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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
        if (!result.ok) { setError("refreshFailed"); return; }
        setSnapshot(result.snapshot);
        setError(null);
      }).catch(() => { if (!cancelled) setError("refreshFailed"); }).finally(() => {
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
    if (host) publishTerminalFileReview(session.tabId, pending.length, error === "refreshFailed");
  }, [host, session.tabId, pending.length, error]);

  useEffect(() => {
    if (!host || !tabReview?.requested) return;
    setOpen(true);
    consumeTerminalFileReviewRequest(session.tabId);
  }, [host, session.tabId, tabReview?.requested]);

  const review = useCallback(async (files: readonly TerminalReviewFile[]) => {
    setReviewing(true);
    try {
      const result = await terminalApi.reviewFiles(session, files.filter((file) => isReviewableHash(file.hash)).map(({ path, hash }) => ({ path, hash })));
      if (!mountedRef.current) return;
      if (!result.ok) setError(result.error === "stale-file-review" ? "staleReview" : "refreshFailed");
      else refreshRef.current();
    } catch {
      if (mountedRef.current) setError("refreshFailed");
    } finally {
      if (mountedRef.current) setReviewing(false);
    }
  }, [terminalApi, session.tabId, session.lane, session.terminalSessionId]);

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
    const pendingFiles = warning.blockId === snapshot.latestBlockId ? pending.filter((file) => warning.files.includes(file.path)) : [];
    const actionable = pendingFiles.length > 0;
    return [createPortal(
      <div className={`flex h-full min-w-0 items-center gap-2 whitespace-nowrap pl-1 font-mono text-[11px] leading-none ${actionable ? "text-muted-foreground" : "text-muted-foreground/(--opacity-strong)"}`}
        title={`$ ${warning.command}\n${names.join("\n")}`}
        data-testid="terminal-file-warning" data-active={actionable ? "true" : "false"}>
        <span className="min-w-0 truncate"># <span className={actionable ? "text-warning" : undefined}>⚠</span> {t("terminalFileReview.annotation", { files: annotationFiles(names) })}</span>
        {actionable ? <>
          <button type="button" className={ANNOTATION_ACTION_CLASS} onClick={() => openDiff(pendingFiles[0]!.path)}>[{t("terminalFileReview.viewChanges")}]</button>
          <button type="button" className={ANNOTATION_ACTION_CLASS} disabled={reviewing || !pendingFiles.some((file) => isReviewableHash(file.hash))} onClick={() => { void review(pendingFiles); }}>[{t("terminalFileReview.review")}]</button>
        </> : null}
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
          {error && <p role="status" className="text-xs text-muted-foreground">{t(`terminalFileReview.${error}`)}</p>}
          {snapshot.files.map((file) => <section key={file.path} className="rounded border border-border px-2 py-1.5" data-testid="terminal-file-review-row">
            <p className="break-all font-mono text-xs" title={file.path}>{display(file.path)}</p>
            <p className={`mt-0.5 break-words text-xs ${file.lastUsed ? "text-warning" : "text-muted-foreground"}`}>{file.lastUsed
              ? t("terminalFileReview.used", { command: file.lastUsed.command, when: new Date(file.lastUsed.when).toLocaleString(locale) })
              : t("terminalFileReview.unused")}</p>
            {!isReviewableHash(file.hash) && <p className="mt-0.5 text-xs text-muted-foreground">{t("terminalFileReview.contentUnavailable")}</p>}
            <div className="mt-1 flex gap-1">
              <button type="button" className={ACTION_CLASS} onClick={() => openDiff(file.path)}>{t("terminalFileReview.openDiff")}</button>
              <button type="button" className={ACTION_CLASS} disabled={file.reviewed || reviewing || !isReviewableHash(file.hash)} onClick={() => { void review([file]); }}>{t(file.reviewed ? "terminalFileReview.reviewed" : "terminalFileReview.review")}</button>
            </div>
          </section>)}
          {selected && <section aria-label={selected.path} data-testid="terminal-file-review-diff">
            <h4 className="mb-2 break-all font-mono text-xs">{display(selected.path)}</h4>
            {selected.diff ? <FileEditDiff data={{ path: selected.path, tool: "edit_file", hunks: [{ oldText: selected.diff.before, newText: selected.diff.after }] }} />
              : <p className="text-xs text-muted-foreground">{t("terminalFileReview.diffUnavailable")}</p>}
          </section>}
        </div>
        <div className="shrink-0 space-y-1 border-t border-border p-2">
          <button type="button" className={ACTION_CLASS} disabled={reviewable.length === 0 || reviewing} onClick={() => { void review(reviewable); }}>{t("terminalFileReview.reviewAll")}</button>
          <p className="px-2 text-xs text-muted-foreground">{t("terminalFileReview.advisory")}</p>
        </div>
      </aside>}
    </>
  );
}
