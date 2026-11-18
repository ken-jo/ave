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
  const facts = { result: { ok: true } as SubAgentSpawnResult, stage: autoStageOf("a"), claimEffect };
  expect(await registry.evaluate({ kind: "stage_ok" }, facts)).toMatchObject({ passed: true });
  expect(await registry.evaluate({ kind: "stage_ok" }, facts)).toMatchObject({ passed: false });
  expect(claimEffect).toHaveBeenCalledTimes(2);
  expect(effect).toHaveBeenCalledTimes(1);
});
