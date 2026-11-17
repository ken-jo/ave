/** How a template run ends, and what survives a crash or a deleted row: the run file is written first and is the truth; the board row is
 * shown from it. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "../../i18n/messages/en.js";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { ko } from "../../i18n/messages/ko.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import * as activityLog from "../../work-board/activity-log.js";
import { workBoardStage } from "../../shared/work-board-lifecycle.js";
import type { WorkItem, WorkItemResolved } from "../../shared/work-board-types.js";
import { WorkflowTemplateError } from "../../work-board/template-graph.js";
import { boardRunState, type RunRecord, type WorkflowRunState } from "../../work-board/workflow/run-state.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

afterEach(() => { vi.restoreAllMocks(); });
type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
type Options = NonNullable<Parameters<typeof stageRunHarness>[0]>;
async function withHarness(run: (h: Harness) => Promise<void>, opts: (h: () => Harness) => Options = () => ({})): Promise<void> {
  // The options may need the harness they configure (its template store, its board).
  const made: { h?: Harness } = {};
  const h = await stageRunHarness(opts(() => { if (!made.h) throw new Error("harness not ready"); return made.h; }));
  made.h = h;
  try {
    await run(h);
  } finally {
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
}

const auto = autoStageOf;
const A = "/projects/a";
const B = "/projects/b";
async function row(h: Harness, id: number): Promise<WorkItemResolved> {
  const got = await h.board.get(id);
  if (got.status !== "found") throw new Error("item not found");
  return got.item;
}
const shown = async (h: Harness, id: number): Promise<WorkItemResolved> => (await h.engine.projectTemplateRuns([await row(h, id)]))[0];

it("deleting the row of a live run interrupts its child and ends the run cancelled", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  await h.untilLive(1);
  const runId = (await h.item(id)).runId ?? "";
  const update = vi.spyOn(h.board.runs, "update");

  expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
  expect(await run).toMatchObject({ status: "cancelled", reason: "item-removed" });
  expect(h.interrupts).toEqual(["child-1"]);
  const record = (await update.mock.results.at(-1)?.value)?.run as RunRecord | undefined;
  expect(record?.settled?.status).toBe("cancelled");
  expect(record?.stageRuns.map(stage => stage.status)).toEqual(["cancelled", "cancelled"]);
  // Settled with no row left: the record is pruned.
  expect(await h.runOf(runId)).toBeNull();
  expect(h.children).toHaveLength(1);
  // The item is free again: nothing of the run is left in the engine.
  expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
}));

it("Stop interrupts every live child and ends the run cancelled when the pinned version can no longer be read", () => {
  let missing = false;
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    await h.untilLive(2);
    missing = true;
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    expect(await run).toMatchObject({ status: "cancelled", reason: "user-stopped" });
    expect([...h.interrupts].sort()).toEqual(["child-1", "child-2"]);
    const item = await h.item(id);
    expect(item.runStatus).toBe("cancelled");
    expect(item.record?.settled?.status).toBe("cancelled");
    expect(item.stageRuns.map(stage => stage.status)).toEqual(["cancelled", "cancelled"]);
  }, h => ({
    workflow: {
      templates: {
        get: id => h().templates.get(id),
        resolveVersion: (pin) => {
          if (missing) throw new WorkflowTemplateError("unknown-version");
          return h().templates.resolveVersion(pin);
        },
      },
    },
  }));
});

it("a run whose pinned version disappears while children are live interrupts them and ends error only when the last has unwound", () => {
  let missing = false;
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(2);
    await h.until(id, item => item.stageRuns.every(stage => stage.childSessionId !== undefined));
    missing = true;
    a.finish();
    expect(await run).toMatchObject({ status: "error" });
    expect(h.interrupts).toEqual(["child-2"]);
    const item = await h.item(id);
    expect(item.runStatus).toBe("error");
    expect(item.record?.settled?.status).toBe("error");
    expect(item.stageRuns.every(stage => stage.status === "cancelled")).toBe(true);
    expect(h.live()).toHaveLength(0);
  }, h => ({
    workflow: {
      templates: {
        get: id => h().templates.get(id),
        resolveVersion: (pin) => {
          if (missing) throw new WorkflowTemplateError("unknown-version");
          return h().templates.resolveVersion(pin);
        },
      },
    },
  }));
});

it("the run's source is asked again after the stage is prepared: a detach during prepare starts no child", () => {
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const preparing = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  return withHarness(async (h) => {
    const version = await h.confirm([auto("a")]);
    const attached = await h.attach(version);
    const id = await h.addItem(version);
    const run = h.start(id, attached.source);
    await preparing;
    await h.detach(attached.id);
    release();
    expect(await run).toMatchObject({ status: "cancelled", reasonCode: "attachment-detached" });
    expect(h.children).toHaveLength(0);
    expect((await h.item(id)).record?.settled?.status).toBe("cancelled");
  }, h => ({
    workspace: {
      prepare: async (run, stage, attempt) => {
        reached();
        await held;
        return { ok: true, workspace: { kind: "folder", root: `${h().dir}/runs/${run.runId}/${stage.id}-${attempt}` } };
      },
    },
  }));
});

it("a stop that arrives while a stage is being prepared starts no child", () => {
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const preparing = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    await preparing;
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    release();
    expect(await run).toMatchObject({ status: "cancelled", reason: "user-stopped" });
    expect(h.children).toHaveLength(0);
  }, h => ({
    workspace: {
      prepare: async (run, stage, attempt) => {
        reached();
        await held;
        return { ok: true, workspace: { kind: "folder", root: `${h().dir}/runs/${run.runId}/${stage.id}-${attempt}` } };
      },
    },
  }));
});

it("a state change is reduced from the run as stored at the write: a workspace stored meanwhile is kept", () => {
  let releaseB: () => void = () => undefined;
  let stored: () => void = () => undefined;
  const bMayPrepare = new Promise<void>((resolve) => { releaseB = resolve; });
  const bStored = new Promise<void>((resolve) => { stored = resolve; });
  let trapped = false;
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    await h.untilLive(2);
    await h.until(id, item => item.stageRuns.every(stage => stage.childSessionId !== undefined));
    expect(trapped).toBe(true);
    expect((await h.stageRun(id, "a")).workspace).toBeDefined();
    expect((await h.stageRun(id, "b")).workspace).toBeDefined();
  }, (h) => {
    let real: WorkflowRunState | undefined;
    const runs = (): WorkflowRunState => real ??= boardRunState(h().board);
    return {
      workflow: {
        runs: {
          begin: (...a) => runs().begin(...a),
          view: () => runs().view(),
          read: (...a) => runs().read(...a),
          adoption: () => runs().adoption(),
          deleted: () => runs().deleted(),
          pruneSettled: () => runs().pruneSettled(),
          rows: () => runs().rows(),
          settleUnstarted: (...a) => runs().settleUnstarted(...a),
          // The read of one event returns only after another write has stored the second stage's workspace: what it read is stale.
          get: async (itemId, runId) => {
            const run = await runs().get(itemId, runId);
            if (!trapped && run?.stageRuns[0].workspace && !run.stageRuns[1]?.workspace) {
              trapped = true;
              releaseB();
              await bStored;
            }
            return run;
          },
          update: async (...a) => {
            const result = await runs().update(...a);
            if (result.ok && result.run.stageRuns[1]?.workspace) stored();
            return result;
          },
        },
      },
      workspace: {
        prepare: async (run, stage, attempt) => {
          if (stage.id === "b") await bMayPrepare;
          return { ok: true, workspace: { kind: "folder", root: `${h().dir}/runs/${run.runId}/${stage.id}-${attempt}` } };
        },
      },
    };
  });
});

/** What a crash between the write that ends the run and the board write leaves: the run file says how it ended, the row still says
 * executing. The next process's board reconcile leaves a row that names a template run as it is. */
function crashBeforeRowWrite(h: Harness, id: number): void {
  h.editRow(id, (stored) => {
    const { output: _output, ...rest } = stored;
    const history = (rest.runHistory as Record<string, unknown>[] | undefined)?.map((entry) => {
      if (entry.runId !== rest.runId) return entry;
      const { endedAt: _endedAt, ...open } = entry;
      return { ...open, status: "executing" };
    });
    return { ...rest, runStatus: "executing", ...(history ? { runHistory: history } : {}) };
  });
}

it("after a crash between the two settle writes, boot shows the row as the run file says", async () => {
  const endings: { status: "completed" | "denied" | "cancelled"; end: (h: Harness, id: number) => Promise<void> }[] = [
    { status: "completed", end: async (h, id) => { expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true }); } },
    { status: "denied", end: async (h, id) => { expect(await h.decide(id, "a", "reject")).toMatchObject({ ok: true }); } },
    { status: "cancelled", end: async (h, id) => { expect(h.engine.cancelRun(id)).toEqual({ ok: true }); } },
  ];
  for (const ending of endings) {
    await withHarness(async (h) => {
      const version = await h.confirm([stageOf("a")]);
      const id = await h.addItem(version);
      const run = h.start(id, h.local(version));
      (await h.untilLive(1))[0].finish({ summary: "the result" });
      expect(await run).toMatchObject({ status: "awaiting_approval" });
      await ending.end(h, id);
      const settled = await h.until(id, item => item.runStatus === ending.status);
      expect(settled.record?.settled?.status).toBe(ending.status);

      crashBeforeRowWrite(h, id);
      const next = h.makeEngine();
      await h.board.reconcileInterruptedRuns();
      expect((await row(h, id)).runStatus).toBe("executing");
      // A reader before the engine has restored the row is already told how the run ended.
      expect((await shown(h, id)).runStatus).toBe(ending.status);
      await next.adoptParkedTemplateRuns();
      const restored = await row(h, id);
      expect(restored.runStatus).toBe(ending.status);
      expect(restored.runHistory?.at(-1)).toMatchObject({ runId: settled.runId, status: ending.status });
      if (ending.status === "completed") expect(restored.output).toBe("the result");
      expect(h.events.at(-1)).toMatchObject({ itemId: id, phase: ending.status === "completed" ? "done" : ending.status, message: "restored" });
      // Nothing is taken over: the run is over.
      expect(next.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
      expect(h.children).toHaveLength(1);
    });
  }
});

it("a run a restart left unsettled is shown as resuming, never as an error, and cannot be started again before it is taken over", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const runId = (await h.item(id)).runId;

  // The next process: the board's own reconcile leaves the row as it is, and the engine has not taken the run over yet.
  const next = h.makeEngine();
  await h.board.reconcileInterruptedRuns();
  expect((await row(h, id)).runStatus).toBe("executing");
  expect(await shown(h, id)).toMatchObject({ runStatus: "executing", templateRunState: "resuming" });
  expect(workBoardStage(await shown(h, id))).toBe("in_progress");

  // A start in that window takes the run over first and is refused: the unsettled run is never replaced.
  expect(await next.runItem(id, { templateSource: h.local(version) })).toMatchObject({ status: "already_running" });
  expect(await shown(h, id)).toMatchObject({ runStatus: "executing", templateRunState: "awaiting_review" });
  await next.adoptParkedTemplateRuns();
  const adopted = await row(h, id);
  expect(adopted).toMatchObject({ runId, runStatus: "executing" });
  // The history entry is as the first process left it: never ended, never an error.
  expect(adopted.runHistory?.at(-1)).toMatchObject({ runId });
  expect(adopted.runHistory?.at(-1)?.endedAt).toBeUndefined();
  expect(adopted.runHistory?.at(-1)?.status).not.toBe("error");
  expect(await shown(h, id)).toMatchObject({ runStatus: "executing", templateRunState: "awaiting_review" });
  expect(h.events.some(event => event.itemId === id && event.phase === "executing" && event.message === "resumed")).toBe(true);
  expect(h.children).toHaveLength(1);

  // The gate the first process left is decided in this one.
  expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
  await h.untilSpawned(2);
  expect(await shown(h, id)).toMatchObject({ runStatus: "executing", templateRunState: "running" });
}));

it("a stage gate and a join that could not be collected put the item in the Review lane; a row cannot claim it", async () => {
  await withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    expect(workBoardStage(await shown(h, id))).toBe("in_progress");
    a.finish();
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    expect((await row(h, id)).runStatus).toBe("executing");
    expect(await shown(h, id)).toMatchObject({ templateRunState: "awaiting_review" });
    expect(workBoardStage(await shown(h, id))).toBe("review");

    // An ordinary item whose row claims a waiting review is shown as it is.
    const plain = await h.board.create({ title: "Plain" });
    if (plain.status !== "created") throw new Error("item not created");
    const forged = (await h.engine.projectTemplateRuns([{ ...plain.item, templateRunState: "awaiting_review" }]))[0];
    expect(forged.templateRunState).toBeUndefined();
    expect(workBoardStage(forged)).toBe("planned");
  });
  await withHarness(async (h) => {
    const version = await h.confirm([auto("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    expect((await h.item(id)).stageJoins[0]).toMatchObject({ status: "conflict" });
    expect(workBoardStage(await shown(h, id))).toBe("review");
  }, () => ({ integrate: () => ({ ok: false, conflict: { conflictHash: "c".repeat(64), reason: "merge-conflict", files: [] } }) }));
});

it("a board row that names another project never becomes the run's project: project-mismatch, and no workspace is opened", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version, A);
  // The row on disk is pointed at another project; the card the user saw was for A.
  h.editRow(id, stored => ({ ...stored, projectRoot: B }));
  const engine = h.makeEngine();
  expect((await row(h, id)).projectRoot).toBe(B);
  expect(await engine.runItem(id, { templateSource: h.local(version, A) })).toMatchObject({ status: "error", reasonCode: "project-mismatch" });
  expect(h.workspaceCalls).toEqual([]);
  expect((await row(h, id)).runId).toBeUndefined();
  expect(h.children).toHaveLength(0);
}));

it("the run's project is the registry root of the project on the card, or the start is refused", () => {
  let registered: string | null = A;
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version, A);
    // The card's root is an alias the registry resolves to another root.
    registered = "/projects/a-canonical";
    expect(await h.start(id, h.local(version, A))).toMatchObject({ status: "error", reasonCode: "project-mismatch" });
    registered = null;
    expect(await h.start(id, h.local(version, A))).toMatchObject({ status: "error", reasonCode: "scope-not-authorised" });
    expect(h.workspaceCalls).toEqual([]);
    registered = A;
    const run = h.start(id, h.local(version, A));
    await h.untilLive(1);
    expect(h.workspaceCalls[0]).toBe(`open:${A}`);
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    expect(await run).toMatchObject({ status: "cancelled" });
  }, () => ({ workflow: { resolveProjectRoot: () => registered } }));
});

it("a scheduled run of a template that is archived mid-run is refused at its next spawn", () => withHarness(async (h) => {
  const version = await h.confirm([auto("a"), auto("b", { inputs: ["a"] })]);
  const { source } = await h.attach(version);
  const id = await h.addItem(version);
  const run = h.start(id, source);
  const [a] = await h.untilLive(1);
  await h.templates.archive(version.templateId);
  a.finish();
  expect(await run).toMatchObject({ status: "cancelled", reasonCode: "template-archived" });
  expect(h.children).toHaveLength(1);
  expect((await h.item(id)).record?.settled?.status).toBe("cancelled");
}));

it("a revision of a stage whose earlier output came from file content starts tainted", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish({ endTrustOrigin: "file-content", summary: "file-derived data" });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  expect(await h.decide(id, "a", "request_changes", "revise")).toMatchObject({ ok: true });
  const child = (await h.untilSpawned(2))[1];
  expect(child.input.instructions).toContain("file-derived data");
  expect(child.input.hostInputTaint).toBe("file-content");
}));

for (const settleFails of [false, true]) {
  it(`a start whose row write threw after the run was stored ends that run error; one that cannot be ended keeps its workspace (${settleFails})`, async () => {
    const released: string[] = [];
    await withHarness(async (h) => {
      const version = await h.confirm([stageOf("a")]);
      const id = await h.addItem(version);
      const begin = h.board.beginRun.bind(h.board);
      vi.spyOn(h.board, "beginRun").mockImplementationOnce(async (...args) => { await begin(...args); throw new Error("the board sync failed"); });
      const other = await h.addItem(version);
      const write = settleFails ? vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" }) : null;
      expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "run-state-unavailable", reasonCode: "run-state-unavailable" });
      const stored = await h.item(id);
      expect(stored.runId).toBeDefined();
      expect(stored.record?.settled?.status).toBe(settleFails ? undefined : "error");
      expect(released).toEqual(settleFails ? [] : [stored.runId]);
      expect(h.children).toHaveLength(0);
      if (!write) return;
      // Until its end is written, nothing starts and nothing is pruned or swept; the next start writes it first.
      const prune = vi.spyOn(h.board, "pruneSettledRuns");
      const swept = h.sweeps.length;
      expect(await h.start(other, h.local(version))).toMatchObject({ status: "error", reasonCode: "template-runs-pending-review" });
      expect(h.children).toHaveLength(0);
      write.mockRestore();
      let outcome: unknown;
      const started = h.start(other, h.local(version)).then((result) => { outcome = result; });
      for (let i = 0; i < 400 && outcome === undefined && h.live().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
      expect(prune).not.toHaveBeenCalled();
      expect(h.sweeps).toHaveLength(swept);
      expect(released).toEqual([stored.runId]);
      expect((await h.item(id))).toMatchObject({ runStatus: "error", record: { settled: { status: "error" } } });
      expect(h.live()).toHaveLength(1);
      expect(h.engine.cancelRun(other)).toEqual({ ok: true });
      await started;
    }, () => ({ workspace: { release: async (run) => { released.push(run.runId); } } }));
  });
}

for (const [refusal, code] of [["refused", "run-state-unavailable"], ["too-large", "template-runs-too-large"]] as const) {
  it(`a start whose run workspace cannot be stored is refused by a code, and the run ends error (${refusal})`, async () => {
    await withHarness(async (h) => {
      const version = await h.confirm([stageOf("a")]);
      const id = await h.addItem(version);
      vi.spyOn(h.board, "updateRun").mockResolvedValueOnce({ status: refusal });
      const result = await h.start(id, h.local(version));
      expect(result).toEqual({ status: "error", reason: code, reasonCode: code });
      expect((await h.item(id)).record?.settled?.status).toBe("error");
      expect(h.children).toHaveLength(0);
    });
  });
}

it("a start whose run cannot be shown on the board is refused by a code, never by raw text, and the run ends error", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  vi.spyOn(h.board, "setRunStatus").mockResolvedValueOnce({ status: "not_found", itemId: id });
  expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "template-run-not-shown", reasonCode: "template-run-not-shown" });
  expect((await h.item(id)).record?.settled?.status).toBe("error");
  expect(h.children).toHaveLength(0);
  for (const catalog of [en, ko]) expect(Reflect.get(catalog, "reasonCodes.template-run-not-shown")).toEqual(expect.stringMatching(/\S/));
}));

it("a run ended without its graph whose end cannot be written keeps its workspace and row until a reader writes that end", () => {
  let missing = false;
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    await h.until(id, item => item.stageRuns[0].childSessionId !== undefined);
    missing = true;
    const write = vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" });
    const prune = vi.spyOn(h.board, "pruneSettledRuns");
    a.finish();
    expect(await run).toEqual({ status: "error" });
    expect(h.events.at(-1)).toMatchObject({ itemId: id, phase: "error" });
    const item = await h.item(id);
    expect(item.record?.settled).toBeUndefined();
    expect(item.runStatus).toBe("executing");
    expect(released).toEqual([]);
    expect(prune).not.toHaveBeenCalled();

    write.mockRestore();
    missing = false;
    expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
    await h.engine.projectTemplateRuns([item]);
    // The end it could not write is written this time, as it was: never taken over again.
    const ended = await h.until(id, current => current.runStatus === "error");
    expect(ended.record?.settled?.status).toBe("error");
    expect(ended.record?.stageRuns.map(stage => stage.status)).toEqual(["cancelled"]);
    expect(released).toEqual([item.runId]);
    expect(prune).not.toHaveBeenCalled();
    expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
  }, h => ({
    workflow: {
      templates: {
        get: id => h().templates.get(id),
        resolveVersion: (pin) => {
          if (missing) throw new WorkflowTemplateError("unknown-version");
          return h().templates.resolveVersion(pin);
        },
      },
    },
    workspace: { release: async (ref) => { released.push(ref.runId); } },
  }));
});

it("while a run end is unconfirmed, starts are refused and nothing is pruned or swept beside a start that has opened its workspace", () => {
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const first = await h.addItem(version);
    const second = await h.addItem(version);
    const third = await h.addItem(version);
    const runFirst = h.start(first, h.local(version));
    const [a] = await h.untilLive(1);
    const firstRun = (await h.until(first, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";

    // The second start has opened its workspace and is held before its record is stored.
    let reached: () => void = () => undefined;
    const atBegin = new Promise<void>(resolve => { reached = resolve; });
    let resume: () => void = () => undefined;
    const held = new Promise<void>(resolve => { resume = resolve; });
    const begin = h.board.beginRun.bind(h.board);
    const beginRun = vi.spyOn(h.board, "beginRun").mockImplementation(async (...args) => {
      if (args[0] === second) { reached(); await held; }
      return begin(...args);
    });
    const runSecond = h.start(second, h.local(version));
    await atBegin;
    expect(h.workspaceCalls.filter(call => call.startsWith("open:"))).toHaveLength(2);

    // The first run's end cannot be written.
    const updateRun = h.board.updateRun.bind(h.board);
    const failing = vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, runId, mutate) =>
      runId === firstRun ? { status: "pending-review" } : updateRun(itemId, runId, mutate));
    const prune = vi.spyOn(h.board, "pruneSettledRuns");
    const swept = h.sweeps.length;
    a.finish();
    expect(await runFirst).toEqual({ status: "error", reason: "template-runs-pending-review", reasonCode: "template-runs-pending-review" });
    expect(h.events.at(-1)).toMatchObject({ itemId: first, phase: "error", reasonCode: "template-runs-pending-review" });
    expect((await h.item(first)).record?.settled).toBeUndefined();

    expect(await h.start(third, h.local(version))).toMatchObject({ status: "error", reasonCode: "template-runs-pending-review" });
    expect(beginRun.mock.calls.filter(call => call[0] === third)).toHaveLength(0);

    // A reader writes the end; nothing else is pruned or swept, and the held start's workspace is never touched.
    failing.mockRestore();
    await h.engine.projectTemplateRuns([await h.item(first)]);
    for (let i = 0; i < 400 && released.length === 0 && h.sweeps.length === swept; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(prune).not.toHaveBeenCalled();
    expect(h.sweeps).toHaveLength(swept);
    expect(released).toEqual([firstRun]);
    expect((await h.until(first, item => item.runStatus === "error")).record?.settled?.status).toBe("error");

    resume();
    await h.untilLive(1);
    const secondRun = (await h.item(second)).runId ?? "";
    expect(h.sweeps).toHaveLength(swept);
    expect(released).not.toContain(secondRun);
    expect(h.engine.cancelRun(second)).toEqual({ ok: true });
    expect(await runSecond).toMatchObject({ status: "cancelled" });
  }, () => ({ workspace: { release: async (ref) => { released.push(ref.runId); } } }));
});

it("an unconfirmed run end refuses only that run's decisions: a decision on another run goes ahead", () => withHarness(async (h) => {
  const gated = await h.confirm([stageOf("g")]);
  const plain = await h.confirm([auto("a")]);
  const other = await h.addItem(gated);
  const id = await h.addItem(plain);
  const runOther = h.start(other, h.local(gated));
  const [g] = await h.untilLive(1);
  g.finish();
  await h.untilStage(other, "g", "awaiting_gate");

  const run = h.start(id, h.local(plain));
  const [a] = await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const updateRun = h.board.updateRun.bind(h.board);
  vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, target, mutate) =>
    target === runId ? { status: "pending-review" } : updateRun(itemId, target, mutate));
  a.finish();
  await run;
  expect((await h.runOf(runId))?.settled).toBeUndefined();

  // That run is never decided, and never taken over by a decision.
  const refused = await h.engine.decideStageGate(id, { runId, stageId: "a", attempt: 1, resultHash: "", decision: "approve" });
  expect(refused).toEqual({ ok: false, reason: "run_end_unconfirmed" });
  expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
  expect(h.children).toHaveLength(2);

  expect(await h.decide(other, "g", "approve")).toEqual({ ok: true, status: "approved" });
  expect(await runOther).toEqual({ status: "awaiting_approval" });
  expect((await h.until(other, item => item.runStatus === "completed")).record?.settled?.status).toBe("completed");
  expect((await h.runOf(runId))?.settled).toBeUndefined();
  // A decision refusal with text names it by its run reason code.
  for (const catalog of [en, ko]) expect(Reflect.get(catalog, `reasonCodes.${"run_end_unconfirmed".replaceAll("_", "-")}`)).toEqual(expect.stringMatching(/\S/));
}));

it("a takeover a reader asks for that fails is logged, never left as an unhandled rejection", () => {
  let failing = false;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  return withHarness(async (h) => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const version = await h.confirm([auto("a")]);
      const id = await h.addItem(version);
      const run = h.start(id, h.local(version));
      const [a] = await h.untilLive(1);
      const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
      const write = vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" });
      a.finish();
      await run;
      write.mockRestore();
      failing = true;
      await h.engine.projectTemplateRuns([await row(h, id)]);
      for (let i = 0; i < 400 && (await h.runOf(runId))?.settled === undefined; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect((await h.runOf(runId))?.settled?.status).toBe("error");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, () => ({ workflow: { itemChanged: () => { if (failing) throw new Error("listener failed"); } } }));
});

it("a start whose checks throw before anything is stored is refused by a code, never by the error's text", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  vi.spyOn(h.templates, "get").mockRejectedValueOnce(new Error("disk error at a private path"));
  expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "run-state-unavailable", reasonCode: "run-state-unavailable" });
  expect(h.live()).toHaveLength(0);
}));

it("a start whose row write never landed, and whose end could not be written, ends once a readable board shows no row naming it; starts resume", async () => {
  const released: string[] = [];
  await withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    // The row write fails before the board file is replaced, and so do the two writes that would end the stored run.
    vi.spyOn(h.board as unknown as { commit: (board: unknown) => Promise<void> }, "commit").mockRejectedValueOnce(new Error("the board write failed"));
    vi.spyOn(h.board.runs, "update").mockRejectedValueOnce(new Error("disk error")).mockRejectedValueOnce(new Error("disk error"));
    expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "run-state-unavailable", reasonCode: "run-state-unavailable" });
    const listed = await h.board.runs.list();
    const stored = listed.status === "found" ? listed.runs.find(run => run.itemId === id) : undefined;
    expect(stored?.settled).toBeUndefined();
    expect(released).toEqual([]);
    // The next start writes that end first: the board on disk is readable and its row never named the run. No row shows that end.
    const shownOnRow = vi.spyOn(h.board, "setRunResult");
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    // Ended, then pruned with the write: the row never listed it.
    expect(stored?.runId).toBeDefined();
    expect(await h.runOf(stored?.runId ?? "")).toBeNull();
    expect(released).toEqual([stored?.runId]);
    expect(shownOnRow).not.toHaveBeenCalled();
    a.finish();
    expect(await run).toMatchObject({ status: "awaiting_approval" });
  }, () => ({ workspace: { release: async (run) => { released.push(run.runId); } } }));
});

it("a start whose run write throws before anything is stored releases its workspace at once", () => {
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    vi.spyOn(h.board, "beginRun").mockRejectedValueOnce(new Error("disk error"));
    expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "run-state-unavailable", reasonCode: "run-state-unavailable" });
    expect(released).toHaveLength(1);
    expect((await h.item(id)).runId).toBeUndefined();
  }, () => ({ workspace: { release: async (ref) => { released.push(ref.runId); } } }));
});

it("a start that threw after storing its run, while the run file awaits review, keeps its workspace until a reader writes the end", () => {
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const begin = h.board.beginRun.bind(h.board);
    const held: { mockRestore: () => void }[] = [];
    vi.spyOn(h.board, "beginRun").mockImplementationOnce(async (...args) => {
      await begin(...args);
      held.push(vi.spyOn(h.board.runs, "view").mockResolvedValue({ pendingReview: true, get: () => ({ status: "pending-review" }) }));
      held.push(vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" }));
      throw new Error("disk error");
    });
    expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "run-state-unavailable", reasonCode: "run-state-unavailable" });
    expect(released).toEqual([]);
    for (const spy of held) spy.mockRestore();
    const runId = (await h.item(id)).runId ?? "";
    expect((await h.runOf(runId))?.settled).toBeUndefined();

    await h.engine.projectTemplateRuns([await row(h, id)]);
    expect((await h.until(id, item => item.runStatus === "error")).record?.settled?.status).toBe("error");
    expect(released).toEqual([runId]);
  }, () => ({ workspace: { release: async (ref) => { released.push(ref.runId); } } }));
});

it("a start that threw while the run file holds its run id for another row counts it stored and is refused as an unreadable run", () => {
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const begin = h.board.beginRun.bind(h.board);
    vi.spyOn(h.board, "beginRun").mockImplementationOnce(async (...args) => {
      await begin(...args);
      const stored = await h.board.runs.view();
      vi.spyOn(h.board.runs, "view").mockResolvedValue({ pendingReview: false, get: (runId) => {
        const read = stored.get(runId);
        return read.status === "found" ? { status: "found", run: { ...read.run, itemId: read.run.itemId + 1 } } : read;
      } });
      vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" });
      throw new Error("disk error");
    });
    expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "invalid-template-run", reasonCode: "invalid-template-run" });
    expect(released).toEqual([]);
    for (const catalog of [en, ko]) expect(Reflect.get(catalog, "reasonCodes.invalid-template-run")).toEqual(expect.stringMatching(/\S/));
  }, () => ({ workspace: { release: async (ref) => { released.push(ref.runId); } } }));
});

it("an unconfirmed run end whose row is then deleted is confirmed only by a by-id write that succeeds, never by one that threw", () => {
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const other = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
    const updateRun = h.board.updateRun.bind(h.board);
    const failing = vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, target, mutate) =>
      target === runId ? { status: "pending-review" } : updateRun(itemId, target, mutate));
    a.finish();
    await run;
    expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
    failing.mockRestore();

    vi.spyOn(h.board.runs, "update").mockRejectedValueOnce(new Error("disk error"));
    let refused: unknown;
    void h.start(other, h.local(version)).then((result) => { refused = result; });
    for (let i = 0; i < 400 && refused === undefined && h.live().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(released).toEqual([]);
    expect(h.live()).toHaveLength(0);
    expect(refused).toMatchObject({ status: "error", reasonCode: "run-state-unavailable" });
    expect((await h.runOf(runId))?.settled).toBeUndefined();

    const started = h.start(other, h.local(version));
    await h.untilLive(1);
    expect(released).toEqual([runId]);
    expect(await h.runOf(runId)).toBeNull();
    expect(h.engine.cancelRun(other)).toEqual({ ok: true });
    await started;
  }, () => ({ workspace: { release: async (ref) => { released.push(ref.runId); } } }));
});

it("a settled run whose row a board written again after it went missing does not list goes with the mark: no run that is not over is below it", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  a.finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");
  rmSync(h.boardPath);
  await h.addItem(version);
  expect(JSON.parse(readFileSync(h.boardPath, "utf8")).unknownBelow).toBe(id + 1);
  await h.board.pruneSettledRuns();
  expect(JSON.parse(readFileSync(h.boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
  expect(await h.runOf(runId)).toBeNull();
}));

const runFileUnreadable: [string, () => Promise<homeTrust.AveHomeInput>][] = [
  ["cannot be read", async () => { throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }); }],
  ["awaits review", async () => ({ status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" })],
  ["is past its read limit", async () => { throw new homeTrust.AveHomeInputSizeLimitError("too large"); }],
  ["does not parse", async () => ({ status: "trusted", bytes: Buffer.from("{") })],
];
for (const [how, input] of runFileUnreadable) {
  it(`while the run file ${how}, no row is added to a board written again after it went missing; once it can be read, the new row takes the id above the run's row`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    await h.untilLive(1);
    rmSync(h.boardPath);
    // The next process: its board file is gone, and its run file holds the floor.
    const boot = new WorkBoardStore(h.boardPath);
    const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
    const read = homeTrust.readAveHomeInput;
    const held = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(target => target === runsPath ? input() : read(target));
    expect(await boot.runs.list().catch(() => null)).not.toMatchObject({ status: "found" });
    expect(await boot.create({ title: "Work" })).toEqual({ status: "invalid", reason: "work-item-ids-unavailable" });
    expect(existsSync(h.boardPath)).toBe(false);
    held.mockRestore();
    expect(await boot.create({ title: "Work" })).toMatchObject({ status: "created", itemId: id + 1 });
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    await run;
  }));
}

const runFileRefusal: [string, () => Promise<homeTrust.AveHomeInput>, string][] = [
  ["cannot be read", runFileUnreadable[0][1], "run-state-unavailable"],
  ["awaits review", runFileUnreadable[1][1], "template-runs-pending-review"],
  ["is past its read limit", runFileUnreadable[2][1], "template-runs-pending-review"],
  ["does not parse", runFileUnreadable[3][1], "invalid-template-run"],
  ["holds a key twice", async () => ({ status: "trusted", bytes: Buffer.from('{"version":1,"rowIdFloor":0,"runs":[],"runs":[]}') }), "workflow-runs-duplicate-key"],
];
for (const [how, input, code] of runFileRefusal) {
  it(`a start whose run file ${how} when the run is stored returns the refusal ${code}, never not found`, () => withHarness(async (h) => {
    const version = await h.confirm([autoStageOf("a")]);
    const first = await h.addItem(version);
    const id = await h.addItem(version);
    // Taken over by a first run, so the second start reaches the run write.
    const done = h.start(first, h.local(version));
    const [a] = await h.untilLive(1);
    a.finish();
    expect(await done).toMatchObject({ status: "completed" });
    const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
    const read = homeTrust.readAveHomeInput;
    vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(target => target === runsPath ? input() : read(target));
    expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: code, reasonCode: code });
    expect(h.live()).toHaveLength(0);
  }));
}

it("a live run whose row is there and names it is never read as its row gone or lost, whatever the board's nextId says", () => withHarness(async (h) => {
  const version = await h.confirm([autoStageOf("a")]);
  const id = await h.addItem(version);
  const other = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  // nextId set back by hand below the run's row: the row is still there, and still names the run.
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { nextId: number };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, nextId: 1 }));
  expect(await h.addItem(version)).toBe(other + 1);
  expect(await h.board.remove(other)).toMatchObject({ status: "deleted" });
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: id, runId }))).toBe("named");
  a.finish();
  expect(await run).toMatchObject({ status: "completed" });
  expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed" || event.message === "template-run-lost")).toBe(false);
  expect((await h.runOf(runId))?.settled?.status).toBe("completed");
}));

it("a start whose row write may not have landed, while the board file cannot be read, keeps its run and workspace until a readable board shows the row without it", () => {
  const released: string[] = [];
  return withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const before = readFileSync(h.boardPath, "utf8");
    const begin = h.board.beginRun.bind(h.board);
    vi.spyOn(h.board, "beginRun").mockImplementationOnce(async (...args) => {
      await begin(...args);
      writeFileSync(h.boardPath, "{ not json");
      throw new Error("the board sync failed");
    });
    expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "run-state-unavailable", reasonCode: "run-state-unavailable" });
    const listed = await h.board.runs.list();
    const runId = (listed.status === "found" ? listed.runs.find(run => run.itemId === id)?.runId : undefined) ?? "";
    expect((await h.runOf(runId))?.settled).toBeUndefined();
    expect(released).toEqual([]);
    // Readable again, with the row there but not naming the run: the start never landed, and the run ends error with no row showing it.
    writeFileSync(h.boardPath, before);
    await h.engine.projectTemplateRuns([]);
    for (let i = 0; i < 400 && released.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(released).toEqual([runId]);
    expect(await h.runOf(runId)).toBeNull();
  }, () => ({ workspace: { release: async (ref) => { released.push(ref.runId); } } }));
});

it("a board restored to an older copy without a live run's row adds rows above that row, and the run ends cancelled as its row gone", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  await h.addItem(version);
  const older = readFileSync(h.boardPath, "utf8");
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  await h.untilLive(1);
  const runId = (await h.item(id)).runId ?? "";
  writeFileSync(h.boardPath, older);
  expect(await h.addItem(version)).toBe(id + 1);
  expect(await run).toMatchObject({ status: "cancelled", reason: "item-removed" });
  expect(await h.runOf(runId)).toBeNull();
}));

it("a live run whose row was edited so it does not validate keeps that row through another row's add, and is never read as its row gone", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const before = await h.runOf(runId);
  h.editRow(id, row => ({ ...row, priority: 42 }));
  const rowOnDisk = () => (JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: { id: number }[] }).items.find(row => row.id === id);
  const edited = rowOnDisk();
  expect(await h.addItem(version)).toBe(id + 1);
  expect(rowOnDisk()).toEqual(edited);
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: id, runId }))).toBe("unreadable");
  a.finish();
  expect(await run).toEqual({ status: "error", reason: "template-runs-board-unread", reasonCode: "template-runs-board-unread" });
  expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
  expect(await h.runOf(runId)).toEqual(before);
  expect(rowOnDisk()).toEqual(edited);
}));

/** How a hand edit can damage one entry of the board file: the live run's row, put back as raw JSON text. */
const ROW_DAMAGES = ["string id", "fraction id", "missing id", "null id", "negative id", "nan-like id", "non-object", "null entry", "missing field", "renumbered"] as const;
type RowDamage = (typeof ROW_DAMAGES)[number];
function damagedRowText(kind: RowDamage, row: Record<string, unknown>, pick: (count: number) => number, freeId: number): string {
  const { id, ...withoutId } = row;
  const withId = (text: string) => JSON.stringify({ ...row, id: "__id__" }).replace('"__id__"', text);
  switch (kind) {
    case "string id": return JSON.stringify({ ...row, id: [String(id), `${String(id)} `, "one"][pick(3)] });
    case "fraction id": return JSON.stringify({ ...row, id: Number(id) + [0.5, 0.25, 0.999][pick(3)] });
    case "missing id": return JSON.stringify(withoutId);
    case "null id": return withId("null");
    case "negative id": return withId(String(-Number(id)));
    case "nan-like id": return withId(["1e400", "-1e400", "-0", "0", "9007199254740993", '"NaN"'][pick(6)]);
    case "non-object": return ['"row"', "42", "true", "[]", JSON.stringify([row])][pick(5)];
    case "null entry": return "null";
    case "missing field": {
      const field = ["title", "status", "priority", "created_at", "updated_at"][pick(5)];
      return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== field)));
    }
    case "renumbered": return withId(String(freeId));
  }
}

/** A live run of a one-stage template, its child idle until the test finishes it. */
async function liveRun(h: Harness) {
  const version = await h.confirm([auto("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [child] = await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  return { version, id, run, child, runId, record: await h.runOf(runId) };
}

/** Damage the run's row on disk, add another row (a board write, after which the engine checks every live run's row) and wait for that
 * check; the run must read unreadable through it and keep its child and record. Then put the row back as it was. */
async function waitsThroughDamage(h: Harness, live: Awaited<ReturnType<typeof liveRun>>, damage: (row: Record<string, unknown>, freeId: number) => string): Promise<void> {
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { nextId: number; items: Record<string, unknown>[] };
  const original = file.items.find(row => row.id === live.id);
  if (!original) throw new Error("the run's row is not on disk");
  const others = file.items.filter(row => row !== original);
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: [...others, "__row__"] }).replace('"__row__"', damage(original, file.nextId + 100)));
  const rows = vi.spyOn(h.board, "runRowsOnDisk");
  const checks = rows.mock.calls.length;
  await h.addItem(live.version);
  expect(rows.mock.calls.length).toBeGreaterThan(checks);
  const standing = await rows.mock.results[checks].value;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(standing?.({ itemId: live.id, runId: live.runId })).toBe("unreadable");
  expect(h.interrupts).toEqual([]);
  expect(h.live()).toEqual([live.child]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  const damaged = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: unknown[] };
  const intact = damaged.items.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)
    && Number.isSafeInteger((entry as { id?: unknown }).id) && (entry as { id: number }).id !== live.id && !JSON.stringify(entry).includes(live.runId));
  writeFileSync(h.boardPath, JSON.stringify({ ...damaged, items: [original, ...intact] }));
  expect(await h.board.runRowsOnDisk().then(next => next?.({ itemId: live.id, runId: live.runId }))).toBe("named");
}

/** The invalid card of the one entry of the board file on disk that does not validate and matches `pick`. */
async function invalidCard(h: Harness, pick: (row: unknown) => boolean): Promise<{ position: number; hash: string }> {
  await h.board.load();
  const listed = await h.board.list();
  const entries = (JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: unknown[] }).items;
  const cards = (listed.status === "ok" ? listed.unreadableRows ?? [] : []).filter(card => entries.some(entry => pick(entry) && createHash("sha256").update(JSON.stringify(entry)).digest("hex") === card.hash));
  if (cards.length !== 1) throw new Error(`${cards.length} invalid cards match`);
  return cards[0];
}

async function completesUntouched(h: Harness, live: Awaited<ReturnType<typeof liveRun>>): Promise<void> {
  live.child.finish();
  expect(await live.run).toMatchObject({ status: "completed" });
  expect(h.interrupts).toEqual([]);
  expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed" || event.message === "template-run-lost")).toBe(false);
  expect((await h.runOf(live.runId))?.settled?.status).toBe("completed");
}

it.each(["string id", "missing id", "fraction id", "non-object", "null entry", "renumbered"] as const)(
  "a live run whose row was damaged by hand (%s) waits: it is never interrupted, cancelled or pruned, and completes once the row is put back",
  (kind) => withHarness(async (h) => {
    const live = await liveRun(h);
    await waitsThroughDamage(h, live, (row, freeId) => damagedRowText(kind, row, () => 0, freeId));
    await completesUntouched(h, live);
  }),
);

it("a live run whose row was moved by hand from the items list under another top-level key waits through another row's add, which writes that key back as it was; it completes once the row is put back", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] };
  const archive = file.items.filter(row => row.id === live.id);
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: file.items.filter(row => row.id !== live.id), archive }));
  const rows = vi.spyOn(h.board, "runRowsOnDisk");
  const checks = rows.mock.calls.length;
  await h.addItem(live.version);
  expect(rows.mock.calls.length).toBeGreaterThan(checks);
  const standing = await rows.mock.results[checks].value;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(standing?.({ itemId: live.id, runId: live.runId })).toBe("unreadable");
  expect(h.interrupts).toEqual([]);
  expect(h.live()).toEqual([live.child]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  const written = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[]; archive?: unknown };
  expect(written.archive).toEqual(archive);
  writeFileSync(h.boardPath, JSON.stringify({ ...written, archive: undefined, items: [...archive, ...written.items] }));
  expect(await h.board.runRowsOnDisk().then(next => next?.({ itemId: live.id, runId: live.runId }))).toBe("named");
  await completesUntouched(h, live);
}));

it("a live run whose row was put by hand in a first items key a second one shadows reads unreadable, and no write takes the run's id out of the file: the run waits and completes once the row is put back", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { version: number; nextId: number; items: Record<string, unknown>[] };
  const mine = file.items.filter(row => row.id === live.id);
  const text = `{"version":${file.version},"nextId":${file.nextId},"items":${JSON.stringify(mine)},"items":${JSON.stringify(file.items.filter(row => row.id !== live.id))}}`;
  writeFileSync(h.boardPath, text);
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: live.id, runId: live.runId }))).toBe("unreadable");
  await expect(h.board.create({ title: "Unrelated" })).resolves.toEqual({ status: "invalid", reason: "work-board-duplicate-key" });
  expect(readFileSync(h.boardPath, "utf8")).toBe(text);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.interrupts).toEqual([]);
  expect(h.live()).toEqual([live.child]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  writeFileSync(h.boardPath, JSON.stringify(file));
  await completesUntouched(h, live);
}));

it("a live run whose row was moved by hand under another top-level key as an escaped string waits through another row's add, which writes that key back as it was; it completes once the row is put back", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] };
  const archive = JSON.stringify(file.items.filter(row => row.id === live.id));
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: file.items.filter(row => row.id !== live.id), archive }));
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: live.id, runId: live.runId }))).toBe("unreadable");
  await h.addItem(live.version);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.interrupts).toEqual([]);
  expect(h.live()).toEqual([live.child]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  const written = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[]; archive?: unknown };
  expect(written.archive).toBe(archive);
  writeFileSync(h.boardPath, JSON.stringify({ ...written, archive: undefined, items: [...JSON.parse(archive) as unknown[], ...written.items] }));
  await completesUntouched(h, live);
}));

/** A run's id put by hand only under a field a board write does not write, on a row renumbered or naming another run. */
const HELD_UNDER: [string, (row: Record<string, unknown>, runId: string) => Record<string, unknown>][] = [
  ["pin", (row, runId) => ({ ...row, pin: { note: runId } })],
  ["stageRuns", (row, runId) => ({ ...row, stageRuns: [{ runId }] })],
  ["gate", (row, runId) => ({ ...row, gate: { runId } })],
  ["runStartedBy", (row, runId) => ({ ...row, runStartedBy: { runId } })],
  ["templateRunError", (row, runId) => ({ ...row, templateRunError: runId })],
  ["planApproval", (row, runId) => ({ ...row, planApproval: { runId } })],
  ["runHistory stageRuns", (row, runId) => ({ ...row, runHistory: [{ runId: "run-zzz", startedAt: "2026-11-16T00:00:00.000Z", status: "completed", stageRuns: [runId] }] })],
];
it.each((["renumber", "rename"] as const).flatMap(mode => HELD_UNDER.map(([field, put]) => [mode, field, put] as const)))(
  "a live run whose row was %s'd by hand and holds the run's id only under %s waits through another row's add and completes once the row is put back",
  (mode, _field, put) => withHarness(async (h) => {
    const live = await liveRun(h);
    await waitsThroughDamage(h, live, (row, freeId) => {
      const { runId: _runId, runHistory: _history, runStatus: _status, ...rest } = row;
      return JSON.stringify(put(mode === "renumber" ? { ...rest, id: freeId } : { ...rest, runId: "run-other", runStatus: "completed" }, live.runId));
    });
    await completesUntouched(h, live);
  }),
);

it("deleting from its invalid card a live run's row that does not validate is refused while it holds the run's id: nothing is written and the run completes untouched", () => withHarness(async (h) => {
  const live = await liveRun(h);
  h.editRow(live.id, row => ({ ...row, priority: 42 }));
  const onDisk = readFileSync(h.boardPath, "utf8");
  await expect(h.board.removeUnreadable(await invalidCard(h, row => (row as { id?: unknown }).id === live.id), () => true)).rejects.toMatchObject({ code: "work-board-run-id-held" });
  expect(readFileSync(h.boardPath, "utf8")).toBe(onDisk);
  expect(h.interrupts).toEqual([]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  h.editRow(live.id, row => ({ ...row, priority: "medium" }));
  await completesUntouched(h, live);
}));

it("deleting from its invalid card a valid twin added by hand beside a live run's row deletes only that twin: the run's row is listed again and the run completes", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] };
  const mine = file.items.find(row => row.id === live.id) ?? {};
  const twin = { id: live.id, title: "unrelated twin", status: "planned", priority: "medium", created_at: mine.created_at, updated_at: mine.updated_at };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: [...file.items, twin] }));
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: live.id, runId: live.runId }))).toBe("unreadable");
  expect(await h.board.removeUnreadable(await invalidCard(h, row => (row as { title?: unknown }).title === twin.title), () => true)).toEqual({ status: "deleted", itemId: live.id });
  const items = (JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] }).items;
  expect(items.filter(row => row.id === live.id)).toEqual([mine]);
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: live.id, runId: live.runId }))).toBe("named");
  await completesUntouched(h, live);
}));

it("a user's delete of a live run's listed row ends the run cancelled as its row removed, while entries without a usable id are in the board file", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: unknown[] };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: [...file.items, null, "text"] }));
  const row = await h.item(live.id);
  expect(await h.board.remove(live.id, row.mutationRevision)).toEqual({ status: "deleted", itemId: live.id, runId: live.runId });
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: live.id, runId: live.runId }))).toBe("unreadable");
  expect(await live.run).toMatchObject({ status: "cancelled", reason: "item-removed" });
  expect(h.interrupts).toEqual([live.child.sessionId]);
  expect((await h.runOf(live.runId))?.settled?.status).toBe("cancelled");
}));

it("a user's delete of a listed row whose twin with its id does not validate cancels only the run the deleted row named, never the twin's", () => withHarness(async (h) => {
  const live = await liveRun(h);
  h.editRow(live.id, row => ({ ...row, priority: 42 }));
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] };
  const mine = file.items.find(row => row.id === live.id) ?? {};
  const twin = { id: live.id, title: "valid twin", status: "planned", priority: "medium", created_at: mine.created_at, updated_at: mine.updated_at, runId: "run-old" };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: [...file.items, twin] }));
  await h.board.load();
  const listed = await h.board.get(live.id);
  if (listed.status !== "found") throw new Error("twin not listed");
  expect(listed.item.title).toBe(twin.title);
  const rows = vi.spyOn(h.board, "runRowsOnDisk");
  const checks = rows.mock.calls.length;
  expect(await h.board.remove(live.id, listed.item.mutationRevision)).toEqual({ status: "deleted", itemId: live.id, runId: "run-old" });
  expect(rows.mock.calls.length).toBeGreaterThan(checks);
  expect((await rows.mock.results[checks].value)?.({ itemId: live.id, runId: live.runId })).toBe("unreadable");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.interrupts).toEqual([]);
  expect(h.live()).toEqual([live.child]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  h.editRow(live.id, row => ({ ...row, priority: "medium" }));
  await completesUntouched(h, live);
}));

it.each([
  ["entries with no id", (items: unknown[]) => [...items, null, "text"]],
  ["a twin that does not validate", (items: unknown[], id: number) => [...items, { id, title: 5 }]],
])("a user's delete of the listed row of a run a restart left parked ends the run cancelled as its row removed, with %s on the board", (_case, damage) => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const runId = (await h.item(id)).runId ?? "";
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: unknown[] };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: damage(file.items, id) }));

  // The next process, before its engine has taken the run over.
  h.makeEngine();
  const update = vi.spyOn(h.board.runs, "update");
  const before = h.events.length;
  const row = await h.item(id);
  expect(await h.board.remove(id, row.mutationRevision)).toEqual({ status: "deleted", itemId: id, runId });
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  for (let i = 0; i < 400 && !ended(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect(ended()).toEqual({ itemId: id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  const record = (await update.mock.results.at(-1)?.value)?.run as RunRecord | undefined;
  expect(record?.settled?.status).toBe("cancelled");
  expect(record?.stageRuns.map(stage => stage.status)).toEqual(["cancelled"]);
  expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
}));

it("an adoption while a deleted row's parked run is being cancelled leaves that run to the cancel, which ends it as its row removed", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const runId = (await h.item(id)).runId ?? "";

  h.makeEngine();
  // The cancel's write waits until the adoption is done.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const write = h.board.runs.update.bind(h.board.runs);
  const update = vi.spyOn(h.board.runs, "update").mockImplementation(async (...args) => {
    if (update.mock.calls.length === 1) await held;
    return write(...args);
  });
  const before = h.events.length;
  const row = await h.item(id);
  expect(await h.board.remove(id, row.mutationRevision)).toEqual({ status: "deleted", itemId: id, runId });
  for (let i = 0; i < 400 && update.mock.calls.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  await h.engine.adoptParkedTemplateRuns();
  expect(update).toHaveBeenCalledOnce();
  release();
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  for (let i = 0; i < 400 && !ended(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect(ended()).toEqual({ itemId: id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
  expect(h.sweeps.at(-1)).toContain(runId);
}));

it("a deleted row's parked run that an adoption takes over while the delete reads its record still ends cancelled as its row removed", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const runId = (await h.item(id)).runId ?? "";
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: unknown[] };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: [...file.items, null] }));

  h.makeEngine();
  const row = await h.item(id);
  // The adoption lists the board with the row still there and waits; the delete's read of the run waits until the adoption is done.
  const gate = () => { let open = (): void => undefined; const shut = new Promise<void>((resolve) => { open = resolve; }); return { open, shut }; };
  const listGate = gate();
  const list = h.board.list.bind(h.board);
  let listed = false;
  vi.spyOn(h.board, "list").mockImplementation(async (...args) => {
    const got = await list(...args);
    listed = true;
    await listGate.shut;
    return got;
  });
  const adopting = h.engine.adoptParkedTemplateRuns();
  for (let i = 0; i < 400 && !listed; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  const viewGate = gate();
  const view = h.board.runs.view.bind(h.board.runs);
  const reads = vi.spyOn(h.board.runs, "view").mockImplementation(async () => {
    if (reads.mock.calls.length === 1) await viewGate.shut;
    return view();
  });
  const before = h.events.length;
  expect(await h.board.remove(id, row.mutationRevision)).toEqual({ status: "deleted", itemId: id, runId });
  listGate.open();
  await adopting;
  expect(h.events.slice(before)).toContainEqual(expect.objectContaining({ itemId: id, phase: "executing", message: "resumed" }));
  viewGate.open();
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  for (let i = 0; i < 400 && !ended(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect(ended()).toEqual({ itemId: id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
}));

it("a user's delete of the listed row of a run a restart left with a stage running fails that stage as interrupted and ends the run cancelled as its row removed", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: unknown[] };
  writeFileSync(h.boardPath, JSON.stringify({ ...file, items: [...file.items, null] }));

  h.makeEngine();
  const update = vi.spyOn(h.board.runs, "update");
  const before = h.events.length;
  const row = await h.item(live.id);
  expect(await h.board.remove(live.id, row.mutationRevision)).toEqual({ status: "deleted", itemId: live.id, runId: live.runId });
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  for (let i = 0; i < 400 && !ended(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect(ended()).toEqual({ itemId: live.id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  const record = (await update.mock.results.at(-1)?.value)?.run as RunRecord | undefined;
  expect(record?.settled?.status).toBe("cancelled");
  expect(record?.stageRuns).toEqual([expect.objectContaining({ status: "failed", failure: "interrupted" })]);
  // No child of this process ran it: none is interrupted.
  expect(h.interrupts).toEqual([]);
}));

const intentsOf = (h: Harness): unknown => (JSON.parse(readFileSync(runsFile(h), "utf8")) as { deleteIntents?: unknown }).deleteIntents ?? [];
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

async function parkedRun(h: Harness): Promise<{ id: number; runId: string }> {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  return { id, runId: (await h.item(id)).runId ?? "" };
}

it("an adoption between a delete's board write and its takeover leaves the deleted row's parked run to its delete intent: it ends cancelled as its row removed, never as an orphan", () => withHarness(async (h) => {
  const { id, runId } = await parkedRun(h);
  h.makeEngine();
  const row = await h.item(id);
  // The takeover's read of the run waits until the adoption is done.
  let open = (): void => undefined;
  const shut = new Promise<void>((resolve) => { open = resolve; });
  const view = h.board.runs.view.bind(h.board.runs);
  const reads = vi.spyOn(h.board.runs, "view").mockImplementation(async () => {
    if (reads.mock.calls.length === 1) await shut;
    return view();
  });
  const before = h.events.length;
  expect(await h.board.remove(id, row.mutationRevision)).toEqual({ status: "deleted", itemId: id, runId });
  for (let i = 0; i < 400 && reads.mock.calls.length === 0; i += 1) await tick();
  await h.engine.adoptParkedTemplateRuns();
  expect(h.sweeps.at(-1)).toContain(runId);
  open();
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  for (let i = 0; i < 400 && !ended(); i += 1) await tick();
  expect(ended()).toEqual({ itemId: id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  expect(intentsOf(h)).toEqual([]);
  expect(h.engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
}));

it("a delete whose process dies before any engine takes the deleted row's parked run over leaves the run to the next boot, which ends it cancelled as its row removed", () => withHarness(async (h) => {
  const { id, runId } = await parkedRun(h);
  const row = await h.item(id);
  // The board write lands; no engine of that process hears of the delete.
  const dying = new WorkBoardStore(h.boardPath);
  expect(await dying.remove(id, row.mutationRevision)).toEqual({ status: "deleted", itemId: id, runId });
  expect(intentsOf(h)).toEqual([{ itemId: id, runId }]);
  expect((await h.runOf(runId))?.settled).toBeUndefined();

  const next = h.makeEngine();
  const before = h.events.length;
  await next.adoptParkedTemplateRuns();
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  for (let i = 0; i < 400 && !ended(); i += 1) await tick();
  expect(ended()).toEqual({ itemId: id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  expect(intentsOf(h)).toEqual([]);
  expect(next.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
}));

it("a deleted row's run whose takeover write fails keeps its delete intent, and a later reader's takeover ends it cancelled as its row removed", () => withHarness(async (h) => {
  const live = await liveRun(h);
  h.makeEngine();
  const row = await h.item(live.id);
  const write = h.board.runs.update.bind(h.board.runs);
  const update = vi.spyOn(h.board.runs, "update").mockImplementation(async (...args) => update.mock.calls.length === 1 ? { status: "too-large" } : write(...args));
  const before = h.events.length;
  expect(await h.board.remove(live.id, row.mutationRevision)).toEqual({ status: "deleted", itemId: live.id, runId: live.runId });
  for (let i = 0; i < 400 && update.mock.calls.length === 0; i += 1) await tick();
  for (let i = 0; i < 4; i += 1) await tick();
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  expect(ended()).toBeUndefined();
  expect(intentsOf(h)).toEqual([{ itemId: live.id, runId: live.runId }]);
  expect((await h.runOf(live.runId))?.settled).toBeUndefined();

  await h.engine.projectTemplateRuns([]);
  for (let i = 0; i < 400 && !ended(); i += 1) await tick();
  expect(ended()).toEqual({ itemId: live.id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  expect(intentsOf(h)).toEqual([]);
  expect(h.interrupts).toEqual([]);
}));

it("a delete whose board write fails after its delete intent is stored deletes nothing, takes its intent back and ends no run: the live run completes untouched", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const row = await h.item(live.id);
  vi.spyOn(h.board as unknown as { commit: (board: unknown) => Promise<void> }, "commit").mockRejectedValueOnce(new Error("the board write failed"));
  await expect(h.board.remove(live.id, row.mutationRevision)).rejects.toThrow("the board write failed");
  expect(intentsOf(h)).toEqual([]);
  expect((await h.item(live.id)).runId).toBe(live.runId);
  expect(await h.board.deletedRuns()).toEqual([]);
  await completesUntouched(h, live);
  expect(intentsOf(h)).toEqual([]);
}));

it("a delete whose board write fails after its delete intent is stored takes its intent back and leaves the parked run to its listed row at the next boot, and the delete tried again ends it cancelled as its row removed", () => withHarness(async (h) => {
  const { id, runId } = await parkedRun(h);
  const row = await h.item(id);
  vi.spyOn(h.board as unknown as { commit: (board: unknown) => Promise<void> }, "commit").mockRejectedValueOnce(new Error("the board write failed"));
  await expect(h.board.remove(id, row.mutationRevision)).rejects.toThrow("the board write failed");
  expect(intentsOf(h)).toEqual([]);

  const next = h.makeEngine();
  const before = h.events.length;
  await next.adoptParkedTemplateRuns();
  for (let i = 0; i < 20; i += 1) await tick();
  const ended = () => h.events.slice(before).find(event => event.phase === "cancelled" || event.phase === "error");
  expect(ended()).toBeUndefined();
  expect((await h.runOf(runId))?.settled).toBeUndefined();
  expect(intentsOf(h)).toEqual([]);

  expect(await h.board.remove(id, (await h.item(id)).mutationRevision)).toEqual({ status: "deleted", itemId: id, runId });
  for (let i = 0; i < 400 && !ended(); i += 1) await tick();
  expect(ended()).toEqual({ itemId: id, phase: "cancelled", message: "item-removed", at: expect.any(String) });
  expect(intentsOf(h)).toEqual([]);
}));

it.each(["live", "parked at boot"] as const)("a user's delete of a %s run's row whose run id another value of the board file still holds ends no run, and its intent stays", (mode) => withHarness(async (h) => {
  const { id, runId } = mode === "live" ? await liveRun(h).then(live => ({ id: live.id, runId: live.runId })) : await parkedRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as Record<string, unknown>;
  writeFileSync(h.boardPath, JSON.stringify({ ...file, archive: { value: runId } }));
  const before = h.events.length;
  const revision = (await h.item(id)).mutationRevision;
  if (mode === "live") expect(await h.board.remove(id, revision)).toEqual({ status: "deleted", itemId: id, runId });
  else {
    expect(await new WorkBoardStore(h.boardPath).remove(id, revision)).toEqual({ status: "deleted", itemId: id, runId });
    await h.makeEngine().adoptParkedTemplateRuns();
  }
  // A board write, a reader and an adoption read the intent again.
  expect(await h.board.create({ title: "another row" })).toMatchObject({ status: "created" });
  await h.engine.projectTemplateRuns([]);
  await h.engine.adoptParkedTemplateRuns();
  for (let i = 0; i < 20; i += 1) await tick();
  expect(h.events.slice(before).filter(event => event.phase === "cancelled" || event.phase === "error")).toEqual([]);
  expect(h.interrupts).toEqual([]);
  expect((await h.runOf(runId))?.settled).toBeUndefined();
  expect(await h.board.deletedRuns()).toEqual([]);
  expect(intentsOf(h)).toEqual([{ itemId: id, runId }]);
}));

for (const [how, input, code] of runFileRefusal) {
  it(`a delete of a live run's row while the run file ${how} stores no delete intent and deletes nothing: ${code}`, () => withHarness(async (h) => {
    const live = await liveRun(h);
    const onDisk = readFileSync(h.boardPath, "utf8");
    const read = homeTrust.readAveHomeInput;
    vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(target => target === runsFile(h) ? input() : read(target));
    const refusal = await h.board.remove(live.id).then(
      result => result.status === "invalid" ? result.reason : result.status,
      (error: { code?: string }) => error.code === "EIO" ? "run-state-unavailable" : error.code,
    );
    expect(refusal).toBe(code);
    expect(readFileSync(h.boardPath, "utf8")).toBe(onDisk);
    vi.restoreAllMocks();
    expect(intentsOf(h)).toEqual([]);
    expect(h.engine.cancelRun(live.id)).toEqual({ ok: true });
    expect(await live.run).toMatchObject({ status: "cancelled", reason: "user-stopped" });
  }));
}

it("a user's delete of a live run's listed row below the board's unknownBelow mark ends the run cancelled as its row removed, never as lost", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as Record<string, unknown>;
  writeFileSync(h.boardPath, JSON.stringify({ ...file, unknownBelow: live.id + 1 }));
  const row = await h.item(live.id);
  expect(await h.board.remove(live.id, row.mutationRevision)).toEqual({ status: "deleted", itemId: live.id, runId: live.runId });
  expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: live.id, runId: live.runId }))).toBe("lost");
  expect(await live.run).toMatchObject({ status: "cancelled", reason: "item-removed" });
  expect(h.interrupts).toEqual([live.child.sessionId]);
  expect(h.events.some(event => event.message === "template-run-lost")).toBe(false);
}));

it("discarding unreadable run records, ones naming the live run's row included, starts, cancels and settles no run: the live run completes untouched", () => withHarness(async (h) => {
  const live = await liveRun(h);
  const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
  const file = JSON.parse(readFileSync(runsPath, "utf8")) as { runs: unknown[] };
  writeFileSync(runsPath, JSON.stringify({ ...file, runs: [...file.runs, { runId: "run-gone", itemId: live.id }, { runId: 7, itemId: live.id }] }));
  const listed = await h.board.list();
  const cards = listed.status === "ok" ? listed.unreadableRuns ?? [] : [];
  expect(cards.map(card => card.itemId)).toEqual([live.id, live.id]);
  for (const card of [...cards].reverse()) expect(await h.board.discardUnreadableRun(card, () => true)).toEqual({ status: "deleted" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.interrupts).toEqual([]);
  expect(h.live()).toEqual([live.child]);
  expect(await h.runOf(live.runId)).toEqual(live.record);
  await completesUntouched(h, live);
}));

it("no single damaged entry drawn by a seeded generator in place of a live run's row reads as its row gone: the run waits through every one and completes", () => withHarness(async (h) => {
  let state = 0x2026_1117;
  const pick = (count: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * count);
  };
  const live = await liveRun(h);
  const seen = new Set<RowDamage>();
  for (let round = 0; round < 4; round += 1) {
    const kinds: RowDamage[] = [...ROW_DAMAGES];
    for (let i = kinds.length - 1; i > 0; i -= 1) {
      const j = pick(i + 1);
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    for (const kind of kinds) {
      seen.add(kind);
      await waitsThroughDamage(h, live, (row, freeId) => damagedRowText(kind, row, pick, freeId));
    }
  }
  expect([...seen].sort()).toEqual([...ROW_DAMAGES].sort());
  await completesUntouched(h, live);
}), 60_000);

it("a reader whose rows name no run writes the unconfirmed end of a run whose row no longer names it, once the board can be read", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const readable = readFileSync(h.boardPath, "utf8");
  writeFileSync(h.boardPath, "{ not json");
  a.finish();
  expect(await run).toMatchObject({ status: "error", reasonCode: "template-runs-board-unread" });
  expect((await h.runOf(runId))?.settled).toBeUndefined();
  // Readable again, with the row there but no longer naming or holding the run.
  writeFileSync(h.boardPath, readable);
  h.editRow(id, ({ runId: _, runHistory: __, ...row }) => row);
  await h.engine.projectTemplateRuns([]);
  for (let i = 0; i < 400 && !h.events.some(event => event.message === "template-run-lost"); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "error", message: "template-run-lost", reasonCode: "template-run-lost" }));
  expect(await h.runOf(runId)).toBeNull();
}));

it("runs whose rows stop naming them leave nothing behind in the run file: each settled record goes as its run ends", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  for (let i = 0; i < 3; i += 1) {
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    await h.untilLive(1);
    await h.until(id, item => item.stageRuns[0].childSessionId !== undefined);
    h.editRow(id, ({ runId: _, runHistory: __, ...row }) => row);
    await h.addItem(version);
    expect(await run).toMatchObject({ status: "error", reasonCode: "template-run-lost" });
    expect(await h.board.runs.list()).toEqual({ status: "found", runs: [] });
  }
}));

it("writing unconfirmed run ends again keeps going past one that still fails: the next one is confirmed", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const first = await h.addItem(version);
  const second = await h.addItem(version);
  const runFirst = h.start(first, h.local(version));
  const [a] = await h.untilLive(1);
  const runSecond = h.start(second, h.local(version));
  const [, b] = await h.untilLive(2);
  const firstId = (await h.until(first, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const secondId = (await h.until(second, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const updateRun = h.board.updateRun.bind(h.board);
  const failing = new Set([firstId, secondId]);
  vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, target, mutate) =>
    failing.has(target) ? { status: "pending-review" } : updateRun(itemId, target, mutate));
  // The first run's end is the first one left unconfirmed, so it is the first written again.
  a.finish();
  await runFirst;
  b.finish();
  await runSecond;
  failing.delete(secondId);
  const rows = [await row(h, first), await row(h, second)];
  await h.engine.projectTemplateRuns(rows);
  for (let i = 0; i < 400 && (await h.runOf(secondId))?.settled === undefined; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect((await h.runOf(secondId))?.settled?.status).toBe("error");
  expect((await h.runOf(firstId))?.settled).toBeUndefined();
}));

it("a stopped run whose end the run file did not confirm reads as stopped, with a note that its end is not saved", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  await h.untilLive(1);
  const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const updateRun = h.board.updateRun.bind(h.board);
  vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, target, mutate) =>
    target === runId ? { status: "pending-review" } : updateRun(itemId, target, mutate));
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  expect(await run).toEqual({ status: "cancelled", reason: "run-end-unconfirmed", reasonCode: "run-end-unconfirmed" });
  expect(h.events.at(-1)).toMatchObject({ itemId: id, phase: "cancelled", message: "user-stopped", reasonCode: "run-end-unconfirmed" });
  expect((await h.runOf(runId))?.settled).toBeUndefined();
}));

it("a stopped run whose end is written again clears its note that the end is not saved, and an error end shows no stop", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const stopped = await h.addItem(version);
  const failed = await h.addItem(version);
  const runStopped = h.start(stopped, h.local(version));
  await h.untilLive(1);
  const runFailed = h.start(failed, h.local(version));
  const [, b] = await h.untilLive(2);
  const stoppedId = (await h.until(stopped, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const failedId = (await h.until(failed, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
  const updateRun = h.board.updateRun.bind(h.board);
  const failing = new Set([stoppedId, failedId]);
  vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, target, mutate) =>
    failing.has(target) ? { status: "pending-review" } : updateRun(itemId, target, mutate));
  expect(h.engine.cancelRun(stopped)).toEqual({ ok: true });
  expect(await runStopped).toMatchObject({ status: "cancelled", reasonCode: "run-end-unconfirmed" });
  // A finished stage whose end the file refuses ends the run error, also unconfirmed.
  b.finish();
  expect(await runFailed).toMatchObject({ status: "error" });
  const shown = h.events.length;
  failing.clear();
  await h.engine.projectTemplateRuns([await row(h, stopped), await row(h, failed)]);
  for (let i = 0; i < 400 && (await h.runOf(failedId))?.settled === undefined; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect((await h.runOf(stoppedId))?.settled?.status).toBe("cancelled");
  expect(h.events.slice(shown).filter(event => event.phase === "cancelled" || event.phase === "error")).toEqual([
    expect.objectContaining({ itemId: stopped, phase: "cancelled" }),
  ]);
  expect(h.events.slice(shown).find(event => event.itemId === stopped && event.phase === "cancelled")).toEqual({ itemId: stopped, phase: "cancelled", reasonCode: "run-end-confirmed", at: expect.any(String) });
  // Every cancelled event names its cause.
  expect(h.events.filter(event => event.phase === "cancelled" && event.message === undefined && event.reasonCode === undefined)).toEqual([]);
}));

for (const [write, refusal, code] of [
  ["stage end", "too-large", "template-runs-too-large"],
  ["workspace", "too-large", "template-runs-too-large"],
  ["stage end", "refused", "run-state-unavailable"],
] as const) {
  it(`a stage write the run file refuses ends the run with the refusal code on its event and its result (${write}, ${refusal})`, async () => {
    await withHarness(async (h) => {
      const version = await h.confirm([stageOf("a")]);
      const id = await h.addItem(version);
      const updateRun = h.board.updateRun.bind(h.board);
      let armed = write === "workspace";
      // The armed write is refused as the run file's store refuses it: the stage's end, or the first stage workspace. The end write that
      // follows fits.
      vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, runId, mutate) => {
        const current = await h.runOf(runId);
        const next = current && mutate(current);
        const refuse = write === "workspace" ? !!next?.stageRuns.some(stage => stage.workspace) && !current?.stageRuns.some(stage => stage.workspace) : true;
        if (!armed || !refuse) return updateRun(itemId, runId, mutate);
        armed = false;
        return { status: refusal };
      });
      const run = h.start(id, h.local(version));
      if (write === "stage end") {
        const [child] = await h.untilLive(1);
        await h.until(id, item => item.stageRuns[0].childSessionId !== undefined);
        armed = true;
        child.finish();
      }
      expect(await run).toMatchObject({ status: "error", reasonCode: code });
      expect(h.events.find(event => event.phase === "error")).toMatchObject({ itemId: id, message: code, reasonCode: code });
      expect((await h.item(id)).record?.settled?.status).toBe("error");
    });
  });
}

for (const [how, twin] of [
  ["neither names nor holds it", ({ runId: _, runHistory: __, ...row }: Record<string, unknown>) => row],
  ["names another run and holds it in its history", (row: Record<string, unknown>) => ({ ...row, runId: "run-other" })],
] as const) {
  it(`a live run whose row gets a valid twin by hand that ${how} is never read as moved, lost or deleted: its record stays as it was`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
    const before = await h.runOf(runId);
    const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[] };
    const own = file.items.find(item => item.id === id);
    if (!own) throw new Error("row not found");
    file.items.push(twin(own));
    writeFileSync(h.boardPath, JSON.stringify(file));
    expect((await h.board.runRowsOnDisk())?.({ itemId: id, runId })).toBe("unreadable");
    await h.addItem(version);
    a.finish();
    expect(await run).toEqual({ status: "error", reason: "template-runs-board-unread", reasonCode: "template-runs-board-unread" });
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed" || event.message === "template-run-lost")).toBe(false);
    expect(await h.runOf(runId)).toEqual(before);
  }));
}

for (const [board, spoil] of [
  ["unreadable", (path: string) => writeFileSync(path, "{ not json")],
  ["missing", (path: string) => rmSync(path)],
  ["without an items list", (path: string) => writeFileSync(path, JSON.stringify({ version: 1, nextId: 9, items: {} }))],
  ["null", (path: string) => writeFileSync(path, "null")],
  // The file awaits review from here on: every read of it is refused, and the board as shown is seeded again.
  ["awaiting review", (path: string) => {
    const read = homeTrust.readAveHomeInput;
    vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async target => target === path ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(target));
  }],
] as const) {
  // A board written again is on disk and readable, unless the file it replaced still awaits review. Written over a board that showed none
  // of its rows, it marks every id below the new row as unknown: a run on one is lost, never read as its row deleted.
  const written = board !== "awaiting review";
  it(`a live run whose board file is ${board} is never read as its row deleted: nothing is cancelled and its record stays as it was`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
    const before = await h.runOf(runId);
    const prune = vi.spyOn(h.board, "pruneSettledRuns");
    spoil(h.boardPath);
    a.finish();
    expect(await run).toEqual({ status: "error", reason: "template-runs-board-unread", reasonCode: "template-runs-board-unread" });
    expect(h.events.at(-1)).toMatchObject({ itemId: id, phase: "error", reasonCode: "template-runs-board-unread" });
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
    expect(await h.runOf(runId)).toEqual(before);
    expect(prune).not.toHaveBeenCalled();
  }));

  it(`a live run whose board file is ${board}, then written again without its row by another board write, is never read as its row deleted${written ? ": it ends error as lost, and its record goes with the mark" : ""}`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
    const before = await h.runOf(runId);
    const prune = vi.spyOn(h.board, "pruneSettledRuns");
    spoil(h.boardPath);
    await h.addItem(version);
    a.finish();
    if (written) {
      expect(await run).toMatchObject({ status: "error", reasonCode: "template-run-lost" });
      expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "error", message: "template-run-lost", reasonCode: "template-run-lost" }));
      expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
      // No run that is not over is below the mark now: the mark is dropped, and the lost run's record with it.
      expect(JSON.parse(readFileSync(h.boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
      expect(await h.runOf(runId)).toBeNull();
      return;
    }
    expect(await run).toEqual({ status: "error", reason: "template-runs-board-unread", reasonCode: "template-runs-board-unread" });
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
    expect(prune).not.toHaveBeenCalled();
    expect(await h.runOf(runId)).toEqual(before);
  }));

  it(`a board file that is ${board} is written again above a live run's row, which it shows ${written ? "lost" : "nothing for"}, then and after a restart`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    await h.untilLive(1);
    const runId = (await h.item(id)).runId ?? "";
    spoil(h.boardPath);
    expect(await h.addItem(version)).toBe(id + 1);
    const shown = written ? "lost" : undefined;
    expect(await h.board.runRowsOnDisk().then(standing => standing?.({ itemId: id, runId }))).toBe(shown);
    expect(await new WorkBoardStore(h.boardPath).runRowsOnDisk().then(standing => standing?.({ itemId: id, runId }))).toBe(shown);
    if (written) {
      expect(await run).toMatchObject({ status: "error", reasonCode: "template-run-lost" });
      return;
    }
    h.engine.cancelRun(id);
    expect(await run).toMatchObject({ status: "cancelled" });
  }));

  it(`an unconfirmed end of a run whose board file is ${board}, after another board write writes it again without the row, ${written ? "is confirmed as lost by the run's id, and its record goes with the mark" : "stays unconfirmed"}`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [a] = await h.untilLive(1);
    const runId = (await h.until(id, item => item.stageRuns[0].childSessionId !== undefined)).runId ?? "";
    const shownBefore = await row(h, id);
    const before = await h.runOf(runId);
    const prune = vi.spyOn(h.board, "pruneSettledRuns");
    spoil(h.boardPath);
    a.finish();
    expect(await run).toMatchObject({ status: "error", reasonCode: "template-runs-board-unread" });
    const added = await h.addItem(version);
    await h.engine.projectTemplateRuns([shownBefore]);
    // A start waits for the same confirmation the reader asked for; one that went ahead would open a child.
    let started: unknown;
    void h.start(added, h.local(version)).then((result) => { started = result; });
    for (let i = 0; i < 400 && started === undefined && h.live().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
    if (!written) {
      expect(h.events.some(event => event.message === "template-run-lost")).toBe(false);
      expect(prune).not.toHaveBeenCalled();
      expect(h.live()).toHaveLength(0);
      expect(started).toMatchObject({ status: "error", reasonCode: "template-runs-board-unread" });
      expect(await h.runOf(runId)).toEqual(before);
      return;
    }
    // Once the board is readable without the row, below the ids it marks unknown, the end is written by the run's id as lost and the
    // start goes ahead. The new run's row is at the mark, not below it, so the mark is dropped and the lost run's record goes with it.
    const [b] = await h.untilLive(1);
    expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "error", message: "template-run-lost", reasonCode: "template-run-lost" }));
    expect(await h.runOf(runId)).toBeNull();
    b.finish();
    for (let i = 0; i < 400 && started === undefined; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(started).toMatchObject({ status: "awaiting_approval" });
  }));

  if (!written) continue;

  it(`a board file that is ${board}, written again by a create, drops its mark once the lost run ends, and the run's record with it; put back by hand, its row starts nothing and cancels nothing`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    await h.untilLive(1);
    const runId = (await h.item(id)).runId ?? "";
    const good = readFileSync(h.boardPath, "utf8");
    spoil(h.boardPath);
    await h.board.create({ title: "Unrelated" });
    expect(await run).toMatchObject({ status: "error", reasonCode: "template-run-lost" });
    expect(JSON.parse(readFileSync(h.boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
    expect(await h.runOf(runId)).toBeNull();
    writeFileSync(h.boardPath, good);
    const next = h.makeEngine();
    await next.adoptParkedTemplateRuns();
    expect(await shown(h, id)).toMatchObject({ runId, runStatus: "error", templateRunError: "template-run-not-found" });
    expect(h.live()).toHaveLength(0);
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
  }));

  it(`ids at or above the mark a create over a board file that is ${board} sets are known, and the mark goes once the lost run ends: a run on a later row that is deleted ends cancelled and leaves nothing`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const lost = h.start(id, h.local(version));
    await h.untilLive(1);
    const lostId = (await h.item(id)).runId ?? "";
    spoil(h.boardPath);
    const added = await h.addItem(version);
    expect(await lost).toMatchObject({ status: "error", reasonCode: "template-run-lost" });
    expect(JSON.parse(readFileSync(h.boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
    expect(await h.runOf(lostId)).toBeNull();
    for (const itemId of [added, await h.addItem(version)]) {
      const run = h.start(itemId, h.local(version));
      await h.untilLive(1);
      const runId = (await h.item(itemId)).runId ?? "";
      expect(await h.board.remove(itemId)).toMatchObject({ status: "deleted" });
      expect(await run).toMatchObject({ status: "cancelled", reason: "item-removed" });
      expect(await h.runOf(runId)).toBeNull();
    }
    expect(await h.board.runs.list()).toEqual({ status: "found", runs: [] });
  }));

  it(`a parked run whose board file is ${board} and written again by another process's create ends error as lost at the next start, and its record goes with the mark`, () => withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    const runId = (await h.item(id)).runId ?? "";
    spoil(h.boardPath);
    await new WorkBoardStore(h.boardPath).create({ title: "Unrelated" });
    const next = h.makeEngine();
    const ended = vi.spyOn(h.board.runs, "update");
    await next.adoptParkedTemplateRuns();
    // It ended error by its id; no run that is not over is below the mark, so the mark is dropped and the record goes with it.
    const writes = await Promise.all(ended.mock.results.map(result => result.value));
    expect(writes.map(result => result.status === "stored" ? [result.run.runId, result.run.settled?.status] : result.status)).toEqual([[runId, "error"]]);
    expect(await h.runOf(runId)).toBeNull();
    expect(JSON.parse(readFileSync(h.boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
  }));
}

// A row put back in flight by hand whose run the run file no longer holds: its record was pruned once the run was lost.
async function restoredWithoutRecord(h: Harness) {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  await h.untilLive(1);
  const runId = (await h.item(id)).runId ?? "";
  const good = readFileSync(h.boardPath, "utf8");
  writeFileSync(h.boardPath, "{");
  await h.board.create({ title: "Unrelated" });
  expect(await run).toMatchObject({ status: "error", reasonCode: "template-run-lost" });
  expect(await h.runOf(runId)).toBeNull();
  writeFileSync(h.boardPath, good);
  h.makeEngine();
  return { id, runId, version };
}
const runsFile = (h: Harness) => join(dirname(h.boardPath), "workflow-runs.json");

it("a row put back in flight whose run has no record: reconcile writes nothing, the board shows it error and run record not found, and a restart or a move is refused with that code", () => withHarness(async (h) => {
  const { id, runId, version } = await restoredWithoutRecord(h);
  const onDisk = readFileSync(h.boardPath, "utf8");
  expect(await h.board.reconcileInterruptedRuns()).toBe(0);
  await h.engine.adoptParkedTemplateRuns();
  expect(readFileSync(h.boardPath, "utf8")).toBe(onDisk);
  const listed = await h.board.list();
  const notFound = { runId, runStatus: "error", templateRunError: "template-run-not-found" };
  expect(listed.status === "ok" ? listed.items.find(item => item.id === id) : undefined).toMatchObject(notFound);
  expect(await shown(h, id)).toMatchObject(notFound);
  expect(await h.start(id, h.local(version))).toEqual({ status: "error", reason: "template-run-not-found", reasonCode: "template-run-not-found" });
  expect(await h.board.complete(id, (await row(h, id)).mutationRevision)).toEqual({ status: "invalid", itemId: id, reason: "template-run-not-found" });
  expect(await h.board.transition(id, "planned")).toEqual({ status: "invalid", itemId: id, reason: "template-run-not-found" });
  expect(h.children).toHaveLength(1);
  expect(readFileSync(h.boardPath, "utf8")).toBe(onDisk);
  expect(en["reasonCodes.template-run-not-found"]).toBeTruthy();
  expect(ko["reasonCodes.template-run-not-found"]).toBeTruthy();
}));

for (const next of ["run", "complete"] as const) {
  it(`clearing a row shown run record not found ends it error and closes its history entry, with no activity, no run record and no child; a card that does not match is refused; then the row can ${next === "run" ? "run again" : "be completed"}`, () => withHarness(async (h) => {
    const { id, runId, version } = await restoredWithoutRecord(h);
    await h.engine.adoptParkedTemplateRuns();
    const revision = (await row(h, id)).mutationRevision ?? "";
    const appended = vi.spyOn(activityLog, "appendActivity");
    const changed = { status: "invalid", itemId: id, reason: "work-item-changed" };
    expect(await h.engine.clearMissingRun(id, { revision: "0".repeat(64), runId })).toEqual(changed);
    expect(await h.engine.clearMissingRun(id, { revision, runId: "another-run" })).toEqual(changed);
    expect(await h.engine.clearMissingRun(id + 100, { revision, runId })).toEqual({ status: "not_found", itemId: id + 100 });
    expect(await h.engine.clearMissingRun(id, { revision, runId })).toMatchObject({ status: "updated", itemId: id, item: { runId, runStatus: "error" } });
    const stored = (JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: WorkItem[] }).items.find(item => item.id === id);
    expect(stored?.runStatus).toBe("error");
    expect(stored?.runHistory?.find(entry => entry.runId === runId)).toMatchObject({ status: "error", endedAt: expect.any(String) });
    expect(await row(h, id)).not.toHaveProperty("templateRunError");
    expect(appended).not.toHaveBeenCalled();
    expect(await h.runOf(runId)).toBeNull();
    expect(h.children).toHaveLength(1);
    expect(h.events.some(event => event.phase === "cancelled" || event.message === "item-removed")).toBe(false);
    // A second clear names a row that is no longer as its card showed it.
    expect(await h.engine.clearMissingRun(id, { revision, runId })).toEqual(changed);
    if (next === "run") {
      const again = h.start(id, h.local(version));
      const [child] = await h.untilLive(1);
      expect((await h.item(id)).runId).not.toBe(runId);
      child.finish();
      expect(await again).toMatchObject({ status: "awaiting_approval" });
    } else {
      expect(await h.board.complete(id, (await row(h, id)).mutationRevision)).toMatchObject({ status: "completed" });
    }
  }));
}

it("a clear is refused while this host runs the item, even with its record taken out of the run file by hand: the run is left to end on its own", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [child] = await h.untilLive(1);
  const runId = (await h.item(id)).runId ?? "";
  const file = JSON.parse(readFileSync(runsFile(h), "utf8")) as { runs: { runId: string }[] };
  writeFileSync(runsFile(h), JSON.stringify({ ...file, runs: file.runs.filter(entry => entry.runId !== runId) }));
  const missing = await row(h, id);
  expect(missing).toMatchObject({ runStatus: "error", templateRunError: "template-run-not-found" });
  const board = readFileSync(h.boardPath, "utf8");
  expect(await h.engine.clearMissingRun(id, { revision: missing.mutationRevision ?? "", runId })).toEqual({ status: "invalid", itemId: id, reason: "moveRunActive" });
  expect(readFileSync(h.boardPath, "utf8")).toBe(board);
  expect(h.interrupts).toEqual([]);
  expect(child.ended).toBe(false);
  child.finish();
  await run;
}));

it("a broken entry under another run id leaves a row whose run has no record shown so; an entry without a run id could be its record, so the row is shown as it says until that entry is discarded, then it can be cleared", () => withHarness(async (h) => {
  const { id, runId } = await restoredWithoutRecord(h);
  await h.engine.adoptParkedTemplateRuns();
  const file = JSON.parse(readFileSync(runsFile(h), "utf8")) as { runs: unknown[] };
  const other = { runId: "another-run", itemId: id };
  writeFileSync(runsFile(h), JSON.stringify({ ...file, runs: [...file.runs, other] }));
  expect(await shown(h, id)).toMatchObject({ runStatus: "error", templateRunError: "template-run-not-found" });
  const idless = { itemId: id };
  writeFileSync(runsFile(h), JSON.stringify({ ...file, runs: [...file.runs, other, idless] }));
  const held = await shown(h, id);
  expect(held.runStatus).toBe("executing");
  expect(held).not.toHaveProperty("templateRunError");
  expect(await h.engine.clearMissingRun(id, { revision: held.mutationRevision ?? "", runId })).toEqual({ status: "invalid", itemId: id, reason: "work-item-changed" });
  const listed = await h.board.list();
  const hash = createHash("sha256").update(JSON.stringify(idless)).digest("hex");
  const entry = listed.status === "ok" ? listed.unreadableRuns?.find(candidate => candidate.hash === hash) : undefined;
  if (!entry) throw new Error("no unreadable run card");
  expect(await h.board.discardUnreadableRun({ position: entry.position, hash }, () => true)).toEqual({ status: "deleted" });
  const freed = await shown(h, id);
  expect(freed).toMatchObject({ runStatus: "error", templateRunError: "template-run-not-found" });
  expect(await h.engine.clearMissingRun(id, { revision: freed.mutationRevision ?? "", runId })).toMatchObject({ status: "updated", itemId: id });
}));
