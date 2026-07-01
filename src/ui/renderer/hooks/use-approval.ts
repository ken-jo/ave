import { useCallback, useEffect, useRef, useState } from "react";
import { approvalQueueReducer } from "../../../lib/approval-queue-reducer.js";
import type { ApprovalChoice, ApprovalDecision, ApprovalRequest } from "../types.js";

export type ApprovalDecisionExtras = Pick<ApprovalDecision, "elicitationContent">;

/**
 * Approval queue hook.
 *
 * Owns: FIFO approval queue state (via approvalQueueReducer), the
 * window.ave.approval.onRequest subscription, and the decide handler which
 * shifts the queue before responding so the next pending request surfaces
 * immediately. Mirrors the prior behavior in App (renderer.tsx) §C4.
 */
export function useApproval() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const queueRef = useRef<ApprovalRequest[]>([]);
  // In-flight guard — prevents double-click from dropping the pending item
  // between shift() and respond(). See Copilot HIGH #2.
  const inFlightRef = useRef<boolean>(false);
  // Guard late setQueue from async `respond()` callbacks resolving after
  // unmount.
  const aliveRef = useRef(true);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    aliveRef.current = true;
    // Surface preload init bugs explicitly. The approval queue is a
    // load-bearing UX path; silently no-op'ing here when `window.ave` is
    // missing makes the bug present as "tools never resolve" instead of
    // "preload didn't run".
    if (!window.ave) {
      console.error("[use-approval] window.ave is undefined — preload missing or failed to load");
      return () => {
        aliveRef.current = false;
      };
    }
    const unsub = window.ave.approval.onRequest((req) => {
      if (!aliveRef.current) return;
      setQueue((q) => approvalQueueReducer(q, { type: "push", req }));
    });
    return () => {
      aliveRef.current = false;
      unsub();
    };
  }, []);

  /**
   * Decide the currently-pending approval request.
   *
   * On `respond()` rejection we only log — we do NOT re-push the request onto
   * the queue. The main process has likely already emitted a response (or the
   * request is no longer actionable), and re-pushing causes a double-display
   * bug where the user sees the same modal twice. See Fix 5 (PR #97).
   */
  const decide = useCallback(
    async (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => {
      if (inFlightRef.current) return;
      const current = queueRef.current[0];
      if (!current) return;
      // Assert preload availability explicitly. If the user landed on this
      // code path with no preload, the queue would never surface a request
      // anyway; reaching here means the early-return safeguard exists in two
      // places and one of them is stale.
      if (!window.ave) {
        console.error("[use-approval] decide: window.ave is undefined — preload missing");
        return;
      }
      inFlightRef.current = true;
      // shift 먼저 — respond 완료 전에 다음 항목 표시
      setQueue((q) => approvalQueueReducer(q, { type: "shift" }));
      try {
        await window.ave.approval.respond({
          requestId: current.id,
          choice,
          rememberPattern: pattern,
          // Confused-deputy defense: echo nonce + HMAC verbatim so the main process can verify
          // this response was bound to the original request (confused-
          // deputy defense). Stale or cross-wired responses fail the check
          // and are forcibly downgraded to deny-once.
          nonce: current.nonce,
          hmac: current.hmac,
          ...(extras && "elicitationContent" in extras
            ? { elicitationContent: extras.elicitationContent }
            : {}),
        });
      } catch (err) {
        // Log only — do NOT re-push. See JSDoc above.
        console.warn("[ave] approval.respond failed:", (err as Error).message);
      } finally {
        inFlightRef.current = false;
      }
    },
    [],
  );

  return { queue, decide };
}
