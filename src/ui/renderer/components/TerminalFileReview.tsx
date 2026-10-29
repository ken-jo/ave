import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalApi, TerminalSessionInfo } from "../../../shared/terminal-session.js";
import type { TerminalFileReviewSnapshot, TerminalReviewFile } from "../../../shared/terminal-file-review.js";
import { useTranslation } from "../../../i18n/react.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { consumeTerminalFileReviewRequest, observeTerminalFileReview, publishTerminalFileReview, useTerminalFileReviewState } from "../preview/terminal-file-review.js";

const REVIEW_REFRESH_MS = 1500;
const ACTION_CLASS = "rounded px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

/** Review evidence is advisory; none of these actions writes to a shell. */
export function TerminalFileReview({ terminalApi, session, revision }: {
  terminalApi: TerminalApi;
  session: TerminalSessionInfo;
  revision: number;
}) {
  const { t, locale } = useTranslation();
  const [snapshot, setSnapshot] = useState<TerminalFileReviewSnapshot>({ files: [], warnings: [] });
  const [open, setOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<"refreshFailed" | "staleReview" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const mountedRef = useRef(false);
  const tabReview = useTerminalFileReviewState(session.tabId);
  const pending = snapshot.files.filter((file) => !file.reviewed);
  const reviewable = pending.filter((file) => /^[a-f0-9]{64}$/i.test(file.hash));
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
      const result = await terminalApi.reviewFiles(session, files.filter((file) => /^[a-f0-9]{64}$/i.test(file.hash)).map(({ path, hash }) => ({ path, hash })));
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
  const warnings = snapshot.warnings.filter((warning) => !dismissed.has(warning.blockId))
    .map((warning) => ({ warning, files: pending.filter((file) => warning.files.includes(file.path)) }))
    .filter(({ warning, files }) => files.length > 0 || warning.unresolved);
  const selected = snapshot.files.find((file) => file.path === diffPath);
  const openDiff = (path: string) => { setDiffPath(path); setOpen(true); };

  return (
    <>
      {(pending.length > 0 || open || error) && <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-2 py-1" data-testid="terminal-file-review-controls">
        {error && <span role="status" className="mr-auto text-xs text-muted-foreground">{t(`terminalFileReview.${error}`)}</span>}
        <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-warning/(--opacity-medium) px-2 py-1 text-xs text-warning" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="terminal-file-review-badge">
          {pending.length > 0 && <span className="h-2 w-2 rounded-full bg-warning" aria-hidden="true" />}
          {t("terminalFileReview.pending", { count: pending.length })}
        </button>
      </div>}
      {warnings.length > 0 && <div className="min-h-0 max-h-[40%] shrink-0 overflow-y-auto" data-testid="terminal-file-warning-list">
        {warnings.map(({ warning, files }) => <div key={warning.blockId} className="shrink-0 border-b border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) px-3 py-2 text-xs" data-testid="terminal-file-warning">
          {files.length > 0 && <p className="break-words">{t("terminalFileReview.banner", { count: files.length, files: files.map((file) => file.path).join(", ") })}</p>}
          <p className="mt-1 truncate font-mono text-muted-foreground" title={warning.command}>$ {warning.command}</p>
          {warning.unresolved && <p className="mt-1 text-muted-foreground">{t("terminalFileReview.unresolved")}</p>}
          <div className="mt-1 flex items-center gap-1">
            {files.length > 0 && <button type="button" className={ACTION_CLASS} onClick={() => openDiff(files[0]!.path)}>{t("terminalFileReview.viewChanges")}</button>}
            {files.length > 0 && <button type="button" className={ACTION_CLASS} disabled={reviewing || !files.some((file) => /^[a-f0-9]{64}$/i.test(file.hash))} onClick={() => { void review(files); }}>{t("terminalFileReview.markReviewed")}</button>}
            <button type="button" className={`${ACTION_CLASS} ml-auto`} aria-label={t("terminalFileReview.dismiss")} onClick={() => setDismissed((previous) => new Set([...previous, warning.blockId]))}>×</button>
          </div>
        </div>)}
      </div>}
      {open && <aside aria-label={t("terminalFileReview.title", { count: snapshot.files.length })} className="absolute inset-y-0 right-0 z-10 flex w-full max-w-md flex-col border-l border-border bg-background shadow-lg" data-testid="terminal-file-review-panel">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h3 className="min-w-0 flex-1 text-sm font-medium">{t("terminalFileReview.title", { count: snapshot.files.length })}</h3>
          <button type="button" className={ACTION_CLASS} aria-label={t("terminalFileReview.closePanel")} onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-3">
          <p className="text-xs text-muted-foreground">{t("terminalFileReview.advisory")}</p>
          {snapshot.files.map((file) => <section key={file.path} className="rounded border border-border p-2" data-testid="terminal-file-review-row">
            <p className="break-all text-xs font-medium">{file.path}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{file.lastUsed
              ? t("terminalFileReview.used", { command: file.lastUsed.command, when: new Date(file.lastUsed.when).toLocaleString(locale) })
              : t("terminalFileReview.unused")}</p>
            {!(/^[a-f0-9]{64}$/i.test(file.hash)) && <p className="mt-1 text-xs text-muted-foreground">{t("terminalFileReview.contentUnavailable")}</p>}
            <div className="mt-1 flex gap-1">
              <button type="button" className={ACTION_CLASS} onClick={() => openDiff(file.path)}>{t("terminalFileReview.openDiff")}</button>
              <button type="button" className={ACTION_CLASS} disabled={file.reviewed || reviewing || !(/^[a-f0-9]{64}$/i.test(file.hash))} onClick={() => { void review([file]); }}>{t(file.reviewed ? "terminalFileReview.reviewed" : "terminalFileReview.review")}</button>
            </div>
          </section>)}
          {selected && <section aria-label={selected.path} data-testid="terminal-file-review-diff">
            <h4 className="mb-2 break-all text-xs font-medium">{selected.path}</h4>
            {selected.diff ? <FileEditDiff data={{ path: selected.path, tool: "edit_file", hunks: [{ oldText: selected.diff.before, newText: selected.diff.after }] }} />
              : <p className="text-xs text-muted-foreground">{t("terminalFileReview.diffUnavailable")}</p>}
          </section>}
        </div>
        <div className="border-t border-border p-2">
          <button type="button" className={ACTION_CLASS} disabled={reviewable.length === 0 || reviewing} onClick={() => { void review(reviewable); }}>{t("terminalFileReview.reviewAll")}</button>
        </div>
      </aside>}
    </>
  );
}
