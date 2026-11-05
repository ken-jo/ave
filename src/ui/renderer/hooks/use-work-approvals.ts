// Read the work-approvals projection (확인 필요) and keep it live: every source store write in main broadcasts a payload-free
// `changed`, and the hook re-lists. The first result is `loading` so callers can hide the badge and show a skeleton until it lands.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type { WorkApprovalView } from "../../../shared/work-approvals-types.js";
import { errorMessage } from "../../../shared/error-message.js";

/** Without a root, main resolves the app-managed default project. */
export type WorkApprovalsRequest = { projectRoot?: string };

export type WorkApprovalsState =
  | { status: "loading" }
  | { status: "ready"; items: WorkApprovalView[]; total: number }
  /** The projection refused or failed; `error` is the IPC error code, rendered through formatIpcError by the caller. */
  | { status: "error"; error: string };

type WorkApprovalsApi = Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;

function requestKey(request: WorkApprovalsRequest): string {
  return `project:${request.projectRoot ?? ""}`;
}

export function useWorkApprovals(api: WorkApprovalsApi, request: WorkApprovalsRequest): {
  state: WorkApprovalsState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<WorkApprovalsState>({ status: "loading" });
  const key = requestKey(request);
  const requestRef = useRef(request);
  requestRef.current = request;
  // A newer list call supersedes an older one; only the latest response is applied.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (typeof api.listWorkApprovals !== "function") {
      setState({ status: "error", error: "work-approvals-source-unavailable" });
      return;
    }
    const mine = ++generation.current;
    try {
      const result = await api.listWorkApprovals(requestRef.current);
      if (mine !== generation.current) return;
      setState(result.ok ? { status: "ready", items: result.items, total: result.total } : { status: "error", error: result.error });
    } catch (err) {
      if (mine !== generation.current) return;
      setState({ status: "error", error: errorMessage(err) });
    }
  }, [api]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
    if (typeof api.onWorkApprovalsChanged !== "function") return undefined;
    const unsubscribe = api.onWorkApprovalsChanged(() => {
      void refresh();
    });
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [api, refresh, key]);

  return { state, refresh };
}
