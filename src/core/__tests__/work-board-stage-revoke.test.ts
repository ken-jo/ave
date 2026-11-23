/** What ends a template run's stages from outside: a removed project, a refused source, a tool ask nobody can answer. */
import { expect, it } from "vitest";
import { authoriseRunSource } from "../../work-board/workflow/run-authority.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

const A = "/projects/a";
const B = "/projects/b";

it("removing the project interrupts every live stage child of its runs and fails those stages", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const onA = await h.addItem(version, A);
    const onB = await h.addItem(version, B);
    void h.start(onA, h.local(version, A));
    const ofA = await h.untilLive(2);
    void h.start(onB, h.local(version, B));
    await h.untilLive(4);

    h.engine.projectRootRevoked(A);

    const item = await h.until(onA, current => current.stageRuns?.every(run => run.status === "failed") === true);
    expect(item.stageRuns).toMatchObject([{ stageId: "a", failure: "workspace-revoked" }, { stageId: "b", failure: "workspace-revoked" }]);
    expect(item.runStatus).toBe("executing");
    expect([...h.interrupts].sort()).toEqual(ofA.map(child => child.sessionId).sort());
    expect(ofA.every(child => child.ended)).toBe(true);
    // No gate opened for an interrupted stage, and the other project's run is untouched.
    expect(h.events.some(event => event.phase === "stage_gate")).toBe(false);
    expect(h.live()).toHaveLength(2);
    expect((await h.item(onB)).stageRuns?.map(run => run.status)).toEqual(["running", "running"]);
    h.engine.cancelRun(onB);
    h.engine.cancelRun(onA);
    await h.until(onB, current => current.runStatus === "cancelled");
    await h.until(onA, current => current.runStatus === "cancelled");
  } finally {
    await h.cleanup();
  }
});

it("a run whose stored source the authority function refuses spawns nothing", async () => {
  // Accepted when the run starts, refused from then on: only the check on the spawn path can stop the first stage.
  const h = await stageRunHarness({
    workflow: { authoriseRunSource: args => args.phase === "start" ? authoriseRunSource(args) : { ok: false, code: "source-not-authorised" } },
  });
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    expect(await h.start(id, h.local(version))).toMatchObject({ status: "cancelled", reasonCode: "source-not-authorised" });
    expect(h.children).toHaveLength(0);
    expect(h.workspaceCalls.filter(call => call.startsWith("prepare"))).toEqual([]);
    const item = await h.item(id);
    expect(item.runStatus).toBe("cancelled");
    expect(item.stageRuns?.map(run => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(await h.settleEvent()).toMatchObject({ phase: "cancelled", reasonCode: "source-not-authorised" });
  } finally {
    await h.cleanup();
  }
});

it("a stage whose tool ask has no approval surface fails and its gate never opens", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    a.finish({ ok: false, summary: "approval required", error: "approval required", stopReason: "authorization-required" });
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    const item = await h.item(id);
    expect(item.stageRuns).toMatchObject([{ stageId: "a", status: "failed", failure: "denied-tool" }, { stageId: "b", status: "waiting" }]);
    expect(item.stageRuns?.[0].gate).toBeUndefined();
    expect(h.events.some(event => event.phase === "stage_gate")).toBe(false);
    expect(h.events.some(event => event.phase === "stage_failed" && event.stageId === "a")).toBe(true);
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});
