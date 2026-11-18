import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["unsettled", "unreadable", "repeated", "unidentified"] as const)("retains unconfirmed records and workspace ownership when %s", async damage => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const running = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    child.finish();
    await running;
    const runId = (await h.item(id)).runId;
    if (!runId) throw new Error("Missing run");
    const path = join(h.dir, "workflow-runs.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { runs: Record<string, unknown>[]; deleteIntents?: unknown[]; unknownDeletes?: unknown[] };
    const record = file.runs.find(run => run.runId === runId);
    if (!record) throw new Error("Missing record");
    if (damage === "unreadable") record.runStartedBy = null;
    if (damage === "repeated") file.runs.push(structuredClone(record));
    if (damage === "unidentified") file.runs.push({ itemId: id + 1 });
    writeFileSync(path, JSON.stringify(file));
    await h.board.runs.markDeleted({ itemId: id, runId });
    await h.board.runs.markUnknown({ itemId: id, runId });
    const before = readFileSync(path, "utf8");
    await h.board.runs.prune(() => null);
    expect(readFileSync(path, "utf8")).toBe(before);
    const readable = await h.board.runs.get(runId);
    if (readable.status === "found") {
      await h.board.runs.put({ ...readable.run, runId: "another-run", itemId: id + 2 }, () => null);
      const retained = JSON.parse(readFileSync(path, "utf8")) as typeof file;
      expect(retained.runs).toContainEqual(record);
      expect(retained.deleteIntents).toContainEqual({ itemId: id, runId });
      expect(retained.unknownDeletes).toContainEqual({ itemId: id, runId, op: "row", ownIntent: true });
    }
    h.makeEngine();
    const start = h.sweeps.length;
    await h.engine.adoptParkedTemplateRuns();
    const sweeps = h.sweeps.slice(start);
    expect(sweeps.every(keep => keep.includes(runId))).toBe(true);
    expect(sweeps.every(keep => new Set(keep).size === keep.length)).toBe(true);
    if (damage === "unidentified") expect(sweeps).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});
