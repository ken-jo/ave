import { useEffect, useId, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AveApi, ApprovalRequest } from "../../types.js";
import type { WorkBoardToolApprovalSurface, WorkItemResolved } from "../../../../shared/work-board-types.js";
import { isWorkBoardToolApprovalSurface } from "../../../../shared/work-board-types.js";
import { useApprovalSurface } from "../../hooks/use-approval.js";
import type { RunStateMap } from "../../hooks/use-work-board-run.js";

/** The setting's contract default: `DEFAULT_SETTINGS.workBoard.toolApprovalSurface`. Settings normalization guarantees a stored value, so
 * this is used only before the first read answers or when it could not be made. */
const DEFAULT_TOOL_APPROVAL_SURFACE: WorkBoardToolApprovalSurface = "chat";

/** Where this board draws its runs' tool approvals, read from settings and kept current as they change. */
export function useToolApprovalSurface(api: AveApi): WorkBoardToolApprovalSurface {
  const [surface, setSurface] = useState<WorkBoardToolApprovalSurface>(DEFAULT_TOOL_APPROVAL_SURFACE);
  useEffect(() => {
    if (typeof api.getSettings !== "function") return undefined;
    let active = true;
    let receivedUpdate = false;
    const apply = (value: unknown) => {
      if (!active) return;
      if (!isWorkBoardToolApprovalSurface(value)) {
        throw new Error(`settings carried an invalid workBoard.toolApprovalSurface: ${String(value)}`);
      }
      setSurface(value);
    };
    const unsubscribe = typeof api.onSettingsUpdated === "function"
      ? api.onSettingsUpdated((settings) => {
        receivedUpdate = true;
        apply(settings.workBoard?.toolApprovalSurface);
      })
      : () => {};
    void api.getSettings().then(
      (settings) => {
        if (!receivedUpdate) apply(settings.workBoard?.toolApprovalSurface);
      },
      (err: unknown) => {
        // A failed read keeps the contract default; the card is drawn either way.
        console.warn("[work-board] could not read the tool approval setting", err);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);
  return surface;
}

export interface BoardApprovals {
  /** The requests this board draws, per item, head first. */
  byItem: ReadonlyMap<number, readonly ApprovalRequest[]>;
  /** Answer the head of `itemId`'s requests through the window's one signed decision path. */
  surface: ReturnType<typeof useApprovalSurface>;
}

/**
 * Claim the tool approvals of this board's runs. A run's children are listed sessions that no tile can open (their transcripts live in
 * the subagent store), so without a claim their cards park behind a row dot with no surface to draw them. The board claims every phase
 * child it knows of, in both approval modes; the window's routing then holds those requests off the focused pane's lane, and the board
 * draws them: in the run's step panel ("chat") or over the board ("dialog"). Only the place changes; the request, its verdict path and
 * the decision stay the window's.
 */
export function useBoardApprovals(items: readonly WorkItemResolved[], runState: RunStateMap): BoardApprovals {
  const surface = useApprovalSurface();
  const { claims, queue } = surface;
  const surfaceId = `work-board:${useId()}`;

  // Session → item, for the children of the items this board lists. The run state also holds runs of items another project's board lists
  // (progress is window-wide); claiming those would hold their cards off the lane with no card here to draw them.
  const sessionToItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      if (item.runSessionId) map.set(item.runSessionId, item.id);
      for (const id of runState[item.id]?.sessionIds ?? []) map.set(id, item.id);
    }
    return map;
  }, [items, runState]);
  const signature = [...sessionToItem.keys()].sort().join("\n");

  // Re-claim whenever the set changes: the claim's version bump re-renders the window's routing, so a request that arrived before its
  // session was known moves off the lane at once instead of being drawn twice.
  useLayoutEffect(() => {
    const owned = new Set(signature === "" ? [] : signature.split("\n"));
    return claims.claim(surfaceId, (sessionId) => owned.has(sessionId));
  }, [claims, surfaceId, signature]);

  const claimsVersion = useSyncExternalStore(claims.subscribe, claims.readVersion);
  const byItem = useMemo(() => {
    void claimsVersion;
    const map = new Map<number, ApprovalRequest[]>();
    for (const request of queue) {
      if (request.sessionId === undefined) continue;
      const itemId = sessionToItem.get(request.sessionId);
      // Another board (a second pane) may hold the claim; only the owner draws.
      if (itemId === undefined || claims.ownerOf(request.sessionId) !== surfaceId) continue;
      const list = map.get(itemId) ?? [];
      list.push(request);
      map.set(itemId, list);
    }
    return map;
  }, [queue, sessionToItem, claims, surfaceId, claimsVersion]);

  return { byItem, surface };
}
