import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { within } from "../../../__tests__/support/signal-wait.js";
import { boardRunState } from "../run-state.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["held", "mutation"] as const)("an obsolete link keeps its original attempt at the %s boundary", async boundary => {
  let linked = false;
  let moved = false;
  const moveWritten = deferred<void>();
  let refusing = false;
  const messages = vi.spyOn(console, "log");
  const h = await stageRunHarness({
    observeRunWork: true,
    script: () => { linked = true; return undefined; },
    wiring: store => {
      const records = boardRunState(store);
      const move = async (runId: string) => {
        moved = true;
        await store.runs.update(runId, current => ({ ...current, stageRuns: current.stageRuns.map(stage => {
          const { childSessionId: _childSessionId, ...rest } = stage;
          return stage.stageId === "a" ? { ...rest, attempt: 2 } : stage;
        }) }));
        moveWritten.resolve();
      };
      return { runs: { ...records,
        get: async (...args) => {
          if (linked && !moved && boundary === "held") { await move(args[1]); refusing = true; }
          return records.get(...args);
        },
        update: async (...args) => {
          if (linked && !moved && boundary === "mutation") await move(args[1]);
          return refusing ? { ok: false, reason: "row-lost" } : records.update(...args);
        },
      } };
    },
  });
  await h.runThenEnd(async () => {
    try {
      await linkMovesOn();
    } finally {
      // The children end, and their run work drains, with the store writing again.
      refusing = false;
      vi.restoreAllMocks();
    }
  });
  async function linkMovesOn() {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    await within(moveWritten.promise, "the moved link write");
    expect(moved).toBe(true);
    const runId = (await h.item(id)).runId ?? "";
    if (boundary === "held") await h.untilRunFile(async () => expect(await h.board.runs.heldEvents({ itemId: id, runId })).toEqual([
      { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_linked" },
    ]));
    refusing = false;
    await h.engine.adoptParkedTemplateRuns();
    const recovered = await h.untilStage(id, "a", "failed");
    expect(recovered.stageRuns[0]).toMatchObject({ attempt: 2, failure: "interrupted" });
    expect(recovered.stageRuns[0].childSessionId).toBeUndefined();
    expect(child.ended).toBe(false);
    expect(messages.mock.calls.some(call => call.includes("its stage moved on to another attempt"))).toBe(true);
  }
});
