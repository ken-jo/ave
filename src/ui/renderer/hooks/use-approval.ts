import { useCallback, useEffect, useRef, useState } from "react";
import { approvalQueueReducer } from "../../../lib/approval-queue-reducer.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

/**
 * Phase 3.4 — approval queue hook.
 *
 * Owns: FIFO approval queue state (via approvalQueueReducer), the
 * window.ave.approval.onRequest subscription, and the decide handler which
 * shifts the queue before responding so the next pending request surfaces
 * immediately. Mirrors the prior behavior in App (renderer.tsx) §C4.
 */
export function useApproval() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const queueRef = useRef<ApprovalRequest[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (!window.ave?.approval) return;
    const unsub = window.ave.approval.onRequest((req) => {
      setQueue((q) => approvalQueueReducer(q, { type: "push", req }));
    });
    return unsub;
  }, []);

  const decide = useCallback(
    async (choice: ApprovalChoice, pattern?: string) => {
      const current = queueRef.current[0];
      if (!current) return;
      // shift 먼저 — respond 완료 전에 다음 항목 표시
      setQueue((q) => approvalQueueReducer(q, { type: "shift" }));
      if (window.ave?.approval) {
        await window.ave.approval.respond({
          requestId: current.id,
          choice,
          rememberPattern: pattern,
        });
      }
    },
    [],
  );

  return { queue, decide };
}
