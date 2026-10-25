// Serialize mutations within this process only and append activity for report reconstruction. IPC owns change broadcasts; compute overdue on read rather
// than persisting or duplicating that projection in consumers.
import { join, dirname } from "node:path";
import { createLogger } from "../lib/logger.js";
import {
  openFeatureNamespace,
  readJsonFileOrEmpty,
  writeFileAtomicAtPath,
} from "./storage/feature-namespace.js";
import { createDirStorage, type WorkBoardStorage } from "../work-board/storage.js";
import {
  BOARD_VERSION,
  PROPOSALS_FILE,
  PROPOSALS_VERSION,
  composeProposal,
  isLiveProposal,
  normalizeBoardDueDates,
  normalizeProposalInput,
  proposalId,
  proposalToWorkItemInput,
  resolveWorkItemStatus,
  type BoardFile,
  type ProposalsFile,
} from "../work-board/board-file.js";
import { appendActivity } from "../work-board/activity-log.js";
import { projectRootEquals } from "../shared/project-identity.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";

const log = createLogger("ave");

// Re-export the shared type boundary so callers that import from work-board-store continue to work unchanged, while the renderer imports from shared/ (no Node built-ins).
export {
  MAX_ITEMS,
  type WorkItemStatusStored,
  type WorkItemRunStatus,
  type WorkItemResolved,
  type WorkItemCreateInput,
  type WorkItemUpdateInput,
  type WorkItemListFilter,
  type WorkItemListResult,
  type WorkItemCreateResult,
  type WorkItemGetResult,
  type WorkItemUpdateResult,
  type WorkItemTransitionResult,
  type WorkItemCompleteResult,
  type WorkItemReopenResult,
  type WorkItemDeleteResult,
  type WorkItemChangedEventPayload,
  type WorkProposalChangedEventPayload,
} from "../shared/work-board-types.js";

import {
  MAX_ITEMS,
  type WorkItem,
  type WorkItemResolved,
  type WorkItemStatusStored,
  type WorkItemPriority,
  type WorkItemRunStatus,
  type WorkItemCreateInput,
  type WorkItemUpdateInput,
  type WorkItemListFilter,
  type WorkItemListResult,
  type WorkItemCreateResult,
  type WorkItemGetResult,
  type WorkItemUpdateResult,
  type WorkItemTransitionResult,
  type WorkItemCompleteResult,
  type WorkItemReopenResult,
  type WorkItemDeleteResult,
  type WorkProposal,
  type WorkProposalAcceptResult,
  type WorkProposalDismissResult,
  type WorkProposalInput,
  type WorkProposalListResult,
  type WorkProposalResult,
  BRIEFING_PROPOSAL_SOURCE_ID,
  BRIEFING_PROPOSAL_SOURCE_LABEL,
  MAX_PROPOSALS,
} from "../shared/work-board-types.js";

// Max title length (defensive bound against runaway records).
const MAX_TITLE_LENGTH = 512;
// Max detail length.
const MAX_DETAIL_LENGTH = 8192;
const MAX_PROJECT_ROOT_LENGTH = 2048;
const MAX_PROJECT_NAME_LENGTH = 120;

// Resolved through the feature-namespace helper so `~/.ave/work-board/` stays the single source of truth for the board file location.
const defaultPath = (): string => join(openFeatureNamespace("work-board").dir, "board.json");

const VALID_STATUSES: readonly WorkItemStatusStored[] = [
  "planned",
  "in_progress",
  "completed",
];
const VALID_PRIORITIES: readonly WorkItemPriority[] = ["high", "medium", "low"];

// Max run-history entries kept per item (oldest evicted from the index — the on-disk transcripts themselves are never deleted here).
const RUN_HISTORY_CAP = 20;
// Run statuses that CLOSE a run, stamping `endedAt` on its history entry.
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkItemRunStatus> = new Set([
  "completed",
  "denied",
  "error",
]);
// Cap on the inline output preview stored in a run-history entry.
const RUN_OUTPUT_PREVIEW_CHARS = 280;
const VALID_RUN_STATUSES: readonly WorkItemRunStatus[] = [
  "idle",
  "planning",
  "awaiting_approval",
  "executing",
  "completed",
  "denied",
  "error",
];

function isStatus(v: unknown): v is WorkItemStatusStored {
  return typeof v === "string" && VALID_STATUSES.includes(v as WorkItemStatusStored);
}
function isPriority(v: unknown): v is WorkItemPriority {
  return typeof v === "string" && VALID_PRIORITIES.includes(v as WorkItemPriority);
}
function isRunStatus(v: unknown): v is WorkItemRunStatus {
  return typeof v === "string" && VALID_RUN_STATUSES.includes(v as WorkItemRunStatus);
}

function normalizeOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

// Reject corrupted disk records before they can poison list or report reads.
function isValidRecord(r: unknown): r is WorkItem {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (typeof x.id !== "number" || !Number.isInteger(x.id) || x.id < 1) return false;
  if (typeof x.title !== "string" || x.title.length === 0) return false;
  if (x.detail !== undefined && typeof x.detail !== "string") return false;
  if (!isStatus(x.status)) return false;
  if (!isPriority(x.priority)) return false;
  if (x.due_at !== undefined && typeof x.due_at !== "string") return false;
  if (x.projectRoot !== undefined && typeof x.projectRoot !== "string") return false;
  if (x.projectName !== undefined && typeof x.projectName !== "string") return false;
  if (typeof x.created_at !== "string") return false;
  if (typeof x.updated_at !== "string") return false;
  if (x.completed_at !== undefined && typeof x.completed_at !== "string") return false;
  // Agent-orchestration run fields — all optional (absent on pre-P2 rows).
  if (x.runStatus !== undefined && !isRunStatus(x.runStatus)) return false;
  if (x.plan !== undefined && typeof x.plan !== "string") return false;
  if (x.output !== undefined && typeof x.output !== "string") return false;
  if (x.runSessionId !== undefined && typeof x.runSessionId !== "string") return false;
  if (x.runUpdatedAt !== undefined && typeof x.runUpdatedAt !== "string") return false;
  return true;
}

// Drop malformed disk rows without poisoning the whole read; content caps belong to intake rather than a second drifting definition.
function isValidProposal(r: unknown): r is WorkProposal {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  for (const field of ["id", "kind", "key", "pluginId", "pluginLabel", "title", "summary", "state", "taskBrief", "createdAt", "updatedAt", "expiresAt"]) {
    if (typeof x[field] !== "string" || (x[field] as string).length === 0) return false;
  }
  if (!isPriority(x.priority)) return false;
  if (!Array.isArray(x.evidence) || !Array.isArray(x.blockers)) return false;
  if (x.dueAt !== undefined && typeof x.dueAt !== "string") return false;
  if (x.dismissedAt !== undefined && typeof x.dismissedAt !== "string") return false;
  if (x.acceptedItemId !== undefined && typeof x.acceptedItemId !== "number") return false;
  return true;
}

function emptyBoard(): BoardFile {
  return { version: BOARD_VERSION, nextId: 1, items: [] };
}

// Back up corrupt JSON and seed empty; filter invalid rows and repair nextId above every surviving ID.
function readFileOrEmpty(filePath: string): Promise<BoardFile> {
  return readJsonFileOrEmpty(filePath, emptyBoard, (parsed) => {
    const file = parsed as BoardFile;
    if (!Array.isArray(file.items)) {
      return emptyBoard();
    }
    const valid = file.items.filter(isValidRecord);
    // One-time re-anchoring of due dates stamped as midnight in a fixed zone, back when the board was KST-anchored. Idempotent by its own rule, so it runs
    // on every load and converges; nothing marks it done.
    const { items, changed } = normalizeBoardDueDates(valid);
    if (changed > 0) {
      log.info(
        { event: "work-board-due-at-localized", changed, total: items.length },
        "[work-board-store] re-anchored due dates stamped as midnight in another zone",
      );
    }
    const maxId = items.reduce((m, it) => Math.max(m, it.id), 0);
    const nextId =
      typeof file.nextId === "number" && Number.isInteger(file.nextId) && file.nextId > maxId
        ? file.nextId
        : maxId + 1;
    return {
      version: BOARD_VERSION,
      nextId,
      items,
    };
  });
}

async function writeFileAtomic(filePath: string, data: BoardFile): Promise<void> {
  // Delegates the 0o700-dir / 0o600-file / tmpfile+rename contract to the feature-namespace SOT helper. The injectable `filePath` (tests pass a temp path)
  // is preserved — the helper enforces the permission boundary on whatever parent directory the path resolves to.
  await writeFileAtomicAtPath(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

// Deep clone a WorkItem so callers cannot mutate shared cache refs.
function cloneItem(it: WorkItem): WorkItem {
  return { ...it };
}

function decorate(item: WorkItem, nowMs: number): WorkItemResolved {
  return { ...item, status_resolved: resolveWorkItemStatus(item, nowMs) };
}

// Transient run phases share run-planned; terminal activity verbs record outcomes.
function runStatusActivityKind(
  runStatus: WorkItemRunStatus,
): "run-planned" | "run-executed" | "run-denied" | "run-failed" {
  switch (runStatus) {
    case "completed":
      return "run-executed";
    case "denied":
      return "run-denied";
    case "error":
      return "run-failed";
    default:
      return "run-planned";
  }
}

export class WorkBoardStore {
  private cache: BoardFile = emptyBoard();
  private loaded = false;
  private readonly filePath: string;
  // Activity-log storage rooted in the same directory as `board.json`.
  private readonly activity: WorkBoardStorage;
  private readonly now: () => number;

  /**
   * @param filePath absolute path to `board.json`. Defaults to the
   *   `~/.ave/work-board/board.json` namespace path; tests inject a temp path.
   * @param now injectable clock for deterministic overdue/timestamp tests.
   */
  constructor(filePath: string = defaultPath(), now: () => number = () => Date.now()) {
    this.filePath = filePath;
    this.activity = createDirStorage(dirname(filePath));
    this.now = now;
  }

  async load(): Promise<void> {
    this.cache = await readFileOrEmpty(this.filePath);
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  // List items, newest-id first, with `status_resolved` computed + filter applied.
  async list(filter: WorkItemListFilter = {}): Promise<WorkItemListResult> {
    await this.ensureLoaded();
    if (filter.limit !== undefined && (!Number.isFinite(filter.limit) || filter.limit < 0)) {
      return { status: "invalid", reason: "limit must be a non-negative number" };
    }
    const projectRoot = normalizeOptionalString(filter.projectRoot, MAX_PROJECT_ROOT_LENGTH);
    const nowMs = this.now();
    let rows = this.cache.items
      .map((item) => decorate(cloneItem(item), nowMs))
      .sort((a, b) => b.id - a.id);
    if (projectRoot) {
      rows = rows.filter((r) => projectRootEquals(r.projectRoot, projectRoot) || (filter.includeUnscoped === true && !r.projectRoot));
    }
    if (filter.status) {
      rows = rows.filter((r) => r.status_resolved === filter.status);
    }
    if (filter.priority) {
      rows = rows.filter((r) => r.priority === filter.priority);
    }
    if (filter.due_before) {
      const cutoff = Date.parse(filter.due_before);
      if (Number.isNaN(cutoff)) {
        return { status: "invalid", reason: "due_before is not a valid ISO timestamp" };
      }
      rows = rows.filter(
        (r) => r.due_at !== undefined && Date.parse(r.due_at) <= cutoff,
      );
    }
    if (filter.limit !== undefined) {
      rows = rows.slice(0, filter.limit);
    }
    return { status: "ok", items: rows };
  }

  // Fetch one item by id.
  async get(id: number): Promise<WorkItemGetResult> {
    await this.ensureLoaded();
    const item = this.cache.items.find((i) => i.id === id);
    if (!item) return { status: "not_found", itemId: id };
    return { status: "found", itemId: id, item: decorate(cloneItem(item), this.now()) };
  }

  async create(input: WorkItemCreateInput): Promise<WorkItemCreateResult> {
    await this.ensureLoaded();
    const title = (input.title ?? "").trim();
    if (!title) {
      return { status: "invalid", reason: "title is required and must be non-empty" };
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return { status: "invalid", reason: `title exceeds ${MAX_TITLE_LENGTH} chars` };
    }
    if (input.detail !== undefined && input.detail.length > MAX_DETAIL_LENGTH) {
      return { status: "invalid", reason: `detail exceeds ${MAX_DETAIL_LENGTH} chars` };
    }
    if (input.status !== undefined && !isStatus(input.status)) {
      return { status: "invalid", reason: `invalid status: ${String(input.status)}` };
    }
    if (input.priority !== undefined && !isPriority(input.priority)) {
      return { status: "invalid", reason: `invalid priority: ${String(input.priority)}` };
    }
    if (input.due_at !== undefined && Number.isNaN(Date.parse(input.due_at))) {
      return { status: "invalid", reason: "due_at is not a valid ISO timestamp" };
    }
    const projectRoot = normalizeOptionalString(input.projectRoot, MAX_PROJECT_ROOT_LENGTH);
    const projectName = normalizeOptionalString(input.projectName, MAX_PROJECT_NAME_LENGTH);

    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      if (board.items.length >= MAX_ITEMS) {
        return {
          status: "invalid" as const,
          reason: `item cap reached (${MAX_ITEMS}); complete or remove old items first`,
        };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const status: WorkItemStatusStored = input.status ?? "planned";
      const item: WorkItem = {
        id: board.nextId,
        title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        status,
        priority: input.priority ?? "medium",
        ...(input.due_at !== undefined ? { due_at: input.due_at } : {}),
        ...(projectRoot ? { projectRoot } : {}),
        ...(projectName ? { projectName } : {}),
        created_at: iso,
        updated_at: iso,
        ...(status === "completed" ? { completed_at: iso } : {}),
      };
      board.nextId += 1;
      board.items.push(item);
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "created",
        itemId: item.id,
        title: item.title,
        ts: iso,
      });
      return {
        status: "created" as const,
        itemId: item.id,
        item: decorate(cloneItem(item), nowMs),
      };
    });
  }

  // Apply a partial update to a single item.
  async update(id: number, patch: WorkItemUpdateInput): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    const keys = Object.keys(patch ?? {}) as (keyof WorkItemUpdateInput)[];
    if (keys.length === 0) {
      return {
        status: "invalid",
        itemId: id,
        reason: "at least one of title / detail / due_at / priority must be provided",
      };
    }
    if (typeof patch.title === "string" && patch.title.trim().length === 0) {
      return { status: "invalid", itemId: id, reason: "title cannot be empty — omit the field instead" };
    }
    if (typeof patch.title === "string" && patch.title.trim().length > MAX_TITLE_LENGTH) {
      return { status: "invalid", itemId: id, reason: `title exceeds ${MAX_TITLE_LENGTH} chars` };
    }
    if (typeof patch.detail === "string" && patch.detail.length > MAX_DETAIL_LENGTH) {
      return { status: "invalid", itemId: id, reason: `detail exceeds ${MAX_DETAIL_LENGTH} chars` };
    }
    if (patch.priority !== undefined && !isPriority(patch.priority)) {
      return { status: "invalid", itemId: id, reason: `invalid priority: ${String(patch.priority)}` };
    }
    if (typeof patch.due_at === "string" && Number.isNaN(Date.parse(patch.due_at))) {
      return { status: "invalid", itemId: id, reason: "due_at is not a valid ISO timestamp" };
    }

    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const updated: WorkItem = { ...board.items[idx] };
      if (typeof patch.title === "string") updated.title = patch.title.trim();
      if ("detail" in patch) {
        if (patch.detail === null) delete updated.detail;
        else if (patch.detail !== undefined) updated.detail = patch.detail;
      }
      if ("due_at" in patch) {
        if (patch.due_at === null) delete updated.due_at;
        else if (patch.due_at !== undefined) updated.due_at = patch.due_at;
      }
      if (patch.priority !== undefined) updated.priority = patch.priority;
      const nowMs = this.now();
      updated.updated_at = new Date(nowMs).toISOString();
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "updated",
        itemId: updated.id,
        title: updated.title,
        ts: updated.updated_at,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  // Write exactly one activity row inside the lock; complete/reopen wrappers supply their domain verb without a second append.
  async transition(
    id: number,
    to: WorkItemStatusStored,
    activityKind: "transitioned" | "completed" | "reopened" = "transitioned",
  ): Promise<WorkItemTransitionResult> {
    if (!isStatus(to)) {
      return { status: "invalid", itemId: id, reason: `invalid target status: ${String(to)}` };
    }
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const from = board.items[idx].status;
      const updated: WorkItem = { ...board.items[idx], status: to, updated_at: iso };
      if (to === "completed") updated.completed_at = iso;
      else delete updated.completed_at;
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: activityKind,
        itemId: updated.id,
        title: updated.title,
        // `from`/`to` carry the status pair for the lifecycle reconstruction regardless of which verb labelled the row.
        from,
        to,
        ts: iso,
      });
      return {
        status: "transitioned" as const,
        itemId: id,
        to,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  // Transition to `completed`, mapping the envelope to a complete result.
  async complete(id: number): Promise<WorkItemCompleteResult> {
    const result = await this.transition(id, "completed", "completed");
    if (result.status === "transitioned") {
      return { status: "completed", itemId: result.itemId, item: result.item };
    }
    return result;
  }

  // Transition back to `in_progress`, mapping the envelope to a reopen result.
  async reopen(id: number): Promise<WorkItemReopenResult> {
    const result = await this.transition(id, "in_progress", "reopened");
    if (result.status === "transitioned") {
      return { status: "reopened", itemId: result.itemId, item: result.item };
    }
    return result;
  }

  // Only the engine writes run phases; user or model patches cannot forge them and unknown IDs never create records.
  async setRunStatus(
    id: number,
    runStatus: WorkItemRunStatus,
  ): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const updated: WorkItem = {
        ...board.items[idx],
        runStatus,
        runUpdatedAt: iso,
      };
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: runStatusActivityKind(runStatus),
        itemId: updated.id,
        title: updated.title,
        to: runStatus,
        ts: iso,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  // Start a fresh capped history entry and reset latest fields without overwriting prior history or transcripts.
  async beginRun(id: number, runId: string, startedAt: string): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const prior = board.items[idx];
      const history = [
        ...(prior.runHistory ?? []),
        { runId, startedAt, status: "planning" as WorkItemRunStatus },
      ];
      const capped =
        history.length > RUN_HISTORY_CAP ? history.slice(history.length - RUN_HISTORY_CAP) : history;
      const updated: WorkItem = {
        ...prior,
        runStatus: "planning",
        runId,
        runUpdatedAt: startedAt,
        runHistory: capped,
      };
      delete updated.plan;
      delete updated.output;
      delete updated.runSessionId;
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "run-planned",
        itemId: id,
        title: updated.title,
        to: "planning",
        ts: startedAt,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), Date.parse(startedAt)),
      };
    });
  }

  // At boot, active persisted phases belong to dead processes; mark them error and close history so items become runnable again.
  async reconcileInterruptedRuns(): Promise<number> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const iso = new Date(this.now()).toISOString();
      let count = 0;
      for (let i = 0; i < board.items.length; i++) {
        const it = board.items[i];
        if (
          it.runStatus === "planning" ||
          it.runStatus === "awaiting_approval" ||
          it.runStatus === "executing"
        ) {
          const updated: WorkItem = { ...it, runStatus: "error", runUpdatedAt: iso };
          if (it.runId && Array.isArray(it.runHistory)) {
            updated.runHistory = it.runHistory.map((h) =>
              h.runId === it.runId && h.endedAt === undefined
                ? { ...h, status: "error" as WorkItemRunStatus, endedAt: iso }
                : h,
            );
          }
          board.items[i] = updated;
          count += 1;
        }
      }
      if (count > 0) {
        await writeFileAtomic(this.filePath, board);
      }
      this.cache = board;
      if (count > 0) log.info("[work-board-store] reconciled %d interrupted run(s) → error", count);
      return count;
    });
  }

  // Only the engine writes terminal results; undefined preserves fields, null clears them, and values replace them.
  // Clear stale plan/output/session fields so a failed new run cannot display an old success.
  async setRunResult(
    id: number,
    result: {
      runStatus: WorkItemRunStatus;
      plan?: string | null;
      output?: string | null;
      runSessionId?: string | null;
    },
  ): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const updated: WorkItem = {
        ...board.items[idx],
        runStatus: result.runStatus,
        runUpdatedAt: iso,
      };
      // null → clear the key; a string → set it; undefined → leave as-is.
      if (result.plan === null) delete updated.plan;
      else if (result.plan !== undefined) updated.plan = result.plan;
      if (result.output === null) delete updated.output;
      else if (result.output !== undefined) updated.output = result.output;
      if (result.runSessionId === null) delete updated.runSessionId;
      else if (result.runSessionId !== undefined) updated.runSessionId = result.runSessionId;
      // Keep the CURRENT run's history entry (matched by runId) in sync, so the re-run history index reflects each run's final status/plan/output — without a
      // separate write path. `endedAt` is stamped on terminal status.
      if (updated.runId && Array.isArray(updated.runHistory)) {
        updated.runHistory = updated.runHistory.map((h) =>
          h.runId === updated.runId
            ? {
                ...h,
                status: result.runStatus,
                ...(typeof updated.plan === "string" ? { plan: updated.plan } : {}),
                ...(typeof updated.output === "string"
                  ? { outputPreview: updated.output.slice(0, RUN_OUTPUT_PREVIEW_CHARS) }
                  : {}),
                ...(TERMINAL_RUN_STATUSES.has(result.runStatus) ? { endedAt: iso } : {}),
              }
            : h,
        );
      }
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: runStatusActivityKind(result.runStatus),
        itemId: updated.id,
        title: updated.title,
        to: result.runStatus,
        ts: iso,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  async remove(id: number): Promise<WorkItemDeleteResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const item = board.items.find((i) => i.id === id);
      if (!item) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      board.items = board.items.filter((i) => i.id !== id);
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "deleted",
        itemId: id,
        title: item.title,
        ts: new Date(this.now()).toISOString(),
      });
      return { status: "deleted" as const, itemId: id };
    });
  }

  // Keep proposals separate from user-owned board rows within the same feature namespace.
  // Enforce granted kinds and per-kind capacity where the stored set is visible, never only in UI or API checks.

  // `proposals.json`, beside whichever `board.json` this store was built on.
  private proposalsPath(): string {
    return join(dirname(this.filePath), PROPOSALS_FILE);
  }

  // Read `proposals.json`, dropping rows that are past their expiry and rows that do not parse. Expiry is a read-time sweep rather than a timer: a
  // proposal whose plugin died still stops being shown.
  private async readProposals(nowMs: number): Promise<ProposalsFile> {
    const raw = await readJsonFileOrEmpty<ProposalsFile>(
      this.proposalsPath(),
      () => ({ version: PROPOSALS_VERSION, proposals: [] }),
      (parsed) => {
        const file = parsed as ProposalsFile;
        if (!Array.isArray(file.proposals)) {
          return { version: PROPOSALS_VERSION, proposals: [] };
        }
        return { version: PROPOSALS_VERSION, proposals: file.proposals.filter(isValidProposal) };
      },
    );
    return {
      version: PROPOSALS_VERSION,
      proposals: raw.proposals.filter((p) => Date.parse(p.expiresAt) > nowMs),
    };
  }

  private async writeProposals(file: ProposalsFile): Promise<void> {
    await writeFileAtomicAtPath(
      this.proposalsPath(),
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }

  // Every proposal still showable right now, newest update first.
  async listProposals(): Promise<WorkProposalListResult> {
    const nowMs = this.now();
    const file = await this.readProposals(nowMs);
    const live = file.proposals
      .filter((p) => isLiveProposal(p, nowMs))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { status: "ok", proposals: live.map((p) => ({ ...p })) };
  }

  // Derive origin and grants from the host binding; same-key refresh preserves acceptance/dismissal and different-key live slots refuse.
  async upsertProposal(
    origin: { pluginId: string; pluginLabel: string; grantedKinds: readonly string[] },
    input: WorkProposalInput,
  ): Promise<WorkProposalResult> {
    const normalized = normalizeProposalInput(input);
    if (!normalized.ok) return { status: "invalid", field: normalized.field };
    if (!origin.grantedKinds.includes(input.kind)) {
      return { status: "kind_not_granted", kind: input.kind };
    }

    const path = this.proposalsPath();
    return withInProcessFileQueue(path, async () => {
      const nowMs = this.now();
      const file = await this.readProposals(nowMs);
      const id = proposalId(origin.pluginId, input.kind, input.key.trim());
      const existingIdx = file.proposals.findIndex((p) => p.id === id);
      const slotTaken = file.proposals.some(
        (p) =>
          p.pluginId === origin.pluginId
          && p.kind === input.kind
          && p.id !== id
          && isLiveProposal(p, nowMs),
      );
      if (slotTaken) return { status: "slot_busy" as const, kind: input.kind };
      if (existingIdx === -1 && file.proposals.length >= MAX_PROPOSALS) {
        return { status: "cap_reached" as const };
      }

      const prior = existingIdx === -1 ? undefined : file.proposals[existingIdx];
      const proposal = composeProposal({
        id,
        kind: input.kind,
        key: input.key.trim(),
        pluginId: origin.pluginId,
        pluginLabel: origin.pluginLabel,
        normalized,
        nowMs,
        ...(prior ? { prior } : {}),
      });
      if (existingIdx === -1) file.proposals.push(proposal);
      else file.proposals[existingIdx] = proposal;
      await this.writeProposals(file);
      return { status: "ok" as const, proposal: { ...proposal } };
    });
  }

  // Derive plugin identity from the caller binding; foreign or missing proposals are indistinguishable and retract is idempotent.
  async withdrawProposal(pluginId: string, kind: string, key: string): Promise<boolean> {
    if (typeof kind !== "string" || typeof key !== "string") return false;
    const path = this.proposalsPath();
    return withInProcessFileQueue(path, async () => {
      const nowMs = this.now();
      const file = await this.readProposals(nowMs);
      const id = proposalId(pluginId, kind, key.trim());
      const idx = file.proposals.findIndex(
        (p) => p.id === id && p.pluginId === pluginId && isLiveProposal(p, nowMs),
      );
      if (idx === -1) return false;
      file.proposals.splice(idx, 1);
      await this.writeProposals(file);
      return true;
    });
  }

  // Close a card the user does not want. Sticky: a re-post keeps the mark.
  async dismissProposal(id: string): Promise<WorkProposalDismissResult> {
    const path = this.proposalsPath();
    return withInProcessFileQueue(path, async () => {
      const nowMs = this.now();
      const file = await this.readProposals(nowMs);
      const idx = file.proposals.findIndex((p) => p.id === id && isLiveProposal(p, nowMs));
      if (idx === -1) return { status: "not_found" as const, proposalId: id };
      file.proposals[idx] = {
        ...file.proposals[idx],
        dismissedAt: new Date(nowMs).toISOString(),
      };
      await this.writeProposals(file);
      return { status: "dismissed" as const, proposalId: id };
    });
  }

  // User-requested briefing output uses per-run and global caps instead of the unattended plugin per-kind slot budget.
  // Stable proposal IDs refresh duplicates without reopening dismissed or accepted cards.
  async fileBriefingProposals(
    inputs: readonly WorkProposalInput[],
  ): Promise<{ filed: string[]; refreshed: string[] }> {
    const path = this.proposalsPath();
    return withInProcessFileQueue(path, async () => {
      const nowMs = this.now();
      const file = await this.readProposals(nowMs);
      const filed: string[] = [];
      const refreshed: string[] = [];

      for (const input of inputs) {
        const normalized = normalizeProposalInput(input);
        if (!normalized.ok) {
          log.warn(
            "briefing proposal rejected (field=%s) — row dropped",
            normalized.field,
          );
          continue;
        }
        const key = input.key.trim();
        const id = proposalId(BRIEFING_PROPOSAL_SOURCE_ID, input.kind, key);
        const existingIdx = file.proposals.findIndex((p) => p.id === id);
        if (existingIdx === -1 && file.proposals.length >= MAX_PROPOSALS) {
          log.warn("briefing proposal dropped — host proposal cap reached");
          break;
        }
        const prior = existingIdx === -1 ? undefined : file.proposals[existingIdx];
        const proposal = composeProposal({
          id,
          kind: input.kind,
          key,
          pluginId: BRIEFING_PROPOSAL_SOURCE_ID,
          pluginLabel: BRIEFING_PROPOSAL_SOURCE_LABEL,
          normalized,
          nowMs,
          ...(prior ? { prior } : {}),
        });
        if (existingIdx === -1) {
          file.proposals.push(proposal);
          filed.push(id);
        } else {
          file.proposals[existingIdx] = proposal;
          refreshed.push(id);
        }
      }

      if (filed.length > 0 || refreshed.length > 0) await this.writeProposals(file);
      return { filed, refreshed };
    });
  }

  // Turn an accepted proposal into a work item through the ORDINARY create path — same validation, same activity row, same MAX_ITEMS budget as a card the
  // user typed. The proposal keeps `acceptedItemId` so the card stops showing and the item it became stays traceable to its source.
  async acceptProposal(
    id: string,
    project?: { projectRoot?: string; projectName?: string },
  ): Promise<WorkProposalAcceptResult> {
    const nowMs = this.now();
    const file = await this.readProposals(nowMs);
    const proposal = file.proposals.find((p) => p.id === id && isLiveProposal(p, nowMs));
    if (!proposal) return { status: "not_found", proposalId: id };

    const created = await this.create(proposalToWorkItemInput(proposal, project));
    if (created.status !== "created") {
      return { status: "invalid", reason: created.reason };
    }

    await withInProcessFileQueue(this.proposalsPath(), async () => {
      const current = await this.readProposals(this.now());
      const idx = current.proposals.findIndex((p) => p.id === id);
      if (idx === -1) return;
      current.proposals[idx] = { ...current.proposals[idx], acceptedItemId: created.itemId };
      await this.writeProposals(current);
    });

    return { status: "accepted", itemId: created.itemId, item: created.item };
  }
}
