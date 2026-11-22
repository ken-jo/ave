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

it("waits for child registration while stage preparation is held", async () => {
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
    running = h.start(id, h.local(version));
    await Promise.race([preparing.promise, running]);
    expect(h.children).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waits = [h.waitForLive(1), h.untilLive(1), h.untilSpawned(1)];
    const settled = vi.fn();
    for (const wait of waits) void wait.then(settled, settled);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).not.toHaveBeenCalled();

    vi.useRealTimers();
    release.resolve();
    const [[child], live, spawned] = await Promise.all(waits);
    expect(live).toEqual([child]);
    expect(spawned).toEqual([child]);
    expect(h.events).toContainEqual(expect.objectContaining({ phase: "executing", runSessionId: child.sessionId }));
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
