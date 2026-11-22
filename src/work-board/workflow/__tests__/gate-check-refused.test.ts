/** A gate that would check a command's exit status is refused when the template is written: the host runs no command and a child's
 * recorded steps carry no exit status, so such a gate could never pass. */
import { expect, it } from "vitest";
import { en } from "../../../i18n/messages/en.js";
import { ko } from "../../../i18n/messages/ko.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("a draft with a check_exit_zero gate is refused gate-check-unsupported and nothing is stored", async () => {
  const h = await stageRunHarness();
  try {
    const gated = stageOf("a", { toolScope: "all", gate: { type: "auto", pass: { kind: "check_exit_zero", command: "echo ok" } } });
    await expect(h.confirm([gated])).rejects.toMatchObject({ code: "gate-check-unsupported" });
    expect(await h.templates.list()).toEqual([]);
    for (const catalog of [en, ko]) expect(Reflect.get(catalog, "reasonCodes.gate-check-unsupported")).toEqual(expect.stringMatching(/\S/));
  } finally {
    await h.cleanup();
  }
});

it("no evaluator claims the kind: a gate that reached the scheduler anyway fails", async () => {
  const verdict = await createPassConditionRegistry().evaluate({ kind: "check_exit_zero", command: "echo ok" }, { result: { ok: true } as never, stage: stageOf("a") });
  expect(verdict).toMatchObject({ passed: false, judgedBy: "host" });
});
