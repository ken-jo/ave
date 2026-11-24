import { expect, it, type MockInstance, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { deferred } from "../../../__tests__/support/deferred.js";
import * as namespace from "../../../main/storage/feature-namespace.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
import { boardRunState } from "../run-state.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { workBoardOriginSessionId } from "../../../shared/work-board-types.js";
import type { StageWorkspaceProvider } from "../stage-workspace.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("checks board and run changes without advancing timers", async () => {
  const h = await stageRunHarness();
  const release = deferred<void>();
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const runId = "run-1";
    expect(await h.board.beginRun(id, runId, "2026-11-16T00:00:00.000Z", {
      ...h.pinOf(version), source: h.local(version), stageRuns: [{ stageId: "a", attempt: 1, status: "waiting" }],
    })).toMatchObject({ status: "updated" });
    const board = h.board;
    const boardRead = await board.get(id);
    const runRead = await board.runs.get(runId);
    if (boardRead.status !== "found" || runRead.status !== "found") throw new Error("Missing wait fixture");
    let boardSnapshot = boardRead;
    let runSnapshot = runRead;
    vi.spyOn(board, "get").mockImplementation(async () => boardSnapshot);
    const read = vi.spyOn(board.runs, "get").mockImplementation(async () => runSnapshot);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const matches = vi.fn((item: Awaited<ReturnType<typeof h.item>>) => h.statusOf(item, "a") === "running");
    const current = h.until(id, matches);
    const stage = h.untilStage(id, "a", "running");
    const done = Promise.all([current, stage]);
    const settled = vi.fn();
    void done.then(settled, settled);
    await setImmediate();
    expect(matches.mock.calls).toEqual([[expect.objectContaining({ title: "Work" })]]);
    expect(read).toHaveBeenCalledTimes(2);

    read.mockImplementationOnce(async () => {
      await release.promise;
      return runRead;
    });
    boardSnapshot = { ...boardRead, item: { ...boardRead.item, title: "Renamed" } };
    board.boardChanged.emit();
    await setImmediate();
    expect(read).toHaveBeenCalledTimes(4);
    expect(settled).not.toHaveBeenCalled();

    runSnapshot = { ...runRead, run: { ...runRead.run, stageRuns: [{ ...runRead.run.stageRuns[0], status: "running" }] } };
    board.runs.runChanged.emit(runId);
    release.resolve();
    await setImmediate();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(matches.mock.calls).toEqual([
      [expect.objectContaining({ title: "Work" })],
      [expect.objectContaining({ title: "Renamed" })],
    ]);
    for (const item of await done) {
      expect(item.title).toBe("Renamed");
      expect(h.statusOf(item, "a")).toBe("running");
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
    vi.useRealTimers();
    await h.cleanup();
  }
});

it("discards a matching snapshot read across board and run wakes", async () => {
  const h = await stageRunHarness();
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const runId = "run-1";
    expect(await h.board.beginRun(id, runId, "2026-11-16T00:00:00.000Z", {
      ...h.pinOf(version), source: h.local(version), stageRuns: [{ stageId: "a", attempt: 1, status: "waiting" }],
    })).toMatchObject({ status: "updated" });
    const runs = h.board.runs;
    const getRun = runs.get.bind(runs);
    const read = vi.spyOn(runs, "get").mockImplementationOnce(async key => {
      entered.resolve();
      await release.promise;
      return getRun(key);
    });
    const matches = vi.fn((item: Awaited<ReturnType<typeof h.item>>) => h.statusOf(item, "a") === "running");
    const waiting = h.until(id, matches);
    void waiting.catch(() => {});
    await entered.promise;
    expect(await h.board.update(id, { title: "Renamed" })).toMatchObject({ status: "updated" });
    expect(await runs.update(runId, run => ({ ...run, stageRuns: [{ ...run.stageRuns[0], status: "running" }] })))
      .toMatchObject({ status: "stored" });
    expect(matches).not.toHaveBeenCalled();
    release.resolve();

    await expect(waiting).resolves.toMatchObject({ title: "Renamed" });
    expect(read.mock.calls).toEqual([[runId], [runId]]);
    expect(matches.mock.calls).toEqual([[expect.objectContaining({ title: "Renamed" })]]);
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

it("ignores a late read rejection from a replaced wait source", async () => {
  const h = await stageRunHarness();
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const id = await h.addItem(await h.confirm([autoStageOf("a")]));
    vi.spyOn(h.board, "get").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("retired board read failed");
    });
    const waiting = h.until(id, item => item.title === "Renamed");
    void waiting.catch(() => {});
    await entered.promise;
    h.editRow(id, row => ({ ...row, title: "Renamed" }));
    h.makeEngine();
    release.resolve();

    await expect(waiting).resolves.toMatchObject({ title: "Renamed" });
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

it("checks the replacement while a retired board read is held", async () => {
  const h = await stageRunHarness();
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const id = await h.addItem(await h.confirm([autoStageOf("a")]));
    const snapshot = await h.board.get(id);
    if (snapshot.status !== "found") throw new Error("Missing wait fixture");
    vi.spyOn(h.board, "get").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return snapshot;
    });
    const matches = vi.fn(() => true);
    const waiting = h.until(id, matches);
    void waiting.catch(() => {});
    await entered.promise;

    const replacement = vi.spyOn(WorkBoardStore.prototype, "get").mockResolvedValueOnce({
      ...snapshot, item: { ...snapshot.item, title: "Replacement" },
    });
    try {
      h.makeEngine();
      expect(await Promise.race([waiting, setImmediate("still pending")]))
        .toMatchObject({ title: "Replacement" });
      release.resolve();
      await setImmediate();
      expect(matches.mock.calls).toHaveLength(1);
    } finally {
      replacement.mockRestore();
    }
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

it("checks a shared run file commit made by the retired store after cutover", async () => {
  const h = await stageRunHarness();
  const entered = deferred<void>();
  const release = deferred<void>();
  let writing: Promise<unknown> | undefined;
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const runId = "run-1";
    const oldBoard = h.board;
    expect(await oldBoard.beginRun(id, runId, "2026-11-16T00:00:00.000Z", {
      ...h.pinOf(version), source: h.local(version), stageRuns: [{ stageId: "a", attempt: 1, status: "waiting" }],
    })).toMatchObject({ status: "updated" });
    const row = await oldBoard.get(id);
    const persist = namespace.writeFileAtomicAtPath;
    const write = vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await persist(...args);
    });
    try {
      writing = oldBoard.runs.update(runId, run => ({
        ...run, stageRuns: [{ ...run.stageRuns[0], status: "running" }],
      }));
      await entered.promise;
      const initial = deferred<void>();
      const replacement = deferred<void>();
      const waiting = h.until(id, item => {
        if (h.statusOf(item, "a") === "running") return true;
        (h.board === oldBoard ? initial : replacement).resolve();
        return false;
      });
      void waiting.catch(() => {});
      await initial.promise;
      // Bootstrapping the row-id floor also takes the run file queue held by the write.
      const firstRead = vi.spyOn(WorkBoardStore.prototype, "get").mockResolvedValueOnce(row);
      try {
        h.makeEngine();
        await replacement.promise;
      } finally {
        firstRead.mockRestore();
      }
      const read = vi.spyOn(h.board, "get");

      release.resolve();
      expect(await writing).toMatchObject({ status: "stored" });
      expect(read.mock.calls).toEqual([[id]]);
      await expect(waiting).resolves.toMatchObject({ stageRuns: [{ stageId: "a", status: "running" }] });
    } finally {
      release.resolve();
      await writing;
      write.mockRestore();
    }
  } finally {
    await h.cleanup();
  }
});

async function waitSnapshots(h: Awaited<ReturnType<typeof stageRunHarness>>) {
  const version = await h.confirm([autoStageOf("a")]);
  const id = await h.addItem(version);
  const runId = "run-1";
  expect(await h.board.beginRun(id, runId, "2026-11-16T00:00:00.000Z", {
    ...h.pinOf(version), source: h.local(version), stageRuns: [{ stageId: "a", attempt: 1, status: "waiting" }],
  })).toMatchObject({ status: "updated" });
  const row = await h.board.get(id);
  const run = await h.board.runs.get(runId);
  if (row.status !== "found" || run.status !== "found") throw new Error("Missing wait fixture");
  return { id, runId, row, run };
}

it("makes progress through unrelated wakes and preserves a relevant wake before the row key is known", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId, row, run } = await waitSnapshots(h);
    const { runs } = h.board;
    const readRow = vi.spyOn(h.board, "get").mockImplementation(async () => {
      if (readRow.mock.calls.length <= 100) runs.runChanged.emit("other-before");
      if (readRow.mock.calls.length === 1) runs.runChanged.emit(runId);
      return row;
    });
    const readRun = vi.spyOn(runs, "get").mockImplementation(async () => {
      if (readRun.mock.calls.length <= 100) runs.runChanged.emit("other-after");
      const output = readRun.mock.calls.length === 1 ? "stale" : "fresh";
      return { ...run, run: { ...run.run, stageRuns: [{ ...run.run.stageRuns[0], output }] } };
    });
    const matches = vi.fn(() => true);
    const result = h.until(id, matches);
    void result.catch(() => {});

    expect(await Promise.race([result, setImmediate("still pending")]))
      .toMatchObject({ stageRuns: [{ output: "fresh" }] });
    expect(readRun.mock.calls).toEqual([[runId], [runId]]);
    expect(matches).toHaveBeenCalledTimes(1);
  } finally {
    await h.cleanup();
  }
});

it("yields with a pending wake so continuous invalidations cannot starve the deadline", async () => {
  const h = await stageRunHarness();
  try {
    const { id, runId, row, run } = await waitSnapshots(h);
    const { runs } = h.board;
    vi.spyOn(h.board, "get").mockResolvedValue(row);
    const burstLimit = 100;
    const readRun = vi.spyOn(runs, "get").mockImplementation(async () => {
      runs.runChanged.emit("other-run");
      // The cap lets a monopolized event loop recover and report a failed assertion.
      if (readRun.mock.calls.length >= burstLimit) return new Promise<never>(() => {});
      runs.runChanged.emit(runId);
      return run;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const matches = vi.fn(() => false);
    const result = h.until(id, matches);
    void result.catch(() => {});

    await setImmediate();
    const firstTurn = readRun.mock.calls.length;
    await setImmediate();
    const secondTurn = readRun.mock.calls.length;
    expect(secondTurn).toBeLessThan(burstLimit);
    expect(secondTurn).toBeGreaterThan(firstTurn);
    expect(matches).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    await expect(result).rejects.toThrow(`timed out waiting for item ${id} to satisfy its predicate`);
    await setImmediate();
    expect(readRun).toHaveBeenCalledTimes(secondTurn);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});

async function replaceOnRead(
  h: Awaited<ReturnType<typeof stageRunHarness>>,
  read: MockInstance<WorkBoardStore["get"]>,
  limit: number,
): Promise<number> {
  const { id, row } = await waitSnapshots(h);
  read.mockClear().mockImplementation(async () => {
    const count = read.mock.calls.length;
    if (count < limit) queueMicrotask(() => h.makeEngine());
    return { ...row, item: { ...row.item, runId: undefined, title: `Read ${count}` } };
  });
  return id;
}

it("bounds a burst of replacement reads and resumes from the active source", async () => {
  const h = await stageRunHarness();
  const read = vi.spyOn(WorkBoardStore.prototype, "get");
  try {
    const id = await replaceOnRead(h, read, 12);
    const result = h.until(id, item => item.title === "Read 12");
    void result.catch(() => {});

    await setImmediate();
    expect(read).toHaveBeenCalledTimes(8);
    h.makeEngine();
    const active = h.board;
    expect(read).toHaveBeenCalledTimes(8);

    await expect(result).resolves.toMatchObject({ title: "Read 12" });
    expect(read).toHaveBeenCalledTimes(12);
    expect(read.mock.contexts[8]).toBe(active);
  } finally {
    read.mockRestore();
    await h.cleanup();
  }
});

it("delivers the deadline during continued replacement churn", async () => {
  const h = await stageRunHarness();
  const read = vi.spyOn(WorkBoardStore.prototype, "get");
  try {
    const limit = 100;
    const id = await replaceOnRead(h, read, limit);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = h.until(id, () => false);
    void result.catch(() => {});

    await setImmediate();
    const firstTurn = read.mock.calls.length;
    await setImmediate();
    const secondTurn = read.mock.calls.length;
    expect(secondTurn).toBeLessThan(limit);
    expect(secondTurn).toBeGreaterThan(firstTurn);

    vi.advanceTimersByTime(30_000);
    await expect(result).rejects.toThrow(`timed out waiting for item ${id} to satisfy its predicate`);
    await setImmediate();
    expect(read).toHaveBeenCalledTimes(secondTurn);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    read.mockRestore();
    await h.cleanup();
  }
});

it("checks state already committed before a wait attaches", async () => {
  const h = await stageRunHarness();
  try {
    const id = await h.addItem(await h.confirm([autoStageOf("a")]));
    expect(await h.board.update(id, { title: "Renamed" })).toMatchObject({ status: "updated" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(h.until(id, item => item.title === "Renamed")).resolves.toMatchObject({ title: "Renamed" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});

it("names the item, stage and status when no signal arrives within the bound", async () => {
  const h = await stageRunHarness();
  try {
    const id = await h.addItem(await h.confirm([autoStageOf("a")]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = h.untilStage(id, "a", "passed").catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await Promise.race([result, setImmediate("still pending")])).toBe("still pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.race([result, setImmediate("still pending")]))
      .toBe(`timed out waiting for item ${id} stage a to reach passed`);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});

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

it.each(["before", "after"] as const)("a rerun's stage that fails before registration settles its child waits when the replaced engine links the same attempt %s it", async order => {
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
    if (order === "before") {
      release.resolve();
      await oldLinked.promise;
      rerunRelease.resolve();
      await h.drainRunWork();
    } else {
      rerunRelease.resolve();
      await h.drainRunWork();
      release.resolve();
      await oldLinked.promise;
    }
    const after = h.events.slice(rerun).filter(event => event.stageId === "a" && event.attempt === 1);
    expect(after.map(event => event.phase)).toEqual(order === "before" ? ["executing", "stage_failed"] : ["stage_failed", "executing"]);
    expect(after.find(event => event.phase === "executing")?.runSessionId).toBeDefined();
    const result = await Promise.race([waits, setImmediate("still pending")]);
    expect(result).toEqual(Array.from({ length: 2 }, () => ({
      status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }),
    })));
    // The replaced engine's child does not clear the rerun's failure for a wait created afterwards.
    await expect(Promise.race([h.untilSpawned(3, id), setImmediate("still pending")])).rejects.toThrow(/stage_failed/);
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
          // Stage a fails only once stage b's child is linked, so the order the test reads is fixed.
          if (args[1].id === "a") {
            await linked.promise;
            throw new Error("preparation failed");
          }
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

it("an accepted Stop whose end the run's class holds still settles a child wait created afterwards", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [child] = await h.untilLive(1, id);
    const runId = (await h.item(id)).runId ?? "";
    h.editRow(id, row => ({ ...row, runId: "run-other" }));
    const runsPath = join(dirname(h.boardPath), "workflow-runs.json");
    writeFileSync(runsPath, JSON.stringify({ ...JSON.parse(readFileSync(runsPath, "utf8")), deleteIntents: [{ itemId: id, runId }] }));
    const stopped = h.events.length;
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    child.finish();
    await run;
    await h.drainRunWork();
    expect(h.events.slice(stopped).filter(event => event.itemId === id && (event.phase === "cancelled" || event.phase === "error"))).toEqual([]);
    await expect(Promise.race([h.untilLive(1, id), setImmediate("still pending")])).rejects.toThrow(/run cancelled/);
  } finally {
    for (const child of h.live()) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("an accepted retry puts its item back in flight for aggregate child waits", async () => {
  const relaunching = deferred<void>();
  const relaunch = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[2] === 2) {
            relaunching.resolve();
            await relaunch.promise;
            throw new Error("relaunch preparation failed");
          }
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const other = await h.addItem(version);
    runs.push(h.start(id, h.local(version)));
    (await h.untilLive(1, id))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[0]).toMatchObject({ status: "awaiting_approval" });
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    // The other item stays in flight, parked on its failed stage with no live child.
    runs.push(h.start(other, h.local(version)));
    (await h.untilLive(1, other))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[1]).toMatchObject({ status: "awaiting_approval" });
    const { runId } = await h.item(id);
    const retry = h.engine.retryStage(id, { runId: runId ?? "", stageId: "a" });
    await relaunching.promise;
    expect(await retry).toEqual({ ok: true });
    const wait = Promise.allSettled([h.untilLive(1)]);
    relaunch.resolve();
    await h.drainRunWork();
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }) },
    ]);
  } finally {
    relaunch.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it.each(["accepted", "refused"] as const)("a %s retry sets aside the item's standing failure only while the call runs", async outcome => {
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[2] === 2) throw new Error("relaunch preparation failed");
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    runs.push(h.start(id, h.local(version)));
    (await h.untilLive(1, id))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[0]).toMatchObject({ status: "awaiting_approval" });
    const { runId } = await h.item(id);
    // The first retry's relaunch fails, which leaves a standing failure for the item.
    expect(await h.engine.retryStage(id, { runId: runId ?? "", stageId: "a" })).toEqual({ ok: true });
    await h.drainRunWork();
    await expect(h.untilLive(1, id)).rejects.toThrow(/stage_failed/);
    const retry = h.engine.retryStage(id, { runId: outcome === "accepted" ? runId ?? "" : "run-other", stageId: "a" });
    const wait = Promise.allSettled([h.untilLive(1, id)]);
    if (outcome === "accepted") expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
    expect(await retry).toMatchObject({ ok: outcome === "accepted" });
    if (outcome === "accepted") {
      const settled = await wait;
      const relaunched = h.children.at(-1);
      expect(settled).toEqual([{ status: "fulfilled", value: [relaunched] }]);
      expect(relaunched).toMatchObject({ ended: false, input: { originSessionId: workBoardOriginSessionId(id) } });
      expect(h.children).toHaveLength(2);
      expect(h.workspaceCalls).toContain("prepare:a#3");
    } else {
      expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
        { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }) },
      ]);
      await expect(h.untilLive(1, id)).rejects.toThrow(/stage_failed/);
    }
  } finally {
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("an accepted gate decision puts its item back in flight for aggregate child waits", async () => {
  const relaunching = deferred<void>();
  const relaunch = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[2] === 2) {
            relaunching.resolve();
            await relaunch.promise;
            throw new Error("relaunch preparation failed");
          }
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const other = await h.addItem(version);
    runs.push(h.start(id, h.local(version)));
    (await h.untilLive(1, id))[0].finish();
    await h.untilStage(id, "a", "awaiting_gate");
    await runs[0];
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    // The other item stays in flight, parked on its failed stage with no live child.
    runs.push(h.start(other, h.local(version)));
    (await h.untilLive(1, other))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[1]).toMatchObject({ status: "awaiting_approval" });
    const decision = h.decide(id, "a", "request_changes", "again");
    await relaunching.promise;
    expect(await decision).toMatchObject({ ok: true, status: "changes_requested" });
    const wait = Promise.allSettled([h.untilLive(1)]);
    relaunch.resolve();
    await h.drainRunWork();
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }) },
    ]);
  } finally {
    relaunch.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

/** An item whose first retry's relaunch failed: its failed stage stands and its run is parked. `read`, once armed, holds every run read
 * until its release. */
async function failedRelaunch(hold?: Promise<void>, read?: { armed: boolean; held: () => void; release: Promise<void> }) {
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (store, { workspace }) => ({
      ...(read ? { runs: heldRead(boardRunState(store), read) } : {}),
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[2] === 2) throw new Error("relaunch preparation failed");
          if (args[2] === 3) await hold;
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1, id))[0].finish({ ok: false, summary: "failed", error: "failed" });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const { runId = "" } = await h.item(id);
  expect(await h.engine.retryStage(id, { runId, stageId: "a" })).toEqual({ ok: true });
  await h.drainRunWork();
  await expect(h.untilLive(1, id)).rejects.toThrow(/stage_failed/);
  return { h, version, id, runId };
}

function heldRead(runs: ReturnType<typeof boardRunState>, read: { armed: boolean; held: () => void; release: Promise<void> }) {
  return {
    ...runs,
    get: async (...args: Parameters<typeof runs.get>) => {
      const result = await runs.get(...args);
      if (read.armed) {
        read.held();
        await read.release;
      }
      return result;
    },
  };
}

it("a refused retry that overlaps an accepted one leaves the accepted retry's start standing", async () => {
  const release = deferred<void>();
  const { h, id, runId } = await failedRelaunch(release.promise);
  try {
    const refused = h.engine.retryStage(id, { runId: "run-other", stageId: "a" });
    const retried = h.engine.retryStage(id, { runId, stageId: "a" });
    expect(await refused).toMatchObject({ ok: false });
    expect(await retried).toEqual({ ok: true });
    const wait = Promise.allSettled([h.untilLive(1, id)]);
    expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
    release.resolve();
    expect(await wait).toEqual([{ status: "fulfilled", value: [expect.objectContaining({ ended: false })] }]);
  } finally {
    release.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a second start of a parked item settles a child wait created while it ran with the item's standing failure", async () => {
  const { h, version, id } = await failedRelaunch();
  try {
    const again = h.start(id, h.local(version));
    const wait = Promise.allSettled([h.untilLive(1, id)]);
    expect(await again).toMatchObject({ status: "already_running" });
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }) },
    ]);
  } finally {
    for (const child of h.live()) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("refused retries of a failed item leave an aggregate wait on another item's children pending", async () => {
  const { h, version, id } = await failedRelaunch();
  const runs: Promise<unknown>[] = [];
  try {
    const other = await h.addItem(version);
    runs.push(h.start(other, h.local(version)));
    await h.untilLive(1, other);
    const wait = Promise.allSettled([h.untilLive(2)]);
    const refusals = await Promise.all([1, 2].map(() => h.engine.retryStage(id, { runId: "run-other", stageId: "a" })));
    expect(refusals).toEqual([expect.objectContaining({ ok: false }), expect.objectContaining({ ok: false })]);
    expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
  } finally {
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it.each(["links", "fails to start"] as const)("a child the replaced engine %s does not settle the current engine's child waits", async outcome => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const spawning = deferred<void>();
  let engines = 0;
  const h = await stageRunHarness({
    script: () => {
      spawning.resolve();
      if (outcome === "fails to start") throw new Error("child script failed");
      return undefined;
    },
    wiring: (_store, { workspace }) => {
      const engine = engines++;
      return {
        workspace: {
          ...workspace,
          prepare: async (...args) => {
            if (engine === 0) {
              preparing.resolve();
              await release.promise;
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
    runs.push(h.start(id, h.local(version)).catch(() => undefined));
    await preparing.promise;
    h.makeEngine();
    const waits = Promise.allSettled([h.untilSpawned(1), h.untilLive(1)]);
    release.resolve();
    await spawning.promise;
    expect(h.children).toHaveLength(1);
    expect(await Promise.race([waits, setImmediate("still pending")])).toBe("still pending");
  } finally {
    release.resolve();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.cleanup();
  }
});

it("an accepted continue puts its item back in flight for aggregate child waits", async () => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (args[1].id === "d") {
            preparing.resolve();
            await release.promise;
            throw new Error("continued stage preparation failed");
          }
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b"), stageOf("c"), stageOf("d")]);
    const single = await h.confirm([stageOf("x")]);
    const id = await h.addItem(version);
    const other = await h.addItem(single);
    runs.push(h.start(id, h.local(version)));
    await h.untilLive(3, id);
    await h.until(id, item => item.stageRuns.filter(stage => stage.childSessionId !== undefined).length === 3);
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    // The other item stays in flight, parked on its failed stage with no live child.
    runs.push(h.start(other, h.local(single)));
    (await h.untilLive(1, other))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[1]).toMatchObject({ status: "awaiting_approval" });
    const { runId = "" } = await h.item(id);
    expect(await h.engine.continueRun(id, { runId })).toEqual({ ok: true });
    await preparing.promise;
    // A spawn count: the replaced engine's live children would put the item in a live count's scope by themselves.
    const wait = Promise.allSettled([h.untilSpawned(h.children.length + 1)]);
    release.resolve();
    await h.drainRunWork();
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }) },
    ]);
  } finally {
    release.resolve();
    await h.drainRunWork();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("an accepted decision that ends the run before it returns leaves the item out of flight", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    runs.push(h.start(id, h.local(version)));
    (await h.untilLive(1, id))[0].finish();
    await h.untilStage(id, "a", "awaiting_gate");
    await runs[0];
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    expect(await h.decide(id, "a", "reject")).toMatchObject({ ok: true, status: "rejected" });
    const ends = ["done", "denied", "cancelled", "error"];
    expect(h.events).toContainEqual(expect.objectContaining({ itemId: id, phase: expect.toSatisfy((phase: string) => ends.includes(phase)) }));
    await expect(h.untilLive(1, id)).rejects.toThrow(/Child wait ended/);
    // Nothing is in flight, so an aggregate wait has no failure to take.
    const wait = Promise.allSettled([h.untilLive(1)]);
    expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
  } finally {
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("an aggregate wait created while a refused retry runs takes the failure that stands again after the refusal", async () => {
  const held = deferred<void>();
  const release = deferred<void>();
  const read = { armed: false, held: () => held.resolve(), release: release.promise };
  const { h, id, runId } = await failedRelaunch(undefined, read);
  try {
    await expect(h.untilLive(1)).rejects.toThrow(/stage_failed/);
    read.armed = true;
    // A stage the run does not have passes the run read, so the refusal comes after it.
    const refused = h.engine.retryStage(id, { runId, stageId: "missing" });
    const wait = Promise.allSettled([h.untilLive(1)]);
    await held.promise;
    expect(await Promise.race([wait, refused, setImmediate("still pending")])).toBe("still pending");
    release.resolve();
    expect(await refused).toMatchObject({ ok: false });
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/stage_failed/) }) },
    ]);
  } finally {
    release.resolve();
    for (const child of h.live()) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
});

it("a child wait that never settles times out and names the items in flight", async () => {
  const h = await stageRunHarness();
  let running: Promise<unknown> | undefined;
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    running = h.start(id, h.local(version));
    await h.untilLive(1, id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wait = Promise.allSettled([h.untilLive(2), h.untilLive(2, id)]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await Promise.race([wait, setImmediate("still pending")])).toBe("still pending");
    await vi.advanceTimersByTimeAsync(1);
    const timedOut = { status: "rejected", reason: expect.objectContaining({ message: `timed out waiting for children; in flight: ${workBoardOriginSessionId(id)}` }) };
    expect(await wait).toEqual([timedOut, timedOut]);
  } finally {
    vi.useRealTimers();
    for (const child of h.live()) child.finish();
    await running;
    await h.cleanup();
  }
});

it("a progress wait whose signal never comes stays pending past 2 s and at 30 s fails naming what it waited for", async () => {
  const h = await stageRunHarness();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ended = h.settleEvent().then(() => "resolved", (error: unknown) => String(error));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await Promise.race([ended, setImmediate("still pending")]), "after 2,001 ms").toBe("still pending");
    await vi.advanceTimersByTimeAsync(29_999 - 2_001);
    expect(await Promise.race([ended, setImmediate("still pending")]), "after 29,999 ms").toBe("still pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await ended).toBe("Error: progress signal never arrived for a run's end (cancelled, done, denied or error)");
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});

it("cleanup ends every pending wait at once and leaves no listener or timer behind", async () => {
  const h = await stageRunHarness();
  let cleaned: Promise<void> | undefined;
  try {
    const id = await h.addItem(await h.confirm([stageOf("a")]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = (wait: Promise<unknown>) => wait.then(() => "resolved", (error: unknown) => String(error));
    const never = () => expect("waiting").toBe("passed");
    const waits = Promise.all([outcome(h.settleEvent()), outcome(h.untilLive(1)), outcome(h.until(id, () => false, "a predicate that never holds")),
      outcome(h.untilRunFile(never, "the stage to pass")), outcome(h.untilObserved(never)), outcome(h.untilWorkspaceCalls(never))]);
    expect(h.pendingWaits()).toBe(6);
    expect(vi.getTimerCount()).toBe(6);
    cleaned = h.cleanup();
    expect(h.pendingWaits()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Past every bound before the directory removal can schedule anything: no wait fails late.
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
    // An assertion wait names what it waited for, says cleanup ended it, and keeps the assertion's last failure.
    const unmet = (what: string) => `Error: the harness was cleaned up while waiting for ${what}; last failure: expected 'waiting' to be 'passed' // Object.is equality`;
    expect(await waits).toEqual(["Error: Progress wait ended: harness cleaned up", "Error: Child wait ended: harness cleaned up",
      "Error: Wait for a predicate that never holds ended: harness cleaned up", unmet("the stage to pass"),
      unmet("a run-file commit or progress event that passes the assertion"), unmet("a workspace call or sweep that passes the assertion")]);
    expect(await outcome(h.untilRunFile(never, "a late wait"))).toBe("Error: the harness was cleaned up before waiting for a late wait");
    expect(await outcome(h.settleEvent())).toBe("Error: Progress wait ended: harness cleaned up");
  } finally {
    vi.useRealTimers();
    await (cleaned ?? h.cleanup());
  }
});

it("an accepted join decision puts its item back in flight for aggregate child waits", async () => {
  let merges = 0;
  const h = await stageRunHarness({
    observeRunWork: true,
    integrate: () => {
      merges += 1;
      return merges === 1 ? { ok: false, conflict: { conflictHash: "c".repeat(64), reason: "merge-conflict", files: [] } } : { ok: true };
    },
  });
  const runs: Promise<unknown>[] = [];
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const single = await h.confirm([stageOf("x")]);
    const id = await h.addItem(version);
    const other = await h.addItem(single);
    runs.push(h.start(id, h.local(version)));
    (await h.untilLive(1, id))[0].finish();
    const parked = await h.until(id, item => item.stageJoins.some(join => join.status === "conflict"));
    await runs[0];
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    // The other item stays in flight, parked on its failed stage with no live child.
    runs.push(h.start(other, h.local(single)));
    (await h.untilLive(1, other))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[1]).toMatchObject({ status: "awaiting_approval" });
    const wait = Promise.allSettled([h.untilLive(1)]);
    const [join] = parked.stageJoins;
    expect(await h.engine.decideStageJoin(id, {
      runId: parked.runId ?? "", joinId: join.joinId, conflictHash: join.conflict?.conflictHash ?? "", decision: "retry_merge",
    })).toEqual({ ok: true });
    await h.drainRunWork();
    expect(await Promise.race([wait, setImmediate("still pending")])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/done/) }) },
    ]);
  } finally {
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});

it.each(["accepted", "refused"] as const)("a late %s call that closes after its engine was replaced leaves the new engine's waits and flights alone", async outcome => {
  const held = deferred<void>();
  const release = deferred<void>();
  const spawning = deferred<void>();
  let armed = false;
  let holding = false;
  let engines = 0;
  const h = await stageRunHarness({
    script: () => {
      if (armed) spawning.resolve();
      return undefined;
    },
    wiring: store => {
      const engine = engines++;
      const runs = boardRunState(store);
      return {
        runs: {
          ...runs,
          get: async (...args: Parameters<typeof runs.get>) => {
            const result = await runs.get(...args);
            if (engine === 0 && holding) {
              holding = false;
              held.resolve();
              await release.promise;
            }
            return result;
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
    (await h.untilLive(1, id))[0].finish({ ok: false, summary: "failed", error: "failed" });
    expect(await runs[0]).toMatchObject({ status: "awaiting_approval" });
    const { runId = "" } = await h.item(id);
    armed = true;
    holding = true;
    const late = h.engine.retryStage(id, { runId: outcome === "accepted" ? runId : "run-other", stageId: "a" });
    await held.promise;
    h.makeEngine();
    // The first child was spawned before the replacement and counts; a child the replaced engine spawns later does not.
    const waits = Promise.allSettled([h.untilLive(1, id), h.untilSpawned(2)]);
    release.resolve();
    expect(await late).toMatchObject({ ok: outcome === "accepted" });
    if (outcome === "accepted") await spawning.promise;
    expect(h.children).toHaveLength(outcome === "accepted" ? 2 : 1);
    expect(await Promise.race([waits, setImmediate("still pending")])).toBe("still pending");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timed = Promise.allSettled([h.untilSpawned(2)]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await timed).toEqual([{ status: "rejected", reason: expect.objectContaining({ message: "timed out waiting for children; in flight: none" }) }]);
  } finally {
    vi.useRealTimers();
    release.resolve();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.cleanup();
  }
});

it("untilRunFile reruns its assertion on each run-file commit, a retired store's too, and not on a board write", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const runId = "run-1";
    expect(await h.board.beginRun(id, runId, "2026-11-16T00:00:00.000Z", {
      ...h.pinOf(version), source: h.local(version), stageRuns: [{ stageId: "a", attempt: 1, status: "waiting" }],
    })).toMatchObject({ status: "updated" });
    const retired = h.board;
    h.makeEngine();
    const assertion = vi.fn(async () => expect((await h.runOf(runId, retired))?.stageRuns[0]?.status).toBe("running"));
    const waiting = h.untilRunFile(assertion);
    await setImmediate();
    expect(assertion).toHaveBeenCalledTimes(1);
    expect(await h.board.update(id, { title: "Renamed" })).toMatchObject({ status: "updated" });
    await setImmediate();
    expect(assertion).toHaveBeenCalledTimes(1);
    expect(await retired.runs.update(runId, run => ({ ...run, stageRuns: [{ ...run.stageRuns[0], status: "running" }] })))
      .toMatchObject({ status: "stored" });
    await waiting;
    expect(assertion).toHaveBeenCalledTimes(2);
  } finally {
    await h.cleanup();
  }
});

it("untilObserved reruns its assertion on progress events and passes once the run's end event is out", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    const ended = h.untilObserved(() => expect(h.events.some(event => event.itemId === id && event.phase === "done")).toBe(true));
    child.finish();
    await ended;
    expect(await run).toMatchObject({ status: "completed" });
  } finally {
    await h.cleanup();
  }
});

it("untilWorkspaceCalls wakes on the calls of a replaced workspace part as on the harness's own", async () => {
  const sealed: string[] = [];
  const release = deferred<void>();
  // The seal holds the run, so no later workspace call of the harness's own can wake the wait.
  const h = await stageRunHarness({ workspace: { seal: async (_run, stageId) => { sealed.push(stageId); await release.promise; return { ok: true }; } } });
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    const seen = h.untilWorkspaceCalls(() => expect(sealed).toEqual(["a"]));
    child.finish();
    await seen;
    release.resolve();
    expect(await run).toMatchObject({ status: "completed" });
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

/** A join whose integration never returns holds the run's observed work; `armDrain` hands over the drain bound's expiry once armed. */
async function heldJoinHarness() {
  const integrating = deferred<void>();
  const h = await stageRunHarness({ observeRunWork: true, integrate: () => { integrating.resolve(); return new Promise(() => undefined); } });
  const armed = deferred<(reason?: string) => void>();
  const armDrain = (expire: (reason?: string) => void) => { armed.resolve(expire); return () => undefined; };
  const holdJoin = async () => {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    (await h.untilLive(1, id))[0].finish();
    await integrating.promise;
  };
  /** Waits for the drain to arm its bound, shows the drain is held, then expires the bound. */
  const expireHeldDrain = async () => {
    const expire = await armed.promise;
    const drained = vi.fn();
    void h.drainAllRunWork().then(drained);
    await setImmediate();
    expect(drained).not.toHaveBeenCalled();
    expire();
  };
  return { h, armDrain, holdJoin, expireHeldDrain };
}
const failureOf = (work: Promise<unknown>) => work.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));

it("runThenEnd rethrows the body's own failure when run work is still held, not the drain's", async () => {
  const { h, armDrain, holdJoin, expireHeldDrain } = await heldJoinHarness();
  const ended = failureOf(h.runThenEnd(async () => {
    await holdJoin();
    throw new Error("the body's own failure");
  }, { bound: armDrain }));
  await expireHeldDrain();
  expect(await ended).toBe("the body's own failure");
  expect(h.pendingWaits()).toBe(0);
});

it("runThenEnd fails naming the drain once held run work outlasts its bound after a passing body, and still cleans up", async () => {
  const { h, armDrain, holdJoin, expireHeldDrain } = await heldJoinHarness();
  const ended = failureOf(h.runThenEnd(holdJoin, { bound: armDrain }));
  await expireHeldDrain();
  expect(await ended).toBe("timed out waiting for the run work to drain");
  expect(await failureOf(h.untilRunFile(() => undefined, "a wait after cleanup"))).toBe("the harness was cleaned up before waiting for a wait after cleanup");
});
