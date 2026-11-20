import type { SubAgentSpawnResult } from "../../../engine/subagent-runner.js";
import { expect, it, vi } from "vitest";
import { createPassConditionRegistry } from "../stage-gates.js";
import { autoStageOf } from "./stage-fixtures.js";

it("a gate effect checks its receipt and does not apply a consumed attempt", async () => {
  const registry = createPassConditionRegistry();
  const effect = vi.fn(() => ({ passed: true, evidence: "applied", judgedBy: "host" as const }));
  registry.register("stage_ok", { evaluate: effect });
  let consumed = false;
  const claimEffect = vi.fn(() => {
    if (consumed) return false;
    consumed = true;
    return true;
  });
  const facts = { result: { ok: true } as SubAgentSpawnResult, stage: autoStageOf("a"), effectConsumed: () => consumed, claimEffect };
  expect(await registry.evaluate({ kind: "stage_ok" }, facts)).toMatchObject({ passed: true });
  expect(await registry.evaluate({ kind: "stage_ok" }, facts)).toMatchObject({ passed: false });
  expect(claimEffect).toHaveBeenCalledTimes(1);
  expect(effect).toHaveBeenCalledTimes(1);
});

it.each([false, true])("a registered evaluator preserves consumption only after its boundary (%s)", async after => {
  const registry = createPassConditionRegistry();
  let consumed = false;
  let calls = 0;
  let effects = 0;
  registry.register("stage_ok", { evaluate: facts => {
    calls += 1;
    if (after || calls > 1) {
      if (facts.claimEffect?.() !== false) effects += 1;
    }
    if (calls === 1) throw new Error("registered evaluation failed");
    return { passed: true, evidence: "applied", judgedBy: "host" };
  } });
  const facts = {
    result: { ok: true } as SubAgentSpawnResult, stage: autoStageOf("a"),
    effectConsumed: () => consumed,
    claimEffect: () => { if (consumed) return false; consumed = true; return true; },
  };
  await expect(registry.evaluate({ kind: "stage_ok" }, facts)).rejects.toThrow("registered evaluation failed");
  expect(consumed).toBe(after);
  expect(await registry.evaluate({ kind: "stage_ok" }, facts)).toMatchObject({ passed: !after });
  expect(calls).toBe(after ? 1 : 2);
  expect(effects).toBe(1);
});
