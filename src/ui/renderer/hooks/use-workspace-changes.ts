import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TurnChangeReview } from "../../../shared/turn-change-review.js";
import type { AveApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { deriveWorkspaceChanges } from "../preview/workspace-changes.js";

/** Shared by the chat summary and Files workspace; never retains review data across session or turn replacement. */
export function useWorkspaceChanges({ api, sessionId, streaming, turnKey, files, targets, workspaceRoot }: {
  api: Pick<AveApi, "chatGetTurnReview">;
  sessionId: string;
  streaming: boolean;
  turnKey: string;
  files: readonly WorkspaceFileItem[];
  targets: readonly ChatPreviewTarget[];
  workspaceRoot?: string;
}) {
  const [snapshot, setSnapshot] = useState<{ api: typeof api; sessionId: string; turnKey: string; review: TurnChangeReview } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const onRefresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!sessionId || streaming) {
      setSnapshot(null);
      setRefreshing(false);
      return;
    }
    let cancelled = false;
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
    };
  }, [api, sessionId, streaming, turnKey]);
  const review = !streaming && snapshot?.api === api && snapshot.sessionId === sessionId && snapshot.turnKey === turnKey
    ? snapshot.review : null;
  return useMemo(() => {
    // Previously disclosed counts remain steady while a file is opened again; only a fresh response enables its ranges.
    const current = review && refreshing ? { ...review, files: review.files.map((file) => ({ ...file, referenceable: false })) } : review;
    return { ...deriveWorkspaceChanges({ files, targets, workspaceRoot, review: current }), onRefresh };
  }, [files, targets, workspaceRoot, review, refreshing, onRefresh]);
}
