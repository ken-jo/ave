import { expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { deferred } from "../../../__tests__/support/deferred.js";
import { boardRunState } from "../run-state.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { workBoardOriginSessionId } from "../../../shared/work-board-types.js";
import type { StageWorkspaceProvider } from "../stage-workspace.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["refused", "failed", "ended", "cancelled"] as const)("settles child waits when the expected run is %s", async outcome => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          preparing.resolve();
          await release.promise;
          if (outcome === "failed") throw new Error("preparation failed");
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const cleanup = vi.fn(h.cleanup);
  let running: ReturnType<typeof h.start> | undefined;
  try {
    try {
      const version = await h.confirm([autoStageOf("a")]);
      const id = await h.addItem(version);
      if (outcome === "refused") {
        running = h.start(id, h.local(version, h.dir));
      } else {
        running = h.start(id, h.local(version));
        await Promise.race([preparing.promise.then(() => "preparing"), running]);
      }
      const count = outcome === "ended" ? 2 : 1;
      const waits = Promise.allSettled([h.waitForLive(count), h.untilLive(count), h.untilSpawned(count)]);
      if (outcome === "cancelled") {
        expect(h.engine.cancelRun(id)).toEqual({ ok: true });
      } else {
        release.resolve();
        if (outcome === "ended") (await h.untilLive(1))[0].finish();
        await running;
      }
      const result = await Promise.race([waits, setImmediate("still pending")]);
      const reason = { refused: /project-mismatch/, failed: /stage_failed/, ended: /done/, cancelled: /cancelled/ }[outcome];
      expect(result).toEqual(Array.from({ length: 3 }, () => ({
        status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(reason) }),
      })));
      if (outcome === "refused" || outcome === "failed") expect(h.children).toHaveLength(0);
    } finally {
      release.resolve();
      await running;
      await h.drainRunWork();
      await cleanup();
    }
  } finally {
    expect(cleanup).toHaveBeenCalledOnce();
  }
});

it.each(["hook failure", "script failure", "scripted exit", "interrupt"] as const)("settles an allocated child after %s", async outcome => {
  const h = await stageRunHarness({
    observeRunWork: true,
    workflow: {
      runScope: {
        sessionLinked: () => {
          if (outcome === "hook failure") throw new Error("linkage hook failed");
        },
        sessionEnded: () => {},
        runEnded: () => {},
      },
    },
    script: () => {
      if (outcome === "script failure") throw new Error("child script failed");
      return outcome === "scripted exit" ? { summary: "scripted result" } : undefined;
    },
  });
  let running: ReturnType<typeof h.start> | undefined;
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    running = h.start(id, h.local(version));
    const live = h.untilLive(1, id);
    const waits = Promise.allSettled([h.untilSpawned(1, id), live]);
    if (outcome === "interrupt") {
      expect((await live)[0].ended).toBe(false);
      expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    }
    const run = await running;
    await h.drainRunWork();

    const result = await Promise.race([waits, setImmediate("still pending")]);
    expect(h.children).toHaveLength(1);
    const [child] = h.children;
    const reason = { "hook failure": /linkage hook failed/, "script failure": /child script failed/, "scripted exit": /done/ };
    expect(result).toEqual([
      { status: "fulfilled", value: [child] },
      outcome === "interrupt" ? { status: "fulfilled", value: [child] } : {
        status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(reason[outcome]) }),
      },
    ]);
    expect(child.ended).toBe(true);
    expect(h.live()).toEqual([]);
    if (outcome === "scripted exit") expect(run).toMatchObject({ status: "completed", output: "scripted result" });
    else if (outcome === "interrupt") {
      expect(run.status).toBe("cancelled");
      expect(h.interrupts).toEqual([child.sessionId]);
    } else expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", failure: "error" });
  } finally {
    for (const child of h.live()) child.finish();
    await running;
    await h.drainRunWork();
    await h.cleanup();
  }
});

it.each(["registered", "ended before preparation", "ended after release"] as const)("checks the preparation and registration order when %s", async outcome => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const linked = deferred<void>();
  const h = await stageRunHarness({
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          preparing.resolve();
          await release.promise;
          if (outcome === "ended after release") throw new Error("preparation failed after release");
          return workspace.prepare(...args);
        },
      },
      runScope: { sessionLinked: () => linked.resolve(), sessionEnded: () => {}, runEnded: () => {} },
    }),
  });
  let running: ReturnType<typeof h.start> | undefined;
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version, outcome === "ended before preparation" ? h.dir : undefined));
    running = started;
    async function checkRegistration() {
      const first = await Promise.race([preparing.promise.then(() => "preparing"), started.then(result => result.status)]);
      expect(first, "run ended before preparation").toBe("preparing");
      expect(h.children).toHaveLength(0);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waits = [h.waitForLive(1), h.untilLive(1), h.untilSpawned(1)];
      const settled = vi.fn();
      for (const wait of waits) void wait.then(settled, settled);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).not.toHaveBeenCalled();

      vi.useRealTimers();
      release.resolve();
      const [[child], live, spawned] = await Promise.race([
        Promise.all(waits).catch((cause: Error) => { throw new Error(`run ended before child registration: ${cause.message}`, { cause }); }),
        started.then(result => { throw new Error(`run ended before child registration: ${result.status}`); }),
      ]);
      expect(live).toEqual([child]);
      expect(spawned).toEqual([child]);
      expect(h.events).toContainEqual(expect.objectContaining({ phase: "executing", runSessionId: child.sessionId }));
    }
    const registration = checkRegistration();
    if (outcome === "registered") await registration;
    else if (outcome === "ended before preparation") {
      const result = await Promise.race([registration, started.then(() => setImmediate("registration stayed pending"))].map(promise =>
        promise.catch((error: Error) => error.message)));
      expect(result).toContain("run ended before preparation");
    } else await expect(registration).rejects.toThrow("run ended before child registration");
  } finally {
    vi.useRealTimers();
    release.resolve();
    try {
      if (running) {
        await Promise.race([linked.promise, running]);
        for (const child of h.children) child.finish();
        await running;
      }
    } finally {
      await h.cleanup();
    }
  }
});

it.each(["cancelled", "ended", "cancelled before its child"] as const)("an aggregate child wait settles when an earlier item it counts is %s", async outcome => {
  const release = deferred<void>();
  let held = 0;
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[0].itemId === held) await release.promise;
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const runs: Promise<unknown>[] = [];
  const version = await h.confirm([autoStageOf("a")]);
  const earlier = await h.addItem(version);
  const later = await h.addItem(version);
  held = outcome === "cancelled before its child" ? earlier : later;
  try {
    runs.push(h.start(earlier, h.local(version)));
    if (held === later) await h.untilLive(1);
    runs.push(h.start(later, h.local(version)));
    const [child] = await h.untilLive(1);
    const waits = Promise.allSettled([h.waitForLive(2), h.untilLive(2)]);
    if (outcome === "ended") child.finish();
    else expect(h.engine.cancelRun(earlier)).toEqual({ ok: true });
    // A held preparation keeps the cancelled start pending until the release below.
    if (held === later) await runs[0];
    const result = await Promise.race([waits, setImmediate("still pending")]);
    const reason = outcome === "ended" ? /done/ : /cancelled/;
    expect(result).toEqual(Array.from({ length: 2 }, () => ({
      status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(reason) }),
    })));
  } finally {
    h.engine.cancelRun(held);
    release.resolve();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a child wait created after a failed relaunch settles at once", async () => {
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (run, stage, attempt) => {
          if (attempt === 2) throw new Error("relaunch preparation failed");
          return workspace.prepare(run, stage, attempt);
        },
      },
    }),
  });
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    (await h.untilLive(1, id))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    const { runId } = await h.item(id);
    expect(await h.engine.retryStage(id, { runId: runId ?? "", stageId: "a" })).toEqual({ ok: true });
    await h.drainRunWork();
    expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 2, status: "failed" });

    const waits = Promise.allSettled([h.untilSpawned(2, id), h.untilLive(1, id), h.untilLive(1)]);
    const result = await Promise.race([waits, setImmediate("still pending")]);
    expect(result).toEqual(Array.from({ length: 3 }, () => ({
      status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }),
    })));
    // A refused retry or gate decision starts nothing, so the failure still stands.
    expect(await h.engine.retryStage(id, { runId: "run-other", stageId: "a" })).toMatchObject({ ok: false });
    expect(await h.engine.decideStageGate(id, { runId: "run-other", stageId: "a", attempt: 2, resultHash: "", decision: "approve" })).toMatchObject({ ok: false });
    await expect(Promise.race([h.untilSpawned(2, id), setImmediate("still pending")])).rejects.toThrow(/stage_failed/);
    expect(h.children).toHaveLength(1);
  } finally {
    for (const child of h.live()) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a rerun's stage that fails before registration settles its child waits after the replaced engine links the same attempt", async () => {
  const held = deferred<void>();
  const release = deferred<void>();
  const rerunPreparing = deferred<void>();
  const rerunRelease = deferred<void>();
  const oldLinked = deferred<void>();
  let engines = 0;
  let prepared = false;
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (store, { workspace }) => {
      const engine = engines++;
      const runs = boardRunState(store);
      return {
        runScope: { sessionLinked: () => { if (engine === 0) oldLinked.resolve(); }, sessionEnded: () => {}, runEnded: () => {} },
        runs: {
          ...runs,
          update: async (...args: Parameters<typeof runs.update>) => {
            const result = await runs.update(...args);
            if (engine === 0 && prepared) {
              held.resolve();
              await release.promise;
            }
            return result;
          },
        },
        workspace: {
          ...workspace,
          prepare: async (...args) => {
            if (engine === 0) prepared = true;
            else {
              rerunPreparing.resolve();
              await rerunRelease.promise;
              throw new Error("rerun preparation failed");
            }
            return workspace.prepare(...args);
          },
        },
      };
    },
  });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    runs.push(h.start(id, h.local(version)));
    await held.promise;
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    await h.drainRunWork();

    const rerun = h.events.length;
    runs.push(h.start(id, h.local(version)));
    const waits = Promise.allSettled([h.untilSpawned(2, id), h.untilLive(2, id)]);
    await rerunPreparing.promise;
    release.resolve();
    await oldLinked.promise;
    rerunRelease.resolve();
    await h.drainRunWork();
    const after = h.events.slice(rerun).filter(event => event.stageId === "a" && event.attempt === 1);
    expect(after.map(event => event.phase)).toEqual(["executing", "stage_failed"]);
    expect(after[0].runSessionId).toBeDefined();
    const result = await Promise.race([waits, setImmediate("still pending")]);
    expect(result).toEqual(Array.from({ length: 2 }, () => ({
      status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }),
    })));
  } finally {
    release.resolve();
    rerunRelease.resolve();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a child wait outlives the restored end of the item's earlier run", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  let running: ReturnType<typeof h.start> | undefined;
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const first = h.start(id, h.local(version));
    (await h.untilLive(1, id))[0].finish();
    expect(await first).toMatchObject({ status: "completed" });
    h.editRow(id, row => ({ ...row, runStatus: "executing" }));
    h.makeEngine();
    const shown = h.events.length;
    const wait = h.untilLive(1, id);
    await h.engine.adoptParkedTemplateRuns();
    expect(h.events.slice(shown)).toContainEqual(expect.objectContaining({ itemId: id, phase: "done", message: "restored" }));
    const settled = vi.fn();
    void wait.then(settled, settled);
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();

    running = h.start(id, h.local(version));
    const [child] = await wait;
    expect(h.live()).toEqual([child]);
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  } finally {
    for (const child of h.live()) child.finish();
    await running;
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a child wait outlives the confirmed end of the item's earlier stopped run", async () => {
  const relinked = deferred<void>();
  let links = 0;
  const h = await stageRunHarness({
    observeRunWork: true,
    workflow: { runScope: { sessionLinked: () => { if (++links === 2) relinked.resolve(); }, sessionEnded: () => {}, runEnded: () => {} } },
  });
  let running: ReturnType<typeof h.start> | undefined;
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const first = h.start(id, h.local(version));
    await h.untilLive(1, id);
    const runId = (await h.item(id)).runId ?? "";
    const updateRun = h.board.updateRun.bind(h.board);
    const failing = vi.spyOn(h.board, "updateRun").mockImplementation(async (itemId, target, mutate) =>
      target === runId ? { status: "pending-review" } : updateRun(itemId, target, mutate));
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    expect(await first).toMatchObject({ status: "cancelled", reasonCode: "run-end-unconfirmed" });
    failing.mockRestore();

    const shown = h.events.length;
    running = h.start(id, h.local(version));
    const wait = Promise.allSettled([h.untilLive(1, id)]);
    await relinked.promise;
    expect(h.events.slice(shown)).toContainEqual(expect.objectContaining({ itemId: id, phase: "cancelled", reasonCode: "run-end-confirmed" }));
    expect(await wait).toEqual([{ status: "fulfilled", value: h.live() }]);
    expect(h.live()).toHaveLength(1);
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  } finally {
    for (const child of h.live()) child.finish();
    await running;
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a child wait created after a refused start settles at once", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    expect(await h.start(id, h.local(version, h.dir))).toMatchObject({ status: "error" });
    const result = await Promise.race([Promise.allSettled([h.untilLive(1, id), h.untilSpawned(1, id)]), setImmediate("still pending")]);
    expect(result).toEqual(Array.from({ length: 2 }, () => ({
      status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/project-mismatch/) }),
    })));
  } finally {
    await h.cleanup();
  }
});

it("a second start of a running item leaves its child waits pending", async () => {
  const release = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (run, stage, attempt) => {
          if (stage.id === "b") await release.promise;
          return workspace.prepare(run, stage, attempt);
        },
      },
    }),
  });
  let running: ReturnType<typeof h.start> | undefined;
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    running = h.start(id, h.local(version));
    await h.untilLive(1, id);
    const early = Promise.allSettled([h.untilLive(2, id), h.untilSpawned(2, id)]);
    expect(await h.start(id, h.local(version))).toMatchObject({ status: "already_running" });
    expect(await Promise.race([early, setImmediate("still pending")])).toBe("still pending");
    const late = h.untilLive(2, id);
    release.resolve();
    const [live] = await Promise.all([late, early]);
    expect(live).toHaveLength(2);
  } finally {
    release.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await running;
    await h.drainRunWork();
    await h.cleanup();
  }
});

/** Holds the preparation of the stages `held` names until `release` resolves. */
function holdingPrepare(held: (itemId: number, stageId: string) => boolean, release: Promise<void>) {
  return {
    observeRunWork: true,
    wiring: (_store: unknown, { workspace }: { workspace: StageWorkspaceProvider }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args: Parameters<StageWorkspaceProvider["prepare"]>) => {
          if (held(args[0].itemId, args[1].id)) await release;
          return workspace.prepare(...args);
        },
      },
    }),
  };
}

it.each(["ended", "refused"] as const)("an aggregate child wait created after a later item %s keeps following an earlier item in flight", async outcome => {
  const release = deferred<void>();
  let earlier = 0;
  const h = await stageRunHarness(holdingPrepare((itemId, stageId) => itemId === earlier && (outcome === "ended" || stageId === "b"), release.promise));
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm(outcome === "ended" ? [autoStageOf("a")] : [autoStageOf("a"), autoStageOf("b")]);
    earlier = await h.addItem(version);
    const later = await h.addItem(version);
    runs.push(h.start(earlier, h.local(version)));
    if (outcome === "ended") {
      runs.push(h.start(later, h.local(version)));
      (await h.untilLive(1, later))[0].finish();
      expect(await runs[1]).toMatchObject({ status: "completed" });
    } else {
      await h.untilLive(1, earlier);
      expect(await h.start(later, h.local(version, h.dir))).toMatchObject({ status: "error" });
    }
    const count = outcome === "ended" ? 1 : 2;
    const wait = Promise.allSettled([h.untilLive(count)]);
    expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
    release.resolve();
    const [result] = await wait;
    expect(result).toEqual({ status: "fulfilled", value: h.live() });
    expect(h.live().map(child => child.input.originSessionId)).toEqual(Array.from({ length: count }, () => workBoardOriginSessionId(earlier)));
  } finally {
    release.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("an aggregate spawn count outlives the normal end of an earlier item it counted", async () => {
  const release = deferred<void>();
  let later = 0;
  const h = await stageRunHarness(holdingPrepare(itemId => itemId === later, release.promise));
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const earlier = await h.addItem(version);
    later = await h.addItem(version);
    runs.push(h.start(earlier, h.local(version)));
    const [child] = await h.untilLive(1, earlier);
    runs.push(h.start(later, h.local(version)));
    const wait = Promise.allSettled([h.untilSpawned(2)]);
    child.finish();
    expect(await runs[0]).toMatchObject({ status: "completed" });
    expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
    release.resolve();
    expect(await wait).toEqual([{ status: "fulfilled", value: h.children }]);
    expect(h.children).toHaveLength(2);
  } finally {
    release.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it.each(["cancelled", "completes while the other item has failed"] as const)("an aggregate spawn count settles when an earlier item it counted is %s", async outcome => {
  const release = deferred<void>();
  let later = 0;
  const h = await stageRunHarness(holdingPrepare((itemId, stageId) => {
    if (itemId !== later) return false;
    if (stageId === "x") throw new Error("preparation failed");
    return true;
  }, release.promise));
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const other = await h.confirm(outcome === "cancelled" ? [stageOf("y")] : [stageOf("x")]);
    const earlier = await h.addItem(version);
    later = await h.addItem(other);
    runs.push(h.start(earlier, h.local(version)));
    const [child] = await h.untilLive(1, earlier);
    runs.push(h.start(later, h.local(other)));
    // The failed preparation parks the later run with its failure recorded and no child.
    if (outcome !== "cancelled") expect(await runs[1]).toMatchObject({ status: "awaiting_approval" });
    const wait = Promise.allSettled([h.untilSpawned(2)]);
    if (outcome === "cancelled") expect(h.engine.cancelRun(earlier)).toEqual({ ok: true });
    else {
      expect(h.events).toContainEqual(expect.objectContaining({ itemId: later, phase: "stage_failed", stageId: "x" }));
      child.finish();
    }
    await runs[0];
    const reason = outcome === "cancelled" ? /cancelled/ : /done/;
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(reason) }) },
    ]);
  } finally {
    h.engine.cancelRun(later);
    release.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a second start of a running item keeps the item's standing failure", async () => {
  const linked = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      runScope: { sessionLinked: () => linked.resolve(), sessionEnded: () => {}, runEnded: () => {} },
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[1].id === "a") throw new Error("preparation failed");
          return workspace.prepare(...args);
        },
      },
    }),
  });
  let running: ReturnType<typeof h.start> | undefined;
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    running = h.start(id, h.local(version));
    await linked.promise;
    await h.drainRunWork();
    expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: "stage_failed", stageId: "a" }));
    expect(await h.start(id, h.local(version))).toMatchObject({ status: "already_running" });
    await expect(Promise.race([h.untilLive(2, id), setImmediate("still pending")])).rejects.toThrow(/stage_failed/);
  } finally {
    for (const child of h.live()) child.finish();
    await running;
    await h.drainRunWork();
    await h.cleanup();
  }
});
