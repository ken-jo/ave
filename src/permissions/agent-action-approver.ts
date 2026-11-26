import { randomUUID } from "node:crypto";
import { admitApprovalAnswer, approvalFailureKind, type ApprovalFailureKind, type ApprovalGate, type ApprovalRequestInput } from "./approval-gate.js";

// Host-built description of one non-tool mutation that needs explicit consent.
export interface AgentActionApprovalRequest {
  toolName: string;
  args: unknown;
  reason: string;
  trustOrigin: string;
}

// Redacted diagnostic identity. Raw request arguments never cross this seam.
export interface AgentActionApprovalDiagnostic {
  toolName: string;
  trustOrigin: string;
}

export interface AgentActionApprovalDiagnostics {
  onConcurrent?: (diagnostic: AgentActionApprovalDiagnostic) => void;
  onError?: (diagnostic: AgentActionApprovalDiagnostic) => void;
}

export type AgentActionApprover = (
  request: AgentActionApprovalRequest,
) => Promise<AgentActionApprovalResult>;

export type AgentActionApprovalFailure = ApprovalFailureKind | "concurrent";

export type AgentActionApprovalResult =
  | AgentActionApprovalReceipt
  | { readonly approved: false; readonly outcome: AgentActionApprovalFailure };

export interface AgentActionApprovalReceipt {
  readonly approved: true;
  // Host-generated ApprovalGate request/decision correlation identifier.
  decisionId: string;
  decidedAt: string;
}

// Build a fail-closed, single-flight ApprovalGate adapter for host mutations. The caller owns the user-facing reason and supplies only host-derived labels. Diagnostics are best-effort and receive tool/origin identity but never the possibly sensitive argument payload or raw gate error. Agent actions are host-constrained one-shot decisions: there is no exact-memory consumer on this mutation seam, so the UI must not imply that `allow-always` persists.
export function buildSingleFlightAgentActionApprover(
  approvalGate: Pick<ApprovalGate, "requestAndWait"> | undefined,
  diagnostics: AgentActionApprovalDiagnostics = {},
  options: Readonly<{ allowOnceOnly?: boolean }> = {},
): AgentActionApprover | undefined {
  if (!approvalGate) return undefined;

  let pending = false;
  return async ({ toolName, args, reason, trustOrigin }) => {
    const diagnostic: AgentActionApprovalDiagnostic = { toolName, trustOrigin };
    if (pending) {
      try {
        diagnostics.onConcurrent?.(diagnostic);
      } catch {
        // Diagnostic failures must not change the fail-closed decision.
      }
      return { approved: false, outcome: "concurrent" };
    }

    pending = true;
    try {
      // Keep the legacy option in the builder signature for call-site compatibility, but every agent action is now explicitly one-shot. A disabled, visible Always allow control explains this constraint.
      void options;
      const card = {
        id: randomUUID(),
        category: "agent-action",
        kind: "agent-action",
        allowedChoices: ["allow-once", "deny-once"] as const,
        durableApprovalRecordAllowed: false as const,
        toolName,
        toolCategory: "meta",
        args,
        reason,
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin,
      } satisfies ApprovalRequestInput;
      const decision = await approvalGate.requestAndWait(card);
      admitApprovalAnswer(decision, { requestId: card.id, toolName: card.toolName, toolUseId: undefined });
      const outcome = approvalFailureKind(decision);
      if (outcome !== undefined) return { approved: false, outcome };
      // The receipt authorizes this one action.
      return decision.choice === "allow-once"
        ? Object.freeze({ approved: true, decisionId: card.id, decidedAt: new Date().toISOString() })
        : { approved: false, outcome: "rejected" };
    } catch {
      try {
        diagnostics.onError?.(diagnostic);
      } catch {
        // Diagnostic failures must not change the fail-closed decision.
      }
      return { approved: false, outcome: "rejected" };
    } finally {
      pending = false;
    }
  };
}
