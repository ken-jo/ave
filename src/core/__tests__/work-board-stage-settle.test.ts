/** How a template run ends, and what survives a crash or a deleted row: the run file is written first and is the truth; the board row is
 * shown from it. */
import { expect, it, vi } from "vitest";
import { workBoardStage } from "../../shared/work-board-lifecycle.js";
import type { WorkItemResolved } from "../../shared/work-board-types.js";
import { WorkflowTemplateError } from "../../work-board/template-graph.js";
import { boardRunState, type RunRecord, type WorkflowRunState } from "../../work-board/workflow/run-state.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

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
          adoption: () => runs().adoption(),
          pruneSettled: () => runs().pruneSettled(),
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
      if (settleFails) vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" });
      expect(await h.start(id, h.local(version))).toMatchObject({ status: "error", reason: "the board sync failed" });
      const stored = await h.item(id);
      expect(stored.runId).toBeDefined();
      expect(stored.record?.settled?.status).toBe(settleFails ? undefined : "error");
      expect(released).toEqual(settleFails ? [] : [stored.runId]);
      expect(h.children).toHaveLength(0);
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
    await run;
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
    await runFirst;
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
