/** The stage scheduler on the parts boot chooses (`workflowEngineExtensions`): run state is the board store's run file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

const auto = (id: string, inputs: string[] = []) => stageOf(id, { inputs, gate: { type: "auto", pass: { kind: "stage_ok" } } });

it("with the production parts and a workspace provider, an authorised template run starts, is stored in the run file and completes", async () => {
  // Only the workspace provider is the harness's: the production default refuses every start until a real provider is wired (below).
  const h = await stageRunHarness({ wiring: (store, harness) => ({ ...workflowEngineExtensions(store), workspace: harness.workspace }) });
  try {
    const version = await h.confirm([auto("a"), auto("b", ["a"])]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish({ summary: "first" });
    (await h.untilSpawned(2))[1].finish({ summary: "second" });
    expect(await run).toMatchObject({ status: "completed", output: "second" });

    const row = await h.board.get(id);
    if (row.status !== "found") throw new Error("item not found");
    const runId = row.item.runId ?? "";
    // The run file holds the run; the board file names it by id and holds none of its fields.
    const runFile = readFileSync(join(h.dir, "workflow-runs.json"), "utf8");
    expect(runFile).toContain(runId);
    expect(runFile).toContain(version.graphHash);
    const boardFile = readFileSync(h.boardPath, "utf8");
    expect(boardFile).toContain(runId);
    for (const field of ["stageRuns", "runStartedBy", "graphHash", "runWorkspace", "settled"]) expect(boardFile).not.toContain(field);
    expect(await h.runOf(runId)).toMatchObject({
      itemId: id, pin: h.pinOf(version), runStartedBy: { kind: "local-create-and-run" }, settled: { status: "completed" },
      stageRuns: [{ stageId: "a", status: "passed", output: "first" }, { stageId: "b", status: "passed", output: "second" }],
    });
  } finally {
    await h.cleanup();
  }
});

it("with the production parts alone a start is refused workspace-unavailable and nothing is written", async () => {
  const h = await stageRunHarness({ wiring: store => workflowEngineExtensions(store) });
  try {
    const version = await h.confirm([auto("a")]);
    const id = await h.addItem(version);
    expect(await h.start(id, h.local(version))).toMatchObject({ status: "error", reasonCode: "workspace-unavailable" });
    expect(JSON.parse(readFileSync(join(h.dir, "workflow-runs.json"), "utf8")).runs).toEqual([]);
    expect((await h.item(id)).runId).toBeUndefined();
    expect(h.children).toHaveLength(0);
  } finally {
    await h.cleanup();
  }
});
