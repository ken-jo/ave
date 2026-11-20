import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { boardRunState } from "../run-state.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["event", "restart"] as const)("a notification failure resumes sealing and integration on the next %s", async recovery => {
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
    workflow: { passConditions: conditions, itemChanged: () => {
      if (!armed) return;
      armed = false; notified = true;
      throw new Error("notification delivery failed");
    } },
    workspace: {
      seal: async () => {
        if (recovery === "restart" && !abandoned) return new Promise(() => undefined);
        if (!sealed) { sealed = true; seals += 1; }
        return { ok: true };
      },
      integrate: async () => { integrations += 1; return { ok: true }; },
    },
    wiring: store => {
      const records = boardRunState(store);
      return { runs: { ...records, update: (...args) => refusing ? Promise.resolve({ ok: false, reason: "row-lost" }) : records.update(...args) } };
    },
  });
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    await h.until(id, item => item.stageRuns[0]?.childSessionId === child.sessionId);
    const runId = (await h.item(id)).runId ?? "";
    child.finish();
    await vi.waitFor(async () => expect(await h.board.runs.heldEvents({ itemId: id, runId })).toMatchObject([{ kind: "gate_evaluated" }]));
    armed = true; refusing = false;
    await h.engine.adoptParkedTemplateRuns();
    await vi.waitFor(() => expect(notified).toBe(true));
    if (recovery === "restart") {
      expect((await h.runOf(runId))?.stageJoins?.[0]?.status).toBe("integrating");
      abandoned = true;
      h.makeEngine();
    }
    await h.engine.adoptParkedTemplateRuns();
    await vi.waitFor(() => expect(integrations).toBe(1));
    expect(await h.settleEvent()).toMatchObject({ phase: "done", itemId: id });
    await h.engine.adoptParkedTemplateRuns();
    expect(seals).toBe(1);
    expect(integrations).toBe(1);
    expect((await h.runOf(runId))?.stageJoins?.[0]).toMatchObject({ status: "integrated" });
    expect(warnings.mock.calls.some(call => call.some(arg => String(arg).includes("notification delivery failed")))).toBe(true);
  } finally {
    refusing = false; armed = false;
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
