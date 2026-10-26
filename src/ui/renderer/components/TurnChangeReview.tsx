import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FilePenLine } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { TurnChangeReview as Review, TurnReviewError, TurnReviewFile } from "../../../shared/turn-change-review.js";
import type { AveApi } from "../types.js";
import { formatIpcError } from "../format-ipc-error.js";
import { FileEditDiff } from "./FileEditDiff.js";
import type { FileMentionReference } from "../../../shared/file-mention-reference.js";
import { chatSurface } from "./chat-surface.js";

const REVIEW_HUNKS_PER_PAGE = 5;

function reviewPage(files: TurnReviewFile[], page: number): Array<TurnReviewFile & { hunkOffset: number }> {
  const start = page * REVIEW_HUNKS_PER_PAGE;
  const end = start + REVIEW_HUNKS_PER_PAGE;
  const visible: Array<TurnReviewFile & { hunkOffset: number }> = [];
  let offset = 0;
  for (const file of files) {
    const hunkOffset = Math.max(0, start - offset);
    const fileEnd = Math.min(file.hunks.length, end - offset);
    if (hunkOffset < fileEnd) visible.push({ ...file, hunkOffset, hunks: file.hunks.slice(hunkOffset, fileEnd) });
    offset += file.hunks.length;
    if (offset >= end) break;
  }
  return visible;
}

interface TurnChangeReviewProps {
  api: Pick<AveApi, "chatGetTurnReview">;
  sessionId: string;
  streaming: boolean;
  onReference?: (reference: FileMentionReference) => void;
}

export function TurnChangeReview({ api, sessionId, streaming, onReference }: TurnChangeReviewProps) {
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
  }>({ sessionId, api });
  const generation = useRef(0);
  const current = useRef({ api, sessionId, streaming, open });
  current.current = { api, sessionId, streaming, open };

  useEffect(() => {
    const requestGeneration = ++generation.current;
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

  return (
    <div className={`${chatSurface({ edge: "quiet", elevation: "flat" })} mb-2 flex max-h-[min(15rem,32vh)] min-w-0 flex-col overflow-hidden text-xs`} data-testid="turn-change-review">
      <button
        type="button"
        disabled={streaming || !sessionId}
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={t("fileEditDiff.reviewTitle")}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full shrink-0 items-center gap-1 rounded-xl px-3 py-2 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
        <FilePenLine className="h-3 w-3" aria-hidden="true" />
        {t("fileEditDiff.reviewTitle")}
      </button>
      {open && (
        <section id={contentId} aria-label={t("fileEditDiff.reviewTitle")} aria-busy={busy} className="flex max-h-[min(15rem,32vh)] min-h-0 flex-col border-t border-border-subtle p-2">
          <div className="flex shrink-0 items-center gap-2 pb-2">
            <div role="status" aria-live="polite" className="min-w-0 flex-1 text-muted-foreground">
              {streaming ? t("fileEditDiff.reviewStreaming")
                : busy ? t("fileEditDiff.loading")
                  : t("fileEditDiff.reviewDescription")}
            </div>
            <button type="button" disabled={busy || streaming} onClick={() => setReload((value) => value + 1)} className="shrink-0 rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">
              {t("fileEditDiff.reviewReload")}
            </button>
          </div>
          {visibleState?.error && (
            <div role="alert" className="pb-2 text-destructive">
              {formatIpcError(visibleState.error, undefined)}
            </div>
          )}
          {review && (
            <div className="min-h-0 space-y-2 overflow-y-auto overscroll-contain" data-testid="turn-review-files">
              {review.files.length === 0 && <p className="text-muted-foreground">{t("fileEditDiff.reviewEmpty")}</p>}
              {visibleFiles.map((file) => (
                <div key={`${review.turnId}:${file.path}`}>
                  <FileEditDiff
                    data={{ path: file.path, tool: "edit_file", hunks: file.hunks }}
                    review={{
                      hunks: file.hunks,
                      hunkOffset: file.hunkOffset,
                      disabled: busy || streaming || !!visibleState?.error,
                      turnId: review.turnId,
                      lineCount: file.lineCount,
                      referenceable: file.referenceable,
                      onReference,
                    }}
                  />
                  {!file.referenceable && (
                    <p className="px-2 py-1 text-muted-foreground">{t("fileEditDiff.reviewNotReferenceable")}</p>
                  )}
                </div>
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
