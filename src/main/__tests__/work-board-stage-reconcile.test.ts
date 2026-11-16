/** What a restart leaves of a template run: a run that waits for the user, never an error and never a spawn. The board fails every row it
 * finds running; the scheduler then parks the run from the run file and shows it on the board again. */
import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import { isAwaitingStageReview } from "../../work-board/workflow/run-state.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
/** The next process over the same board file and run file. */
async function restarted(h: Harness) {
  await h.board.reconcileInterruptedRuns();
  const engine = h.makeEngine();
  await engine.adoptParkedTemplateRuns();
  return engine;
}

it("keeps a pending stage gate across restart and fails running stages as interrupted", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b"), stageOf("c", { inputs: ["a", "b"] })]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const [a] = await h.untilLive(2);
    a.finish();
    const before = await h.untilStage(id, "a", "awaiting_gate");

    await restarted(h);
    const item = await h.item(id);
    expect(item.runStatus).toBe("executing");
    expect(item.runId).toBe(before.runId);
    expect(item.stageRuns).toMatchObject([
      { stageId: "a", status: "awaiting_gate", output: "output of child-1", resultHash: resultHashOf("output of child-1"), gate: { type: "human", status: "pending" } },
      { stageId: "b", status: "failed", failure: "interrupted" },
      { stageId: "c", status: "waiting" },
    ]);
    expect(item.stageRuns[1].resultHash).toBeUndefined();
    expect(item.record && isAwaitingStageReview(item.record)).toBe(true);
    // A second restart changes nothing, and no child was started by either.
    await restarted(h);
    expect((await h.item(id)).record).toEqual(item.record);
    expect(h.children).toHaveLength(2);
  } finally {
    await h.cleanup();
  }
});

it("fails a gate whose stored output no longer matches its hash, and a kept stage whose workspace folder is gone", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    for (const child of await h.untilLive(2)) child.finish();
    const before = await h.until(id, item => item.stageRuns.length === 2 && item.stageRuns.every(run => run.status === "awaiting_gate"));
    await h.board.updateRun(id, before.runId ?? "", run => ({ ...run, stageRuns: run.stageRuns.map(stage => stage.stageId === "a" ? { ...stage, output: "another output" } : stage) }));
    rmSync((await h.stageRun(id, "b")).workspace?.root ?? "", { recursive: true, force: true });

    await restarted(h);
    const item = await h.item(id);
    expect(item.runStatus).toBe("executing");
    expect(item.stageRuns).toMatchObject([{ stageId: "a", status: "failed", failure: "interrupted" }, { stageId: "b", status: "failed", failure: "workspace-lost" }]);
    expect(item.record && isAwaitingStageReview(item.record)).toBe(false);
  } finally {
    await h.cleanup();
  }
});

it("turns a join that was being collected into a conflict the user decides", async () => {
  let hold = true;
  let held = false;
  const h = await stageRunHarness({ integrate: () => { if (!hold) return { ok: true }; held = true; return new Promise(() => undefined); } });
  try {
    const version = await h.confirm([stageOf("a", { gate: { type: "auto", pass: { kind: "stage_ok" } } })]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    const before = await h.until(id, item => item.stageJoins[0]?.status === "integrating");
    // The join is stored as integrating before its stages are sealed: the first process must be inside the collect it never finishes.
    for (let i = 0; i < 400 && !held; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(held).toBe(true);

    hold = false;
    const next = await restarted(h);
    const item = await h.item(id);
    expect(item.runStatus).toBe("executing");
    expect(item.stageRuns[0].status).toBe("passed");
    const join = item.stageJoins[0];
    expect(join).toMatchObject({ status: "conflict", conflict: { reason: "interrupted", files: [] } });
    expect(item.record && isAwaitingStageReview(item.record)).toBe(true);

    // The next process collects it again only on the decision that names this conflict.
    const decision = { runId: before.runId ?? "", joinId: join.joinId, decision: "retry_merge" } as const;
    expect(await next.decideStageJoin(id, { ...decision, conflictHash: "d".repeat(64) })).toEqual({ ok: false, reason: "conflict_mismatch" });
    expect(await next.decideStageJoin(id, { ...decision, conflictHash: join.conflict?.conflictHash ?? "" })).toEqual({ ok: true });
    expect((await h.until(id, current => current.runStatus !== "executing")).runStatus).toBe("completed");
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

it("a row deleted while its run is parked after a restart ends the run cancelled in the run file", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    const runId = (await h.untilStage(id, "a", "awaiting_gate")).runId ?? "";

    await restarted(h);
    expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
    for (let i = 0; i < 400 && (await h.runOf(runId))?.settled === undefined; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const record = await h.runOf(runId);
    expect(record?.settled?.status).toBe("cancelled");
    expect(record?.stageRuns.map(stage => stage.status)).toEqual(["cancelled"]);
    expect(h.events.at(-1)).toMatchObject({ itemId: id, phase: "cancelled", message: "item-removed" });
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});
