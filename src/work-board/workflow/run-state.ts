import type { WorkBoardStore } from "../../main/work-board-store.js";
import type { WorkItemResolved, WorkItemUpdateResult } from "../../shared/work-board-types.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import type { StageJoin, TemplateRunStart, WorkflowRunReadResult, WorkflowRunRecord, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import { WorkflowTemplateError } from "../template-graph.js";

/** Everything a template run is decided from. It lives in the covered run file, keyed by `runId`; a board row names a run only by that id
 * and nothing on a board row is ever read as one of these fields. */
export type RunRecord = WorkflowRunRecord;

/** row-gone: the board on disk shows the run's row gone, as boot reads it. row-lost: the board on disk shows the row lost with a board it
 * replaced. board-unread: the board file is missing or unreadable, or shows neither. refused: `mutate` returned null. pending-review and too-large: the run file awaits review,
 * or the write would take it past its read limit. invalid: the stored run cannot be read. unavailable: the run is not in the run file. */
export type RunWriteFailure = "row-gone" | "row-lost" | "board-unread" | "refused" | "pending-review" | "too-large" | "invalid" | "unavailable";
type RunWrite = { ok: true; run: RunRecord } | { ok: false; reason: RunWriteFailure };

type RunAdoption = {
  ok: true;
  /** Every board row that names a template run, with that run: null when the run file holds no readable run of that row under that id. */
  named: { item: WorkItemResolved; run: RunRecord | null }[];
  /** Stored runs whose row the board on disk shows gone or naming another run. */
  orphans: RunRecord[];
  /** Stored runs whose row the board on disk shows lost with a board it replaced. */
  lost: RunRecord[];
  /** Stored runs no row names that the board on disk shows neither gone nor lost: a row id it never issued, or a row that does not validate. */
  kept: RunRecord[];
} | { ok: false; code: "template-runs-pending-review" | "template-runs-board-unread" };

/** The one reader and writer of run state the stage scheduler uses. */
export interface WorkflowRunState {
  /** Stores the new run in the run file, then names it on the board row, under the board lock. */
  begin(itemId: number, runId: string, startedAt: string, start: TemplateRunStart): Promise<WorkItemUpdateResult>;
  /** The stored run of that row, read by run id whether or not the row still exists. Null when it is missing, unreadable, awaits review or
   * belongs to another row. */
  get(itemId: number, runId: string): Promise<RunRecord | null>;
  /** As `get`, with how the read went: a run stored for another row reads `invalid`. */
  read(itemId: number, runId: string): Promise<WorkflowRunReadResult>;
  /** One atomic read-modify-write. While the row exists it runs under the board lock and only for the run the row names; `rowGone` writes
   * by run id alone, for a run whose row was deleted. */
  update(itemId: number, runId: string, mutate: (run: RunRecord) => RunRecord | null, rowGone?: boolean): Promise<RunWrite>;
  /** Ends a run whose start failed before its row write was known to land: `settled` once the run is over (or the file no longer holds
   * it), `named` when the board on disk shows the row naming it after all, so it ends as any stored run does. */
  settleUnstarted(itemId: number, runId: string): Promise<"settled" | "named" | RunWriteFailure>;
  /** One read of the run file: the run a row names, or null as for `get`. */
  view(): Promise<(row: { id: number; runId?: string }) => RunRecord | null>;
  /** What boot adopts, from one read of the run file and, when a stored run is named by no row, of the board file on disk. */
  adoption(): Promise<RunAdoption>;
  /** Removes the settled runs no row lists any more. */
  pruneSettled(): Promise<void>;
  /** Whether the board file on disk shows a run's row gone, as boot reads it. Undefined when that board proves nothing. */
  rowGone(): Promise<((run: { itemId: number; runId: string }) => boolean) | undefined>;
}

/** Run state in the board store's run file. The record is used as stored: there is no second shape. */
export function boardRunState(store: Pick<WorkBoardStore, "beginRun" | "updateRun" | "settleUnstartedRun" | "list" | "runs" | "pruneSettledRuns" | "runRowGoneOnDisk" | "runRowLostOnDisk">): WorkflowRunState {
  const view: WorkflowRunState["view"] = async () => {
    const runs = await store.runs.view();
    return (row) => {
      if (row.runId === undefined) return null;
      const read = runs.get(row.runId);
      return read.status === "found" && read.run.itemId === row.id ? read.run : null;
    };
  };
  return {
    begin: (itemId, runId, startedAt, start) => store.beginRun(itemId, runId, startedAt, start),
    get: async (itemId, runId) => (await view())({ id: itemId, runId }),
    read: async (itemId, runId) => {
      const read = (await store.runs.view()).get(runId);
      return read.status === "found" && read.run.itemId !== itemId ? { status: "invalid" } : read;
    },
    update: async (itemId, runId, mutate, rowGone = false) => {
      try {
        const result = rowGone
          ? await store.runs.update(runId, run => run.itemId === itemId ? mutate(run) : null)
          : await store.updateRun(itemId, runId, mutate);
        if (result.status === "stored") return { ok: true, run: result.run };
        if (result.status === "not-found") return { ok: false, reason: rowGone ? "unavailable" : "row-gone" };
        return { ok: false, reason: result.status };
      } catch (error) {
        // The store refuses a record it does not understand by throwing; nothing was written.
        if (error instanceof WorkflowTemplateError) return { ok: false, reason: "invalid" };
        throw error;
      }
    },
    settleUnstarted: async (itemId, runId) => {
      try {
        const result = await store.settleUnstartedRun(itemId, runId);
        if (result.status === "stored" || result.status === "refused" || result.status === "not-found") return "settled";
        return result.status;
      } catch (error) {
        if (error instanceof WorkflowTemplateError) return "invalid";
        throw error;
      }
    },
    view,
    adoption: async () => {
      const stored = await store.runs.list();
      if (stored.status !== "found") return { ok: false, code: "template-runs-pending-review" };
      const listed = await store.list();
      if (listed.status !== "ok") return { ok: false, code: "template-runs-board-unread" };
      const byId = new Map(stored.runs.map(run => [run.runId, run]));
      const named = listed.items.filter(item => item.templateId !== undefined && item.runId !== undefined).map((item) => {
        const run = byId.get(item.runId ?? "");
        return { item, run: run?.itemId === item.id ? run : null };
      });
      const adopted = new Set(named.flatMap(({ run }) => run ? [run.runId] : []));
      const rest = stored.runs.filter(run => !adopted.has(run.runId));
      if (rest.length === 0) return { ok: true, named, orphans: [], lost: [], kept: [] };
      // The listed board may be one seeded empty after the file went missing or was damaged: only the file on disk tells a deleted row.
      const gone = await store.runRowGoneOnDisk();
      const lost = await store.runRowLostOnDisk();
      if (!gone || !lost) return { ok: false, code: "template-runs-board-unread" };
      const left = rest.filter(run => !gone(run));
      return { ok: true, named, orphans: rest.filter(gone), lost: left.filter(lost), kept: left.filter(run => !lost(run)) };
    },
    pruneSettled: () => store.pruneSettledRuns(),
    rowGone: () => store.runRowGoneOnDisk(),
  };
}

/** A template run waits for the user: a stage is at its gate, or a join could not be collected. */
export function isAwaitingStageReview(run: Pick<RunRecord, "settled" | "stageRuns" | "stageJoins">): boolean {
  if (run.settled !== undefined) return false;
  return run.stageRuns.some(stage => stage.status === "awaiting_gate") || (run.stageJoins ?? []).some(join => join.status === "conflict");
}

/** What a restart leaves of an unsettled run: a run that waits for the user, and nothing starts. A stage that was running lost its child
 * and fails as interrupted; a gate stays only while its stored output still matches its hash; a join that was being collected becomes a
 * conflict the user decides; a kept stage whose workspace folder is gone fails as workspace-lost. Null when nothing changes. */
export async function reconcileRunRecord(run: RunRecord, now: string, folderExists: (root: string) => Promise<boolean>): Promise<RunRecord | null> {
  let changed = false;
  const joins = run.stageJoins ?? [];
  const collected = new Set(joins.filter(join => join.status === "integrated").flatMap(join => join.stageIds));
  const stageRuns: WorkItemStageRun[] = [];
  for (const stage of run.stageRuns) {
    const gateWhole = stage.status === "awaiting_gate" && typeof stage.output === "string" && stage.resultHash === resultHashOf(stage.output);
    const kept = gateWhole || (stage.status === "passed" && !collected.has(stage.stageId));
    let failure: WorkItemStageRun["failure"];
    if (stage.status === "running" || (stage.status === "awaiting_gate" && !gateWhole)) failure = "interrupted";
    else if (kept && stage.workspace && !(await folderExists(stage.workspace.root))) failure = "workspace-lost";
    if (failure === undefined) {
      stageRuns.push(stage);
      continue;
    }
    changed = true;
    const failed: WorkItemStageRun = { ...stage, status: "failed", failure, endedAt: stage.endedAt ?? now };
    delete failed.resultHash;
    stageRuns.push(failed);
  }
  const stageJoins = joins.map((join): StageJoin => {
    if (join.status !== "integrating") return join;
    changed = true;
    return { ...join, status: "conflict", conflict: { conflictHash: resultHashOf(`${run.runId}:${join.joinId}:interrupted`), reason: "interrupted", files: [] } };
  });
  return changed ? { ...run, stageRuns, stageJoins } : null;
}
