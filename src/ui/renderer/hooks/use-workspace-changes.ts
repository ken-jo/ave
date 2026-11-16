import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TurnChangeReview, TurnReviewDecision, TurnReviewError } from "../../../shared/turn-change-review.js";
import type { AveApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { deriveWorkspaceChanges } from "../preview/workspace-changes.js";

/** Shared by the chat summary and Files workspace; never retains review data across session or turn replacement. */
export function useWorkspaceChanges({ api, sessionId, streaming, turnKey, files, targets, workspaceRoot }: {
  api: Pick<AveApi, "chatGetTurnReview" | "chatDecideTurnReview">;
  sessionId: string;
  streaming: boolean;
  turnKey: string;
  files: readonly WorkspaceFileItem[];
  targets: readonly ChatPreviewTarget[];
  workspaceRoot?: string;
}) {
  const [snapshot, setSnapshot] = useState<{ api: typeof api; sessionId: string; turnKey: string; review: TurnChangeReview } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [decision, setDecision] = useState<{ pending: boolean; error: TurnReviewError | null }>({ pending: false, error: null });
  const refreshRef = useRef<() => void>(() => {});
  /** The review on screen; a decision is made on it and names its turn. */
  const shownReviewRef = useRef<TurnChangeReview | null>(null);
  /** Applies a decision for the review that is current when it is called; null outside a reviewable turn. */
  const decideRef = useRef<((decision: TurnReviewDecision) => void) | null>(null);
  const onRefresh = useCallback(() => refreshRef.current(), []);
  const onDecide = useCallback((next: TurnReviewDecision) => decideRef.current?.(next), []);
  useEffect(() => {
    setDecision({ pending: false, error: null });
    if (!sessionId || streaming) {
      setSnapshot(null);
      setRefreshing(false);
      return;
    }
    let cancelled = false;
    let deciding = false;
    const decide = (next: TurnReviewDecision) => {
      // A decision names the turn whose review is on screen; with no review shown there is nothing to decide.
      const reviewed = shownReviewRef.current;
      if (cancelled || deciding || reviewed === null || reviewed.sessionId !== sessionId) return;
      deciding = true;
      setDecision({ pending: true, error: null });
      // The host answers with the review as it is afterwards; it replaces the shown one wholesale.
      api.chatDecideTurnReview(sessionId, { ...next, turnId: reviewed.turnId }).then(
        (result) => {
          deciding = false;
          if (cancelled) return;
          if (result.ok && result.review.sessionId === sessionId) {
            setSnapshot({ api, sessionId, turnKey, review: result.review });
            setDecision({ pending: false, error: null });
            return;
          }
          setDecision({ pending: false, error: result.ok ? "turn-review-stale" : result.error });
          // A refused decision means the shown review may be out of date: ask again.
          refreshRef.current();
        },
        () => {
          deciding = false;
          if (cancelled) return;
          setDecision({ pending: false, error: "turn-review-failed" });
          refreshRef.current();
        },
      );
    };
    decideRef.current = decide;
    let running = false;
    let queued = false;
    const refresh = () => {
      if (cancelled) return;
      if (running) { queued = true; return; }
      running = true;
      setRefreshing(true);
      void Promise.resolve().then(() => cancelled ? undefined : api.chatGetTurnReview(sessionId)).then((result) => {
        if (cancelled || !result) return;
        setSnapshot(result.ok && result.review.sessionId === sessionId ? { api, sessionId, turnKey, review: result.review } : null);
      }).catch(() => { if (!cancelled) setSnapshot(null); }).finally(() => {
        running = false;
        if (cancelled) return;
        if (queued) { queued = false; refresh(); }
        else setRefreshing(false);
      });
    };
    refreshRef.current = refresh;
    refresh();
    return () => {
      cancelled = true;
      if (refreshRef.current === refresh) refreshRef.current = () => {};
      if (decideRef.current === decide) decideRef.current = null;
    };
  }, [api, sessionId, streaming, turnKey]);
  const review = !streaming && snapshot?.api === api && snapshot.sessionId === sessionId && snapshot.turnKey === turnKey
    ? snapshot.review : null;
  shownReviewRef.current = review;
  return useMemo(() => {
    // Previously disclosed counts remain steady while a file is opened again; only a fresh response enables its ranges.
    const current = review && refreshing ? { ...review, files: review.files.map((file) => ({ ...file, referenceable: false })) } : review;
    return {
      ...deriveWorkspaceChanges({ files, targets, workspaceRoot, review: current }),
      onRefresh, onDecide, deciding: decision.pending || refreshing, decisionError: decision.error,
    };
  }, [files, targets, workspaceRoot, review, refreshing, onRefresh, onDecide, decision]);
}
