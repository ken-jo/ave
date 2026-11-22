/** Template runs on the production parts: every stage child works in its own real folder under the home, bound to its session. */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import { boundStageWorkspace, isOwnStageWorkspacePath } from "../../permissions/stage-workspace-binding.js";
import { aveHome } from "../../shared/ave-home.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
async function withProductionParts(run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await stageRunHarness({ wiring: store => workflowEngineExtensions(store) });
  try {
    await run(h);
  } finally {
    await h.cleanup();
  }
}
const folderOf = (child: Harness["children"][number]): string => child.input.projectRoot ?? "";

it("two stages run in two folders under the home, each bound to its own session", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b")]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [first, second] = await h.untilLive(2);
  const worktrees = join(realpathSync.native(aveHome()), "worktrees");
  expect(folderOf(first)).not.toBe(folderOf(second));
  expect(dirname(folderOf(first))).toBe(dirname(folderOf(second)));
  for (const child of [first, second]) {
    expect(realpathSync.native(folderOf(child)).startsWith(worktrees)).toBe(true);
    expect(boundStageWorkspace(child.sessionId)).toBe(realpathSync.native(folderOf(child)));
  }
  expect(isOwnStageWorkspacePath(first.sessionId, join(folderOf(first), "notes.txt"))).toBe(true);
  expect(isOwnStageWorkspacePath(first.sessionId, join(folderOf(second), "notes.txt"))).toBe(false);
  expect(isOwnStageWorkspacePath(first.sessionId, join(dirname(folderOf(first)), "_out", "notes.txt"))).toBe(false);
  first.finish();
  await h.untilStage(id, "a", "awaiting_gate");
  // The binding ends with the session.
  expect(boundStageWorkspace(first.sessionId)).toBeUndefined();
  expect(boundStageWorkspace(second.sessionId)).toBeDefined();
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");
  expect(boundStageWorkspace(second.sessionId)).toBeUndefined();
  await vi.waitFor(() => expect(existsSync(folderOf(second))).toBe(false), { timeout: 5000 });
}));

it("request changes reruns in the same folder", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  writeFileSync(join(folderOf(first), "draft.md"), "first attempt\n");
  first.finish();
  await h.untilStage(id, "a", "awaiting_gate");
  expect(await h.decide(id, "a", "request_changes", "tighten it")).toMatchObject({ ok: true });
  const [, second] = await h.untilSpawned(2);
  expect((await h.stageRun(id, "a")).attempt).toBe(2);
  expect(folderOf(second)).toBe(folderOf(first));
  expect(readFileSync(join(folderOf(second), "draft.md"), "utf8")).toBe("first attempt\n");
  expect(boundStageWorkspace(second.sessionId)).toBe(realpathSync.native(folderOf(second)));
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");
}));

it("retry prepares a fresh folder", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  writeFileSync(join(folderOf(first), "half-done.md"), "left by the failed attempt\n");
  first.finish({ ok: false, summary: "failed", error: "failed" });
  const item = await h.untilStage(id, "a", "failed");
  expect(existsSync(join(folderOf(first), "half-done.md"))).toBe(true);
  expect(await h.engine.retryStage(id, { runId: item.runId ?? "", stageId: "a" })).toEqual({ ok: true });
  const [, second] = await h.untilSpawned(2);
  expect((await h.stageRun(id, "a")).attempt).toBe(2);
  expect(folderOf(second)).toBe(folderOf(first));
  expect(existsSync(join(folderOf(second), "half-done.md"))).toBe(false);
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");
}));

it("boot sweep removes folders of runs that are no longer active only", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  first.finish();
  await h.untilStage(id, "a", "awaiting_gate");
  writeFileSync(join(folderOf(first), "kept.md"), "kept\n");

  // What a run that is on no record left behind: its folders, and nothing that names it.
  const leftover = createStageWorkspaceProvider();
  const gone = { itemId: 99, runId: "run-on-no-record", runKey: "key" };
  const opened = await leftover.open(gone, undefined);
  if (!opened.ok) throw new Error(opened.code);
  const prepared = await leftover.prepare(gone, stageOf("a"), 1);
  if (!prepared.ok) throw new Error(prepared.code);

  await h.board.reconcileInterruptedRuns();
  await h.makeEngine().adoptParkedTemplateRuns();
  expect(existsSync(prepared.workspace.root)).toBe(false);
  expect(readFileSync(join(folderOf(first), "kept.md"), "utf8")).toBe("kept\n");
}));

it("the run output folder stays when the run settles and goes when its item is removed", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  const runRoot = dirname(folderOf(first));
  const out = join(runRoot, "_out");
  writeFileSync(join(out, "result.md"), "collected\n");
  const runId = (await h.item(id)).runId ?? "";

  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");
  await vi.waitFor(() => expect(existsSync(folderOf(first))).toBe(false), { timeout: 5000 });
  // Settled, its stage folders released: the row still lists the run, so its record and its output stay.
  expect((await h.runOf(runId))?.settled?.status).toBe("cancelled");
  expect(readFileSync(join(out, "result.md"), "utf8")).toBe("collected\n");
  expect(existsSync(join(runRoot, "_run.json"))).toBe(true);

  expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
  expect(await h.runOf(runId)).toBeNull();
  await vi.waitFor(() => expect(existsSync(runRoot)).toBe(false), { timeout: 5000 });
}));

it("a delete of a live run's item keeps the output folder until the run has settled and its record is gone", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  const runRoot = dirname(folderOf(first));
  const out = join(runRoot, "_out");
  const runId = (await h.item(id)).runId ?? "";
  // What is on disk at each step of the delete: the intent stored, then the write that ends the run.
  const seen: string[] = [];
  const note = (step: string): void => { seen.push(`${step}:${existsSync(out) ? "out" : "gone"}`); };
  const markDeleted = h.board.runs.markDeleted.bind(h.board.runs);
  vi.spyOn(h.board.runs, "markDeleted").mockImplementation(async (...args) => { const marked = await markDeleted(...args); note("intent"); return marked; });
  const settleRun = h.board.runs.settleRun.bind(h.board.runs);
  vi.spyOn(h.board.runs, "settleRun").mockImplementation(async (...args) => { const settled = await settleRun(...args); note("settled"); return settled; });

  expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
  expect(await run).toMatchObject({ status: "cancelled", reason: "item-removed" });
  expect(seen[0]).toBe("intent:out");
  expect(seen).toContain("settled:out");
  expect(seen.filter(step => step.endsWith(":gone"))).toEqual([]);
  await vi.waitFor(async () => expect(await h.runOf(runId)).toBeNull(), { timeout: 5000 });
  await vi.waitFor(() => expect(existsSync(runRoot)).toBe(false), { timeout: 5000 });
}));
