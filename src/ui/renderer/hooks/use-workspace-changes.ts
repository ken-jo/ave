import { useEffect, useMemo, useState } from "react";
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
  useEffect(() => {
    if (!sessionId || streaming) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    void api.chatGetTurnReview(sessionId).then((result) => {
      if (cancelled) return;
      setSnapshot(result.ok && result.review.sessionId === sessionId ? { api, sessionId, turnKey, review: result.review } : null);
    }).catch(() => { if (!cancelled) setSnapshot(null); });
    return () => { cancelled = true; };
  }, [api, sessionId, streaming, turnKey]);
  const review = !streaming && snapshot?.api === api && snapshot.sessionId === sessionId && snapshot.turnKey === turnKey
    ? snapshot.review : null;
  return useMemo(() => deriveWorkspaceChanges({ files, targets, workspaceRoot, review }), [files, targets, workspaceRoot, review]);
}
