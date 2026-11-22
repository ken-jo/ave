import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { autoStageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

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
