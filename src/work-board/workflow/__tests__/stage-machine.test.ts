import { describe, expect, it } from "vitest";
import type { StageJoin, TemplateGraph, WorkItemStageRun } from "../../../shared/workflow-template-types.js";
import { MAX_PARALLEL_STAGES, reduceRun, type RunEffect, type RunEvent } from "../stage-machine.js";
import { graphOf, stageOf, waitingRuns } from "./stage-fixtures.js";

/** Drive the reducer the way the engine does: feed an event, keep the state, collect the effects. */
function driver(graph: TemplateGraph) {
  let stageRuns: WorkItemStageRun[] = waitingRuns(graph);
  let joins: StageJoin[] = [];
  let runStatus = "executing";
  const flags = { stopping: false, refused: false };
  const send = (event: RunEvent): RunEffect[] => {
    const step = reduceRun({ graph, stageRuns, joins, ...flags, now: "2026-11-16T00:00:00.000Z" }, event);
    ({ stageRuns, joins, runStatus } = step);
    return step.effects;
  };
  return {
    send, flags,
    status: (id: string) => stageRuns.find(run => run.stageId === id)?.status,
    run: (id: string) => stageRuns.find(run => run.stageId === id),
    runStatus: () => runStatus,
    joins: () => joins,
  };
}
const spawned = (effects: RunEffect[]): string[] => effects.flatMap(effect => effect.type === "spawn" ? [effect.stageId] : []);
const ended = (stageId: string, attempt = 1, ok = true): RunEvent => ({ type: "stage_ended", stageId, attempt, ok, output: `out-${stageId}-${attempt}` });

describe("stage machine", () => {
  it("starts every ready stage of a step together up to the cap", () => {
    const d = driver(graphOf([stageOf("a"), stageOf("b"), stageOf("c"), stageOf("d"), stageOf("z", { inputs: ["a"] })]));
    expect(spawned(d.send({ type: "started" }))).toEqual(["a", "b", "c"]);
    expect(MAX_PARALLEL_STAGES).toBe(3);
    expect(d.status("d")).toBe("waiting");
    expect(d.status("z")).toBe("waiting");
    // A freed slot starts the fourth; the next step stays closed until the whole step passed and was collected.
    expect(spawned(d.send(ended("a")))).toEqual(["d"]);
    expect(spawned(d.send({ type: "gate_decided", stageId: "a", attempt: 1, decision: "approve" }))).toEqual([]);
    expect(d.status("z")).toBe("waiting");
  });

  it("a failed stage keeps its siblings running and the join closed", () => {
    const d = driver(graphOf([stageOf("a"), stageOf("b"), stageOf("z", { inputs: ["a", "b"] })]));
    d.send({ type: "started" });
    const effects = d.send(ended("a", 1, false));
    expect(d.run("a")).toMatchObject({ status: "failed", failure: "error" });
    expect(d.status("b")).toBe("running");
    expect(effects).toEqual([]);
    d.send(ended("b"));
    const after = d.send({ type: "gate_decided", stageId: "b", attempt: 1, decision: "approve" });
    expect(after.some(effect => effect.type === "integrate")).toBe(false);
    expect(d.joins()).toEqual([]);
    expect(d.status("z")).toBe("waiting");
    expect(d.runStatus()).toBe("executing");
  });

  it("request changes reruns the same stage with attempt + 1 and refuses a fourth", () => {
    const d = driver(graphOf([stageOf("a")]));
    d.send({ type: "started" });
    for (const attempt of [1, 2]) {
      d.send(ended("a", attempt));
      expect(d.send({ type: "gate_decided", stageId: "a", attempt, decision: "request_changes", note: "more" })).toEqual([{ type: "spawn", stageId: "a", attempt: attempt + 1 }]);
      expect(d.run("a")).toMatchObject({ status: "running", attempt: attempt + 1, output: `out-a-${attempt}`, gate: { status: "changes_requested", note: "more" } });
    }
    d.send(ended("a", 3));
    expect(d.send({ type: "gate_decided", stageId: "a", attempt: 3, decision: "request_changes", note: "again" })).toEqual([]);
    expect(d.run("a")).toMatchObject({ status: "awaiting_gate", attempt: 3 });
    // A failed stage is retried the same way and is bounded the same way.
    const f = driver(graphOf([stageOf("a")]));
    f.send({ type: "started" });
    f.send(ended("a", 1, false));
    expect(spawned(f.send({ type: "retry_requested", stageId: "a" }))).toEqual(["a"]);
    f.send(ended("a", 2, false));
    f.send({ type: "retry_requested", stageId: "a" });
    f.send(ended("a", 3, false));
    expect(f.send({ type: "retry_requested", stageId: "a" })).toEqual([]);
    expect(f.run("a")).toMatchObject({ status: "failed", attempt: 3 });
  });

  it("reject settles the run denied and starts nothing later", () => {
    const d = driver(graphOf([stageOf("a"), stageOf("b"), stageOf("z", { inputs: ["a"] })]));
    d.send({ type: "started" });
    d.send(ended("a"));
    const rejected = d.send({ type: "gate_decided", stageId: "a", attempt: 1, decision: "reject" });
    expect(rejected).toEqual([{ type: "interrupt", stageId: "b" }]);
    expect(d.runStatus()).toBe("executing");
    const unwound = d.send({ type: "stage_ended", stageId: "b", attempt: 1, ok: false, interrupted: true });
    expect(unwound[0]).toEqual({ type: "settle", runStatus: "denied" });
    expect(spawned(unwound)).toEqual([]);
    expect([d.status("a"), d.status("b"), d.status("z")]).toEqual(["rejected", "cancelled", "cancelled"]);
  });

  it("stop cancels pending gates and settles cancelled after the last child unwinds", () => {
    const d = driver(graphOf([stageOf("a"), stageOf("b")]));
    d.send({ type: "started" });
    d.send(ended("a"));
    expect(d.status("a")).toBe("awaiting_gate");
    d.flags.stopping = true;
    expect(d.send({ type: "stop_requested" })).toEqual([{ type: "interrupt", stageId: "b" }]);
    expect(d.status("a")).toBe("cancelled");
    expect(d.runStatus()).toBe("executing");
    expect(d.send({ type: "gate_decided", stageId: "a", attempt: 1, decision: "approve" })).toEqual([]);
    const last = d.send({ type: "stage_ended", stageId: "b", attempt: 1, ok: false, interrupted: true });
    expect(last[0]).toEqual({ type: "settle", runStatus: "cancelled" });
    expect(d.status("b")).toBe("cancelled");
    // With no live child a stop settles at once: this is how a run parked across a restart is stopped.
    const parked = driver(graphOf([stageOf("a")]));
    parked.send({ type: "started" });
    parked.send(ended("a"));
    parked.flags.stopping = true;
    expect(parked.send({ type: "stop_requested" })[0]).toEqual({ type: "settle", runStatus: "cancelled" });
  });

  it("collects every step, then completes after the last one", () => {
    const d = driver(graphOf([stageOf("a", { gate: { type: "auto", pass: { kind: "stage_ok" } } }), stageOf("z", { inputs: ["a"] })]));
    d.send({ type: "started" });
    expect(d.send(ended("a"))).toEqual([{ type: "evaluate_gate", stageId: "a", attempt: 1 }]);
    expect(d.send({ type: "gate_evaluated", stageId: "a", attempt: 1, passed: true, evidence: "ok", judgedBy: "host" }))
      .toEqual([{ type: "seal", stageId: "a" }, { type: "integrate", joinId: "step-1", stageIds: ["a"] }]);
    expect(spawned(d.send({ type: "join_integrated", joinId: "step-1" }))).toEqual(["z"]);
    d.send(ended("z"));
    d.send({ type: "gate_decided", stageId: "z", attempt: 1, decision: "approve" });
    expect(d.send({ type: "join_integrated", joinId: "step-2" })[0]).toEqual({ type: "settle", runStatus: "completed" });
  });

  it("a refused spawn cancels pending gates, lets a live child end without a gate, and settles cancelled", () => {
    const d = driver(graphOf([stageOf("a"), stageOf("b"), stageOf("c")]));
    d.send({ type: "started" });
    d.send(ended("a"));
    d.flags.refused = true;
    d.send({ type: "spawn_refused", stageId: "c", attempt: 1 });
    expect([d.status("a"), d.status("b"), d.status("c")]).toEqual(["cancelled", "running", "cancelled"]);
    expect(d.runStatus()).toBe("executing");
    const last = d.send(ended("b"));
    expect(d.run("b")).toMatchObject({ status: "cancelled", output: "out-b-1" });
    expect(d.run("b")?.gate).toBeUndefined();
    expect(last[0]).toEqual({ type: "settle", runStatus: "cancelled" });
  });
});
