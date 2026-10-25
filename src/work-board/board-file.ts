/** Compute overdue on read for planned or in-progress items with past deadlines; never persist the projection. */
import { createHash } from "node:crypto";
import type {
  WorkItem,
  WorkItemCreateInput,
  WorkItemPriority,
  WorkItemStatusResolved,
  WorkProposal,
  WorkProposalBlocker,
  WorkProposalEvidence,
  WorkProposalInput,
  WorkProposalUntrustedText,
} from "../shared/work-board-types.js";
import {
  MAX_PROPOSAL_BLOCKERS,
  MAX_PROPOSAL_EVIDENCE,
  PROPOSAL_KEY_MAX,
  PROPOSAL_KIND_PATTERN,
  PROPOSAL_LINE_MAX,
  PROPOSAL_STATE_MAX,
  PROPOSAL_SUMMARY_MAX,
  PROPOSAL_TASK_BRIEF_MAX,
  PROPOSAL_TITLE_MAX,
  PROPOSAL_TTL_DEFAULT_MS,
  PROPOSAL_TTL_MAX_MS,
  PROPOSAL_TTL_MIN_MS,
} from "../shared/work-board-types.js";
import { localDayStart, utcDateKey } from "../shared/local-date.js";

export interface BoardFile {
  version: number;
  nextId: number;
  items: WorkItem[];
}

export const BOARD_VERSION = 1;

export function resolveWorkItemStatus(
  item: WorkItem,
  nowMs: number,
): WorkItemStatusResolved {
  if (
    (item.status === "planned" || item.status === "in_progress") &&
    item.due_at !== undefined &&
    Date.parse(item.due_at) < nowMs
  ) {
    return "overdue";
  }
  return item.status;
}

function explicitOffsetMinutes(iso: string): number | null {
  const match = /(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(iso);
  if (!match) return null;
  if (match[1]) return 0;
  const magnitude = Number(match[3]) * 60 + Number(match[4]);
  return match[2] === "-" ? -magnitude : magnitude;
}

/** Re-anchor only exact midnight values with explicit non-Z offsets differing from the host; preserve real times and ambiguous stamps. */
export function normalizeDueAt(dueAt: string): string {
  const offsetMinutes = explicitOffsetMinutes(dueAt);
  if (offsetMinutes === null) return dueAt;
  // Never migrate Z output again; that would make dates move between hosts.
  if (offsetMinutes === 0) return dueAt;

  const instant = new Date(dueAt);
  if (Number.isNaN(instant.getTime())) return dueAt;

  if (offsetMinutes === -instant.getTimezoneOffset()) return dueAt;

  const asWritten = new Date(instant.getTime() + offsetMinutes * 60_000);
  const isMidnightThere =
    asWritten.getUTCHours() === 0
    && asWritten.getUTCMinutes() === 0
    && asWritten.getUTCSeconds() === 0
    && asWritten.getUTCMilliseconds() === 0;
  if (!isMidnightThere) return dueAt;

  const pickedDay = utcDateKey(asWritten);
  return localDayStart(pickedDay)?.toISOString() ?? dueAt;
}

export function normalizeBoardDueDates(
  items: readonly WorkItem[],
): { items: WorkItem[]; changed: number } {
  let changed = 0;
  const next = items.map((item) => {
    if (item.due_at === undefined) return item;
    const due_at = normalizeDueAt(item.due_at);
    if (due_at === item.due_at) return item;
    changed += 1;
    return { ...item, due_at };
  });
  return { items: next, changed };
}

// Keep machine-authored revocable proposals separate from user-owned items and their capacity budget.

export const PROPOSALS_FILE = "proposals.json";

export interface ProposalsFile {
  version: number;
  proposals: WorkProposal[];
}

export const PROPOSALS_VERSION = 1;

/** Hash arbitrary plugin keys and prefix ids by plugin ownership so identifiers are safe and cross-plugin proposals stay unreachable. */
export function proposalId(pluginId: string, kind: string, key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return `${pluginId}:${kind}:${digest.slice(0, 16)}`;
}

/** Dismissal and expiry hide cards without deleting their sticky identity; reposting must not resurrect them. */
export function isLiveProposal(proposal: WorkProposal, nowMs: number): boolean {
  if (proposal.dismissedAt !== undefined) return false;
  if (proposal.acceptedItemId !== undefined) return false;
  const expiry = Date.parse(proposal.expiresAt);
  return Number.isNaN(expiry) ? false : expiry > nowMs;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/** Reject malformed fields by name; defaults would invent plugin-authored claims. */
export type NormalizedProposal =
  | {
      ok: true;
      text: WorkProposalUntrustedText;
      priority: WorkItemPriority;
      dueAt?: string;
      ttlMs: number;
    }
  | { ok: false; field: string };

const VALID_PROPOSAL_PRIORITIES: readonly WorkItemPriority[] = ["high", "medium", "low"];

/** Shape validation decides neither authorization nor capacity. */
export function normalizeProposalInput(input: WorkProposalInput): NormalizedProposal {
  if (typeof input?.kind !== "string" || !PROPOSAL_KIND_PATTERN.test(input.kind)) {
    return { ok: false, field: "kind" };
  }
  const key = boundedText(input.key, PROPOSAL_KEY_MAX);
  if (key === null || key.length !== (input.key as string).trim().length) {
    return { ok: false, field: "key" };
  }
  const title = boundedText(input.title, PROPOSAL_TITLE_MAX);
  if (title === null) return { ok: false, field: "title" };
  const summary = boundedText(input.summary, PROPOSAL_SUMMARY_MAX);
  if (summary === null) return { ok: false, field: "summary" };
  const state = boundedText(input.state, PROPOSAL_STATE_MAX);
  if (state === null) return { ok: false, field: "state" };
  const taskBrief = boundedText(input.taskBrief, PROPOSAL_TASK_BRIEF_MAX);
  if (taskBrief === null) return { ok: false, field: "taskBrief" };

  const rawEvidence = input.evidence ?? [];
  if (!Array.isArray(rawEvidence) || rawEvidence.length > MAX_PROPOSAL_EVIDENCE) {
    return { ok: false, field: "evidence" };
  }
  const evidence: WorkProposalEvidence[] = [];
  for (const row of rawEvidence) {
    const label = boundedText(row?.label, PROPOSAL_LINE_MAX);
    const detail = boundedText(row?.detail, PROPOSAL_LINE_MAX);
    if (label === null || detail === null) return { ok: false, field: "evidence" };
    evidence.push({ label, detail });
  }

  const rawBlockers = input.blockers ?? [];
  if (!Array.isArray(rawBlockers) || rawBlockers.length > MAX_PROPOSAL_BLOCKERS) {
    return { ok: false, field: "blockers" };
  }
  const blockers: WorkProposalBlocker[] = [];
  for (const row of rawBlockers) {
    const reason = boundedText(row?.reason, PROPOSAL_LINE_MAX);
    if (reason === null) return { ok: false, field: "blockers" };
    const resolution = row?.resolution === undefined
      ? undefined
      : boundedText(row.resolution, PROPOSAL_LINE_MAX);
    if (row?.resolution !== undefined && resolution === null) {
      return { ok: false, field: "blockers" };
    }
    blockers.push({ reason, ...(resolution ? { resolution } : {}) });
  }

  if (input.priority !== undefined && !VALID_PROPOSAL_PRIORITIES.includes(input.priority)) {
    return { ok: false, field: "priority" };
  }
  let dueAt: string | undefined;
  if (input.dueAt !== undefined) {
    if (typeof input.dueAt !== "string" || Number.isNaN(Date.parse(input.dueAt))) {
      return { ok: false, field: "dueAt" };
    }
    dueAt = normalizeDueAt(input.dueAt);
  }
  if (input.ttlMs !== undefined && (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs))) {
    return { ok: false, field: "ttlMs" };
  }
  const ttlMs = input.ttlMs === undefined
    ? PROPOSAL_TTL_DEFAULT_MS
    : Math.min(PROPOSAL_TTL_MAX_MS, Math.max(PROPOSAL_TTL_MIN_MS, input.ttlMs));

  return {
    ok: true,
    text: { title, summary, state, evidence, blockers, taskBrief },
    priority: input.priority ?? "medium",
    ...(dueAt !== undefined ? { dueAt } : {}),
    ttlMs,
  };
}

/** Keep dismissal and accepted-item identity sticky across both plugin reposts and host briefing refreshes. */
export function composeProposal(args: {
  id: string;
  kind: string;
  key: string;
  pluginId: string;
  pluginLabel: string;
  normalized: Extract<NormalizedProposal, { ok: true }>;
  nowMs: number;
  prior?: WorkProposal;
}): WorkProposal {
  const { id, kind, key, pluginId, pluginLabel, normalized, nowMs, prior } = args;
  const iso = new Date(nowMs).toISOString();
  return {
    id,
    kind,
    key,
    pluginId,
    pluginLabel,
    ...normalized.text,
    priority: normalized.priority,
    ...(normalized.dueAt !== undefined ? { dueAt: normalized.dueAt } : {}),
    createdAt: prior?.createdAt ?? iso,
    updatedAt: iso,
    expiresAt: new Date(nowMs + normalized.ttlMs).toISOString(),
    ...(prior?.dismissedAt !== undefined ? { dismissedAt: prior.dismissedAt } : {}),
    ...(prior?.acceptedItemId !== undefined ? { acceptedItemId: prior.acceptedItemId } : {}),
  };
}

/** The host formats accepted detail from state, evidence, and blockers; taskBrief is run instruction, never display text. */
export function proposalToWorkItemInput(
  proposal: WorkProposal,
  project?: { projectRoot?: string; projectName?: string },
): WorkItemCreateInput {
  const sections: string[] = [proposal.summary, "", proposal.state];
  if (proposal.evidence.length > 0) {
    sections.push("", ...proposal.evidence.map((e) => `- ${e.label}: ${e.detail}`));
  }
  if (proposal.blockers.length > 0) {
    sections.push(
      "",
      ...proposal.blockers.map((b) =>
        b.resolution ? `- ${b.reason} → ${b.resolution}` : `- ${b.reason}`,
      ),
    );
  }
  return {
    title: proposal.title,
    detail: sections.join("\n"),
    priority: proposal.priority,
    ...(proposal.dueAt !== undefined ? { due_at: proposal.dueAt } : {}),
    ...(project?.projectRoot ? { projectRoot: project.projectRoot } : {}),
    ...(project?.projectName ? { projectName: project.projectName } : {}),
  };
}
