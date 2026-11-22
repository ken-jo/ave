import { expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { deferred } from "../../../__tests__/support/deferred.js";
import { autoStageOf } from "./stage-fixtures.js";
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

it.each(["cancelled", "ended"] as const)("an aggregate child wait settles when an earlier item it counts is %s", async outcome => {
  const release = deferred<void>();
  let prepares = 0;
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({
      workspace: {
        ...workspace,
        prepare: async (...args) => {
          prepares += 1;
          if (prepares > 1) await release.promise;
          return workspace.prepare(...args);
        },
      },
    }),
  });
  const runs: Promise<unknown>[] = [];
  const version = await h.confirm([autoStageOf("a")]);
  const earlier = await h.addItem(version);
  const later = await h.addItem(version);
  try {
    runs.push(h.start(earlier, h.local(version)));
    const [child] = await h.untilLive(1);
    runs.push(h.start(later, h.local(version)));
    const waits = Promise.allSettled([h.waitForLive(2), h.untilLive(2)]);
    if (outcome === "cancelled") expect(h.engine.cancelRun(earlier)).toEqual({ ok: true });
    else child.finish();
    await runs[0];
    const result = await Promise.race([waits, setImmediate("still pending")]);
    const reason = { cancelled: /cancelled/, ended: /done/ }[outcome];
    expect(result).toEqual(Array.from({ length: 2 }, () => ({
      status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(reason) }),
    })));
  } finally {
    h.engine.cancelRun(later);
    release.resolve();
    for (const child of h.live()) child.finish();
    await Promise.allSettled(runs);
    await h.drainRunWork();
    await h.cleanup();
  }
});
