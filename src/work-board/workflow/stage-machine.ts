import type { WorkPlanDecision } from "../../shared/work-board-types.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import type { StageJoin, TemplateGraph, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import type { JoinConflict, StageFailure } from "./shipped-shapes.js";
import { currentStepOf, joinIdOfStep, readyStages, stepsOf } from "./stage-graph.js";

/** A reissued conflict is a new decision even when the sealed inputs and diagnostics are identical. */
export function issueJoinConflict(join: StageJoin, conflict: JoinConflict): StageJoin {
  const conflictGeneration = (join.conflictGeneration ?? 0) + 1;
  return {
    ...join,
    status: "conflict",
    conflictGeneration,
    conflict: { ...conflict, conflictHash: resultHashOf(JSON.stringify([conflict.conflictHash, conflictGeneration])) },
  };
}

export const MAX_PARALLEL_STAGES = 3;
export const MAX_STAGE_ATTEMPTS = 3;

export type RunEvent =
  | { type: "started" } | { type: "stage_linked"; stageId: string; childSessionId: string }
  | { type: "stage_ended"; stageId: string; attempt: number; ok: boolean; output?: string; taint?: WorkItemStageRun["taint"]; reason?: string; interrupted?: boolean; failure?: StageFailure }
  | { type: "gate_evaluated"; stageId: string; attempt: number; passed: boolean; evidence: string; judgedBy: "host" | "model" }
  | { type: "gate_decided"; stageId: string; attempt: number; decision: WorkPlanDecision; note?: string }
  | { type: "retry_requested"; stageId: string } | { type: "continue_requested" } | { type: "stop_requested" }
  | { type: "join_integrated"; joinId: string } | { type: "join_conflict"; joinId: string; conflict: JoinConflict }
  | { type: "join_decided"; joinId: string; decision: "retry_merge" | "reject" }
  // Host outcomes of an effect: the run's source is no longer authorised, a passed stage could not be sealed, the pin or wiring failed.
  | { type: "spawn_requested"; stageId: string; attempt: number } | { type: "spawn_refused"; stageId: string; attempt: number } | { type: "seal_failed"; stageId: string } | { type: "fault" };

export type RunEffect =
  | { type: "spawn"; stageId: string; attempt: number } | { type: "evaluate_gate"; stageId: string; attempt: number }
  | { type: "interrupt"; stageId: string } | { type: "seal"; stageId: string } | { type: "integrate"; joinId: string; stageIds: string[] }
  | { type: "settle"; runStatus: "completed" | "denied" | "error" | "cancelled" } | { type: "release_workspace"; stageIds: string[] };

export interface RunSnapshot {
  graph: TemplateGraph;
  stageRuns: readonly WorkItemStageRun[];
  joins: readonly StageJoin[];
  /** The user asked to stop this run. */
  stopping: boolean;
  /** A spawn of this run was refused by the run authority; nothing more starts and no gate opens. */
  refused: boolean;
  /** The pin, the run state or the wiring failed. Like a stop, it starts nothing more; the run ends `error` once no child is live. */
  faulted?: boolean;
  /** Recovery may finish an existing join while leaving the next child for an explicit continuation. */
  parked?: boolean;
  now: string;
}

export interface RunStep {
  stageRuns: WorkItemStageRun[];
  joins: StageJoin[];
  runStatus: "executing" | "completed" | "denied" | "error" | "cancelled";
  effects: RunEffect[];
}

function rerun(run: WorkItemStageRun): void {
  run.attempt += 1;
  run.status = "waiting";
  for (const key of ["failure", "resultHash", "childSessionId", "startedAt", "endedAt", "blocked"] as const) delete run[key];
}

/** The whole scheduler as one pure step. It never spawns, writes or reads a clock; the engine runs the effects it returns. */
export function reduceRun(snapshot: RunSnapshot, event: RunEvent): RunStep {
  const { graph, now } = snapshot;
  const stageRuns = snapshot.stageRuns.map(run => ({ ...run }));
  const joins = snapshot.joins.map(join => ({ ...join }));
  const effects: RunEffect[] = [];
  const find = (stageId: string): WorkItemStageRun | undefined => stageRuns.find(run => run.stageId === stageId);
  const denied = (): boolean => stageRuns.some(run => run.status === "rejected") || joins.some(join => join.status === "rejected");
  const faulted = snapshot.faulted === true || event.type === "fault";
  const winding = (): boolean => snapshot.stopping || snapshot.refused || faulted || denied();
  const interruptRunning = (): void => {
    for (const run of stageRuns) if (run.status === "running") effects.push({ type: "interrupt", stageId: run.stageId });
  };
  const settle = (runStatus: Exclude<RunStep["runStatus"], "executing">): RunStep => {
    effects.push({ type: "settle", runStatus }, { type: "release_workspace", stageIds: stageRuns.map(run => run.stageId) });
    return { stageRuns, joins, runStatus, effects };
  };

  switch (event.type) {
    case "started":
    case "continue_requested":
      break;
    case "fault":
      // A live child is never left behind: each is interrupted, and the run ends when the last one has unwound.
      interruptRunning();
      break;
    case "stage_linked": {
      const run = find(event.stageId);
      if (run?.status === "running") run.childSessionId = event.childSessionId;
      break;
    }
    case "stage_ended": {
      const run = find(event.stageId);
      if (run?.status !== "running" || run.attempt !== event.attempt) break;
      run.endedAt = now;
      if (event.output !== undefined) run.output = event.output;
      if (event.taint) run.taint = event.taint;
      if (winding()) run.status = "cancelled";
      else if (!event.ok) {
        run.status = "failed";
        run.failure = event.failure ?? (event.interrupted ? "interrupted" : "error");
      } else if (graph.stages.find(stage => stage.id === run.stageId)?.gate.type === "human") {
        run.output ??= "";
        run.status = "awaiting_gate";
        run.resultHash = resultHashOf(run.output);
        run.gate = { type: "human", status: "pending", revision: run.attempt - 1 };
      } else {
        run.output ??= "";
        effects.push({ type: "evaluate_gate", stageId: run.stageId, attempt: run.attempt });
      }
      break;
    }
    case "gate_evaluated": {
      const run = find(event.stageId);
      if (run?.status !== "running" || run.attempt !== event.attempt) break;
      run.gate = { type: "auto", passed: event.passed, evidence: event.evidence, evaluatedAt: now, judgedBy: event.judgedBy };
      if (winding()) run.status = "cancelled";
      else if (event.passed) {
        run.status = "passed";
        effects.push({ type: "seal", stageId: run.stageId });
      } else {
        run.status = "failed";
        run.failure = "gate";
      }
      break;
    }
    case "gate_decided": {
      const run = find(event.stageId);
      if (run?.status !== "awaiting_gate" || run.attempt !== event.attempt || run.gate?.type !== "human" || run.gate.status !== "pending" || winding()) break;
      const decided = { type: "human" as const, revision: run.gate.revision, decidedAt: now, ...(event.note !== undefined ? { note: event.note } : {}) };
      if (event.decision === "approve") {
        run.status = "passed";
        run.gate = { ...decided, status: "approved" };
        effects.push({ type: "seal", stageId: run.stageId });
      } else if (event.decision === "reject") {
        run.status = "rejected";
        run.gate = { ...decided, status: "rejected" };
        interruptRunning();
      } else if (run.attempt < MAX_STAGE_ATTEMPTS) {
        // The prior output and the note stay on the stage run; the next attempt's prompt quotes them as fenced data.
        rerun(run);
        run.gate = { ...decided, status: "changes_requested" };
      }
      break;
    }
    case "retry_requested": {
      const run = find(event.stageId);
      if (run?.status !== "failed" || run.attempt >= MAX_STAGE_ATTEMPTS || winding()) break;
      rerun(run);
      if (run.gate?.type === "auto") delete run.gate;
      break;
    }
    case "stop_requested":
      for (const run of stageRuns) if (run.status === "awaiting_gate") run.status = "cancelled";
      interruptRunning();
      break;
    case "spawn_requested": {
      const run = find(event.stageId);
      if (run?.status === "running" && run.attempt === event.attempt && !winding()) effects.push({ type: "spawn", stageId: event.stageId, attempt: event.attempt });
      break;
    }
    case "spawn_refused": {
      const run = find(event.stageId);
      if (run?.status === "running" && run.attempt === event.attempt) run.status = "cancelled";
      for (const other of stageRuns) if (other.status === "awaiting_gate") other.status = "cancelled";
      break;
    }
    case "seal_failed": {
      const run = find(event.stageId);
      if (run?.status !== "passed") break;
      run.status = "failed";
      run.failure = "error";
      const open = joins.findIndex(join => join.status === "integrating" && join.stageIds.includes(event.stageId));
      if (open !== -1) joins.splice(open, 1);
      break;
    }
    case "join_integrated": {
      const join = joins.find(candidate => candidate.joinId === event.joinId);
      if (join?.status === "integrating") join.status = "integrated";
      break;
    }
    case "join_conflict": {
      const join = joins.find(candidate => candidate.joinId === event.joinId);
      if (join?.status !== "integrating") break;
      Object.assign(join, issueJoinConflict(join, event.conflict));
      break;
    }
    case "join_decided": {
      const join = joins.find(candidate => candidate.joinId === event.joinId);
      if (join?.status !== "conflict" || winding()) break;
      join.decidedAt = now;
      if (event.decision === "reject") join.status = "rejected";
      else {
        join.status = "integrating";
        delete join.conflict;
        effects.push({ type: "integrate", joinId: join.joinId, stageIds: [...join.stageIds] });
      }
      break;
    }
  }

  if (winding()) {
    if (stageRuns.some(run => run.status === "running")) return { stageRuns, joins, runStatus: "executing", effects };
    for (const run of stageRuns) if (run.status === "waiting" || run.status === "awaiting_gate") run.status = "cancelled";
    return settle(snapshot.stopping ? "cancelled" : faulted ? "error" : snapshot.refused ? "cancelled" : "denied");
  }

  const steps = stepsOf(graph);
  const current = currentStepOf(graph, joins);
  if (current >= steps.length) return settle("completed");
  const step = steps[current];
  const joinId = joinIdOfStep(current);
  if (!joins.some(join => join.joinId === joinId) && step.every(id => find(id)?.status === "passed")) {
    // Collected after every step, one-stage steps included: the next step's workspaces start from the collected result.
    joins.push({ joinId, stageIds: [...step], status: "integrating" });
    effects.push({ type: "integrate", joinId, stageIds: [...step] });
  } else {
    let slots = MAX_PARALLEL_STAGES - stageRuns.filter(run => run.status === "running").length;
    for (const id of snapshot.parked ? [] : readyStages(graph, stageRuns, joins)) {
      const run = find(id);
      if (slots <= 0 || !run) continue;
      run.status = "running";
      run.startedAt = now;
      slots -= 1;
      effects.push({ type: "spawn", stageId: id, attempt: run.attempt });
    }
  }
  return { stageRuns, joins, runStatus: "executing", effects };
}
