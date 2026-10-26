import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FilePenLine } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { TurnChangeReview as Review, TurnHunkDecisionRequest, TurnReviewError, TurnReviewFile } from "../../../shared/turn-change-review.js";
import type { AveApi } from "../types.js";
import { formatIpcError } from "../format-ipc-error.js";
import { FileEditDiff } from "./FileEditDiff.js";

const REVIEW_HUNKS_PER_PAGE = 5;

function reviewPage(files: TurnReviewFile[], page: number): Array<TurnReviewFile & { hunkOffset: number }> {
  const start = page * REVIEW_HUNKS_PER_PAGE;
  const end = start + REVIEW_HUNKS_PER_PAGE;
  const visible: Array<TurnReviewFile & { hunkOffset: number }> = [];
  let offset = 0;
  for (const file of files) {
    const hunkOffset = Math.max(0, start - offset);
    const fileEnd = Math.min(file.hunks.length, end - offset);
    if (hunkOffset < fileEnd) visible.push({ path: file.path, hunkOffset, hunks: file.hunks.slice(hunkOffset, fileEnd) });
    offset += file.hunks.length;
    if (offset >= end) break;
  }
  return visible;
}

interface TurnChangeReviewProps {
  api: Pick<AveApi, "chatGetTurnReview" | "chatDecideTurnHunk">;
  sessionId: string;
  streaming: boolean;
}

export function TurnChangeReview({ api, sessionId, streaming }: TurnChangeReviewProps) {
  const { t } = useTranslation();
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{
    sessionId: string;
    api: TurnChangeReviewProps["api"];
    review?: Review;
    error?: TurnReviewError;
    notice?: TurnHunkDecisionRequest["decision"];
    affectedHunk?: { path: string; number: number };
  }>({ sessionId, api });
  const generation = useRef(0);
  const actionPending = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const current = useRef({ api, sessionId, streaming, open });
  current.current = { api, sessionId, streaming, open };

  useEffect(() => {
    const requestGeneration = ++generation.current;
    actionPending.current = false;
    setPage(0);
    setBusy(false);
    setState({ sessionId, api });
    if (!open || streaming || !sessionId) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const result = await api.chatGetTurnReview(sessionId);
        if (cancelled || generation.current !== requestGeneration || current.current.sessionId !== sessionId
          || current.current.api !== api || current.current.streaming || !current.current.open) return;
        if (!result.ok) setState({ sessionId, api, error: result.error });
        else if (result.review.sessionId !== sessionId) setState({ sessionId, api, error: "turn-review-stale" });
        else setState({ sessionId, api, review: result.review });
      } catch {
        if (!cancelled && generation.current === requestGeneration && current.current.sessionId === sessionId) {
          setState({ sessionId, api, error: "turn-review-failed" });
        }
      } finally {
        if (!cancelled && generation.current === requestGeneration) setBusy(false);
      }
    })();
    return () => { cancelled = true; generation.current++; };
  }, [api, sessionId, streaming, open, reload]);

  const visibleState = state.sessionId === sessionId && state.api === api && !streaming ? state : undefined;
  const review = visibleState?.review;
  const hunkCount = review?.files.reduce((count, file) => count + file.hunks.length, 0) ?? 0;
  const lastPage = Math.max(0, Math.ceil(hunkCount / REVIEW_HUNKS_PER_PAGE) - 1);
  const visiblePage = Math.min(page, lastPage);
  const visibleFiles = review ? reviewPage(review.files, visiblePage) : [];

  async function handleDecision(hunkId: string, decision: TurnHunkDecisionRequest["decision"]) {
    if (busy || actionPending.current || visibleState?.error || !review || streaming || !open || current.current.api !== api
      || current.current.streaming || !current.current.open || review.sessionId !== current.current.sessionId) return;
    if (!review.files.some((file) => file.hunks.some((hunk) => hunk.id === hunkId && hunk.decision === "pending"))) return;
    actionPending.current = true;
    setBusy(true);
    const requestGeneration = ++generation.current;
    const requestedApi = api;
    const requestedSessionId = sessionId;
    const affectedFile = review.files.find((file) => file.hunks.some((hunk) => hunk.id === hunkId))!;
    const affectedHunk = { path: affectedFile.path, number: affectedFile.hunks.findIndex((hunk) => hunk.id === hunkId) + 1 };
    let decidedReview: Review | undefined;
    const isCurrent = () => generation.current === requestGeneration
      && current.current.api === requestedApi
      && current.current.sessionId === requestedSessionId
      && !current.current.streaming
      && current.current.open;
    try {
      const result = await requestedApi.chatDecideTurnHunk({
        sessionId: review.sessionId,
        turnId: review.turnId,
        version: review.version,
        hunkId,
        decision,
      });
      if (!isCurrent()) return;
      if (!result.ok) {
        setState({ sessionId: requestedSessionId, api: requestedApi, error: result.error, affectedHunk });
        statusRef.current?.focus();
        return;
      }
      if (result.review.sessionId !== requestedSessionId) {
        setState({ sessionId: requestedSessionId, api: requestedApi, error: "turn-review-stale" });
        return;
      }
      decidedReview = result.review;
      setState({ sessionId: requestedSessionId, api: requestedApi, review: result.review, notice: decision });
      const refreshed = await requestedApi.chatGetTurnReview(requestedSessionId);
      if (!isCurrent()) return;
      if (!refreshed.ok) setState({ sessionId: requestedSessionId, api: requestedApi, review: result.review, notice: decision, error: "turn-review-failed", affectedHunk });
      else if (refreshed.review.sessionId !== requestedSessionId) setState({ sessionId: requestedSessionId, api: requestedApi, error: "turn-review-stale" });
      else setState({ sessionId: requestedSessionId, api: requestedApi, review: refreshed.review, notice: decision });
      statusRef.current?.focus();
    } catch {
      if (isCurrent()) {
        setState({ sessionId: requestedSessionId, api: requestedApi, review: decidedReview, notice: decidedReview ? decision : undefined, error: "turn-review-failed", affectedHunk });
        statusRef.current?.focus();
      }
    } finally {
      if (isCurrent()) {
        actionPending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div className="mx-3 mt-1 min-w-0 text-xs" data-testid="turn-change-review">
      <button
        type="button"
        disabled={streaming || !sessionId}
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={t("fileEditDiff.reviewTitle")}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded px-1 py-1 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
        <FilePenLine className="h-3 w-3" aria-hidden="true" />
        {t("fileEditDiff.reviewTitle")}
      </button>
      {open && (
        <section id={contentId} aria-label={t("fileEditDiff.reviewTitle")} aria-busy={busy} className="mt-1 rounded border border-border bg-background p-2">
          <div className="flex items-center gap-2 pb-2">
            <div ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="min-w-0 flex-1 text-muted-foreground">
              {streaming ? t("fileEditDiff.reviewStreaming")
                : busy ? t("fileEditDiff.loading")
                  : visibleState?.notice === "accept" ? t("fileEditDiff.reviewAcceptDone")
                    : visibleState?.notice === "reject" ? t("fileEditDiff.reviewRejectDone")
                      : t("fileEditDiff.reviewDescription")}
            </div>
            <button type="button" disabled={busy || streaming} onClick={() => setReload((value) => value + 1)} className="shrink-0 rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">
              {t("fileEditDiff.reviewReload")}
            </button>
          </div>
          {visibleState?.error && (
            <div role="alert" className="pb-2 text-destructive">
              {formatIpcError(visibleState.error, undefined)}
              {visibleState.affectedHunk && <p className="mt-1 break-words">{t("fileEditDiff.reviewHunkLabel", visibleState.affectedHunk)}</p>}
            </div>
          )}
          {review && (
            <div className="max-h-64 space-y-2 overflow-y-auto" data-testid="turn-review-files">
              {review.files.length === 0 && <p className="text-muted-foreground">{t("fileEditDiff.reviewEmpty")}</p>}
              {visibleFiles.map((file) => (
                <FileEditDiff
                  key={`${review.turnId}:${file.path}`}
                  data={{ path: file.path, tool: "edit_file", hunks: file.hunks }}
                  review={{ hunks: file.hunks, hunkOffset: file.hunkOffset, disabled: busy || streaming || !!visibleState?.error, onDecision: (hunkId, decision) => { void handleDecision(hunkId, decision); } }}
                />
              ))}
              {hunkCount > REVIEW_HUNKS_PER_PAGE && (
                <nav aria-label={t("fileEditDiff.reviewPages")} className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" disabled={busy || visiblePage === 0} onClick={() => setPage(visiblePage - 1)} className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">
                    {t("fileEditDiff.reviewPrevious")}
                  </button>
                  <span aria-live="polite" className="text-muted-foreground">{t("fileEditDiff.reviewPageRange", {
                    start: visiblePage * REVIEW_HUNKS_PER_PAGE + 1,
                    end: Math.min(hunkCount, (visiblePage + 1) * REVIEW_HUNKS_PER_PAGE),
                    count: hunkCount,
                  })}</span>
                  <button type="button" disabled={busy || visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)} className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">
                    {t("fileEditDiff.reviewNext")}
                  </button>
                </nav>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
