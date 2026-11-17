// Serialize mutations within this process only and append activity for report reconstruction. IPC owns change broadcasts; compute overdue on read rather
// than persisting or duplicating that projection in consumers.
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createLogger } from "../lib/logger.js";
import {
  openFeatureNamespace,
  quarantineCorruptJson,
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
import { projectRootEquals, projectRootKey } from "../shared/project-identity.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { workBoardMoveRefusal } from "../shared/work-board-lifecycle.js";
import { ChangeSignal } from "../lib/change-signal.js";
import { WorkflowRunStore, type WorkflowRunRetention, type WorkflowRunView } from "./workflow-run-store.js";
import { stripBoardRunFields } from "../work-board/template-run-fields.js";
import { readAveHomeInput } from "../shared/ave-home-trust.js";
import { isTemplateId, requireTemplate } from "../work-board/template-graph.js";
import type { TemplateRunStart, WorkflowRunReadResult, WorkflowRunRecord, WorkflowRunWriteResult } from "../shared/workflow-template-types.js";

const log = createLogger("ave");

// Re-export the shared type boundary so callers that import from work-board-store continue to work unchanged, while the renderer imports from shared/ (no Node built-ins).
export {
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
} from "../shared/work-board-types.js";

import {
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
  type WorkPlanApproval,
  type WorkPlanApprovalStatus,
  type WorkPlanDecideRefusal,
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
  "cancelled",
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
  "cancelled",
];

const UPDATABLE_FIELDS: ReadonlySet<string> = new Set<keyof WorkItemUpdateInput>(["title", "detail", "due_at", "priority"]);

const PLAN_APPROVAL_STATUSES: readonly WorkPlanApprovalStatus[] = ["pending", "approved", "rejected", "changes_requested"];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The hash a plan decision binds to; computed by the host from the stored plan, never taken from the renderer. */
export function planHashOf(plan: string): string {
  return sha256(plan);
}

/** What the plan was made for. A title, detail or project change after planning makes the plan stale. */
export function itemDigestOf(item: Pick<WorkItem, "title" | "detail" | "projectRoot">): string {
  return sha256(JSON.stringify([item.title, item.detail ?? "", item.projectRoot ?? ""]));
}

function isValidPlanApproval(v: unknown): v is WorkPlanApproval {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  for (const field of ["runId", "planHash", "itemDigest", "requestedAt"]) {
    if (typeof x[field] !== "string" || (x[field] as string).length === 0) return false;
  }
  if (typeof x.status !== "string" || !PLAN_APPROVAL_STATUSES.includes(x.status as WorkPlanApprovalStatus)) return false;
  if (typeof x.revision !== "number" || !Number.isInteger(x.revision) || x.revision < 0) return false;
  if (x.note !== undefined && typeof x.note !== "string") return false;
  if (x.decidedAt !== undefined && typeof x.decidedAt !== "string") return false;
  if (x.agentName !== undefined && typeof x.agentName !== "string") return false;
  return true;
}

/** The decision the user made, applied inside the board lock. */
export interface PlanDecisionInput {
  runId: string;
  planHash: string;
  status: Exclude<WorkPlanApprovalStatus, "pending">;
  note?: string;
}

export type PlanDecisionResult =
  | { status: "decided"; item: WorkItemResolved; planApproval: WorkPlanApproval }
  | { status: "refused"; reason: Exclude<WorkPlanDecideRefusal, "already_running" | "plan_settling" | "note_required" | "note_too_long" | "note_invalid"> };

/** An item whose stored plan can still be decided: awaiting approval, with a pending decision for its current run and plan. */
/** A stored plan the user can decide now: its run waits on exactly this plan. */
export function isDecidablePlan(item: WorkItem): boolean {
  const approval = item.planApproval;
  return (
    item.runStatus === "awaiting_approval" &&
    typeof item.plan === "string" &&
    typeof item.runId === "string" &&
    approval !== undefined &&
    approval.status === "pending" &&
    approval.runId === item.runId &&
    approval.planHash === planHashOf(item.plan)
  );
}

/** A plan the user sent back for changes whose run is planning again; it waits for the agent, not for the user. */
export function isReplanningPlan(item: WorkItem): boolean {
  const approval = item.planApproval;
  return (
    item.runStatus === "planning" &&
    typeof item.runId === "string" &&
    approval !== undefined &&
    approval.status === "changes_requested" &&
    approval.runId === item.runId
  );
}

interface RunResultPatch {
  runStatus: WorkItemRunStatus;
  plan?: string | null;
  output?: string | null;
  runSessionId?: string | null;
}

// null → clear the key; a string → set it; undefined → leave as-is. Keeps the CURRENT run's history entry (matched by runId) in sync, so
// the re-run history index reflects each run's final status/plan/output without a separate write path; `endedAt` is stamped on terminal status.
function withRunResult(item: WorkItem, result: RunResultPatch, iso: string): WorkItem {
  const updated: WorkItem = { ...item, runStatus: result.runStatus, runUpdatedAt: iso };
  if (result.plan === null) delete updated.plan;
  else if (result.plan !== undefined) updated.plan = result.plan;
  if (result.output === null) delete updated.output;
  else if (result.output !== undefined) updated.output = result.output;
  if (result.runSessionId === null) delete updated.runSessionId;
  else if (result.runSessionId !== undefined) updated.runSessionId = result.runSessionId;
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
  return updated;
}

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
  return { version: BOARD_VERSION, nextId: 1, items: [], unreadable: [] };
}

/** A board as a write read it. `unread`: the file was absent, awaited review, did not parse or had no items list, so the board started
 * empty and shows none of the rows the file may have held. `unmoved`: it did not parse or had no items list and could not be moved
 * aside, so nothing may be written over it. `prior`: the file's bytes, when writing back its rows that do not validate would not give
 * them byte for byte. None of these is written. */
type BoardRead = BoardFile & { unread?: true; unmoved?: true; prior?: Buffer };

/** Where a stored run's row stands on a readable board. named: the row names the run. moved: it names another run and holds this one in its
 * history. unnamed: it neither names nor holds the run. lost: the board lists no row with its id, and the id is below the board's
 * `unknownBelow`: the board was written over one that showed none of its rows, so the row may have been there. gone: the board lists no
 * row with its id, at or above `unknownBelow`. unreadable: whatever could still be the run's row: a row with its id that does not
 * validate, or, where the run would otherwise read unnamed, lost or gone, any entry of the file holding the run's id as a string anywhere
 * in it, or (with its row absent) any entry without a usable id. Every stored run's itemId is at or below the run file's row-id floor, which no new row is
 * issued under, so a gone row is gone for good. */
export type RunRowStanding = "named" | "moved" | "unnamed" | "gone" | "lost" | "unreadable";
type RowStandings = (run: { itemId: number; runId: string }) => RunRowStanding;

// `entries`: every entry of the board file the standing is read from, as it is there.
function boardStanding(board: BoardFile, entries: readonly unknown[] = [...board.items, ...board.unreadable]): RowStandings {
  const rows = new Map(board.items.map((item) => [item.id, item]));
  const invalidIds = new Set(rawRowIds(board.unreadable));
  const idless = entries.some((row) => rowIdOf(row) === undefined);
  let text: string | undefined;
  const heldAnywhere = (runId: string) => {
    if (text === undefined) text = JSON.stringify(entries);
    return text.includes(JSON.stringify(runId));
  };
  return (run) => {
    const row = rows.get(run.itemId);
    if (row?.runId === run.runId) return "named";
    if (row && Array.isArray(row.runHistory) && row.runHistory.some((entry) => entry.runId === run.runId)) return "moved";
    if ((!row && (invalidIds.has(run.itemId) || idless)) || heldAnywhere(run.runId)) return "unreadable";
    return row ? "unnamed" : run.itemId < (board.unknownBelow ?? 0) ? "lost" : "gone";
  };
}

function rowIdOf(row: unknown): number | undefined {
  const id = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 1 ? id : undefined;
}

// The id of each row object in a board file's items, valid or not.
function rawRowIds(items: readonly unknown[]): number[] {
  return items.flatMap((row) => {
    const id = rowIdOf(row);
    return id === undefined ? [] : [id];
  });
}

// The board as it is on disk with where runs' rows stand on it, or undefined when the file is absent, pending review, does not parse
// or lists no items; never quarantines. Read errors throw.
async function readBoardOnDisk(filePath: string): Promise<{ board: BoardFile; standing: RowStandings } | undefined> {
  const parsed = await parseBoardOnDisk(filePath);
  if (!readableBoard(parsed)) return undefined;
  const board = hydrateBoard(parsed);
  return { board, standing: boardStanding(board, parsed.items) };
}

function readableBoard(parsed: unknown): parsed is BoardFile {
  return typeof parsed === "object" && parsed !== null && Array.isArray((parsed as BoardFile).items);
}

async function parseBoardOnDisk(filePath: string): Promise<unknown> {
  const input = await readAveHomeInput(filePath);
  return input.status === "trusted" ? parseBoard(input.bytes) : undefined;
}

function parseBoard(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf-8")) as unknown; } catch { return undefined; }
}

function hydrateBoard(file: BoardFile): BoardFile {
  // Valid rows that share an id are not listed, so no run is read off a twin: each is kept as a row that does not validate. A valid row
  // whose id only a row that does not validate has too is still listed.
  const rowsById = new Map<number, number>();
  for (const row of file.items) if (isValidRecord(row)) rowsById.set(row.id, (rowsById.get(row.id) ?? 0) + 1);
  const listed = (row: unknown): row is WorkItem => isValidRecord(row) && rowsById.get(row.id) === 1;
  // Run state lives in the run file. A row carrying run fields was edited by hand: they are dropped here, so nothing reads or shows them.
  const valid = file.items.filter(listed).map(stripBoardRunFields).map((item) => {
    if (item.planApproval === undefined || isValidPlanApproval(item.planApproval)) return item;
    // Keep the item; drop only the unreadable decision. A run left awaiting approval without one reconciles to error at boot.
    log.warn("[work-board-store] dropped an unreadable plan approval on item %d", item.id);
    const repaired = { ...item };
    delete repaired.planApproval;
    return repaired;
  });
  // One-time re-anchoring of due dates stamped as midnight in a fixed zone, back when the board was KST-anchored. Idempotent by its own rule, so it runs
  // on every load and converges; nothing marks it done.
  const { items, changed } = normalizeBoardDueDates(valid);
  if (changed > 0) {
    log.info(
      { event: "work-board-due-at-localized", changed, total: items.length },
      "[work-board-store] re-anchored due dates stamped as midnight in another zone",
    );
  }
  // Above every row id in the file, valid or not.
  const maxId = rawRowIds(file.items).reduce((m, id) => Math.max(m, id), 0);
  const nextId =
    typeof file.nextId === "number" && Number.isSafeInteger(file.nextId) && file.nextId > maxId
      ? file.nextId
      : maxId + 1;
  // One that is not a row id reads as the board's next id: no row below it that the board does not list is read as gone.
  const unknownBelow = file.unknownBelow === undefined ? undefined
    : Number.isSafeInteger(file.unknownBelow) && file.unknownBelow >= 1 ? file.unknownBelow : nextId;
  return {
    version: BOARD_VERSION, nextId, ...(unknownBelow !== undefined ? { unknownBelow } : {}), items,
    unreadable: file.items.filter((row) => !listed(row)),
  };
}

/** A copy of the board file as it was, beside it, once per content: a row that does not validate is written back as JSON writes its
 * parsed value, which can differ from its bytes (a number past the safe-integer limit, other spacing). A copy that cannot be made
 * fails the write, and the board file is left as it was. */
async function keepPriorBytes(filePath: string, prior: Buffer): Promise<void> {
  const copy = `${filePath}.invalid-rows-${createHash("sha256").update(prior).digest("hex")}.bak`;
  if (await access(copy).then(() => true, () => false)) return;
  await writeFileAtomicAtPath(copy, prior);
  log.warn("[work-board-store] the board file holds rows that do not validate; kept it as it was at %s", copy);
}

async function writeFileAtomic(filePath: string, data: BoardFile): Promise<void> {
  // Delegates the 0o700-dir / 0o600-file / tmpfile+rename contract to the feature-namespace SOT helper. The injectable `filePath` (tests pass a temp path)
  // is preserved — the helper enforces the permission boundary on whatever parent directory the path resolves to.
  const { version, nextId, unknownBelow, items, unreadable } = data;
  const board = { version, nextId, ...(unknownBelow !== undefined ? { unknownBelow } : {}), items: [...items, ...unreadable] };
  await writeFileAtomicAtPath(filePath, `${JSON.stringify(board, null, 2)}\n`);
}

// Deep clone a WorkItem so callers cannot mutate shared cache refs.
function cloneItem(it: WorkItem): WorkItem {
  return { ...it };
}

function mutationRevision(item: WorkItem): string {
  return sha256(JSON.stringify(item));
}

// A template row names its run by runId alone. The run file decides whether that run can be read and whether it belongs to this row;
// while the file awaits review no template run can be vouched for. Ordinary rows and unstarted template rows have no run in that file and
// are never marked.
// What a settled run keeps once its row names a newer run: how it ended and each stage's status, times, result hash and output hash.
function runSummary(run: WorkflowRunRecord): WorkflowRunRecord {
  const { runId, itemId, pin, runStartedBy, startedAt, settled } = run;
  const stageRuns = run.stageRuns.map(({ stageId, attempt, status, startedAt, endedAt, resultHash, outputHash }) =>
    ({ stageId, attempt, status, ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }), ...(resultHash === undefined ? {} : { resultHash }), ...(outputHash === undefined ? {} : { outputHash }) }));
  return { runId, itemId, pin, runStartedBy, startedAt, stageRuns, ...(settled === undefined ? {} : { settled }) };
}

const namesTemplateRun = (item: WorkItem): boolean => item.templateId !== undefined && item.runId !== undefined;
function templateRunError(item: WorkItem, runs: WorkflowRunView): WorkItemResolved["templateRunError"] {
  if (!namesTemplateRun(item) || item.runId === undefined) return undefined;
  const result = runs.get(item.runId);
  if (result.status === "pending-review") return "template-runs-pending-review";
  return result.status === "invalid" || (result.status === "found" && result.run.itemId !== item.id) ? "invalid-template-run" : undefined;
}

// A pending plan also carries whether the item changed since the plan was made; main judges it once, here, for every reader.
function decorate(item: WorkItem, nowMs: number, runError?: WorkItemResolved["templateRunError"]): WorkItemResolved {
  const approval = item.planApproval;
  return {
    ...item,
    mutationRevision: mutationRevision(item),
    ...(runError ? { templateRunError: runError } : {}),
    status_resolved: resolveWorkItemStatus(item, nowMs),
    ...(approval?.status === "pending" ? { planStale: approval.itemDigest !== itemDigestOf(item) } : {}),
  };
}

// Transient run phases share run-planned; terminal activity verbs record outcomes.
function runStatusActivityKind(
  runStatus: WorkItemRunStatus,
): "run-planned" | "run-executed" | "run-denied" | "run-failed" | "run-cancelled" {
  switch (runStatus) {
    case "idle":
    case "planning":
    case "awaiting_approval":
    case "executing":
      return "run-planned";
    case "completed":
      return "run-executed";
    case "denied":
      return "run-denied";
    case "error":
      return "run-failed";
    case "cancelled":
      return "run-cancelled";
    default: {
      const unhandled: never = runStatus;
      throw new Error(`unhandled work-board run status: ${String(unhandled)}`);
    }
  }
}

export class WorkBoardStore {
  // Fires after every proposals.json write, including briefing, accept and dismiss.
  readonly proposalsChanged = new ChangeSignal((err) => log.warn("[work-board-proposals] change listener threw: %s", (err as Error).message));
  // Fires after every board.json write (items, runs and plan approvals), whichever path made it (IPC, engine, model tools, reconcile).
  readonly boardChanged = new ChangeSignal((err) => log.warn("[work-board] change listener threw: %s", (err as Error).message));
  private cache: BoardFile = emptyBoard();
  private loaded = false;
  private readonly filePath: string;
  // Activity-log storage rooted in the same directory as `board.json`.
  private readonly activity: WorkBoardStorage;
  private readonly now: () => number;
  /** Template-run state, keyed by runId, in the covered run file beside `board.json`. */
  readonly runs: WorkflowRunStore;

  /**
   * @param filePath absolute path to `board.json`. Defaults to the
   *   `~/.ave/work-board/board.json` namespace path; tests inject a temp path.
   * @param now injectable clock for deterministic overdue/timestamp tests.
   * @param runs the run store; defaults to `workflow-runs.json` beside the board file.
   */
  constructor(filePath: string = defaultPath(), now: () => number = () => Date.now(), runs: WorkflowRunStore = new WorkflowRunStore(join(dirname(filePath), "workflow-runs.json"))) {
    this.filePath = filePath;
    this.runs = runs;
    this.activity = createDirStorage(dirname(filePath));
    this.now = now;
  }

  // The one board write: the cache takes the board only after it is on disk, then listeners hear about it. A board read as unread is
  // written only by a create, which first marks the ids it cannot show.
  private async commit(board: BoardRead): Promise<void> {
    const { unread, prior, ...file } = board;
    if (unread) throw new Error("a board that shows none of its rows is written only by a create");
    if (prior) await keepPriorBytes(this.filePath, prior);
    await writeFileAtomic(this.filePath, file);
    this.cache = file;
    this.boardChanged.emit();
  }

  // Only the run record says a run is over (`settled`); a record without it stays whole, whatever its row shows. A settled run stays
  // whole while its row names it, does not validate or is lost, shrinks to its summary while it is only in the row's run history, and goes once
  // its row is gone or no longer holds it.
  private retention(standing: RowStandings): WorkflowRunRetention {
    return (run) => {
      if (run.settled === undefined) return run;
      const row = standing(run);
      if (row === "named" || row === "unreadable" || row === "lost") return run;
      return row === "moved" ? runSummary(run) : null;
    };
  }

  /** For the engine, at boot and live: where each stored run's row stands on the board file on disk. Undefined while the file is absent,
   * awaits review, does not parse or lists no items: such a board shows nothing. */
  async runRowsOnDisk(): Promise<RowStandings | undefined> {
    return (await readBoardOnDisk(this.filePath))?.standing;
  }

  // What a write starts from. A file that does not parse or is not a board with an items list is moved aside as damaged JSON is, and one
  // that cannot be moved is marked so no write goes over it. It and a file that is absent or awaits review start empty. Invalid rows are
  // set aside and nextId is repaired above every row id in the file. `keepBytes`: the write drops entries that do not validate, so the file's
  // bytes are kept as they are.
  private async readBoard(keepBytes = false): Promise<BoardRead> {
    const input = await readAveHomeInput(this.filePath);
    if (input.status !== "trusted") return { ...emptyBoard(), unread: true };
    const parsed = parseBoard(input.bytes);
    if (readableBoard(parsed)) {
      const board: BoardRead = hydrateBoard(parsed);
      if (keepBytes || (board.unreadable.length > 0 && !input.bytes.equals(Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`)))) board.prior = input.bytes;
      return board;
    }
    return (await quarantineCorruptJson(this.filePath)) ? { ...emptyBoard(), unread: true } : { ...emptyBoard(), unread: true, unmoved: true };
  }

  // A failed row write may still have replaced the board (a failed directory sync after the rename). While the board on disk shows the
  // row naming the run (`named`), shows nothing, or holds a row with that id that does not validate, the record stays as it is. Any other
  // readable board shows the start never landed: the run ends error and no row shows it.
  private async settleUnstarted(id: number, runId: string): Promise<WorkflowRunWriteResult | { status: "board-unread" | "named" }> {
    const onDisk = await readBoardOnDisk(this.filePath);
    const row = onDisk?.standing({ itemId: id, runId });
    if (!onDisk || row === "unreadable") return { status: "board-unread" };
    if (row === "named") {
      this.cache = onDisk.board;
      this.boardChanged.emit();
      return { status: "named" };
    }
    const at = new Date(this.now()).toISOString();
    const settledRun = await this.runs.update(runId, (run) => {
      requireTemplate(run.itemId === id, "invalid-template-run");
      return run.settled === undefined ? { ...run, settled: { status: "error", at } } : null;
    });
    if (settledRun.status === "stored") await this.pruneAfterWrite(this.retention(onDisk.standing));
    return settledRun;
  }

  /** For the engine: end a run whose start failed before its row write was known to land, by the rule above. Never for a run that started. */
  async settleUnstartedRun(id: number, runId: string): Promise<WorkflowRunWriteResult | { status: "board-unread" | "named" }> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, () => this.settleUnstarted(id, runId));
  }

  // Cleanup after a board write never fails that write: whatever it leaves behind goes with the next prune. The engine's
  // pruneSettledRuns does not go through here, so its failures reach the engine.
  private async pruneAfterWrite(retain: WorkflowRunRetention): Promise<void> {
    try { await this.runs.prune(retain); }
    catch (error) { log.warn("[work-board-store] run records were not pruned: %s", (error as Error).message); }
  }

  /** For the engine: remove every settled run no row lists and shrink the ones only a run history lists, judged by the board file on
   * disk; one that shows nothing prunes nothing. Call it after settling a run whose row is gone or no longer names it. A run file that
   * cannot be read rejects; one pending review or past the read limit is left as it is. */
  async pruneSettledRuns(): Promise<void> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const onDisk = await readBoardOnDisk(this.filePath);
      if (onDisk) await this.runs.prune(this.retention(onDisk.standing));
    });
  }

  async load(): Promise<void> {
    const { unread: _, unmoved: __, prior: ___, ...board } = await this.readBoard();
    this.cache = board;
    this.loaded = true;
    // The run file's row-id floor starts from the first board read: every id it shows. One that cannot take it now gets it with the next new row.
    try { await this.runs.raiseRowIdFloor(this.cache.nextId - 1); }
    catch (error) { log.warn("[work-board-store] the row-id floor was not raised: %s", (error as Error).message); }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  // List items, newest-id first, with `status_resolved` computed + filter applied.
  async list(filter: WorkItemListFilter = {}): Promise<WorkItemListResult> {
    await this.ensureLoaded();
    // Read on every call, never cached: the marks follow the run file as it is now.
    const runs = await this.runs.view();
    if (filter.limit !== undefined && (!Number.isFinite(filter.limit) || filter.limit < 0)) {
      return { status: "invalid", reason: "limit must be a non-negative number" };
    }
    const projectRoot = normalizeOptionalString(filter.projectRoot, MAX_PROJECT_ROOT_LENGTH);
    const nowMs = this.now();
    let rows = this.cache.items
      .map((item) => decorate(cloneItem(item), nowMs, templateRunError(item, runs)))
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
    const unreadable = this.cache.unreadable.map((row) => {
      const [id] = rawRowIds([row]);
      return id === undefined ? {} : { id };
    });
    return { status: "ok", items: rows, ...(unreadable.length > 0 ? { unreadableRows: unreadable } : {}) };
  }

  // Fetch one item by id.
  async get(id: number): Promise<WorkItemGetResult> {
    await this.ensureLoaded();
    const item = this.cache.items.find((i) => i.id === id);
    if (!item) return { status: "not_found", itemId: id };
    const runError = namesTemplateRun(item) ? templateRunError(item, await this.runs.view()) : undefined;
    return { status: "found", itemId: id, item: decorate(cloneItem(item), this.now(), runError) };
  }

  /** The template run a row names, read from the run file only. A run stored for another row is refused. */
  async getRun(id: number): Promise<WorkflowRunReadResult> {
    await this.ensureLoaded();
    const runId = this.cache.items.find((i) => i.id === id)?.runId;
    if (runId === undefined) return { status: "not-found" };
    const result = await this.runs.get(runId);
    return result.status === "found" && result.run.itemId !== id ? { status: "invalid" } : result;
  }

  /** Change the template run a row names, under the board lock so the row cannot move to another run meanwhile. `mutate` runs only
   * while the board file on disk shows the row naming the run, and the stored run belongs to that row. `not-found` when that board shows
   * the row gone or naming a newer run, `row-lost` when the row is there without naming or holding the run or is lost, `board-unread` while the
   * board file shows nothing or the row does not validate. A missing or unreadable board is never read as empty, and is left as it is. */
  async updateRun(id: number, runId: string, mutate: (run: WorkflowRunRecord) => WorkflowRunRecord | null): Promise<WorkflowRunWriteResult | { status: "board-unread" | "row-lost" }> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const row = (await readBoardOnDisk(this.filePath))?.standing({ itemId: id, runId });
      if (row === "gone" || row === "moved") return { status: "not-found" };
      if (row === "unnamed" || row === "lost") return { status: "row-lost" };
      if (row !== "named") return { status: "board-unread" };
      return this.runs.update(runId, (run) => {
        requireTemplate(run.itemId === id, "invalid-template-run");
        return mutate(run);
      });
    });
  }

  async create(input: WorkItemCreateInput): Promise<WorkItemCreateResult> {
    await this.ensureLoaded();
    if (input.templateId !== undefined && !isTemplateId(input.templateId)) return { status: "invalid", reason: "invalid templateId" };
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
      const board = await this.readBoard();
      // A damaged board file that could not be moved aside is left byte for byte as it is.
      if (board.unmoved) return { status: "invalid" as const, reason: "work-board-file-not-set-aside" };
      // The id comes from the run file's row-id floor, above every id this board shows, and the floor is advanced before the row is
      // written: no id is issued twice, whatever board file is read. While the floor cannot be read or stored, no row is added.
      const id = await this.runs.issueRowId(board.nextId - 1).catch((error: unknown) => {
        log.warn("[work-board-store] no row id was issued: %s", (error as Error).message);
        return undefined;
      });
      if (id === undefined) return { status: "invalid" as const, reason: "work-item-ids-unavailable" };
      if (id === "exhausted") return { status: "invalid" as const, reason: "work-item-ids-exhausted" };
      if (board.unread) {
        // Written over a board that showed none of its rows: a row below this id that it does not list is lost, never gone.
        if (id > 1) board.unknownBelow = id;
        delete board.unread;
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const status: WorkItemStatusStored = input.status ?? "planned";
      const item: WorkItem = {
        ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        id,
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
      board.nextId = id + 1;
      board.items.push(item);
      await this.commit(board);
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
    // Run fields and the plan decision are engine-written; a patch naming any other field is refused, never silently ignored.
    const unknown = keys.filter((key) => !UPDATABLE_FIELDS.has(key));
    if (unknown.length > 0) {
      return { status: "invalid", itemId: id, reason: `fields not updatable: ${unknown.join(", ")}` };
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
      const board = await this.readBoard();
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
      await this.commit(board);
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
    expectedRevision?: string,
  ): Promise<WorkItemTransitionResult> {
    if (!isStatus(to)) {
      return { status: "invalid", itemId: id, reason: `invalid target status: ${String(to)}` };
    }
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const current = board.items[idx];
      if (expectedRevision !== undefined && expectedRevision !== mutationRevision(current)) {
        this.cache = board;
        return { status: "invalid" as const, itemId: id, reason: "work-item-changed" };
      }
      // Reopening a settled result has the derived Review destination.
      const target = current.status === "completed" && current.runStatus === "completed" && current.output?.trim() && to === "in_progress" ? "review" : to;
      const refusal = workBoardMoveRefusal(current, target);
      if (refusal) {
        this.cache = board;
        return { status: "invalid" as const, itemId: id, reason: refusal };
      }
      const from = current.status;
      const updated: WorkItem = { ...board.items[idx], status: to, updated_at: iso };
      if (to === "completed") updated.completed_at = iso;
      else delete updated.completed_at;
      board.items[idx] = updated;
      await this.commit(board);
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
  async complete(id: number, expectedRevision?: string): Promise<WorkItemCompleteResult> {
    const result = await this.transition(id, "completed", "completed", expectedRevision);
    if (result.status === "transitioned") {
      return { status: "completed", itemId: result.itemId, item: result.item };
    }
    return result;
  }

  // Transition back to `in_progress`, mapping the envelope to a reopen result.
  async reopen(id: number, expectedRevision?: string): Promise<WorkItemReopenResult> {
    const result = await this.transition(id, "in_progress", "reopened", expectedRevision);
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
      const board = await this.readBoard();
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
      await this.commit(board);
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

  // Start a fresh capped history entry and reset latest fields without overwriting prior history or transcripts. A template run
  // stores its pin, start authority and stage state in the run file first; the row then names that run by runId and nothing else.
  async beginRun(id: number, runId: string, startedAt: string, pin?: TemplateRunStart): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const prior = board.items[idx];
      if (prior.templateId !== undefined && !pin) {
        this.cache = board;
        return { status: "invalid" as const, itemId: id, reason: "template-run-unavailable" };
      }
      if (pin) requireTemplate(prior.templateId === pin.templateId && pin.source !== undefined, "invalid-template-run");
      if (pin?.source.kind === "local-create-and-run") requireTemplate(projectRootKey(pin.source.projectRoot) === projectRootKey(prior.projectRoot), "project-mismatch");
      if (prior.status === "completed") {
        this.cache = board;
        return { status: "invalid" as const, itemId: id, reason: "work-item-completed" };
      }
      // Judged against the board as it is on disk until the row write below lands.
      const retain = this.retention((await readBoardOnDisk(this.filePath))?.standing ?? (() => "unreadable"));
      if (pin) {
        const stored = await this.runs.put(structuredClone({
          runId, itemId: id, pin: { templateId: pin.templateId, version: pin.version, graphHash: pin.graphHash },
          runStartedBy: pin.source, startedAt, stageRuns: pin.stageRuns,
        }), retain);
        if (stored.status !== "stored") {
          this.cache = board;
          return { status: "invalid" as const, itemId: id, reason: stored.status === "pending-review" ? "template-runs-pending-review" : stored.status === "too-large" ? "template-runs-too-large" : "invalid-template-run" };
        }
      }
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
      delete updated.planApproval;
      board.items[idx] = updated;
      try { await this.commit(board); }
      catch (error) {
        if (pin) await this.settleUnstarted(id, runId).catch((cleanup: Error) => log.warn("[work-board-store] a failed run start was not settled: %s", cleanup.message));
        throw error;
      }
      // The run this row named until now is in its history only from this write on.
      if (pin) await this.pruneAfterWrite(this.retention(boardStanding(board)));
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
  // A crash is not a user stop, so it never becomes cancelled; terminal statuses (cancelled included) are left as they are. A row
  // that names a template run is left to the engine, which adopts the run back from its record.
  async reconcileInterruptedRuns(): Promise<number> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const iso = new Date(this.now()).toISOString();
      let count = 0;
      for (let i = 0; i < board.items.length; i++) {
        const it = board.items[i];
        if (namesTemplateRun(it)) continue;
        // A plan waiting for the user's decision belongs to no process: it stays, with its stored decision object, as long as that
        // object is whole and still matches the stored plan. Anything less cannot be decided safely and becomes error like the rest.
        if (it.runStatus === "awaiting_approval" && isDecidablePlan(it)) continue;
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
      if (count > 0) await this.commit(board);
      else this.cache = board;
      if (count > 0) log.info("[work-board-store] reconciled %d interrupted run(s) → error", count);
      return count;
    });
  }

  // Point the run at the execute child once it links. Only the session id changes: the phase is already `executing` and its activity
  // entry was written by setRunStatus, so this write appends no activity (a second entry would duplicate the run in reports).
  async setRunSessionId(id: number, runSessionId: string): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const updated: WorkItem = {
        ...board.items[idx],
        runSessionId,
        runUpdatedAt: new Date(nowMs).toISOString(),
      };
      board.items[idx] = updated;
      await this.commit(board);
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  // Only the engine writes terminal results; undefined preserves fields, null clears them, and values replace them.
  // Clear stale plan/output/session fields so a failed new run cannot display an old success.
  async setRunResult(id: number, result: RunResultPatch): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const updated = withRunResult(board.items[idx], result, iso);
      board.items[idx] = updated;
      await this.commit(board);
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

  // The plan child finished: store the plan and its pending decision in one write, so no reader (or a restart) ever sees a run awaiting
  // approval without the decision object. `itemDigest` is the digest of the item snapshot the plan prompt was built from, never the
  // item as it is now: an edit made while the child was planning must leave the plan stale. Refused (null) when the run moved on.
  async setPlanAwaitingApproval(
    id: number,
    input: { runId: string; plan: string; runSessionId: string; revision: number; itemDigest: string; agentName?: string },
  ): Promise<WorkItemUpdateResult | null> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const current = board.items[idx];
      if (current.runId !== input.runId || current.runStatus !== "planning") {
        this.cache = board;
        return null;
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const updated = withRunResult(current, { runStatus: "awaiting_approval", plan: input.plan, runSessionId: input.runSessionId }, iso);
      updated.planApproval = {
        runId: input.runId,
        planHash: planHashOf(input.plan),
        itemDigest: input.itemDigest,
        requestedAt: iso,
        status: "pending",
        revision: input.revision,
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      };
      board.items[idx] = updated;
      await this.commit(board);
      await appendActivity(this.activity, {
        kind: runStatusActivityKind("awaiting_approval"),
        itemId: updated.id,
        title: updated.title,
        to: "awaiting_approval",
        ts: iso,
      });
      return { status: "updated" as const, itemId: id, item: decorate(cloneItem(updated), nowMs) };
    });
  }

  // Record the user's decision on the pending plan. Every check runs inside the board lock against the stored item, so two decisions for
  // the same plan cannot both pass: the second finds the approval no longer pending. The decision is written before anything acts on it;
  // approve moves the run to executing and request_changes back to planning in the same write, and reject ends the run as denied.
  async decidePlan(id: number, input: PlanDecisionInput): Promise<PlanDecisionResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      // The board is mutated below, so the cache takes it only after the write lands; a refusal caches the board as read.
      const refuse = (reason: Extract<PlanDecisionResult, { status: "refused" }>["reason"]): PlanDecisionResult => {
        this.cache = board;
        return { status: "refused" as const, reason };
      };
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) return refuse("not_found");
      const current = board.items[idx];
      const approval = current.planApproval;
      if (
        current.runStatus !== "awaiting_approval" ||
        approval === undefined ||
        approval.status !== "pending" ||
        current.runId !== input.runId ||
        approval.runId !== input.runId
      ) {
        return refuse("not_pending");
      }
      if (typeof current.plan !== "string" || approval.planHash !== planHashOf(current.plan) || input.planHash !== approval.planHash) {
        return refuse("plan_mismatch");
      }
      // A stale plan can still be sent back for changes (that re-plans the current item) or rejected; it cannot be approved.
      if (input.status === "approved" && approval.itemDigest !== itemDigestOf(current)) {
        return refuse("plan_stale");
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const decided: WorkPlanApproval = {
        ...approval,
        status: input.status,
        decidedAt: iso,
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      if (input.note === undefined) delete decided.note;
      const nextRunStatus: WorkItemRunStatus =
        input.status === "approved" ? "executing" : input.status === "rejected" ? "denied" : "planning";
      const updated = withRunResult(current, { runStatus: nextRunStatus }, iso);
      updated.planApproval = decided;
      board.items[idx] = updated;
      await this.commit(board);
      await appendActivity(this.activity, {
        kind: runStatusActivityKind(nextRunStatus),
        itemId: updated.id,
        title: updated.title,
        to: nextRunStatus,
        ts: iso,
      });
      return { status: "decided" as const, item: decorate(cloneItem(updated), nowMs), planApproval: { ...decided } };
    });
  }

  async remove(id: number): Promise<WorkItemDeleteResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard();
      const item = board.items.find((i) => i.id === id);
      if (!item) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      board.items = board.items.filter((i) => i.id !== id);
      await this.commit(board);
      if (item.templateId !== undefined) await this.pruneAfterWrite(this.retention(boardStanding(board)));
      await appendActivity(this.activity, {
        kind: "deleted",
        itemId: id,
        title: item.title,
        ts: new Date(this.now()).toISOString(),
      });
      return { status: "deleted" as const, itemId: id };
    });
  }

  /** Delete, as an invalid card asks, every entry of the board file that does not validate and has `id` (valid twins included); a listed
   * row with that id stays. Every such entry must pass `allowed`, or none is deleted. The file as it was is copied beside it first; there
   * is no undo. */
  async removeUnreadable(id: number, allowed: (row: unknown) => boolean): Promise<WorkItemDeleteResult> {
    await this.ensureLoaded();
    return withInProcessFileQueue(this.filePath, async () => {
      const board = await this.readBoard(true);
      const rows = board.unreadable.filter((row) => rowIdOf(row) === id);
      if (rows.length === 0 || !rows.every(allowed)) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      board.unreadable = board.unreadable.filter((row) => !rows.includes(row));
      await this.commit(board);
      await this.pruneAfterWrite(this.retention(boardStanding(board)));
      const title = (rows[0] as { title?: unknown }).title;
      await appendActivity(this.activity, {
        kind: "deleted",
        itemId: id,
        ...(typeof title === "string" ? { title } : {}),
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
  // stale proposal still stops being shown.
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
    this.proposalsChanged.emit();
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

  // User-requested briefing output uses per-run and global caps.
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

  // Turn an accepted proposal into a work item through the ORDINARY create path — same validation and the same activity row as a card the
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
