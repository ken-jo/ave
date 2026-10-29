import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalApi, TerminalSessionInfo } from "../../../shared/terminal-session.js";
import type { TerminalExecutionWarning, TerminalFileReviewSnapshot, TerminalReviewFile } from "../../../shared/terminal-file-review.js";
import { useTranslation } from "../../../i18n/react.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { consumeTerminalFileReviewRequest, observeTerminalFileReview, publishTerminalFileReview, useTerminalFileReviewState } from "../preview/terminal-file-review.js";

const REVIEW_REFRESH_MS = 1500;
const BANNER_NAMED_FILES = 2;
const ACTION_CLASS = "rounded px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const STRIP_ACTION_CLASS = "shrink-0 rounded border border-warning/(--opacity-medium) px-1.5 leading-5 text-xs hover:bg-warning/(--opacity-subtle) focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

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

/** The single banner a terminal shows: the latest command, only when it matched still-pending agent-changed
 * files. Any later command (a match or not) replaces it; the header badge keeps the pending count. */
function latestBanner(snapshot: TerminalFileReviewSnapshot, pending: readonly TerminalReviewFile[]):
  { warning: TerminalExecutionWarning; files: TerminalReviewFile[] } | null {
  if (snapshot.latestBlockId === null) return null;
  const latest = snapshot.warnings.find((warning) => warning.blockId === snapshot.latestBlockId);
  if (!latest || latest.files.length === 0) return null;
  const matched = latest.files;
  const files = pending.filter((file) => matched.includes(file.path));
  return files.length > 0 ? { warning: latest, files } : null;
}

/**
 * Review evidence is advisory; none of these actions writes to a shell. The banner is a one-line overlay on
 * the output area so it never takes rows from xterm; the pending count lives only on the terminal's header badge.
 */
export function TerminalFileReview({ terminalApi, session, revision }: {
  terminalApi: TerminalApi;
  session: TerminalSessionInfo;
  revision: number;
}) {
  const { t, locale } = useTranslation();
  const [snapshot, setSnapshot] = useState<TerminalFileReviewSnapshot>({ cwd: "", latestBlockId: null, files: [], warnings: [] });
  const [open, setOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [dismissedBlockId, setDismissedBlockId] = useState<number | null>(null);
  const [error, setError] = useState<"refreshFailed" | "staleReview" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const mountedRef = useRef(false);
  const tabReview = useTerminalFileReviewState(session.tabId);
  const pending = snapshot.files.filter((file) => !file.reviewed);
  const reviewable = pending.filter((file) => isReviewableHash(file.hash));
  const host = session.lane === "manual" && session.substrate === "host";

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
    if (host) publishTerminalFileReview(session.tabId, pending.length);
  }, [host, session.tabId, pending.length]);

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
  const candidate = latestBanner(snapshot, pending);
  const banner = candidate && candidate.warning.blockId !== dismissedBlockId ? candidate : null;
  const selected = snapshot.files.find((file) => file.path === diffPath);
  const openDiff = (path: string) => { setDiffPath(path); setOpen(true); };
  const display = (path: string) => terminalReviewDisplayPath(path, snapshot.cwd);
  const bannerNames = banner ? banner.files.map((file) => display(file.path)) : [];
  const bannerFiles = bannerNames.slice(0, BANNER_NAMED_FILES).join(", ")
    + (bannerNames.length > BANNER_NAMED_FILES ? ` +${bannerNames.length - BANNER_NAMED_FILES}` : "");

  return (
    <>
      {banner ? (
        // Right-anchored so the short, left-aligned prompt line under it (e.g. right after `clear`) stays readable.
        <div className="absolute right-0 top-0 z-10 h-8 max-w-full rounded-bl-md bg-background shadow-sm" data-testid="terminal-file-warning">
          <div className="flex h-full items-center gap-2 rounded-bl-md border-b border-l border-warning/(--opacity-muted) bg-warning/(--opacity-subtle) pl-2.5 pr-1 text-xs text-foreground" title={`$ ${banner.warning.command}\n${bannerNames.join("\n")}`}>
            <span className="min-w-0 flex-1 truncate">
              <span className="text-warning" aria-hidden="true">⚠ </span>
              {t("terminalFileReview.banner", { files: bannerFiles })}
            </span>
            <button type="button" className={STRIP_ACTION_CLASS} onClick={() => openDiff(banner.files[0]!.path)}>{t("terminalFileReview.viewChanges")}</button>
            <button type="button" className={STRIP_ACTION_CLASS} disabled={reviewing || !banner.files.some((file) => isReviewableHash(file.hash))} onClick={() => { void review(banner.files); }}>{t("terminalFileReview.review")}</button>
            <button type="button" className="shrink-0 rounded px-1 leading-5 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("terminalFileReview.dismiss")} onClick={() => setDismissedBlockId(banner.warning.blockId)}>×</button>
          </div>
        </div>
      ) : error && !open ? (
        <div role="status" className="absolute right-0 top-0 z-10 flex h-8 max-w-full items-center truncate rounded-bl-md border-b border-l border-border bg-background px-2.5 text-xs text-muted-foreground" data-testid="terminal-file-review-status">
          {t(`terminalFileReview.${error}`)}
        </div>
      ) : null}
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
