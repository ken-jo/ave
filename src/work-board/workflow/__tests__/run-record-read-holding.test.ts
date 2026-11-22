import { expect, it, vi } from "vitest";
import { boardRunState } from "../run-state.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("a failed scheduler read retains link and completion identities for the original attempt", async () => {
  let unreadable = false;
  const h = await stageRunHarness({
    script: () => { unreadable = true; return undefined; },
    wiring: store => {
      const records = boardRunState(store);
      return { runs: { ...records, get: async (...args) => {
        if (unreadable) throw new Error("run record read failed");
        return records.get(...args);
      } } };
    },
  });
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const running = h.start(id, h.local(version));
    void running.catch(() => undefined);
    const [child] = await h.untilLive(1);
    const runId = (await h.item(id)).runId ?? "";
    const identity = { itemId: id, runId, stage: "a", attempt: 1 };
    const linked = { ...identity, kind: "stage_linked" };
    const ended = { ...identity, kind: "stage_ended" };
    await vi.waitFor(async () => expect(await h.board.runs.heldEvents(identity)).toEqual([linked]));
    child.finish();
    await vi.waitFor(async () => expect(await h.board.runs.heldEvents(identity)).toEqual([linked, ended]));
    expect((await h.runOf(runId))?.settled).toBeUndefined();
    unreadable = false;
    await h.engine.adoptParkedTemplateRuns();
    const recovered = await h.untilStage(id, "a", "awaiting_gate");
    expect(recovered.stageRuns[0]).toMatchObject({ attempt: 1, childSessionId: child.sessionId, output: `output of ${child.sessionId}` });
    await vi.waitFor(async () => expect(await h.board.runs.heldEvents(identity)).toEqual([]));
    expect(h.children).toHaveLength(1);
    expect(h.events.some(event => event.phase === "error")).toBe(false);
  } finally {
    unreadable = false;
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});
