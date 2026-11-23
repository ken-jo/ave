import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { boardRunState } from "../run-state.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["event", "restart", "missing notification"] as const)("observes join replay with %s", async recovery => {
  const replayWriting = deferred<void>();
  const releaseReplay = deferred<void>();
  const notification = deferred<void>();
  const sealStarted = deferred<void>();
  const releaseSeal = deferred<{ ok: true }>();
  let refusing = false;
  let armed = false;
  let notified = false;
  let abandoned = false;
  let sealed = false;
  let seals = 0;
  let integrations = 0;
  const conditions = createPassConditionRegistry();
  const evaluate = conditions.evaluate;
  vi.spyOn(conditions, "evaluate").mockImplementation(async (...args) => {
    const verdict = await evaluate(...args); refusing = true; return verdict;
  });
  const warnings = vi.spyOn(console, "warn");
  const h = await stageRunHarness({
    observeRunWork: true,
    workflow: { passConditions: conditions, itemChanged: () => {
      if (!armed) return;
      armed = false;
      if (recovery === "missing notification") return;
      notified = true;
      notification.resolve();
      throw new Error("notification delivery failed");
    } },
    workspace: {
      seal: async () => {
        if (recovery === "restart" && !abandoned) {
          sealStarted.resolve();
          return releaseSeal.promise;
        }
        if (!sealed) { sealed = true; seals += 1; }
        return { ok: true };
      },
      integrate: async () => { integrations += 1; return { ok: true }; },
    },
    wiring: store => {
      const records = boardRunState(store);
      return { runs: { ...records, update: async (...args) => {
        if (refusing) return { ok: false, reason: "row-lost" };
        if (armed) {
          replayWriting.resolve();
          await releaseReplay.promise;
        }
        return records.update(...args);
      } } };
    },
  });
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).childSessionId).toBe(child.sessionId);
    const runId = (await h.item(id)).runId ?? "";
    child.finish();
    await h.drainRunWork();
    expect(await h.board.runs.heldEvents({ itemId: id, runId })).toMatchObject([{ kind: "gate_evaluated" }]);
    armed = true; refusing = false;
    await h.engine.adoptParkedTemplateRuns();
    const drain = h.drainRunWork();
    const observed = Promise.race([notification.promise, drain]).then(() => expect(notified, "join replay ended without notification").toBe(true));
    const observation = observed.then(() => "notified", (error: Error) => error.message);
    const first = await Promise.race([replayWriting.promise.then(() => "writer"), drain.then(() => "drain")]);
    expect(first).toBe("writer");
    expect(notified).toBe(false);
    releaseReplay.resolve();
    if (recovery === "missing notification") {
      const failure = await Promise.race([observation, drain.then(() => setImmediate("notification check stayed pending"))]);
      expect(failure).toContain("join replay ended without notification");
      return;
    }
    await observed;
    if (recovery === "restart") {
      expect(await Promise.race([sealStarted.promise.then(() => "sealing"), drain.then(() => "drained")])).toBe("sealing");
      expect((await h.runOf(runId))?.stageJoins?.[0]?.status).toBe("integrating");
      abandoned = true;
      h.makeEngine();
    } else await drain;
    await h.engine.adoptParkedTemplateRuns();
    await h.drainRunWork();
    expect(integrations).toBe(1);
    expect(await h.settleEvent()).toMatchObject({ phase: "done", itemId: id });
    await h.engine.adoptParkedTemplateRuns();
    expect(seals).toBe(1);
    expect(integrations).toBe(1);
    expect((await h.runOf(runId))?.stageJoins?.[0]).toMatchObject({ status: "integrated" });
    expect(warnings.mock.calls.some(call => call.some(arg => String(arg).includes("notification delivery failed")))).toBe(true);
  } finally {
    refusing = false; armed = false;
    if (!abandoned) releaseSeal.resolve({ ok: true });
    abandoned = true;
    releaseReplay.resolve();
    for (const child of h.live()) child.finish();
    await h.drainRunWork();
    vi.restoreAllMocks();
    await h.cleanup();
  }
});

it("resuming a parked join does not spawn the next step at boot", async () => {
  const firstIntegration = deferred<void>();
  const integrate = vi.fn(async () => ({ ok: true } as const)).mockImplementationOnce(() => {
    firstIntegration.resolve();
    return new Promise(() => undefined);
  });
  const h = await stageRunHarness({ observeRunWork: true, integrate });
  try {
    const version = await h.confirm([autoStageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    await firstIntegration.promise;
    expect((await h.item(id)).stageJoins[0]?.status).toBe("integrating");
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    await h.until(id, item => item.stageJoins[0]?.status === "integrated");
    await h.drainRunWork();
    expect((await h.stageRun(id, "b")).status).toBe("waiting");
    expect(h.children).toHaveLength(1);
  } finally { await h.cleanup(); }
});
