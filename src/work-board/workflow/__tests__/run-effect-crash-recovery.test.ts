import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { boardRunState } from "../run-state.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import { autoStageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("a new engine consumes a durably applied gate once when the old write never returns", async () => {
  let abandoned = false;
  let crashReached = false;
  const crashed = deferred<void>();
  let gateWrites = 0;
  const conditions = createPassConditionRegistry();
  const evaluate = vi.spyOn(conditions, "evaluate");
  const h = await stageRunHarness({
    workflow: { passConditions: conditions },
    wiring: store => {
      const records = boardRunState(store);
      return { runs: { ...records, update: async (itemId, runId, mutate, removedAs) => {
        let applied = false;
        const stored = await records.update(itemId, runId, current => {
          const next = mutate(current);
          const run = next && "run" in next ? next.run : next;
          applied = run?.stageRuns.some(stage => stage.gate?.type === "auto"
            && current.stageRuns.find(prior => prior.stageId === stage.stageId)?.gate?.type !== "auto") ?? false;
          return next;
        }, removedAs);
        if (stored.ok && applied) {
          gateWrites += 1;
          if (!abandoned) {
            crashReached = true;
            crashed.resolve();
            // The real file write landed. Never return to the engine: no receipt, notification or cleanup can run.
            return new Promise<never>(() => undefined);
          }
        }
        return stored;
      } } };
    },
  });
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    await crashed.promise;
    expect(crashReached).toBe(true);
    const disk = JSON.parse(readFileSync(join(h.dir, "workflow-runs.json"), "utf8"));
    const before = disk.runs[0];
    expect(before.stageRuns[0]).toMatchObject({ status: "passed", gate: { type: "auto", passed: true } });
    expect(before.stageJoins[0].status).toBe("integrating");
    expect(h.events.some(event => event.phase === "stage_passed")).toBe(false);
    expect(h.workspaceCalls.some(call => call.startsWith("seal:") || call.startsWith("integrate:"))).toBe(false);
    // Abandon the original engine, its pending write and its memory without cleanup; construct a new store and engine on the same paths.
    abandoned = true;
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    const after = await h.until(id, item => item.runStatus === "completed");
    expect(after.stageRuns[0].gate).toEqual(before.stageRuns[0].gate);
    expect(after.stageJoins[0]).toMatchObject({ status: "integrated" });
    expect(gateWrites).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(1);
    expect(h.workspaceCalls.filter(call => call.startsWith("integrate:"))).toHaveLength(1);
    await h.engine.adoptParkedTemplateRuns();
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    expect(gateWrites).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(1);
    expect(h.workspaceCalls.filter(call => call.startsWith("integrate:"))).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await h.cleanup(); }
});
