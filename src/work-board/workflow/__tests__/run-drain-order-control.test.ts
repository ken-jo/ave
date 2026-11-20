import { expect, it, vi } from "vitest";
import { boardRunState } from "../run-state.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import { autoStageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;

async function permittedRead(h: Harness): Promise<void> {
  const listed = await h.board.list();
  if (listed.status === "ok") {
    await h.engine.projectTemplateRuns(listed.items);
  }
  await h.engine.adoptParkedTemplateRuns();
}

it("concurrent readers preserve held arrival order and finish after evaluation resumes", async () => {
  let refusing = false;
  let releaseEvaluation: () => void = () => undefined;
  const evaluation = new Promise<void>(resolve => {
    releaseEvaluation = resolve;
  });
  const order: string[] = [];
  const conditions = createPassConditionRegistry();
  conditions.register("stage_ok", {
    evaluate: async facts => {
      order.push(facts.stage.id);
      if (facts.stage.id === "a") await evaluation;
      return { passed: true, evidence: "checked", judgedBy: "host" };
    },
  });

  const h = await stageRunHarness({
    workflow: { passConditions: conditions },
    wiring: store => {
      const records = boardRunState(store);
      return {
        runs: {
          ...records,
          update: async (...args) =>
            refusing
              ? { ok: false, reason: "row-lost" }
              : records.update(...args),
        },
      };
    },
  });

  try {
    const version = await h.confirm([autoStageOf("a"), autoStageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version)).catch(() => undefined);
    const children = await h.untilLive(2);
    const linked = await h.until(
      id,
      item => item.stageRuns.every(stage => stage.childSessionId !== undefined),
    );
    const runId = linked.runId;
    if (!runId) throw new Error("run identity was not stored");

    const childFor = (stageId: string) =>
      children.find(
        child =>
          child.sessionId ===
          linked.stageRuns.find(stage => stage.stageId === stageId)
            ?.childSessionId,
      );
    const a = childFor("a");
    const b = childFor("b");
    if (!a || !b) throw new Error("stage children were not linked");

    refusing = true;
    a.finish();
    await vi.waitFor(async () => {
      expect(await h.board.runs.heldEvents({ itemId: id, runId }))
        .toMatchObject([{ stage: "a", attempt: 1, kind: "stage_ended" }]);
    });
    b.finish();
    await vi.waitFor(async () => {
      expect(await h.board.runs.heldEvents({ itemId: id, runId }))
        .toMatchObject([
          { stage: "a", attempt: 1, kind: "stage_ended" },
          { stage: "b", attempt: 1, kind: "stage_ended" },
        ]);
    });

    refusing = false;
    await permittedRead(h);
    await vi.waitFor(() => expect(order).toEqual(["a"]));
    await Promise.all(
      Array.from({ length: 8 }, () => permittedRead(h)),
    );
    expect(order).toEqual(["a"]);

    releaseEvaluation();
    await h.until(id, item => item.runStatus === "completed");
    await permittedRead(h);

    expect(order).toEqual(["a", "b"]);
    expect(await h.board.runs.heldEvents({ itemId: id, runId })).toEqual([]);
    expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(1);
    expect(h.workspaceCalls.filter(call => call === "seal:b")).toHaveLength(1);
    expect(
      h.workspaceCalls.filter(call => call.startsWith("integrate:")),
    ).toHaveLength(1);
  } finally {
    refusing = false;
    releaseEvaluation();
    vi.restoreAllMocks();
    await h.cleanup();
  }
});
