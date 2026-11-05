// Read the work-approvals projection (확인 필요) and keep it live: every source store write in main broadcasts a payload-free
// `changed`, and the hook re-lists. The first result is `loading` so callers can hide the badge and show a skeleton until it lands.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type { WorkApprovalProject, WorkApprovalView } from "../../../shared/work-approvals-types.js";
import { errorMessage } from "../../../shared/error-message.js";

/** One project's home (without a root, main resolves the app-managed default project), or every authorized project. */
export type WorkApprovalsRequest = { projectRoot?: string } | { allProjects: true };

export type WorkApprovalsState =
  | { status: "loading" }
  /** `requestKey` names the request this result answers, so a caller can tell a fresh list from one still showing the previous request. */
  | { status: "ready"; items: WorkApprovalView[]; total: number; projects: WorkApprovalProject[]; requestKey: string }
  /** The projection refused or failed; `error` is the IPC error code, rendered through formatIpcError by the caller. */
  | { status: "error"; error: string };

type WorkApprovalsApi = Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;

function workApprovalsRequestKey(request: WorkApprovalsRequest): string {
  return "allProjects" in request ? "all" : `project:${request.projectRoot ?? ""}`;
}

export function useWorkApprovals(api: WorkApprovalsApi, request: WorkApprovalsRequest): {
  state: WorkApprovalsState;
  refresh: () => Promise<void>;
  /** The current request's key; compare with a ready state's `requestKey`. */
  requestKey: string;
} {
  const [state, setState] = useState<WorkApprovalsState>({ status: "loading" });
  const key = workApprovalsRequestKey(request);
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
      setState(result.ok
        ? { status: "ready", items: result.items, total: result.total, projects: result.projects, requestKey: workApprovalsRequestKey(requestRef.current) }
        : { status: "error", error: result.error });
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

  return { state, refresh, requestKey: key };
}
