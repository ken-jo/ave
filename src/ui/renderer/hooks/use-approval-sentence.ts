import { useCallback, useEffect, useRef, useState } from "react";
import { formatIpcError } from "../format-ipc-error.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

/** Intercept /allow before the message queue; it only preselects an existing approval choice and never calls decide. The
 * user must still press the granting button. */

const ALLOW_PREFIX = "/allow";

/** Cheap, local recognition. The host re-parses authoritatively. */
function isApprovalSentenceInput(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === ALLOW_PREFIX || trimmed.startsWith(`${ALLOW_PREFIX} `);
}

export interface UseApprovalSentenceOptions {
  approvalRequest: ApprovalRequest | null;
  /** Sink for the plain user-facing sentence. Never receives a grant. */
  onNotice?: (message: string) => void;
}

export function useApprovalSentence({
  approvalRequest,
  onNotice,
}: UseApprovalSentenceOptions) {
  const [proposal, setProposal] = useState<{
    requestId: string;
    choice: ApprovalChoice;
  } | null>(null);
  const requestId = approvalRequest?.id ?? null;
  // Filter during render, before passive effects run. This prevents a proposal from the previous FIFO head from reaching the
  // next card for even one commit when the acknowledged head is shifted.
  const proposedChoice = proposal?.requestId === requestId ? proposal.choice : null;
  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = requestId;

  // A proposal belongs to exactly one prompt. A new request — or the prompt being answered — drops it, so a stale proposal
  // can never pre-select a button on a request it was not about.
  useEffect(() => {
    setProposal(null);
  }, [requestId]);

  const notice = useCallback(
    (error: string) => onNotice?.(formatIpcError(error, undefined)),
    [onNotice],
  );

  /** Returns true when the input was an approval sentence and has been handled (so the caller must not also send it as a chat
   * message). */
  const interceptSubmit = useCallback(
    (text: string): boolean => {
      if (!isApprovalSentenceInput(text)) return false;
      const pendingId = requestIdRef.current;
      if (!pendingId) {
        notice("allow-no-pending-request");
        return true;
      }
      const api = window.ave?.approval;
      if (!api?.selectSentence) {
        notice("allow-selector-unavailable");
        return true;
      }
      void (async () => {
        try {
          const result = await api.selectSentence(pendingId, text.trim());
          // The prompt may have been answered or replaced while the selector was thinking. Landing a proposal on whatever is on
          // screen now would pre-select a button for a different request.
          if (requestIdRef.current !== pendingId) return;
          if (result?.ok) {
            setProposal({ requestId: pendingId, choice: result.choice });
            return;
          }
          notice(result?.error ?? "allow-selection-failed");
        } catch {
          notice("allow-selection-failed");
        }
      })();
      return true;
    },
    [notice],
  );

  return { proposedChoice, interceptSubmit };
}
