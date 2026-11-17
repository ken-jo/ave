/** What a restart leaves of a template run: a run that waits for the user, never an error and never a spawn. The board's reconcile leaves a
 * row that names a template run alone; the scheduler parks the run from the run file and shows it on the board again. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as homeTrust from "../../shared/ave-home-trust.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import { isAwaitingStageReview } from "../../work-board/workflow/run-state.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
afterEach(() => { vi.restoreAllMocks(); });
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

    const engine = await restarted(h);
    const update = vi.spyOn(h.board.runs, "update");
    expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
    for (let i = 0; i < 400 && !h.events.some(event => event.itemId === id && event.message === "item-removed"); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.events.at(-1)).toMatchObject({ itemId: id, phase: "cancelled", message: "item-removed" });
    const settled = await update.mock.results.at(-1)?.value;
    expect(settled).toMatchObject({ status: "stored", run: { runId, settled: { status: "cancelled" } } });
    expect(settled.run.stageRuns.map((stage: { status: string }) => stage.status)).toEqual(["cancelled"]);
    // Settled with no row left: the record is pruned.
    expect(await h.runOf(runId)).toBeNull();
    expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

/** Remove a row from the board file while no process runs, as a deletion the engine never heard of. */
function deleteRowOffline(h: Harness, id: number): void {
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: { id: number }[] };
  file.items = file.items.filter(row => row.id !== id);
  writeFileSync(h.boardPath, JSON.stringify(file));
}

async function parkedRun(h: Harness) {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  const runId = (await h.untilStage(id, "a", "awaiting_gate")).runId ?? "";
  const gate = await h.stageRun(id, "a");
  return { id, runId, version, gate };
}

it("a run whose row was deleted while the app was down is cancelled at boot and its record pruned", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId } = await parkedRun(h);
    const kept = await parkedRun(h);
    deleteRowOffline(h, id);
    await h.board.reconcileInterruptedRuns();
    const engine = h.makeEngine();
    const update = vi.spyOn(h.board.runs, "update");
    await engine.adoptParkedTemplateRuns();
    const cancelled = await Promise.all(update.mock.results.map(result => result.value));
    expect(cancelled).toContainEqual(expect.objectContaining({ status: "stored", run: expect.objectContaining({ runId, settled: expect.objectContaining({ status: "cancelled" }) }) }));
    const record = cancelled.find(result => result.status === "stored" && result.run.runId === runId)?.run;
    expect(record?.stageRuns.map((stage: { status: string }) => stage.status)).toEqual(["cancelled", "cancelled"]);
    expect(await h.runOf(runId)).toBeNull();
    // The other run is taken over as usual, and only its workspace is kept.
    expect((await h.item(kept.id)).record?.settled).toBeUndefined();
    expect(engine.cancelRun(kept.id)).toEqual({ ok: true });
    expect(h.sweeps.at(-1)).toEqual([kept.runId]);
    expect(h.children).toHaveLength(2);
  } finally {
    await h.cleanup();
  }
});

it("a run whose row names another run is cancelled at boot and kept only as that row's history", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId } = await parkedRun(h);
    h.editRow(id, row => ({ ...row, runId: "run-elsewhere" }));
    await restarted(h);
    const record = await h.board.runs.get(runId);
    expect(record).toMatchObject({ status: "found", run: { runId, settled: { status: "cancelled" } } });
    expect(h.sweeps.at(-1)).toEqual([]);
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

it("a boot that finds the run file awaiting review settles, sweeps and takes over nothing, and a later reader takes the run over", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId, version, gate } = await parkedRun(h);
    const other = await h.addItem(version);
    const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
    const read = homeTrust.readAveHomeInput;
    const held = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
      path === runsPath ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
    const swept = h.sweeps.length;
    const engine = await restarted(h);
    expect(h.sweeps).toHaveLength(swept);
    expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
    // Until the takeover has happened nothing starts and nothing is decided.
    const begin = vi.spyOn(h.board, "beginRun");
    expect(await engine.runItem(other, { templateSource: h.local(version) })).toMatchObject({ status: "error", reasonCode: "template-runs-pending-review" });
    expect(begin).not.toHaveBeenCalled();
    const decision = { runId, stageId: "a", attempt: gate.attempt, resultHash: gate.resultHash ?? "", decision: "approve" as const };
    expect(await engine.decideStageGate(id, decision)).toMatchObject({ ok: false });
    expect(h.sweeps).toHaveLength(swept);

    held.mockRestore();
    expect((await h.runOf(runId))?.settled).toBeUndefined();
    const [shown] = await engine.projectTemplateRuns([(await h.item(id))]);
    expect(shown).toMatchObject({ runStatus: "executing", templateRunState: "resuming" });
    for (let i = 0; i < 400 && engine.cancelRun(id).ok === false; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.sweeps.slice(swept)).toEqual([[runId]]);
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

it("a boot over a board file that is missing, damaged or replaced by an empty one changes no run record", async () => {
  for (const board of ["missing", "corrupt", "emptied"] as const) {
    const h = await stageRunHarness();
    try {
      const { runId, version } = await parkedRun(h);
      const before = await h.runOf(runId);
      if (board === "missing") rmSync(h.boardPath);
      else writeFileSync(h.boardPath, board === "corrupt" ? "{ not json" : JSON.stringify({ version: 1, nextId: 1, items: [] }));
      const engine = h.makeEngine();
      const update = vi.spyOn(h.board.runs, "update");
      const prune = vi.spyOn(h.board, "pruneSettledRuns");
      const swept = h.sweeps.length;
      await engine.adoptParkedTemplateRuns();
      expect(await h.runOf(runId)).toEqual(before);
      expect(update).not.toHaveBeenCalled();
      if (board === "emptied") {
        // A row id the board never issued proves nothing: the run is kept with its workspace.
        expect(h.sweeps.slice(swept)).toEqual([[runId]]);
      } else {
        expect(prune).not.toHaveBeenCalled();
        expect(h.sweeps).toHaveLength(swept);
        const created = await h.board.create({ title: "Other", templateId: version.templateId });
        if (created.status !== "created") throw new Error("item not created");
        // Creating the item wrote the board file; it goes again, so the board still proves nothing and nothing starts.
        rmSync(h.boardPath);
        expect(await engine.runItem(created.itemId, { templateSource: h.local(version) })).toMatchObject({ status: "error", reasonCode: "template-runs-board-unread" });
        expect(await h.runOf(runId)).toEqual(before);
      }
    } finally {
      await h.cleanup();
    }
  }
});

it("an orphaned run whose cancel write fails is neither pruned nor swept, and the next start cancels it", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId, version } = await parkedRun(h);
    const other = await h.addItem(version);
    deleteRowOffline(h, id);
    const before = await h.runOf(runId);
    const engine = h.makeEngine();
    const update = vi.spyOn(h.board.runs, "update").mockResolvedValueOnce({ status: "pending-review" });
    const prune = vi.spyOn(h.board, "pruneSettledRuns");
    const swept = h.sweeps.length;
    await engine.adoptParkedTemplateRuns();
    expect(await h.runOf(runId)).toEqual(before);
    expect(prune).not.toHaveBeenCalled();
    expect(h.sweeps).toHaveLength(swept);

    update.mockRestore();
    const started = engine.runItem(other, { templateSource: h.local(version) });
    await h.untilLive(1);
    expect(await h.runOf(runId)).toBeNull();
    expect(prune).toHaveBeenCalled();
    expect(h.sweeps.slice(swept)).toEqual([[]]);
    expect(engine.cancelRun(other)).toEqual({ ok: true });
    await started;
  } finally {
    await h.cleanup();
  }
});

it("a boot whose reconcile or row repair write fails takes nothing over: starts stay refused and nothing is swept until a later attempt succeeds", async () => {
  for (const failing of ["reconcile", "row"] as const) {
    const h = await stageRunHarness();
    try {
      const { id, runId, version } = await parkedRun(h);
      if (failing === "reconcile") await h.board.runs.update(runId, run => ({ ...run, stageRuns: run.stageRuns.map(stage => stage.stageId === "a" ? { ...stage, status: "running" } : stage) }));
      else h.editRow(id, row => ({ ...row, runStatus: "error" }));
      const other = await h.addItem(version);
      const engine = h.makeEngine();
      const write = failing === "reconcile"
        ? vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" })
        : vi.spyOn(h.board, "setRunResult").mockRejectedValue(new Error("disk full"));
      const swept = h.sweeps.length;
      await engine.adoptParkedTemplateRuns();
      const begin = vi.spyOn(h.board, "beginRun");
      expect(await engine.runItem(other, { templateSource: h.local(version) }))
        .toMatchObject({ status: "error", reasonCode: failing === "reconcile" ? "template-runs-pending-review" : "run-state-unavailable" });
      expect(begin).not.toHaveBeenCalled();
      expect(h.sweeps).toHaveLength(swept);
      expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });

      write.mockRestore();
      const started = engine.runItem(other, { templateSource: h.local(version) });
      await h.untilLive(1);
      expect(h.sweeps.slice(swept)).toEqual([[runId]]);
      expect(engine.cancelRun(id)).toEqual({ ok: true });
      expect(engine.cancelRun(other)).toEqual({ ok: true });
      await started;
    } finally {
      await h.cleanup();
    }
  }
});

it("a settled run whose row a crash left executing is restored by the next start or reader once a deferred boot adoption can run", async () => {
  for (const event of ["start", "reader"] as const) {
    const h = await stageRunHarness();
    try {
      const version = await h.confirm([stageOf("a")]);
      const id = await h.addItem(version);
      const first = h.start(id, h.local(version));
      (await h.untilLive(1))[0].finish();
      await first;
      expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
      await h.until(id, item => item.runStatus === "completed");
      h.editRow(id, row => ({ ...row, runStatus: "executing" }));
      const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
      const read = homeTrust.readAveHomeInput;
      const held = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
        path === runsPath ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
      const engine = await restarted(h);
      held.mockRestore();
      if (event === "start") {
        const again = engine.runItem(id, { templateSource: h.local(version) });
        await h.untilLive(1);
        expect(engine.cancelRun(id)).toEqual({ ok: true });
        expect(await again).toMatchObject({ status: "cancelled" });
      } else {
        expect((await engine.projectTemplateRuns([await h.item(id)]))[0]).toMatchObject({ runStatus: "completed" });
        await h.until(id, item => item.runStatus === "completed");
      }
    } finally {
      await h.cleanup();
    }
  }
});
