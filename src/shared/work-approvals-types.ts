/**
 * Work-level decisions ("확인 필요"): a read-only projection over the stores that own each decision. Tool-execution approvals are not here; they
 * stay in the chat ApprovalDock. Views are built field by field from each record, never by spreading one, so private record fields (a routine's
 * prePrompt, a proposal's taskBrief) do not reach the renderer through this channel.
 *
 * Renderer-safe: no Node imports.
 */
import type { RoutineFailure } from "./routines-types.js";

// Scope: `project` (with whether it is the default project), `unscoped` (no project yet; accepting chooses one), or `global` (belongs to no project).

/** An authorized project, for grouping the list and choosing where an accepted proposal goes. */
export interface WorkApprovalProject {
  projectRoot: string;
  projectName: string;
  isDefault: boolean;
}

/** A work item's stored plan. `pending` waits for the user's decision and is counted; `replanning` was sent back for changes and waits for
 * the agent, so it is listed (dimmed) but never counted. */
export interface WorkPlanApprovalView {
  kind: "plan";
  key: string;
  /** A plan whose item has no project is shared by every project home. */
  scope: { type: "project"; projectRoot: string; isDefault: boolean } | { type: "unscoped" };
  title: string;
  arrivedAt: string;
  itemId: number;
  runId: string;
  /** The stored plan's hash, which the decision sends back; never a hash of the masked text below. */
  planHash: string;
  /** The plan as the agent wrote it, with secrets masked. Display only. */
  plan: string;
  /** How many times the plan was sent back for changes. */
  revision: number;
  /** Which plan this is, counting from 1: the waiting plan, or while re-planning the plan being made. Display only. */
  planNumber: number;
  agentName?: string;
  phase: "pending" | "replanning";
  /** The item changed after the plan was made, so approve would be refused as plan_stale; 수정 요청 re-plans it. */
  stale: boolean;
  /** Present while re-planning: what the user asked to change (masked). */
  changeRequest?: string;
}

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
// Only a broken configuration or an unacknowledged failed run counts; a successful or notify-only result never does.
type RoutineAttentionReason = "plugins-missing" | "invalid-plugin-id" | "run-failed";

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
  /** Present with the run-failed reason, never acknowledged; `firedAt` is what 확인함 sends back to acknowledge exactly this failure. */
  failure?: RoutineFailure;
}

export type WorkApprovalView =
  | WorkPlanApprovalView
  | WorkProposalApprovalView
  | RoutineAttentionApprovalView;

export type WorkApprovalListResult =
  | {
      ok: true;
      /** The requested project's decisions plus the unscoped and global ones, or every authorized project's in all-projects mode. */
      items: WorkApprovalView[];
      /** Every decision waiting for the user across all authorized projects, each counted once; the title-bar badge. */
      total: number;
      /** The authorized projects, default first. */
      projects: WorkApprovalProject[];
    }
  /** A source store is not wired. The projection never drops a source silently. */
  | { ok: false; error: "work-approvals-source-unavailable"; source: WorkApprovalView["kind"] }
  | { ok: false; error: "project-not-allowed" }
  | { ok: false; error: "invalid-input" };
