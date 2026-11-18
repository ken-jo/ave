import type { RunClass } from "../../main/run-classification.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import type { DeleteIntent, RunEnd, RunRemovalCause } from "../../main/workflow-run-store.js";
import type { WorkItemResolved, WorkItemUpdateResult } from "../../shared/work-board-types.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import type { StageJoin, TemplateRunStart, WorkflowRunReadResult, WorkflowRunRecord, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import { WorkflowTemplateError } from "../template-graph.js";

/** Everything a template run is decided from. It lives in the covered run file, keyed by `runId`; a board row names a run only by that id
 * and nothing on a board row is ever read as one of these fields. */
export type RunRecord = WorkflowRunRecord;

/** row-gone: the board on disk lists no row with the run's id, or the row names a newer run. row-lost: the row is there without naming or
 * holding the run. board-unread: the board file shows nothing, or the row does not validate. refused: `mutate` returned null. pending-review
 * and too-large: the run file awaits review, or the write would take it past its read limit. invalid: the stored run cannot be read.
 * unavailable: the run is not in the run file. cause-refused: the run's class, read again inside the write, does not allow how it was to
 * end; nothing was written. */
export type RunWriteFailure = "row-gone" | "row-lost" | "board-unread" | "refused" | "pending-review" | "too-large" | "invalid" | "unavailable" | "cause-refused";
type RunWrite = { ok: true; run: RunRecord } | { ok: false; reason: RunWriteFailure };

type RunAdoption = {
  ok: true;
  /** Every board row that names a template run, with that run: null when the run file holds no readable run of that row under that id. */
  named: { item: WorkItemResolved; run: RunRecord | null }[];
  /** Workspace identities that must survive sweeping; undefined defers the sweep. */
  keepWorkspaces: readonly string[] | undefined;
  /** Unsettled runs no adopted row names, by class (see classifyRun): `orphans`, `lost`, `removed` (due-delete) and `kept`, every other
   * class (waiting-delete, unreadable, and live where the board on disk names the run though the board as read did not). */
  orphans: RunRecord[];
  lost: RunRecord[];
  kept: RunRecord[];
  removed: RunRecord[];
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
  /** One atomic read-modify-write, under the board lock; `mutate` may end the run (a RunEnd). Without `removedAs` it runs only for the run
   * the row names, and ends it only by the row's causes; with it, by run id alone, for a run whose row was removed or lost, and ends it
   * only as that cause while its class allows it. */
  update(itemId: number, runId: string, mutate: (run: RunRecord) => RunRecord | RunEnd | null, removedAs?: RunRemovalCause): Promise<RunWrite>;
  /** Ends a run whose start failed before its row write was known to land: `settled` once the run is over (or the file no longer holds
   * it), `named` when the board on disk shows the row naming it after all, so it ends as any stored run does. */
  settleUnstarted(itemId: number, runId: string): Promise<"settled" | "named" | RunWriteFailure>;
  /** One read of the run file: the run a row names, or null as for `get`. */
  view(): Promise<(row: { id: number; runId?: string }) => RunRecord | null>;
  /** What boot adopts, classifying every unsettled candidate from the run file and the board file on disk. */
  adoption(): Promise<RunAdoption>;
  /** The run file's open delete intents, split by the store's one rule: `due`, the unsettled runs whose row a user's delete took off the
   * board; `waiting`, the rest. The refusal code while the run file awaits review or the board file on disk shows nothing. */
  deleted(): Promise<{ due: DeleteIntent[]; waiting: DeleteIntent[] } | "template-runs-pending-review" | "template-runs-board-unread">;
  /** Removes the settled runs no row lists any more. */
  pruneSettled(): Promise<void>;
  /** The class of each unsettled run (see classifyRun). The refusal code while the run file awaits review or the board file on disk shows
   * nothing. */
  classes(): Promise<((run: { itemId: number; runId: string }) => RunClass) | "template-runs-pending-review" | "template-runs-board-unread">;
}

/** Run state in the board store's run file. The record is used as stored: there is no second shape. */
export function boardRunState(store: Pick<WorkBoardStore, "beginRun" | "updateRun" | "settleRemovedRun" | "settleUnstartedRun" | "list" | "runs" | "pruneSettledRuns" | "runClasses" | "deleteIntentsOnDisk">): WorkflowRunState {
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
    update: async (itemId, runId, mutate, removedAs) => {
      try {
        const result = removedAs
          ? await store.settleRemovedRun(itemId, runId, removedAs, mutate)
          : await store.updateRun(itemId, runId, mutate);
        if (result.status === "stored") return { ok: true, run: result.run };
        if (result.status === "not-found") return { ok: false, reason: removedAs ? "unavailable" : "row-gone" };
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
      const { keepWorkspaces } = await store.runs.view();
      const listed = await store.list();
      if (listed.status !== "ok") return { ok: false, code: "template-runs-board-unread" };
      const classOf = await store.runClasses();
      if (typeof classOf === "string") return { ok: false, code: classOf };
      const classes = new Map(stored.runs.filter(run => run.settled === undefined).map(run => [run.runId, classOf(run)]));
      const byId = new Map(stored.runs.map(run => [run.runId, run]));
      const named = listed.items.filter(item => item.templateId !== undefined && item.runId !== undefined).map((item) => {
        const run = byId.get(item.runId ?? "");
        return { item, run: run?.itemId === item.id && (run.settled !== undefined || classes.get(run.runId) === "live") ? run : null };
      });
      const adopted = new Set(named.flatMap(({ run }) => run ? [run.runId] : []));
      const rest = stored.runs.filter(run => !adopted.has(run.runId) && run.settled === undefined);
      const of = (...allowed: RunClass[]) => rest.filter(run => allowed.includes(classes.get(run.runId) as RunClass));
      return { ok: true, named, keepWorkspaces, orphans: of("orphan"), lost: of("lost"), kept: of("waiting-delete", "unreadable", "live"), removed: of("due-delete") };
    },
    deleted: () => store.deleteIntentsOnDisk(),
    pruneSettled: () => store.pruneSettledRuns(),
    classes: () => store.runClasses(),
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
