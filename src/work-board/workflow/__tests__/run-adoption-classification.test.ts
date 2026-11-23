import { expect, it, vi } from "vitest";
import type { RunClass } from "../../../main/run-classification.js";
import { boardRunState } from "../run-state.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["live", "waiting-delete", "unreadable", "due-delete", "orphan", "lost"] as const)("classifies every named candidate before adopting class %s", async cls => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const running = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    child.finish();
    await running;
    const runId = (await h.item(id)).runId;
    const classify = vi.fn((): RunClass => cls);
    const classes = vi.spyOn(h.board, "runClasses").mockResolvedValue(classify);
    const rows = vi.spyOn(h.board, "list");
    const snapshot = vi.spyOn(h.board, "runBoardSnapshot");
    const adopted = await boardRunState(h.board).adoption();
    const current = await snapshot.mock.results[0].value;
    expect(current).toBeDefined();
    expect(rows.mock.calls[0][1]).toBe(current);
    expect(classes.mock.calls[0][0]).toBe(current);
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ itemId: id, runId }));
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) throw new Error("Adoption refused");
    expect(adopted.named.some(entry => entry.run?.runId === runId)).toBe(cls === "live");
    const group = cls === "live" ? [] : cls === "orphan" ? adopted.orphans : cls === "lost" ? adopted.lost : cls === "due-delete" ? adopted.removed : adopted.kept;
    if (cls !== "live") expect(group).toContainEqual(expect.objectContaining({ runId }));
  } finally {
    vi.restoreAllMocks();
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});
