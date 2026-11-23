/** Template runs on the production parts: every stage child works in its own real folder under the home, bound to its session. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import { boundStageWorkspace, isOwnStageWorkspacePath } from "../../permissions/stage-workspace-binding.js";
import { aveHome } from "../../shared/ave-home.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import type { StageWorkspaceProvider } from "../../work-board/workflow/stage-workspace.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
/** The provider the production wiring chose for the engine now running. */
let production: StageWorkspaceProvider;
async function withProductionParts(run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await stageRunHarness({ wiring: (store, { templates }) => { const parts = workflowEngineExtensions(store, templates); production = parts.workspace; return parts; } });
  try {
    await run(h);
  } finally {
    await h.cleanup();
  }
}
const folderOf = (child: Harness["children"][number]): string => child.input.projectRoot ?? "";
/** As a stop between a record's removal and the discard, or a board recovery, leaves it: a run folder with an output folder and no run
 * record. */
async function left(run: { itemId: number; runId: string; runKey: string }): Promise<string> {
  const leftover = createStageWorkspaceProvider();
  const opened = await leftover.open(run, undefined);
  if (!opened.ok || opened.workspace.kind !== "folder") throw new Error("no folder workspace");
  const prepared = await leftover.prepare(run, stageOf("a"), 1);
  if (!prepared.ok) throw new Error(prepared.code);
  writeFileSync(join(opened.workspace.runRoot, "_out", "result.md"), "left behind\n");
  return opened.workspace.runRoot;
}

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

it("boot sweep removes folders of runs that are no longer active only, and of a parked run only what its ignore matcher left", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  first.finish();
  await h.untilStage(id, "a", "awaiting_gate");
  writeFileSync(join(folderOf(first), "kept.md"), "kept\n");
  // What a stop while a stage folder was seeded left in the parked run: the ignore matcher's repository.
  const residue = join(dirname(folderOf(first)), "_ignore-Ab12Cd");
  mkdirSync(join(residue, ".git"), { recursive: true });

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
  expect(existsSync(residue)).toBe(false);
}));

it("boot sweep removes the output folder and record of a run with no record whose item is gone, and follows no link out of it", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  const [child] = await h.untilLive(1);
  const settled = dirname(folderOf(child));
  writeFileSync(join(settled, "_out", "result.md"), "collected\n");
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");

  const itemGone = await left({ itemId: 99, runId: "run-of-a-removed-item", runKey: "key" });
  const itemListed = await left({ itemId: id, runId: "run-of-a-listed-item", runKey: "key" });
  const outside = join(h.dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.md"), "not the run's\n");
  symlinkSync(outside, join(itemGone, "_out", "linked"), "junction");

  await h.board.reconcileInterruptedRuns();
  await h.makeEngine().adoptParkedTemplateRuns();
  expect(existsSync(itemGone)).toBe(false);
  expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("not the run's\n");
  // An item still on the board keeps the output of its run without a record, and a settled run on record keeps its own.
  expect(existsSync(join(itemListed, "a"))).toBe(false);
  expect(readFileSync(join(itemListed, "_out", "result.md"), "utf8")).toBe("left behind\n");
  expect(existsSync(join(itemListed, "_run.json"))).toBe(true);
  expect(readFileSync(join(settled, "_out", "result.md"), "utf8")).toBe("collected\n");
  expect(existsSync(join(settled, "_run.json"))).toBe(true);
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

it("a superseded run keeps its output folder when its record goes, until its item is removed", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const runRoots: string[] = [];
  const runIds: string[] = [];
  for (const round of [1, 2]) {
    void h.start(id, h.local(version));
    const child = (await h.untilSpawned(round))[round - 1];
    if (child === undefined) throw new Error("no stage child");
    await vi.waitFor(() => expect(existsSync(folderOf(child))).toBe(true), { timeout: 5000 });
    runRoots.push(dirname(folderOf(child)));
    writeFileSync(join(dirname(folderOf(child)), "_out", "result.md"), `collected ${round}\n`);
    runIds.push((await h.item(id)).runId ?? "");
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    await h.until(id, item => item.runStatus === "cancelled");
    await vi.waitFor(() => expect(existsSync(folderOf(child))).toBe(false), { timeout: 5000 });
  }
  const [first, second] = runRoots as [string, string];
  expect(first).not.toBe(second);

  // Retention lets the superseded run's record go while the row is still listed.
  const discarded = vi.spyOn(production, "discard");
  await h.board.runs.prune(run => run.runId === runIds[0] ? null : run);
  expect(await h.runOf(runIds[0] ?? "")).toBeNull();
  await vi.waitFor(() => expect(discarded).toHaveBeenCalled(), { timeout: 5000 });
  await discarded.mock.results.at(-1)?.value;
  expect(readFileSync(join(first, "_out", "result.md"), "utf8")).toBe("collected 1\n");
  expect(existsSync(join(first, "_run.json"))).toBe(true);

  expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
  await vi.waitFor(() => expect(existsSync(second)).toBe(false), { timeout: 5000 });
  await vi.waitFor(() => expect(existsSync(first)).toBe(false), { timeout: 5000 });
}));

it("a delete of a live run's item keeps the output folder until the run has settled and its record is gone", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [first] = await h.untilLive(1);
  const runRoot = dirname(folderOf(first));
  const out = join(runRoot, "_out");
  const runId = (await h.item(id)).runId ?? "";
  // What is on disk at each step of the delete: the intent stored, then each run write, which says whether it ended the run and how. A
  // live run keeps writing its progress meanwhile; only the write that ends it has to follow the intent.
  type Step = { step: string; out: boolean; ends?: string };
  const seen: Step[] = [];
  const note = (step: string): Step => { const at = { step, out: existsSync(out) }; seen.push(at); return at; };
  const markDeleted = h.board.runs.markDeleted.bind(h.board.runs);
  vi.spyOn(h.board.runs, "markDeleted").mockImplementation(async (...args) => { const marked = await markDeleted(...args); note("intent"); return marked; });
  const settleRun = h.board.runs.settleRun.bind(h.board.runs);
  vi.spyOn(h.board.runs, "settleRun").mockImplementation(async (runId, step, allowed) => {
    // The row is gone and the run still has its record: a discard now takes nothing of it.
    await production.discard(new Map());
    const recorded = note("recorded");
    let ends: string | undefined;
    const settled = await settleRun(runId, (record) => {
      const next = step(record);
      if (next !== null && "ends" in next) ends = next.ends;
      return next;
    }, allowed);
    if (ends !== undefined) recorded.ends = ends;
    note("settled").ends = ends;
    return settled;
  });

  expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
  expect(await run).toMatchObject({ status: "cancelled", reason: "item-removed" });
  const ending = seen.findIndex(at => at.step === "recorded" && at.ends !== undefined);
  expect(seen[ending]?.ends).toBe("item-removed");
  expect(seen.findIndex(at => at.step === "intent")).toBeGreaterThanOrEqual(0);
  expect(seen.findIndex(at => at.step === "intent")).toBeLessThan(ending);
  expect(seen[ending + 1]).toEqual({ step: "settled", out: true, ends: "item-removed" });
  expect(seen.filter(at => !at.out)).toEqual([]);
  await vi.waitFor(async () => expect(await h.runOf(runId)).toBeNull(), { timeout: 5000 });
  await vi.waitFor(() => expect(existsSync(runRoot)).toBe(false), { timeout: 5000 });
}));

it("a discard whose first read of the stores is older than an item keeps the workspace of that item's starting run", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  // A board that lists a row, so its file on disk says which items are gone.
  await h.addItem(version);
  const readStores = h.board.runsWithoutItem.bind(h.board);
  let reads = 0;
  let taken = false;
  let deliver = (): void => undefined;
  const held = new Promise<void>((resolve) => { deliver = resolve; });
  vi.spyOn(h.board, "runsWithoutItem").mockImplementation(async () => {
    reads += 1;
    const answer = await readStores();
    if (reads > 1) return answer;
    taken = true;
    await held;
    return answer;
  });
  const discarding = production.discard(new Map());
  await vi.waitFor(() => expect(taken).toBe(true), { timeout: 5000 });

  // An unrelated item is added and started; its start is held where the folder is published and no record is stored yet.
  const open = production.open.bind(production);
  let runRoot = "";
  let proceed = (): void => undefined;
  const publishedOnly = new Promise<void>((resolve) => { proceed = resolve; });
  vi.spyOn(production, "open").mockImplementation(async (...args) => {
    const opened = await open(...args);
    if (opened.ok) runRoot = opened.workspace.runRoot;
    await publishedOnly;
    return opened;
  });
  const id = await h.addItem(version);
  void h.start(id, h.local(version));
  await vi.waitFor(() => expect(runRoot).not.toBe(""), { timeout: 5000 });
  expect((await h.item(id)).runId).toBeUndefined();

  deliver();
  await discarding;
  expect(reads).toBeGreaterThan(1);
  expect(existsSync(join(runRoot, "_out"))).toBe(true);
  expect(existsSync(join(runRoot, "_run.json"))).toBe(true);

  proceed();
  const [child] = await h.untilLive(1);
  expect(dirname(folderOf(child))).toBe(runRoot);
  expect(h.engine.cancelRun(id)).toEqual({ ok: true });
  await h.until(id, item => item.runStatus === "cancelled");
}));

it("deleting a row whose runs have no record left removes their output folders", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const other = await h.addItem(version);
  const ofRow = await left({ itemId: id, runId: "recordless-run-of-the-deleted-row", runKey: "key" });
  const ofOther = await left({ itemId: other, runId: "recordless-run-of-a-listed-row", runKey: "key" });
  // No run record goes with this delete, so no run removal is announced for it.
  const announced = vi.fn();
  h.board.runs.onRunsRemoved = announced;

  expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
  await vi.waitFor(() => expect(existsSync(ofRow)).toBe(false), { timeout: 5000 });
  expect(announced).not.toHaveBeenCalled();
  expect(readFileSync(join(ofOther, "_out", "result.md"), "utf8")).toBe("left behind\n");
  expect(existsSync(join(ofOther, "_run.json"))).toBe(true);
}));

it("a start refused because its row was deleted while its workspace was opened leaves no run folder", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  // A board that lists a row, so its file on disk says which items are gone.
  await h.addItem(version);
  const open = production.open.bind(production);
  for (const deleted of ["before the folder is published", "after it"] as const) {
    const id = await h.addItem(version);
    let runRoot = "";
    const spy = vi.spyOn(production, "open").mockImplementation(async (...args) => {
      const removeRow = async (): Promise<void> => {
        expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
        // The discard that removal asks for has run its course.
        await production.discard(new Map());
      };
      if (deleted === "before the folder is published") await removeRow();
      const opened = await open(...args);
      if (opened.ok) runRoot = opened.workspace.runRoot;
      if (deleted === "after it") await removeRow();
      return opened;
    });
    await h.start(id, h.local(version));
    spy.mockRestore();
    expect(runRoot, deleted).not.toBe("");
    expect(existsSync(runRoot), deleted).toBe(false);
  }
}));

it("removing an unreadable row whose runs have no record left removes their output folders, and no other row's", () => withProductionParts(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const other = await h.addItem(version);
  const ofRow = await left({ itemId: id, runId: "recordless-run-of-the-unreadable-row", runKey: "key" });
  const ofOther = await left({ itemId: other, runId: "recordless-run-of-a-surviving-row", runKey: "key" });
  const announced = vi.fn();
  h.board.runs.onRunsRemoved = announced;

  // The row no longer validates, so it is listed as a card and removed as one.
  h.editRow(id, row => ({ ...row, priority: 42 }));
  await h.board.load();
  const listed = await h.board.list();
  const entry = (JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: { id?: unknown }[] }).items.find(row => row.id === id);
  const card = (listed.status === "ok" ? listed.unreadableRows ?? [] : []).find(row => row.hash === createHash("sha256").update(JSON.stringify(entry)).digest("hex"));
  if (card === undefined) throw new Error("the row is not listed as unreadable");
  expect(await h.board.removeUnreadable(card, () => true)).toMatchObject({ status: "deleted" });
  await vi.waitFor(() => expect(existsSync(ofRow)).toBe(false), { timeout: 5000 });
  expect(announced).not.toHaveBeenCalled();
  expect(readFileSync(join(ofOther, "_out", "result.md"), "utf8")).toBe("left behind\n");
  expect(existsSync(join(ofOther, "_run.json"))).toBe(true);
}));
