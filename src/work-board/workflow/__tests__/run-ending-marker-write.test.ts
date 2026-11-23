import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import * as classification from "../../../main/run-classification.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("a completion after a landed delete with an unknown marker keeps its item-removed cause", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    const running = h.start(id, h.local(version));
    void running.catch(() => undefined);
    const [child] = await h.untilLive(1);
    await h.until(id, item => item.stageRuns.some(stage => stage.childSessionId === child.sessionId));
    const runId = (await h.item(id)).runId ?? "";
    const board = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: { id: number }[] };
    board.items = board.items.filter(item => item.id !== id);
    writeFileSync(h.boardPath, JSON.stringify(board));
    const path = join(h.dir, "workflow-runs.json");
    const runs = JSON.parse(readFileSync(path, "utf8"));
    runs.deleteIntents = [{ itemId: id, runId }];
    runs.unknownDeletes = [{ itemId: id, runId }];
    writeFileSync(path, JSON.stringify(runs));
    const before = JSON.parse(readFileSync(join(h.dir, "workflow-runs.json"), "utf8"));
    const classify = vi.spyOn(classification, "classifyRun");
    const settle = h.board.runs.settleRun.bind(h.board.runs);
    const causes: string[] = [];
    const removedWritten = deferred<void>();
    vi.spyOn(h.board.runs, "settleRun").mockImplementation(async (key, step, allowed) => {
      const stored = await settle(key, run => {
        const next = step(run);
        if (next && "ends" in next) causes.push(next.ends);
        return next;
      }, allowed);
      if (causes.includes("item-removed")) removedWritten.resolve();
      return stored;
    });
    child.finish();
    await removedWritten.promise;
    expect(causes).toContain("item-removed");
    expect(classify.mock.results.map(result => result.value), JSON.stringify(before)).toContain("due-delete");
    expect(causes).not.toContain("orphan");
  } finally {
    vi.restoreAllMocks();
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});
