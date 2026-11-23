/** What a restart leaves of a template run: a run that waits for the user, never an error and never a spawn. The board's reconcile leaves a
 * row that names a template run alone; the scheduler parks the run from the run file and shows it on the board again. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import { isAwaitingStageReview } from "../../work-board/workflow/run-state.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import type { WorkflowRunStore } from "../workflow-run-store.js";

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

it("resumes an intact join after restart without manufacturing a conflict", async () => {
  let hold = true;
  let held = false;
  const h = await stageRunHarness({ integrate: () => { if (!hold) return { ok: true }; held = true; return new Promise(() => undefined); } });
  try {
    const version = await h.confirm([stageOf("a", { gate: { type: "auto", pass: { kind: "stage_ok" } } })]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    await h.until(id, item => item.stageJoins[0]?.status === "integrating");
    await vi.waitFor(() => expect(held).toBe(true));
    hold = false;
    await restarted(h);
    const item = await h.until(id, current => current.runStatus === "completed");
    expect(item.stageRuns[0].status).toBe("passed");
    expect(item.stageJoins[0]).toMatchObject({ status: "integrated" });
    expect(item.stageJoins[0].conflict).toBeUndefined();
    expect(item.record && isAwaitingStageReview(item.record)).toBe(false);
    await restarted(h);
    expect((await h.item(id)).record).toEqual(item.record);
    expect(h.children).toHaveLength(1);
  } finally { await h.cleanup(); }
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
    const update = vi.spyOn(h.board.runs, "settleRun");
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

async function parkedRun(h: Harness, projectRoot?: string) {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version, projectRoot);
  void h.start(id, h.local(version, projectRoot));
  (await h.untilLive(1))[0].finish();
  const runId = (await h.untilStage(id, "a", "awaiting_gate")).runId ?? "";
  const gate = await h.stageRun(id, "a");
  return { id, runId, version, gate };
}

it("the boot sweep is given the project the run file names for a run that ended only at boot, and no project for a run that has none", async () => {
  const h = await stageRunHarness();
  try {
    const ended = await parkedRun(h, "/projects/a");
    const plain = await parkedRun(h);
    const kept = await parkedRun(h, "/projects/b");
    deleteRowOffline(h, ended.id);
    deleteRowOffline(h, plain.id);
    await h.board.reconcileInterruptedRuns();
    await h.makeEngine().adoptParkedTemplateRuns();
    expect(h.sweeps.at(-1)).toEqual([kept.runId]);
    expect(h.sweptProjects.at(-1)).toEqual(new Map([[ended.runId, "/projects/a"], [kept.runId, "/projects/b"]]));
  } finally {
    await h.cleanup();
  }
});

it("a run whose row was deleted while the app was down is cancelled at boot and its record pruned", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId } = await parkedRun(h);
    const kept = await parkedRun(h);
    deleteRowOffline(h, id);
    await h.board.reconcileInterruptedRuns();
    const engine = h.makeEngine();
    const update = vi.spyOn(h.board.runs, "settleRun");
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

/** A parked run, then the board file as `edit` leaves it while the app is down; the next process boots over it. */
/** How each write the spy saw ended that run, in order. */
async function endsWritten(update: MockInstance<WorkflowRunStore["update"]>, runId: string): Promise<(string | undefined)[]> {
  const writes = update.mock.calls.flatMap(([target], i) => target === runId ? [update.mock.results[i]?.value] : []);
  return (await Promise.all(writes)).map(result => result?.status === "stored" ? result.run.settled?.status : result?.status);
}

async function bootOverBoard(h: Harness, edit: (id: number) => void) {
  const parked = await parkedRun(h);
  const before = await h.runOf(parked.runId);
  edit(parked.id);
  const engine = h.makeEngine();
  const update = vi.spyOn(h.board.runs, "settleRun");
  const prune = vi.spyOn(h.board, "pruneSettledRuns");
  const swept = h.sweeps.length;
  await engine.adoptParkedTemplateRuns();
  return { ...parked, before, engine, update, prune, swept };
}

for (const board of ["missing", "corrupt"] as const) {
  it(`a boot over a ${board} board file changes no run record, sweeps nothing and refuses template starts`, async () => {
    const h = await stageRunHarness();
    try {
      const boot = await bootOverBoard(h, () => board === "missing" ? rmSync(h.boardPath) : writeFileSync(h.boardPath, "{ not json"));
      expect(await h.runOf(boot.runId)).toEqual(boot.before);
      expect(boot.update).not.toHaveBeenCalled();
      expect(boot.prune).not.toHaveBeenCalled();
      expect(h.sweeps).toHaveLength(boot.swept);
      const created = await h.board.create({ title: "Other", templateId: boot.version.templateId });
      if (created.status !== "created") throw new Error("item not created");
      // Creating the item wrote the board file; it goes again, so the board still proves nothing and nothing starts.
      rmSync(h.boardPath);
      expect(await boot.engine.runItem(created.itemId, { templateSource: h.local(boot.version) })).toMatchObject({ status: "error", reasonCode: "template-runs-board-unread" });
      expect(await h.runOf(boot.runId)).toEqual(boot.before);
    } finally {
      await h.cleanup();
    }
  });
}

it("a decision while the runs a restart left are not taken over is refused by its own reason, which has text", async () => {
  const h = await stageRunHarness();
  try {
    const boot = await bootOverBoard(h, () => rmSync(h.boardPath));
    const decided = await boot.engine.decideStageGate(boot.id, { runId: boot.runId, stageId: "a", attempt: 1, resultHash: boot.gate.resultHash ?? "", decision: "approve" });
    expect(decided).toEqual({ ok: false, reason: "runs_not_adopted" });
    for (const catalog of [en, ko]) expect(Reflect.get(catalog, "reasonCodes.runs-not-adopted")).toEqual(expect.stringMatching(/\S/));
    expect(await h.runOf(boot.runId)).toEqual(boot.before);
  } finally {
    await h.cleanup();
  }
});

it("a boot over a row on the board without naming its run, as a start whose row write never landed leaves it, ends that run error and keeps nothing of it", async () => {
  const h = await stageRunHarness();
  try {
    const boot = await bootOverBoard(h, id => h.editRow(id, ({ runId: _, runHistory: __, ...row }) => row));
    expect(await endsWritten(boot.update, boot.runId)).toEqual(["error"]);
    expect(boot.prune).toHaveBeenCalled();
    expect(await h.runOf(boot.runId)).toBeNull();
    expect(h.sweeps.slice(boot.swept)).toEqual([[]]);
    // The next boot finds nothing of it to adopt.
    const again = h.makeEngine();
    const update = vi.spyOn(h.board.runs, "settleRun");
    await again.adoptParkedTemplateRuns();
    expect(update).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

it("a boot over a board file replaced by an empty one cancels the run, whose row it does not list, then prunes and sweeps it", async () => {
  const h = await stageRunHarness();
  try {
    const boot = await bootOverBoard(h, () => writeFileSync(h.boardPath, JSON.stringify({ version: 1, nextId: 1, items: [] })));
    expect(await endsWritten(boot.update, boot.runId)).toEqual(["cancelled"]);
    expect(await h.runOf(boot.runId)).toBeNull();
    expect(h.sweeps.slice(boot.swept)).toEqual([[]]);
  } finally {
    await h.cleanup();
  }
});

it("a board written again after it went missing issues ids above the run's row, and the next start ends that run error as lost, never cancelled, and its record goes with the mark", async () => {
  const h = await stageRunHarness();
  try {
    const boot = await bootOverBoard(h, () => rmSync(h.boardPath));
    // The id comes from the run file's floor, above the row the run names.
    const created = await h.board.create({ title: "Other", templateId: boot.version.templateId });
    expect(created).toMatchObject({ status: "created", itemId: boot.id + 1 });
    if (created.status !== "created") throw new Error("item not created");
    const ended = vi.spyOn(h.board.runs, "settleRun");
    const started = boot.engine.runItem(created.itemId, { templateSource: h.local(boot.version) });
    await h.untilLive(1);
    // The board was written over one that showed nothing, below the run's row: the run ends error by its id. The new run's row is at the
    // mark, not below it, so the mark is dropped and the lost run's record goes with it.
    expect(await endsWritten(ended, boot.runId)).toEqual(["error"]);
    expect(await h.runOf(boot.runId)).toBeNull();
    expect(JSON.parse(readFileSync(h.boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
    expect(h.sweeps.slice(boot.swept)).toEqual([[]]);
    expect(boot.engine.cancelRun(created.itemId)).toEqual({ ok: true });
    await started;
  } finally {
    await h.cleanup();
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
    const update = vi.spyOn(h.board.runs, "settleRun").mockResolvedValueOnce({ status: "pending-review" });
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

for (const failing of ["reconcile", "row"] as const) {
  it(`a boot whose reconcile or row repair write fails takes nothing over: starts stay refused and nothing is swept until a later attempt succeeds (${failing})`, async () => {
    const h = await stageRunHarness();
    try {
      const { id, runId, version } = await parkedRun(h);
      if (failing === "reconcile") await h.board.runs.update(runId, run => ({ ...run, stageRuns: run.stageRuns.map(stage => stage.stageId === "a" ? { ...stage, status: "running" } : stage) }));
      else h.editRow(id, row => ({ ...row, runStatus: "error" }));
      const other = await h.addItem(version);
      const engine = h.makeEngine();
      const write = failing === "reconcile"
        ? vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" })
        : vi.spyOn(h.board, "setRunResult").mockResolvedValue({ status: "invalid", itemId: id, reason: "refused" });
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
  });
}

for (const event of ["start", "reader"] as const) {
  it(`a settled run whose row a crash left executing is restored by the next start or reader once a deferred boot adoption can run (${event})`, async () => {
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
  });
}

it("a deferred adoption is retried only by an event, never by time", async () => {
  const h = await stageRunHarness();
  try {
    const { id } = await parkedRun(h);
    const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
    const read = homeTrust.readAveHomeInput;
    const held = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
      path === runsPath ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
    // Time is faked from the refused boot attempt on, so a retry timer it set would be seen.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    let engine: Awaited<ReturnType<typeof restarted>>;
    let attempts: ReturnType<typeof vi.spyOn>;
    try {
      engine = await restarted(h);
      held.mockRestore();
      attempts = vi.spyOn(h.board.runs, "list");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
    expect(attempts).not.toHaveBeenCalled();
    expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
    // One reader is the event: one attempt, and the run is taken over.
    await engine.projectTemplateRuns([await h.item(id)]);
    for (let i = 0; i < 400 && !engine.cancelRun(id).ok; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(attempts).toHaveBeenCalledTimes(1);
  } finally {
    await h.cleanup();
  }
});

/** An ordinary row started on the harness engine, once its plan child links. */
async function ordinaryRun(h: Harness, title: string) {
  const created = await h.board.create({ title });
  if (created.status !== "created") throw new Error("no row");
  const before = h.children.length;
  const running = h.engine.runItem(created.itemId);
  const [child] = (await h.untilSpawned(before + 1)).slice(before);
  await h.until(created.itemId, item => item.runSessionId === child.sessionId);
  return { id: created.itemId, child, running };
}
/** The run file made to hold a key twice, as a hand edit can: nothing reads it until it is put back. */
function breakRunFile(h: Harness): () => void {
  const runsPath = join(h.dir, "workflow-runs.json");
  const original = readFileSync(runsPath, "utf8");
  writeFileSync(runsPath, `{"version":1,${original.trim().slice(1)}`);
  return () => writeFileSync(runsPath, original);
}
const rowOnDisk = (h: Harness, id: number) => (JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] }).items.find(row => row.id === id);

it.each<[string, (h: Harness, id: number) => Promise<unknown>]>([
  ["reader", async h => { const listed = await h.board.list(); if (listed.status === "ok") await h.engine.projectTemplateRuns(listed.items); }],
  ["adoption", h => h.engine.adoptParkedTemplateRuns()],
  ["plan decision", (h, id) => h.engine.decidePlan(id, { runId: "other-run", planHash: "c".repeat(64), decision: "approve" })],
  ["stage decision", (h, id) => h.engine.decideStageGate(id, { runId: "other-run", stageId: "a", attempt: 1, resultHash: "c".repeat(64), decision: "approve" })],
  ["missing run clear", (h, id) => h.engine.clearMissingRun(id, { revision: "c".repeat(64), runId: "other-run" })],
])("an ordinary run whose end was refused while the run file could not be read ends error at the next %s once the file reads, never by time", async (_, event) => {
  const h = await stageRunHarness();
  try {
    await h.engine.adoptParkedTemplateRuns();
    const { id, child, running } = await ordinaryRun(h, "ordinary work");
    const restore = breakRunFile(h);
    child.finish({ ok: false, summary: "child failed", error: "child failed" });
    expect(await running).toMatchObject({ status: "error" });
    restore();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
    expect(rowOnDisk(h, id)).toMatchObject({ runStatus: "planning" });
    await event(h, id);
    expect(rowOnDisk(h, id)).toMatchObject({ runStatus: "error", runHistory: [{ status: "error" }] });
  } finally {
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});

it("a start of an ordinary row whose end was refused while the run file could not be read runs it again once the file reads", async () => {
  const h = await stageRunHarness();
  try {
    const { id, child, running } = await ordinaryRun(h, "ordinary work");
    const restore = breakRunFile(h);
    child.finish({ ok: false, summary: "child failed", error: "child failed" });
    expect(await running).toMatchObject({ status: "error" });
    restore();
    const again = h.engine.runItem(id);
    const [next] = await h.untilLive(1);
    expect(next).not.toBe(child);
    next.finish({ ok: false, summary: "again failed", error: "again failed" });
    expect(await again).toMatchObject({ status: "error", reason: "again failed" });
  } finally {
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});

it("the recovery leaves an ordinary run in flight to end by its own write and replays no write the episode refused", async () => {
  const h = await stageRunHarness();
  try {
    const dead = await ordinaryRun(h, "dead work");
    const kept = await ordinaryRun(h, "kept work");
    const restore = breakRunFile(h);
    dead.child.finish();
    expect(await dead.running).toMatchObject({ status: "error" });
    await expect(h.board.update(kept.id, { title: "renamed" })).rejects.toMatchObject({ code: "work-board-runs-unreadable" });
    restore();
    await h.engine.adoptParkedTemplateRuns();
    expect(rowOnDisk(h, dead.id)).toMatchObject({ runStatus: "error" });
    expect(rowOnDisk(h, dead.id)).not.toHaveProperty("plan");
    expect(rowOnDisk(h, kept.id)).toMatchObject({ title: "kept work", runStatus: "planning" });
    kept.child.finish();
    expect(await kept.running).toMatchObject({ status: "awaiting_approval" });
    expect(rowOnDisk(h, kept.id)).toMatchObject({ title: "kept work", runStatus: "awaiting_approval", plan: `output of ${kept.child.sessionId}` });
  } finally {
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});

/** The run file as a hand edit leaves it: `edit` changes its top-level object. */
function editRunFile(h: Harness, edit: (file: Record<string, unknown>) => void): void {
  const runsPath = join(h.dir, "workflow-runs.json");
  const file = JSON.parse(readFileSync(runsPath, "utf8")) as Record<string, unknown>;
  edit(file);
  writeFileSync(runsPath, JSON.stringify(file));
}
const runFileOnDisk = (h: Harness) => JSON.parse(readFileSync(join(h.dir, "workflow-runs.json"), "utf8")) as Record<string, unknown>;
async function untilTrue(check: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}

/** A parked run this engine holds, an ordinary row and a completed one, once the takeover ran and read every intent. */
async function adoptedWithRows(h: Harness) {
  await h.engine.adoptParkedTemplateRuns();
  const parked = await parkedRun(h);
  const created = await h.board.create({ title: "ordinary work" });
  const done = await h.board.create({ title: "finished work", status: "completed" });
  if (created.status !== "created" || done.status !== "created") throw new Error("no row");
  await h.engine.adoptParkedTemplateRuns();
  return { ...parked, plain: created.itemId, completed: done.itemId };
}
type Rows = Awaited<ReturnType<typeof adoptedWithRows>>;
// Each start is refused before it writes the board, so no board write's row check reads the intent in its place.
const PERMITTED_EVENTS: [string, (h: Harness, rows: Rows) => Promise<unknown>][] = [
  ["reader", async h => { const listed = await h.board.list(); if (listed.status === "ok") await h.engine.projectTemplateRuns(listed.items); }],
  ["template start", (h, rows) => h.engine.runItem(rows.id, { templateSource: h.local(rows.version) })],
  ["ordinary start", (h, rows) => h.engine.runItem(rows.completed)],
  ["stage decision", (h, rows) => h.engine.decideStageGate(rows.id, { runId: rows.runId, stageId: "a", attempt: rows.gate.attempt, resultHash: "c".repeat(64), decision: "approve" })],
  ["plan decision", (h, rows) => h.engine.decidePlan(rows.plain, { runId: "other-run", planHash: "c".repeat(64), decision: "approve" })],
  ["adoption", h => h.engine.adoptParkedTemplateRuns()],
  ["missing run clear", (h, rows) => h.engine.clearMissingRun(rows.plain, { revision: "c".repeat(64), runId: "other-run" })],
];

it.each(PERMITTED_EVENTS)("after the takeover, each %s reads a delete intent written since and ends that deleted row's run as item-removed", async (_, event) => {
  const h = await stageRunHarness();
  try {
    const rows = await adoptedWithRows(h);
    deleteRowOffline(h, rows.id);
    editRunFile(h, file => { file.deleteIntents = [{ itemId: rows.id, runId: rows.runId }]; });
    await event(h, rows);
    expect(await untilTrue(() => h.events.some(e => e.itemId === rows.id && e.phase === "cancelled" && e.message === "item-removed"))).toBe(true);
    expect(await untilTrue(async () => (await h.runOf(rows.runId)) === null)).toBe(true);
    expect(runFileOnDisk(h)).not.toHaveProperty("deleteIntents");
  } finally {
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});

it.each(PERMITTED_EVENTS)("after the takeover, each %s reads an unknown marker written since, and withdraws it with its intent while the board lists the row", async (_, event) => {
  const h = await stageRunHarness();
  try {
    const rows = await adoptedWithRows(h);
    editRunFile(h, file => {
      file.deleteIntents = [{ itemId: rows.id, runId: rows.runId }];
      file.unknownDeletes = [{ itemId: rows.id, runId: rows.runId, op: "row", ownIntent: true }];
    });
    await event(h, rows);
    expect(await untilTrue(() => !("deleteIntents" in runFileOnDisk(h)) && !("unknownDeletes" in runFileOnDisk(h)))).toBe(true);
    expect((await h.runOf(rows.runId))?.settled).toBeUndefined();
    expect(rowOnDisk(h, rows.id)).toMatchObject({ runId: rows.runId });
    expect(h.events.some(e => e.itemId === rows.id && e.phase === "cancelled")).toBe(false);
  } finally {
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});
