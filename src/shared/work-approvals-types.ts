/**
 * Work-level decisions ("확인 필요"): a read-only projection over the stores that own each decision. Tool-execution approvals are not here; they
 * stay in the chat ApprovalDock. Views are built field by field from each record, never by spreading one, so private record fields (a routine's
 * prePrompt, a proposal's taskBrief) do not reach the renderer through this channel.
 *
 * Renderer-safe: no Node imports.
 */

// Scope: `project` (with whether it is the default project), `unscoped` (no project yet; accepting chooses one), or `global` (belongs to no project).

/** A plugin or briefing proposal the user can add to a project or dismiss. */
export interface WorkProposalApprovalView {
  kind: "proposal";
  key: string;
  scope: { type: "unscoped" };
  title: string;
  arrivedAt: string;
  proposalId: string;
  summary: string;
  pluginLabel: string;
  priority: "high" | "medium" | "low";
  expiresAt: string;
  /** The card's expandable detail: what the plugin observed. Display text only; never the run's taskBrief. */
  state: string;
  evidence: Array<{ label: string; detail: string }>;
  blockers: Array<{ reason: string; resolution?: string }>;
}

/** Why a routine needs the user. One routine yields one view carrying every reason that applies. */
// Only a broken configuration (or, with routine failure persistence, a failed run) counts; a successful or notify-only result never does.
type RoutineAttentionReason = "plugins-missing" | "invalid-plugin-id";

export interface RoutineAttentionApprovalView {
  kind: "routine-attention";
  key: string;
  scope: { type: "global" };
  title: string;
  /** Null for a held-back invalid routine, whose stored record is not trusted for a timestamp. */
  arrivedAt: string | null;
  routineId: string;
  reasons: RoutineAttentionReason[];
  /** Present with the plugins-missing reason. */
  missingPluginIds?: string[];
}

export type WorkApprovalView =
  | WorkProposalApprovalView
  | RoutineAttentionApprovalView;

export type WorkApprovalListResult =
  | {
      ok: true;
      /** The requested project's decisions plus the unscoped and global ones. */
      items: WorkApprovalView[];
      /** Every decision across all authorized projects, each counted once; the title-bar badge. */
      total: number;
    }
  /** A source store is not wired. The projection never drops a source silently. */
  | { ok: false; error: "work-approvals-source-unavailable"; source: WorkApprovalView["kind"] }
  | { ok: false; error: "project-not-allowed" }
  | { ok: false; error: "invalid-input" };
