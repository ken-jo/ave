/** The stage scheduler on the parts boot chooses (`workflowEngineExtensions`): run state is the board store's run file. */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, type MockInstance, vi } from "vitest";
import { aveHome } from "../../shared/ave-home.js";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import type { RemovedRun } from "../workflow-run-store.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import type { StageWorkspaceProvider } from "../../work-board/workflow/stage-workspace.js";
import { gitFixture } from "../../work-board/workflow/__tests__/stage-git-fixture.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

/** The project root a discard was given for each run. */
const rootsOf = (projects: ReadonlyMap<string, { projectRoot: string }>): Map<string, string> => new Map([...projects].map(([runId, named]) => [runId, named.projectRoot]));
const auto = (id: string, inputs: string[] = []) => stageOf(id, { inputs, gate: { type: "auto", pass: { kind: "stage_ok" } } });

it("with the production parts and a workspace provider, an authorised template run starts, is stored in the run file and completes", async () => {
  // Only the workspace provider is the harness's, and with it no session is bound: its folders are not under the home (the real ones are, below).
  const h = await stageRunHarness({ wiring: (store, harness) => ({ ...workflowEngineExtensions(store, harness.templates), workspace: harness.workspace, workspaceBinding: undefined }) });
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
  const h = await stageRunHarness({ wiring: (store, harness) => workflowEngineExtensions(store, harness.templates) });
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

it("the production parts give a discard the project of each run whose record went: a card's root at once, a schedule's approved one once read", async () => {
  const given: Map<string, string>[] = [];
  const items: Map<string, number>[] = [];
  const atOnce: { removed: readonly RemovedRun[]; projects: Map<string, string> | undefined }[] = [];
  const h = await stageRunHarness({ wiring: (store, harness) => {
    const parts = workflowEngineExtensions(store, harness.templates);
    vi.spyOn(parts.workspace, "discard").mockImplementation(async (projects) => { given.push(rootsOf(projects)); items.push(new Map([...projects].map(([runId, named]) => [runId, named.itemId]))); return []; });
    // A row's removal asks for a discard as soon as its record's has been announced.
    const announce = store.runs.onRunsRemoved;
    store.runs.onRunsRemoved = (removed) => {
      announce?.(removed);
      const asked = given.length;
      store.onItemRemoved?.();
      atOnce.push({ removed, projects: given[asked] });
    };
    return { ...parts, workspace: harness.workspace, workspaceBinding: undefined };
  } });
  try {
    const A = "/projects/a";
    const B = "/projects/b";
    const version = await h.confirm([stageOf("a")]);
    const onB = await h.confirm([stageOf("a")], { scope: { kind: "project", projectRoot: B } });
    const attachment = await h.attach(onB, { kind: "project", projectRoot: B });
    const card = await h.addItem(version, A);
    const scheduled = await h.addItem(onB, B);
    const plain = await h.addItem(version);
    void h.start(card, h.local(version, A));
    void h.start(scheduled, attachment.source);
    void h.start(plain, h.local(version));
    await h.untilLive(3);
    const [cardRun, scheduledRun, plainRun] = await Promise.all([card, scheduled, plain].map(async id => (await h.item(id)).runId ?? ""));
    for (const id of [card, scheduled, plain]) expect(await h.board.remove(id)).toMatchObject({ status: "deleted" });
    await vi.waitFor(() => expect(atOnce.flatMap(entry => entry.removed.map(run => run.runId)).sort()).toEqual([cardRun, scheduledRun, plainRun].sort()), { timeout: 5000 });
    expect(atOnce.find(entry => entry.removed.some(run => run.runId === cardRun))?.projects?.get(cardRun)).toBe(A);
    // A run with no project has none to give, and is left to the provider as one.
    await vi.waitFor(() => expect(given.at(-1)).toEqual(new Map([[cardRun, A], [scheduledRun, B]])), { timeout: 5000 });
    // Each with the item it was a run of: the two name the run's folder.
    expect(items.at(-1)).toEqual(new Map([[cardRun, card], [scheduledRun, scheduled]]));
  } finally {
    await h.cleanup();
  }
});

/** The production parts with a provider whose discards are noted and take in hand the runs `taken` names; `announce` is a removal
 * the run store tells of, and resolves to what the discard it asked for was given, once that discard's answer is taken in. */
async function withNotedDiscards(run: (announce: (runs: [runId: string, projectRoot: string][]) => Promise<Map<string, string> | undefined>, taken: string[]) => Promise<void>): Promise<void> {
  const given: Map<string, string>[] = [];
  const taken: string[] = [];
  const h = await stageRunHarness({ wiring: (store, harness) => {
    const parts = workflowEngineExtensions(store, harness.templates);
    vi.spyOn(parts.workspace, "discard").mockImplementation(async (projects) => { given.push(rootsOf(projects)); return [...taken]; });
    return { ...parts, workspace: harness.workspace, workspaceBinding: undefined };
  } });
  try {
    const pin = h.pinOf(await h.confirm([stageOf("a")]));
    await run(async (runs) => {
      const asked = given.length;
      h.board.runs.onRunsRemoved?.(runs.map(([runId, projectRoot]): RemovedRun => ({ runId, itemId: 1, runStartedBy: { kind: "local-create-and-run", pin, projectRoot } })));
      await vi.waitFor(() => expect(given.length).toBeGreaterThan(asked), { timeout: 5000 });
      await new Promise(resolve => setImmediate(resolve));
      return given.at(-1);
    }, taken);
  } finally {
    await h.cleanup();
  }
}

it("the production parts keep a removed record's project only until a discard has taken its run in hand", () => withNotedDiscards(async (announce, taken) => {
  // The provider took the first two in hand, one taken apart and one left whole: it tells them alike. The third's row is still listed.
  taken.push("cleaned", "left-whole");
  expect(await announce([["cleaned", "/projects/a"], ["left-whole", "/projects/b"], ["waiting", "/projects/c"]]))
    .toEqual(new Map([["cleaned", "/projects/a"], ["left-whole", "/projects/b"], ["waiting", "/projects/c"]]));
  taken.length = 0;
  expect(await announce([["next", "/projects/d"]])).toEqual(new Map([["waiting", "/projects/c"], ["next", "/projects/d"]]));
}));

it("the production parts keep the projects of the newest 256 removed records that wait, and no older one", () => withNotedDiscards(async (announce) => {
  await announce([["stale", "/projects/a"], ["kept", "/projects/b"]]);
  const later = await announce(Array.from({ length: 255 }, (_, index): [string, string] => [`later-${index}`, "/projects/c"]));
  expect(later?.size).toBe(256);
  expect([later?.has("stale"), later?.get("kept"), later?.has("later-254")]).toEqual([false, "/projects/b", true]);
}));

interface GitRunScene {
  h: Awaited<ReturnType<typeof stageRunHarness>>;
  repo: string;
  run: { itemId: number; runId: string };
  runRoot: string;
  /** The production provider's discards, as they were asked for. */
  discard: MockInstance<StageWorkspaceProvider["discard"]>;
  /** The removal of the run's record, as the run store tells of one a schedule or a card started. */
  removed: (by: "schedule" | "card") => RemovedRun;
  /** Lets the schedule's approved project be read. */
  answer: () => void;
  /** Holds the next read of the stores that a discard has not begun yet, until what it returns is called. */
  hold: () => () => void;
  /** The warnings that a run was left whole for want of its project. */
  unverified: () => string[];
}

/** The production parts and their own provider on a repository of the test's, with a git run of a row that is not on the board and
 * has no record left: only the root its removed record named lets it be taken apart. The run and the repository go with the test. */
async function withGitRun(work: (scene: GitRunScene) => Promise<void>): Promise<void> {
  const fx = gitFixture();
  const said = vi.spyOn(console, "warn");
  let answer = (): void => undefined;
  const reading = new Promise<void>((resolve) => { answer = resolve; });
  const gates: Promise<void>[] = [];
  let parts: ReturnType<typeof workflowEngineExtensions> | undefined;
  let h: Awaited<ReturnType<typeof stageRunHarness>> | undefined;
  let opened: (() => Promise<void>) | undefined;
  try {
    vi.stubEnv("GIT_CONFIG_GLOBAL", fx.env.GIT_CONFIG_GLOBAL ?? "");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    h = await stageRunHarness({ wiring: (store, harness) => {
      const read = store.runsWithoutItem.bind(store);
      vi.spyOn(store, "runsWithoutItem").mockImplementation(async () => { await gates.shift(); return read(); });
      parts = workflowEngineExtensions(store, { getAttachment: async (id) => { await reading; return { ...await harness.templates.getAttachment(id), approvedScope: { kind: "project", projectRoot: fx.repo } } as never; } });
      return { ...parts, workspace: harness.workspace, workspaceBinding: undefined };
    } });
    const version = await h.confirm([stageOf("a")]);
    const pin = h.pinOf(version);
    await h.addItem(version);
    const workspace = parts?.workspace;
    if (workspace === undefined) throw new Error("the parts were not chosen");
    const run = { itemId: 99, runId: `run-wiring-${process.pid}-${Date.now()}`, runKey: "key", projectRoot: fx.repo };
    const open = await workspace.open(run, fx.repo);
    if (!open.ok) throw new Error(open.code);
    // What a failed assertion leaves of the run goes before the repository does.
    opened = () => workspace.release(run, "all");
    await work({
      h, repo: fx.repo, run, runRoot: open.workspace.runRoot, answer, discard: vi.spyOn(workspace, "discard"),
      removed: by => ({ runId: run.runId, itemId: run.itemId, runStartedBy: by === "card"
        ? { kind: "local-create-and-run", pin, projectRoot: fx.repo }
        : { kind: "schedule-attachment", attachmentId: "attachment", pin, firedAt: "2026-11-16T00:00:00.000Z" } }),
      hold: () => {
        let open = (): void => undefined;
        gates.push(new Promise<void>((resolve) => { open = resolve; }));
        return () => open();
      },
      unverified: () => said.mock.calls.map(line => line.join(" ")).filter(line => line.includes("cleanup is unverified")),
    });
  } finally {
    said.mockRestore();
    try {
      await opened?.().catch(() => undefined);
      vi.unstubAllEnvs();
      await h?.cleanup();
    } finally {
      await fx.done();
    }
  }
}

it("a discard a row's removal asks for while a schedule's approved project is still being read waits for it: the git run goes, with no warning", () => withGitRun(async ({ h, repo, run, runRoot, discard, removed, answer, unverified }) => {
  h.board.runs.onRunsRemoved?.([removed("schedule")]);
  h.board.onItemRemoved?.();
  await new Promise(resolve => setImmediate(resolve));
  expect.soft(discard).not.toHaveBeenCalled();
  answer();
  await vi.waitFor(() => expect(existsSync(runRoot)).toBe(false), { timeout: 20_000 });
  expect.soft(discard.mock.calls.map(([projects]) => projects.get(run.runId)?.projectRoot)).toEqual(discard.mock.calls.map(() => repo));
  expect.soft(unverified()).toEqual([]);
}));

it.each([
  ["is still being read", "schedule"],
  ["was noted after that discard was given its roots", "card"],
] as const)("a discard already at its read of the stores leaves a git run whose project %s to the next one: the run goes, with no warning", (_when, by) => withGitRun(async ({ h, runRoot, discard, removed, answer, hold, unverified }) => {
  const first = hold();
  h.board.onItemRemoved?.();
  expect(discard).toHaveBeenCalledTimes(1);
  // The run's record goes while the first discard waits for the stores. A card's root is noted at once, and the discard that
  // removal asks for is held at its own read; a schedule's is asked for only once its project was read.
  const second = by === "card" ? hold() : (): void => undefined;
  h.board.runs.onRunsRemoved?.([removed(by)]);
  first();
  await discard.mock.results[0]?.value;
  expect.soft(existsSync(runRoot)).toBe(true);
  expect.soft(unverified()).toEqual([]);
  answer();
  second();
  await vi.waitFor(() => expect(existsSync(runRoot)).toBe(false), { timeout: 20_000 });
  expect.soft(unverified()).toEqual([]);
}));

interface HeldDiscard { given: Map<string, string>; answer: (taken: readonly string[]) => void; fail: (error: Error) => void }

/** The production parts with a provider whose discards stay open until the test answers them; `announce` is a removal the run store
 * tells of, awaited until the discard it asks for was given its projects, and `settled` waits until an answer has been taken in. */
async function withHeldDiscards(run: (announce: (runs: [runId: string, projectRoot: string][]) => Promise<void>, discards: HeldDiscard[], settled: () => Promise<void>) => Promise<void>): Promise<void> {
  const discards: HeldDiscard[] = [];
  const h = await stageRunHarness({ wiring: (store, harness) => {
    const parts = workflowEngineExtensions(store, harness.templates);
    vi.spyOn(parts.workspace, "discard").mockImplementation(projects => new Promise((answer, fail) => { discards.push({ given: rootsOf(projects), answer, fail }); }));
    return { ...parts, workspace: harness.workspace, workspaceBinding: undefined };
  } });
  try {
    const pin = h.pinOf(await h.confirm([stageOf("a")]));
    const settled = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
    await run(async (runs) => {
      h.board.runs.onRunsRemoved?.(runs.map(([runId, projectRoot]): RemovedRun => ({ runId, itemId: 1, runStartedBy: { kind: "local-create-and-run", pin, projectRoot } })));
      await settled();
    }, discards, settled);
  } finally {
    await h.cleanup();
  }
}

it("a project noted while a discard is still running is kept for the next one, whatever that discard then says it took", () => withHeldDiscards(async (announce, discards, settled) => {
  await announce([["early", "/projects/a"]]);
  // While the first discard runs: a run it never saw, and the first run noted again under another root.
  await announce([["late", "/projects/b"], ["early", "/projects/c"]]);
  expect(discards.map(discard => discard.given)).toEqual([new Map([["early", "/projects/a"]]), new Map([["early", "/projects/c"], ["late", "/projects/b"]])]);
  discards[0]?.answer(["early", "late"]);
  await settled();
  await announce([["next", "/projects/d"]]);
  expect(discards[2]?.given).toEqual(new Map([["early", "/projects/c"], ["late", "/projects/b"], ["next", "/projects/d"]]));
}));

it("a discard that fails keeps every project it was given", () => withHeldDiscards(async (announce, discards, settled) => {
  await announce([["first", "/projects/a"], ["second", "/projects/b"]]);
  discards[0]?.fail(new Error("fixture: the discard failed"));
  await settled();
  await announce([["next", "/projects/c"]]);
  expect(discards[1]?.given).toEqual(new Map([["first", "/projects/a"], ["second", "/projects/b"], ["next", "/projects/c"]]));
}));
