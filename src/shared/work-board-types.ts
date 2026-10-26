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

export const MAX_ITEMS = 200;

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

/** Run lifecycle is independent of board status; absent means never run, denied means approval rejected or expired, and error means planning or execution threw. */
export type WorkItemRunStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "denied"
  | "error";

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
  /** The execute child's `childSessionId` — links the run to its isolated session for audit/trace. */
  runSessionId?: string;
  runUpdatedAt?: string;
  runId?: string;
  /** Archive prior runs in this append-only index so reruns retain transcript history. */
  runHistory?: WorkItemRunHistoryEntry[];
}

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
  | "error";

/** Transcript lines live at sessions/<itemId>/<runId>.jsonl and accumulate the run conversation. */
export interface RunTranscriptEvent {
  ts: string;
  phase: WorkBoardRunPhase;
  kind: "turn" | "plan" | "output" | "decision" | "error";
  turn?: number;
  text?: string;
  message?: string;
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
  /** The execute child's session id, set on the terminal `done` event. */
  runSessionId?: string;
  at: string;
}

/** IPC forwards the engine event unchanged; this renderer-safe alias must remain the same wire shape. */
export type RunProgressEventPayload = WorkBoardRunEvent;

/** IPC forwards the engine result unchanged; not_found means an unknown item ID. */
export interface WorkItemRunResult {
  status: "completed" | "denied" | "not_found" | "error" | "already_running";
  output?: string;
  plan?: string;
  runSessionId?: string;
  /** already_running reports the concurrent run without spawning another child. */
  reason?: string;
}

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
