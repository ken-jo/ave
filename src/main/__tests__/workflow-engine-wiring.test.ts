/** The stage scheduler on the parts boot chooses (`workflowEngineExtensions`): run state is the board store's run file. */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { aveHome } from "../../shared/ave-home.js";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

const auto = (id: string, inputs: string[] = []) => stageOf(id, { inputs, gate: { type: "auto", pass: { kind: "stage_ok" } } });

it("with the production parts and a workspace provider, an authorised template run starts, is stored in the run file and completes", async () => {
  // Only the workspace provider is the harness's, and with it no session is bound: its folders are not under the home (the real ones are, below).
  const h = await stageRunHarness({ wiring: (store, harness) => ({ ...workflowEngineExtensions(store), workspace: harness.workspace, workspaceBinding: undefined }) });
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

it("with the production parts alone a run works in stage folders under the home and leaves its output folder", async () => {
  const h = await stageRunHarness({ wiring: store => workflowEngineExtensions(store) });
  try {
    const version = await h.confirm([auto("a"), auto("b", ["a"])]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [first] = await h.untilLive(1);
    const stageRoot = first.input.projectRoot ?? "";
    expect(realpathSync.native(stageRoot).startsWith(join(realpathSync.native(aveHome()), "worktrees"))).toBe(true);
    writeFileSync(join(stageRoot, "result.md"), "made by the first stage\n");
    first.finish({ summary: "first" });
    (await h.untilSpawned(2))[1].finish({ summary: "second" });
    expect(await run).toMatchObject({ status: "completed", output: "second" });
    const row = await h.board.get(id);
    if (row.status !== "found") throw new Error("item not found");
    expect((await h.runOf(row.item.runId ?? ""))?.runWorkspace).toMatchObject({ kind: "folder", runRoot: dirname(stageRoot) });
    await vi.waitFor(() => expect(existsSync(stageRoot)).toBe(false), { timeout: 5000 });
  } finally {
    await h.cleanup();
  }
});
