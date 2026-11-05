/** Keep board contracts renderer-safe. Overdue is derived on read for incomplete items past due, never persisted. */

import type {
  WorkProposal,
  WorkProposalBlocker,
  WorkProposalEvidence,
  WorkProposalInput,
  WorkProposalResult,
  WorkProposalUntrustedText,
} from "../plugins/public-contract.js";

export type {
  WorkProposal,
  WorkProposalBlocker,
  WorkProposalEvidence,
  WorkProposalInput,
  WorkProposalResult,
  WorkProposalUntrustedText,
};

export type WorkItemStatusStored = "planned" | "in_progress" | "completed";

/** Overdue is computed on every read from incomplete status and due_at. */
export type WorkItemStatusResolved =
  | "planned"
  | "in_progress"
  | "completed"
  | "overdue";

/**
 * User-assigned priority bucket. `medium` is the default for new items.
 */
export type WorkItemPriority = "high" | "medium" | "low";

/** Run lifecycle is independent of board status; absent means never run, denied means the user rejected the plan, error means planning or
 * execution failed, and cancelled means the user stopped the execution (owner decision 2026-11-04: shown as stopped, never as an error). */
export type WorkItemRunStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "denied"
  | "error"
  | "cancelled";

/** Persist ISO timestamps; unset optional fields are omitted rather than null. */
export interface WorkItem {
  id: number;
  title: string;
  detail?: string;
  status: WorkItemStatusStored;
  priority: WorkItemPriority;
  due_at?: string;
  projectRoot?: string;
  projectName?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  // Run fields are engine-written and absent until first run; user/model patches must not forge results.
  runStatus?: WorkItemRunStatus;
  plan?: string;
  output?: string;
  /** The plan child's id while awaiting approval, replaced by the execute child's `childSessionId` as soon as that child links — links the run to its isolated session for audit/trace. */
  runSessionId?: string;
  runUpdatedAt?: string;
  runId?: string;
  /** Archive prior runs in this append-only index so reruns retain transcript history. */
  runHistory?: WorkItemRunHistoryEntry[];
  /** The user's decision on this run's plan (work approval, permission-decision-tree.md "Work approvals"). Engine-written only. */
  planApproval?: WorkPlanApproval;
}

/** Longest note the user may attach to a plan decision. */
export const MAX_PLAN_NOTE_LENGTH = 2000;

export type WorkPlanApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested";

/** A plan approval is a work-level decision stored on the item, not a tool-approval card: it has no timeout and survives restart. */
export interface WorkPlanApproval {
  /** The run that produced the plan. */
  runId: string;
  /** sha256 of the stored plan, computed by the host. A decision binds to exactly this plan. */
  planHash: string;
  /** sha256 of the item's title, detail and projectRoot when the plan was made; a changed item makes the plan stale. */
  itemDigest: string;
  requestedAt: string;
  status: WorkPlanApprovalStatus;
  /** The user's note. A change request carries one; it reaches the re-plan child only as fenced non-principal guidance. */
  note?: string;
  decidedAt?: string;
  /** How many times the user asked for changes on this run. */
  revision: number;
  /** The named agent profile the run started with, so the execute phase uses the same model after the approval. */
  agentName?: string;
}

export type WorkPlanDecision = "approve" | "reject" | "request_changes";

/** What the renderer sends for a plan decision: the run and the hash of the plan it showed, never the plan text. */
export interface WorkPlanDecideInput {
  runId: string;
  planHash: string;
  decision: WorkPlanDecision;
  note?: string;
}

/** Why a plan decision was refused. not_pending: no pending approval for that run; plan_mismatch: the plan changed; plan_stale: the
 * item changed after the plan was made, so a change request must re-plan it. */
export type WorkPlanDecideRefusal =
  | "not_found"
  | "not_pending"
  | "plan_mismatch"
  | "plan_stale"
  | "already_running"
  /** The plan was just stored and its run is still closing; the decision can be sent again in a moment. */
  | "plan_settling"
  | "note_required"
  | "note_too_long"
  | "note_invalid";

export type WorkPlanDecideResult =
  | { ok: true; status: Exclude<WorkPlanApprovalStatus, "pending"> }
  | { ok: false; reason: WorkPlanDecideRefusal };

/** The decide-plan IPC adds the boundary's own refusals and the outgoing PII redaction count, as steer does. */
export type WorkPlanDecideIpcResult =
  | { ok: true; status: Exclude<WorkPlanApprovalStatus, "pending">; redactedCount?: number }
  | { ok: false; reason: WorkPlanDecideRefusal | "user-gesture-required" | "invalid-input" };

export interface WorkItemResolved extends WorkItem {
  status_resolved: WorkItemStatusResolved;
}

export interface WorkItemCreateInput {
  title: string;
  detail?: string;
  /** Omit → defaults to "medium". */
  priority?: WorkItemPriority;
  /** ISO-8601 deadline. Omit → no deadline. */
  due_at?: string;
  /** Initial stored status. Omit → "planned". */
  status?: WorkItemStatusStored;
  projectRoot?: string;
  projectName?: string;
}

/** Require at least one patch field; null clears detail or due_at. */
export interface WorkItemUpdateInput {
  title?: string;
  detail?: string | null;
  due_at?: string | null;
  priority?: WorkItemPriority;
}

export interface WorkItemListFilter {
  /** Match against `status_resolved` (so `"overdue"` is selectable). */
  status?: WorkItemStatusResolved;
  priority?: WorkItemPriority;
  due_before?: string;
  projectRoot?: string;
  /** Include legacy items without projectRoot when filtering by projectRoot. */
  includeUnscoped?: boolean;
  limit?: number;
}

// Discriminated outcomes let callers branch without parsing exception messages.

export type WorkItemListResult =
  | { status: "ok"; items: WorkItemResolved[] }
  | { status: "invalid"; reason: string };

export type WorkItemCreateResult =
  | { status: "created"; itemId: number; item: WorkItemResolved }
  | { status: "invalid"; reason: string };

export type WorkItemGetResult =
  | { status: "found"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number };

export type WorkItemUpdateResult =
  | { status: "updated"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemTransitionResult =
  | {
      status: "transitioned";
      itemId: number;
      to: WorkItemStatusStored;
      item: WorkItemResolved;
    }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemCompleteResult =
  | { status: "completed"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemReopenResult =
  | { status: "reopened"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemDeleteResult =
  | { status: "deleted"; itemId: number; reason?: string }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

// The reporter returns ok or empty; IPC adds error when model work throws.

export type WorkBoardReportKind = "daily" | "weekly";

export type WorkBoardReportResult =
  | { status: "ok"; kind: WorkBoardReportKind; period: string; markdown: string }
  | { status: "empty"; kind: WorkBoardReportKind; period: string; reason: string }
  | { status: "error"; kind: WorkBoardReportKind; reason: string };

// Briefings file reviewable proposals, never committed work items from unreviewed model output.

export type WorkBoardBriefingKind = "daily" | "weekly";

/** Reserve the dotted host ID so no installed plugin can impersonate briefing provenance. */
export const BRIEFING_PROPOSAL_SOURCE_ID = "ave.briefing";

export const BRIEFING_PROPOSAL_SOURCE_LABEL = "Briefing";

export const BRIEFING_PROPOSAL_KINDS: Record<WorkBoardBriefingKind, string> = {
  daily: "daily-briefing",
  weekly: "weekly-briefing",
};

/** Return proposal IDs for change-event fan-out; refreshed duplicates update existing cards rather than adding another. */
export type WorkBoardBriefingResult =
  | {
      status: "ok";
      kind: WorkBoardBriefingKind;
      filed: string[];
      refreshed: string[];
    }
  | { status: "empty"; kind: WorkBoardBriefingKind; reason: string }
  | { status: "error"; kind: WorkBoardBriefingKind; reason: string };

/** Emit only a pointer when due_at enters the next 24 hours; do not include item content. */
export interface WorkItemDueSoonEventPayload {
  itemId: number;
  title: string;
  notifiedAt: string;
}

export interface WorkItemChangedEventPayload {
  itemId: number;
  change:
    | "created"
    | "updated"
    | "transitioned"
    | "completed"
    | "reopened"
    | "removed";
  changedAt: string;
}

/** Transient progress is distinct from persisted mutations; planning/executing carry text, denied/error carry reasons, and done means output persisted. */
/** Engine and session lists share item-origin composition; briefing prefixes must never resolve to item origins. */
const WORK_BOARD_ORIGIN_PREFIX = "work-board:";

export function workBoardOriginSessionId(itemId: number): string {
  return `${WORK_BOARD_ORIGIN_PREFIX}${itemId}`;
}

export function parseWorkBoardOriginSessionId(origin: unknown): number | null {
  if (typeof origin !== "string" || !origin.startsWith(WORK_BOARD_ORIGIN_PREFIX)) return null;
  const rest = origin.slice(WORK_BOARD_ORIGIN_PREFIX.length);
  if (!/^[1-9][0-9]{0,15}$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) ? id : null;
}

type WorkBoardRunPhase =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "denied"
  | "done"
  | "error"
  | "cancelled";

/** Where a running work item's tool approval is answered (owner decision 2026-11-04). `chat`: the board marks the card and links to the run's
 * chat, where the normal approval card decides. `dialog`: the window's approval dialog over the board. Display location only: the same
 * request is decided once, through the same gate, in either place. */
export type WorkBoardToolApprovalSurface = "chat" | "dialog";

export interface WorkBoardSettings {
  toolApprovalSurface: WorkBoardToolApprovalSurface;
}

export function isWorkBoardToolApprovalSurface(value: unknown): value is WorkBoardToolApprovalSurface {
  return value === "chat" || value === "dialog";
}

/** One tool call inside a child turn, as the board shows it. The host derives it from the child's DLP-masked transcript: `label` is a
 * short one-line target (a file name, the head of a command, a host and path), never the call's input. */
export interface WorkBoardRunToolStep {
  toolUseId: string;
  name: string;
  kind: "read" | "write" | "shell" | "web" | "other";
  /** At most {@link WORK_BOARD_TOOL_LABEL_MAX} characters on one line; absent when the call names no target. */
  label?: string;
  status: "running" | "done" | "error" | "cancelled";
  /** 1-based turn of the phase's child the step belongs to. */
  turn: number;
  /** Epoch milliseconds the step started, while the child reports it. */
  startedAt?: number;
  durationMs?: number;
}

export const WORK_BOARD_TOOL_LABEL_MAX = 80;
/** Most tool steps one progress event carries: the latest ones of the phase. */
export const WORK_BOARD_TOOL_STEPS_MAX = 40;

/** What became of a queued steer. `delivered` names the turn of the execute child that received it; `dropped` means the child's turn ended
 * (or the join limit was reached) before a round boundary took it, so the child never saw it. */
export type WorkBoardSteerAck =
  | { messageId: string; status: "delivered"; turn: number }
  | { messageId: string; status: "dropped"; reason: "joined-limit" | "turn-ended" };

/** Transcript lines live at sessions/<itemId>/<runId>.jsonl and accumulate the run conversation. */
export interface RunTranscriptEvent {
  ts: string;
  phase: WorkBoardRunPhase;
  kind: "turn" | "plan" | "output" | "decision" | "error" | "tool";
  turn?: number;
  text?: string;
  message?: string;
  /** `kind: "tool"`: a finished tool step, written once when it leaves `running`. */
  tool?: WorkBoardRunToolStep;
}

/** Keep prior run transcript pointers on rerun instead of discarding history. */
interface WorkItemRunHistoryEntry {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: WorkItemRunStatus;
  plan?: string;
  outputPreview?: string;
}

export interface WorkBoardRunEvent {
  itemId: number;
  phase: WorkBoardRunPhase;
  /** 1-based child-agent turn number (planning / executing phases). */
  turn?: number;
  text?: string;
  /** Failure reason (error phase) or denial reason (denied phase). */
  message?: string;
  /** The phase child's session id: set on the `planning` / `executing` event fired when that phase's child links (before its first round) and on
   * the terminal `done` event. */
  runSessionId?: string;
  /** The phase's current tool steps (latest {@link WORK_BOARD_TOOL_STEPS_MAX}), sent whenever one starts or changes status. Such an event
   * carries no `turn` and is not a phase entry. */
  tools?: WorkBoardRunToolStep[];
  /** A queued steer's outcome. Such an event reports nothing else: it may arrive after the run settled (a dropped steer), so its `phase`
   * is `executing` by construction and must not be read as the run's phase. */
  steer?: WorkBoardSteerAck;
  at: string;
}

/** IPC forwards the engine event unchanged; this renderer-safe alias must remain the same wire shape. */
export type RunProgressEventPayload = WorkBoardRunEvent;

/** IPC forwards the engine result unchanged; not_found means an unknown item ID. */
export interface WorkItemRunResult {
  /** awaiting_approval: planning finished and the plan waits for the user's decision; the run resumes through decide-plan. */
  status: "completed" | "awaiting_approval" | "denied" | "not_found" | "error" | "already_running" | "cancelled";
  output?: string;
  plan?: string;
  runSessionId?: string;
  /** already_running reports the concurrent run without spawning another child. */
  reason?: string;
}

/** Steering a running execution (permission-decision-tree.md S→T): accepted means queued for the execute child's next round boundary,
 * not delivered; a steer still queued when the child's turn ends is dropped and recorded only in the audit.
 * not-executing covers every phase but a linked execute child, planning and plan approval included. The other reasons are the runner's
 * live-delivery refusals; nothing is stored for later. */
type WorkBoardSteerRefusal =
  | "not-executing"
  | "unknown-recipient"
  | "invalid-message"
  | "message-too-long"
  | "recipient-unavailable"
  | "pending-cap";

/** `ok: true` means queued for the child's next round boundary, not delivered; the outcome arrives later as a progress event whose
 * `steer.messageId` is this `messageId`. */
export type WorkBoardSteerResult = { ok: true; messageId: string } | { ok: false; reason: WorkBoardSteerRefusal };

/** Stopping a running execution; not-running means the runner had already let go of the child (it was finishing). */
export type WorkBoardCancelResult = { ok: true } | { ok: false; reason: "not-executing" | "not-running" };

/** Refusals the IPC boundary makes before the engine is asked: no consumed local keyboard gesture (never downgraded), or no such item. */
type WorkBoardControlRequestRefusal = "user-gesture-required" | "not-found";

/** `redactedCount` reports outgoing PII redaction applied to the text before it reached the child, like a chat send's notice. */
export type WorkBoardSteerIpcResult =
  | { ok: true; messageId: string; redactedCount?: number }
  | {
      ok: false;
      reason:
        | WorkBoardSteerRefusal
        | WorkBoardControlRequestRefusal
        | "empty-text"
        | "file-reference-while-running"
        | "file-reference-invalid";
    };

export type WorkBoardCancelIpcResult =
  | WorkBoardCancelResult
  | { ok: false; reason: WorkBoardControlRequestRefusal };

// Proposals are author-revocable and expire separately from user-owned work items; only user acceptance creates an item.
// Proposals carry text and identity, never plugin actions; starting one uses the host plan/approve/execute flow.

// Import the plugin public-contract shapes rather than restating them so submitted and persisted proposals stay identical.

/** Longest a declared kind id may be, and the shape it must take. */
export const PROPOSAL_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Most proposal kinds one plugin may declare — the outer bound of its ceiling. */
export const MAX_PROPOSAL_KINDS = 4;
/** Most evidence rows one proposal may carry. */
export const MAX_PROPOSAL_EVIDENCE = 6;
/** Most blocker rows one proposal may carry. */
export const MAX_PROPOSAL_BLOCKERS = 4;
/** Hard cap on stored proposals across every plugin (runaway-record defence). */
export const MAX_PROPOSALS = 64;

export const PROPOSAL_KEY_MAX = 200;
export const PROPOSAL_TITLE_MAX = 120;
export const PROPOSAL_SUMMARY_MAX = 200;
export const PROPOSAL_STATE_MAX = 400;
/** Cap on one evidence / blocker line. */
export const PROPOSAL_LINE_MAX = 200;
export const PROPOSAL_TASK_BRIEF_MAX = 2000;
export const PROPOSAL_KIND_LABEL_MAX = 60;

/** Shortest a proposal may ask to live. */
export const PROPOSAL_TTL_MIN_MS = 60 * 60 * 1000;
/** Longest a proposal may ask to live — 14 days. */
export const PROPOSAL_TTL_MAX_MS = 14 * 24 * 60 * 60 * 1000;
/** What an unstated `ttlMs` means — 7 days. */
export const PROPOSAL_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkProposalListResult =
  | { status: "ok"; proposals: WorkProposal[] }
  | { status: "invalid"; reason: string };

export type WorkProposalAcceptResult =
  | { status: "accepted"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; proposalId: string }
  | { status: "invalid"; reason: string };

export type WorkProposalDismissResult =
  | { status: "dismissed"; proposalId: string }
  | { status: "not_found"; proposalId: string };

/** Proposal changes emit pointers so renderer windows refresh without polling. */
export interface WorkProposalChangedEventPayload {
  proposalId: string;
  change: "posted" | "withdrawn" | "dismissed" | "accepted";
  changedAt: string;
}
