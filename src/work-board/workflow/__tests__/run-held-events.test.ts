/**
 * Held events (work-board-run-ending.md): a scheduler event whose run write finds the row not naming the run while its class holds it.
 * `testTimeout` bounds hangs caused by product regressions such as awaiting a detached launch in the startup handler
 * (rv-heldev3 P2 (a)) or skipping dispatch or the busy decrement (rv-heldev3 P2 (b)). `afterEach` releases the gates,
 * finishes fake children, and disposes fixtures even when the test body is stranded.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterQueuedCallbacks, deferred } from "../../../__tests__/support/deferred.js";
import { WorkflowRunStore } from "../../../main/workflow-run-store.js";
import { boardRunState } from "../run-state.js";
import { createPassConditionRegistry, type PassConditionRegistry } from "../stage-gates.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { type FakeChild, stageRunHarness } from "./stage-run-harness.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
interface RunsOnDisk { runs: { runId: string; stageRuns: Record<string, unknown>[] }[]; heldEvents?: unknown[] }
interface Run { h: Harness; id: number; runId: string; children: FakeChild[]; lose(on: boolean): void }

interface TestResources {
  closing: boolean;
  releaseGates: (() => void)[];
  disposeFixtures: (() => Promise<void>)[];
}

let resources: TestResources;
beforeEach(() => {
  resources = { closing: false, releaseGates: [], disposeFixtures: [] };
});

afterEach(async () => {
  resources.closing = true;
  for (const release of resources.releaseGates) release();
  vi.restoreAllMocks();
  const results = await Promise.allSettled(resources.disposeFixtures.map(dispose => dispose()));
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Held-event fixture cleanup failed");
});

function releaseGate() {
  const gate = deferred<void>();
  resources.releaseGates.push(gate.resolve);
  return gate;
}

function makeHarness(options: NonNullable<Parameters<typeof stageRunHarness>[0]>): Promise<Harness> {
  const testResources = resources;
  const harness = stageRunHarness({
    ...options,
    // A release during cleanup can let a pending launch create another child.
    script: input => testResources.closing ? {} : options.script?.(input),
  });
  testResources.disposeFixtures.push(async () => {
    const h = await harness;
    try {
      for (const child of h.children) child.finish();
      await h.drainRunWork();
    } finally {
      await h.cleanup();
    }
  });
  return harness;
}

/** One run on its own home. While `lose` is on, every run write reads `row-lost` while the class stays live: as a board edit between the
 * class read and the write leaves it. `onSpawn` runs right after each child links. */
async function withRun(stages: string[], body: (run: Run) => Promise<void>, onSpawn?: (lose: (on: boolean) => void) => void, reason: "row-lost" | "board-unread" = "row-lost", passConditions?: PassConditionRegistry): Promise<void> {
  let losing = false;
  const lose = (on: boolean): void => { losing = on; };
  const scheduled = deferred<void>();
  const h = await makeHarness({
    observeRunWork: true,
    onRunWorkScheduled: scheduled.resolve,
    script: () => {
      onSpawn?.(lose);
      return undefined;
    },
    workflow: passConditions ? { passConditions } : undefined,
    wiring: (store) => {
      const runs = boardRunState(store);
      return { runs: { ...runs, update: async (...a) => losing ? { ok: false, reason } : runs.update(...a) } };
    },
  });
  const version = await h.confirm(stages.map(id => passConditions ? autoStageOf(id) : stageOf(id)));
  const id = await h.addItem(version);
  const started = h.start(id, h.local(version));
  // The startup work schedules the launches. The drain joins each until it links or exits.
  await Promise.race([scheduled.promise, started]);
  await h.drainRunWork();
  const children = h.live();
  expect(children).toHaveLength(stages.length);
  const { runId, stageRuns } = await h.item(id);
  if (runId === undefined) throw new Error("Run missing");
  expect(stageRuns.map(stage => stage.status)).toEqual(stages.map(() => "running"));
  await body({ h, id, runId, children, lose });
}

const runsOnDisk = (h: Harness): RunsOnDisk => JSON.parse(readFileSync(join(h.dir, "workflow-runs.json"), "utf8")) as RunsOnDisk;
function editRuns(h: Harness, edit: (file: RunsOnDisk) => void): void {
  const file = runsOnDisk(h);
  edit(file);
  writeFileSync(join(h.dir, "workflow-runs.json"), JSON.stringify(file));
}
async function linked({ h, id }: Run): Promise<void> {
  expect((await h.item(id)).stageRuns.every(stage => stage.childSessionId !== undefined)).toBe(true);
}

/** A permitted read: a reader, then the takeover. */
async function permittedRead(h: Harness): Promise<void> {
  const listed = await h.board.list();
  if (listed.status === "ok") await h.engine.projectTemplateRuns(listed.items);
  await h.engine.adoptParkedTemplateRuns();
}
async function replayHeldEvents(h: Harness, options?: Parameters<Harness["drainRunWork"]>[0]): Promise<void> {
  await permittedRead(h);
  await h.drainRunWork(options);
}

const logged = (spy: { mock: { calls: unknown[][] } }, text: string): number => spy.mock.calls.filter(call => call.some(arg => arg === text)).length;

it("the run file stores a held event once by its identity, drops it by identity or with its run, and lets it go with its run's end", async () => {
  const fixture = mkdtemp(join(tmpdir(), "held-events-"));
  resources.disposeFixtures.push(async () => { await rm(await fixture, { recursive: true, force: true }); });
  const dir = await fixture;
  const path = join(dir, "runs.json");
  const store = new WorkflowRunStore(path);
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  await store.put({ itemId: 1, runId: "run-1", pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z", stageRuns: [] });
  const run = { itemId: 1, runId: "run-1" };
  const ended = { ...run, stage: "a", attempt: 1, kind: "stage_ended" };
  const stop = { ...run, stage: null, attempt: 0, kind: "stop_requested" };
  expect(await store.holdEvent(ended)).toBe(true);
  expect(await store.holdEvent(ended)).toBe(true);
  expect(await store.holdEvent(stop)).toBe(true);
  // A run the file does not hold keeps no held event.
  await store.holdEvent({ ...ended, itemId: 2, runId: "run-2" });
  expect(JSON.parse(await readFile(path, "utf8")).heldEvents).toEqual([ended, stop]);
  await store.dropHeld(run, { stage: "a", attempt: 1, kind: "stage_ended" });
  expect(await store.heldEvents(run)).toEqual([stop]);
  await store.holdEvent(ended);
  await store.dropHeld(run);
  expect(JSON.parse(await readFile(path, "utf8")).heldEvents).toBeUndefined();

  const malformed = { ...run, stage: "a", attempt: -1, kind: "stage_ended" };
  const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...file, heldEvents: [ended, malformed] }));
  expect(await store.heldEvents(run)).toEqual([ended]);
  const settled = await store.settleRun("run-1", current => ({ run: current, ends: "stopped", at: "2026-01-01T00:00:01.000Z" }), () => true);
  expect(settled.status).toBe("stored");
  expect(JSON.parse(await readFile(path, "utf8")).heldEvents).toEqual([malformed]);
});

it("a completion held behind its run write replays once the class is live, and a second release changes nothing", async () =>
  withRun(["a"], async (run) => {
    const { h, id, runId, children: [child], lose } = run;
    await linked(run);
    lose(true);
    child.finish();
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([{ itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" }]);
    expect((await h.stageRun(id, "a")).status).toBe("running");
    lose(false);
    await Promise.all([permittedRead(h), permittedRead(h)]);
    await h.drainRunWork();
    const gated = await h.item(id);
    expect(gated.stageRuns[0]).toMatchObject({ status: "awaiting_gate", output: `output of ${child.sessionId}` });
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
    await replayHeldEvents(h);
    expect(await h.runOf(runId)).toEqual(gated.record);
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
  }));

it("a later Stop wins over an earlier completion still held: the completion replays under it, its output kept, and the run ends stopped", async () =>
  withRun(["a"], async (run) => {
    const { h, id, runId, children: [child], lose } = run;
    await linked(run);
    lose(true);
    child.finish();
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toHaveLength(1);
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([
      { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" },
      { itemId: id, runId, stage: null, attempt: 0, kind: "stop_requested" },
    ]);
    lose(false);
    await replayHeldEvents(h);
    expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "cancelled", message: "user-stopped" }));
    const record = await h.runOf(runId);
    expect(record?.settled?.status).toBe("cancelled");
    expect(record?.stageRuns[0]).toMatchObject({ status: "cancelled", output: `output of ${child.sessionId}` });
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
  }));

it("held events whose stage moved on to another attempt are dropped with their reason, never applied to it, and that attempt takes the lost path", async () =>
  withRun(["a"], async ({ h, id, runId, children: [child], lose }) => {
    const ended = { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" };
    expect(runsOnDisk(h).heldEvents).toEqual([{ ...ended, kind: "stage_linked" }]);
    child.finish();
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([{ ...ended, kind: "stage_linked" }, ended]);
    // A retry the run file shows: the stage runs again as its second attempt.
    editRuns(h, (file) => {
      const stage = file.runs.find(candidate => candidate.runId === runId)?.stageRuns[0];
      if (stage) stage.attempt = 2;
    });
    lose(false);
    const log = vi.spyOn(console, "log");
    await replayHeldEvents(h);
    const failed = await h.stageRun(id, "a");
    expect(failed).toMatchObject({ status: "failed", attempt: 2, failure: "interrupted" });
    expect(failed.childSessionId).toBeUndefined();
    expect(failed.output).toBeUndefined();
    expect(logged(log, "its stage moved on to another attempt")).toBe(2);
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
  }, lose => lose(true)));

it("a running stage with no child, none starting, no launch and no held event ends interrupted at a permitted read; one with a live child does not", async () =>
  withRun(["a"], async (run) => {
    const { h, id, runId, children: [child] } = run;
    await linked(run);
    await replayHeldEvents(h);
    expect((await h.stageRun(id, "a")).status).toBe("running");
    expect(child.ended).toBe(false);
    child.finish();
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    // The run file shows the stage running again, with nothing that will end it.
    editRuns(h, (file) => {
      const stage = file.runs.find(candidate => candidate.runId === runId)?.stageRuns[0];
      if (!stage) return;
      stage.status = "running";
      delete stage.gate;
      delete stage.resultHash;
    });
    await replayHeldEvents(h);
    expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", attempt: 1, failure: "interrupted" });
  }));

it.each(["sibling", "prior attempt"] as const)("a live child of a %s does not suppress a lost stage attempt", async live =>
  withRun(["a", "b"], async (run) => {
    const { h, id, runId, children: [first, second] } = run;
    await linked(run);
    if (live === "sibling") {
      first.finish();
      await h.drainRunWork();
      expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    }
    const attempt = live === "sibling" ? 1 : 2;
    editRuns(h, file => {
      const stored = file.runs.find(candidate => candidate.runId === runId);
      if (!stored) throw new Error("Run missing");
      stored.stageRuns[0] = { stageId: "a", attempt, status: "running" };
    });
    await replayHeldEvents(h);
    expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", attempt, failure: "interrupted" });
    expect(second.ended).toBe(false);
    expect((await h.stageRun(id, "b")).status).toBe("running");
    if (live === "prior attempt") expect(first.ended).toBe(false);
    expect((await h.runOf(runId))?.settled).toBeUndefined();
  }));

it("a pending preparation protects its exact stage attempt at a permitted read", async () => {
  const preparing = deferred<"preparing">();
  const childLinked = deferred<"child-linked">();
  const release = releaseGate();
  const h = await makeHarness({
    observeRunWork: true,
    script: () => {
      childLinked.resolve("child-linked");
      return undefined;
    },
    wiring: (_store, { workspace }) => ({
      workspace: { ...workspace, prepare: async (...args) => {
        preparing.resolve("preparing");
        await release.promise;
        return workspace.prepare(...args);
      } },
    }),
  });
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const running = h.start(id, h.local(version));
  expect(await Promise.race([preparing.promise, childLinked.promise, running])).toBe("preparing");
  await replayHeldEvents(h, { includeLaunches: false });
  expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 1, status: "running" });
  expect(h.children).toHaveLength(0);
  expect(runsOnDisk(h).heldEvents).toBeUndefined();
  release.resolve();
  await h.drainRunWork();
  expect(h.children).toHaveLength(1);
  const [child] = h.children;
  child.finish();
  await h.drainRunWork();
  expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
});

it("a held event the run file cannot store is held in memory, keeps its stage off the lost path, and replays once live", async () =>
  withRun(["a"], async (run) => {
    const { h, id, children: [child], lose } = run;
    await linked(run);
    const stored = vi.spyOn(h.board.runs, "holdEvent").mockRejectedValue(new Error("run file not writable"));
    lose(true);
    child.finish();
    await h.drainRunWork();
    expect(stored).toHaveBeenCalledTimes(1);
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
    lose(false);
    await replayHeldEvents(h);
    expect(await h.stageRun(id, "a")).toMatchObject({ status: "awaiting_gate", output: `output of ${child.sessionId}` });
  }));

it("a user decision is refused while its run holds events, and goes through once they replay", async () =>
  withRun(["a", "b"], async (run) => {
    const { h, id, runId, children: [first, second], lose } = run;
    await linked(run);
    first.finish();
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    lose(true);
    second.finish();
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([{ itemId: id, runId, stage: "b", attempt: 1, kind: "stage_ended" }]);
    expect(await h.decide(id, "a", "approve")).toEqual({ ok: false, reason: "run_mismatch" });
    expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    lose(false);
    await replayHeldEvents(h);
    expect((await h.stageRun(id, "b")).status).toBe("awaiting_gate");
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
  }));

it.each([true, false])("of the events a process held, a restart drops each but a Stop, which still stops the run (Stop held: %s)", async (stopped) =>
  withRun(["a"], async (run) => {
    const { h, id, runId, children: [child], lose } = run;
    await linked(run);
    lose(true);
    child.finish();
    await h.drainRunWork();
    if (stopped) h.engine.cancelRun(id);
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toHaveLength(stopped ? 2 : 1);
    lose(false);
    const log = vi.spyOn(console, "log");
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    await h.drainRunWork();
    if (stopped) expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "cancelled" }));
    const record = await h.runOf(runId);
    expect(record?.settled?.status).toBe(stopped ? "cancelled" : undefined);
    expect(record?.stageRuns[0]).toMatchObject({ status: "failed", failure: "interrupted" });
    expect(record?.stageRuns[0]?.output).toBeUndefined();
    expect(log.mock.calls.some(call => String(call[0]).includes("superseded by the restart reconcile") && call.includes("stage_ended"))).toBe(true);
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
  }));

it("a run boot kept while its class held it is adopted by a later permitted read once its class is live, without a sweep", async () =>
  withRun(["a"], async (run) => {
    const { h, id, runId } = run;
    await linked(run);
    const goodBoard = readFileSync(h.boardPath, "utf8");
    h.editRow(id, ({ runId: _runId, runHistory: _history, ...row }) => row);
    expect(await h.board.runs.markDeleted({ itemId: id, runId })).toBe("marked");
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    expect((await h.runOf(runId))?.stageRuns[0]?.status).toBe("running");
    expect(h.sweeps.at(-1)).toContain(runId);
    const sweeps = h.sweeps.length;
    writeFileSync(h.boardPath, goodBoard);
    expect(await h.board.runs.withdrawIntent({ itemId: id, runId })).toBe(true);
    await replayHeldEvents(h);
    expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", failure: "interrupted" });
    expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "executing", message: "resumed" }));
    expect(h.sweeps).toHaveLength(sweeps);
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    await h.drainRunWork();
    expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "cancelled" }));
  }));

it.each((["row-lost", "board-unread"] as const).flatMap(reason => [false, true].map(superseded => ({ reason, superseded }))))("a pre-spawn workspace write held by $reason retains its spawn attempt and revalidates it (superseded: $superseded)", async ({ reason, superseded }) => {
  let refusing = true;
  let prepared = false;
  let refusedWrites = 0;
  const childLinked = deferred<"child-linked">();
  const h = await makeHarness({
    observeRunWork: true,
    script: () => {
      childLinked.resolve("child-linked");
      return undefined;
    },
    wiring: (store, { workspace }) => {
      const runs = boardRunState(store);
      return {
        workspace: { ...workspace, prepare: async (...args) => { const result = await workspace.prepare(...args); prepared = true; return result; } },
        runs: { ...runs, update: async (...args) => {
          if (!refusing || !prepared) return runs.update(...args);
          refusedWrites += 1;
          return { ok: false, reason };
        } },
      };
    },
  });
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const running = h.start(id, h.local(version));
  expect(await Promise.race([running, childLinked.promise])).toMatchObject({ status: "awaiting_approval" });
  await h.drainRunWork();
  const runId = (await h.item(id)).runId ?? "";
  const held = { itemId: id, runId, stage: "a", attempt: 1, kind: "spawn_requested" };
  expect(runsOnDisk(h).heldEvents).toEqual([held]);
  expect(h.children).toHaveLength(0);
  expect((await h.runOf(runId))?.settled).toBeUndefined();
  const initialRefusals = refusedWrites;
  await replayHeldEvents(h);
  expect(refusedWrites).toBeGreaterThan(initialRefusals);
  expect(runsOnDisk(h).heldEvents).toEqual([held]);
  if (superseded) editRuns(h, file => { file.runs[0].stageRuns[0].attempt = 2; });
  const log = vi.spyOn(console, "log");
  refusing = false;
  await Promise.all([permittedRead(h), permittedRead(h)]);
  await h.drainRunWork();
  if (superseded) {
    expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", attempt: 2, failure: "interrupted" });
    expect(h.children).toHaveLength(0);
    expect(logged(log, "its stage moved on to another attempt")).toBe(1);
  } else {
    expect(h.children).toHaveLength(1);
    const [child] = h.children;
    child.finish();
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    await replayHeldEvents(h);
    expect(h.children).toHaveLength(1);
  }
  expect(runsOnDisk(h).heldEvents).toBeUndefined();
  expect((await h.runOf(runId))?.settled).toBeUndefined();
});

it("board-unread holds each completion with one coded notice per episode and revalidates without a restart", async () =>
  withRun(["a", "b"], async (run) => {
    const { h, id, runId, children, lose } = run;
    await linked(run);
    for (const [index, child] of children.entries()) {
      lose(true);
      child.finish();
      const stage = index === 0 ? "a" : "b";
      await h.drainRunWork();
      expect(runsOnDisk(h).heldEvents).toEqual([{ itemId: id, runId, stage, attempt: 1, kind: "stage_ended" }]);
      expect((await h.stageRun(id, stage)).status).toBe("running");
      expect((await h.runOf(runId))?.settled).toBeUndefined();
      expect(h.events.filter(event => event.reasonCode === "template-runs-board-unread")).toHaveLength(index + 1);
      await replayHeldEvents(h);
      expect(h.events.filter(event => event.reasonCode === "template-runs-board-unread")).toHaveLength(index + 1);
      lose(false);
      await replayHeldEvents(h);
      expect((await h.stageRun(id, stage)).status).toBe("awaiting_gate");
      expect(runsOnDisk(h).heldEvents).toBeUndefined();
      expect(h.events.filter(event => event.message === "resumed")).toHaveLength(index + 1);
    }
    expect(h.events.some(event => event.phase === "error")).toBe(false);
  }, undefined, "board-unread"));

it("a completion held by an unreadable board replays after the actual board file is restored", async () =>
  withRun(["a"], async (run) => {
    const { h, id, runId, children: [child] } = run;
    await linked(run);
    const readable = readFileSync(h.boardPath);
    writeFileSync(h.boardPath, "{unreadable");
    child.finish();
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([{ itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" }]);
    expect((await h.runOf(runId))?.stageRuns[0].status).toBe("running");
    expect((await h.runOf(runId))?.settled).toBeUndefined();
    expect(h.events.filter(event => event.reasonCode === "template-runs-board-unread")).toHaveLength(1);
    writeFileSync(h.boardPath, readable);
    await replayHeldEvents(h);
    expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
    expect(h.events.some(event => event.phase === "error")).toBe(false);
  }));

it.each(["before", "before-evaluation", "after", "none"] as const)("a held replay claims effects at most once when its handle throws %s the effect", async (failure) => {
  const conditions = createPassConditionRegistry();
  const original = conditions.evaluate;
  const evaluate = vi.spyOn(conditions, "evaluate");
  if (failure === "before-evaluation") evaluate.mockRejectedValueOnce(new Error("before gate effect"));
  if (failure === "after") evaluate.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("after gate effect"); });
  await withRun(["a"], async (run) => {
    const { h, id, runId, children: [child], lose } = run;
    await linked(run);
    lose(true);
    child.finish();
    const held = { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" };
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([held]);
    const warnings = vi.spyOn(console, "warn");
    const write = failure === "before" ? vi.spyOn(h.board, "updateRun").mockRejectedValue(new Error("before gate effect")) : undefined;
    lose(false);
    await h.engine.adoptParkedTemplateRuns();
    await h.drainRunWork();
    if (failure === "before") {
      expect(write).toHaveBeenCalled();
      expect(runsOnDisk(h).heldEvents).toEqual([held]);
      expect((await h.runOf(runId))?.settled).toBeUndefined();
      expect(evaluate).not.toHaveBeenCalled();
      write?.mockRestore();
    } else if (failure === "before-evaluation") {
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(runsOnDisk(h).heldEvents).toEqual([held]);
      expect((await h.runOf(runId))?.settled).toBeUndefined();
    } else if (failure === "after") {
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(runsOnDisk(h).heldEvents).toBeUndefined();
    }
    const boundary = failure === "before-evaluation" ? "before" : failure;
    if (failure !== "none") expect(warnings.mock.calls.some(call => call.some(arg => String(arg).includes(`${boundary} gate effect`)))).toBe(true);
    await Promise.all([permittedRead(h), permittedRead(h)]);
    await h.drainRunWork();
    if (failure === "after") expect((await h.stageRun(id, "a")).status).toBe("failed");
    else expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "done" }));
    await replayHeldEvents(h);
    expect(evaluate).toHaveBeenCalledTimes(failure === "before-evaluation" ? 2 : 1);
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
    expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(failure === "after" ? 0 : 1);
  }, undefined, "row-lost", conditions);
});

it.each(["before", "after", "none"] as const)("a registered gate retries only an unconsumed effect after %s failure", async failure => {
  const conditions = createPassConditionRegistry();
  let calls = 0;
  let effects = 0;
  conditions.register("stage_ok", { evaluate: facts => {
    calls += 1;
    if (failure === "before" && calls === 1) throw new Error("before registered effect");
    if (facts.claimEffect?.() !== false) effects += 1;
    if (failure === "after") throw new Error("after registered effect");
    return { passed: true, evidence: "applied", judgedBy: "host" };
  } });
  await withRun(["a"], async run => {
    const { h, id, runId, children: [child], lose } = run;
    await linked(run);
    lose(true);
    child.finish();
    const identity = { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" };
    await h.drainRunWork();
    expect(runsOnDisk(h).heldEvents).toEqual([identity]);
    const warnings = vi.spyOn(console, "warn");
    lose(false);
    await replayHeldEvents(h);
    expect(calls).toBe(1);
    if (failure === "before") {
      expect(effects).toBe(0);
      expect(runsOnDisk(h).heldEvents).toEqual([identity]);
    } else expect(runsOnDisk(h).heldEvents).toBeUndefined();
    if (failure !== "none") expect(warnings.mock.calls.some(call => call.some(arg => String(arg).includes(`${failure} registered effect`)))).toBe(true);
    await replayHeldEvents(h);
    if (failure === "after") expect((await h.stageRun(id, "a")).status).toBe("failed");
    else expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "done" }));
    await replayHeldEvents(h);
    expect(calls).toBe(failure === "before" ? 2 : 1);
    expect(effects).toBe(1);
  }, undefined, "row-lost", conditions);
});

it("waits for held-event removal after a registered gate claims its effect and throws", async () => {
  const conditions = createPassConditionRegistry();
  const evaluate = vi.fn((facts: Parameters<PassConditionRegistry["evaluate"]>[1]) => {
    expect(facts.claimEffect?.()).toBe(true);
    throw new Error("after registered effect");
  });
  conditions.register("stage_ok", { evaluate });

  await withRun(["a"], async run => {
    const { h, id, runId, children: [child], lose } = run;
    await linked(run);
    lose(true);
    child.finish();
    await h.drainRunWork();
    const identity = { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" };
    expect(runsOnDisk(h).heldEvents).toEqual([identity]);

    const dropStarted = deferred<void>();
    const allowDrop = releaseGate();
    const runWorkDrained = deferred<void>();
    const allowDrain = releaseGate();
    const dropHeld = h.board.runs.dropHeld.bind(h.board.runs);
    const drop = vi.spyOn(h.board.runs, "dropHeld").mockImplementationOnce(async (...args) => {
      dropStarted.resolve();
      await allowDrop.promise;
      await dropHeld(...args);
    });
    const drainRunWork = h.drainRunWork;
    const joinReplay = vi.spyOn(h, "drainRunWork").mockImplementationOnce(async options => {
      await drainRunWork(options);
      runWorkDrained.resolve();
      await allowDrain.promise;
    });

    lose(false);
    let replayFinished = false;
    const replayed = replayHeldEvents(h).finally(() => { replayFinished = true; });
    try {
      await Promise.race([dropStarted.promise, runWorkDrained.promise, replayed]);
      expect(replayFinished).toBe(false);
      expect(evaluate).toHaveBeenCalledOnce();
      expect(runsOnDisk(h).heldEvents).toEqual([identity]);
      // A reader may join the writer. Release the write before checking the separate drain wait.
      allowDrop.resolve();
      await Promise.race([runWorkDrained.promise, replayed]);
      expect(joinReplay).toHaveBeenCalledOnce();
      await afterQueuedCallbacks();
      expect(replayFinished).toBe(false);
    } finally {
      allowDrop.resolve();
      allowDrain.resolve();
      await drainRunWork();
    }
    await replayed;
    expect(runsOnDisk(h).heldEvents).toBeUndefined();
    expect(drop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemId: id, runId }), {
      stage: "a", attempt: 1, kind: "stage_ended",
    });
    expect((await h.stageRun(id, "a")).status).toBe("failed");
    await replayHeldEvents(h);
    expect(evaluate).toHaveBeenCalledOnce();
  }, undefined, "row-lost", conditions);
});
