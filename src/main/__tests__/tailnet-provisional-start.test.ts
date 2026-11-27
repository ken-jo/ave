import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript/unstable/ast";
import { expect, it, vi } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { useConfigurationOwner as installConfigurationOwnerFixture } from "../../__tests__/support/configuration-owner.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { ensureAveHomePrivate } from "../../shared/ave-home.js";
import type { TailnetWorkDecisionRequest } from "../../shared/tailnet-work-decisions.js";
import type { WorkItem } from "../../shared/work-board-types.js";
import { createHostGit, type HostGit } from "../../work-board/workflow/host-git.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { gitFixture } from "../../work-board/workflow/__tests__/stage-git-fixture.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { readPermissionSettings, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { RoutinesStore } from "../routines-store.js";
import * as storage from "../storage/rewrite-keeping-bytes.js";
import { createTailnetWorkDecisions } from "../tailnet-work-decisions.js";

installConfigurationOwnerFixture();

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;

function remoteStart(h: Harness) {
  const log = vi.fn();
  let current = true;
  const routines = new RoutinesStore(join(h.dir, "routines.json"));
  routines.bindTemplateAttachments(h.templates);
  const runtime = createTailnetWorkDecisions({
    workBoardStore: h.board, workBoardEngine: h.engine, workflowTemplateStore: h.templates, routinesStore: routines,
    settingsService: { get: key => DEFAULT_SETTINGS[key] }, auditLogger: { log },
  });
  if (!runtime) throw new Error("Work decision runtime unavailable");
  return {
    log,
    revoke: () => { current = false; },
    decide: (input: Extract<TailnetWorkDecisionRequest, { kind: "create-and-run" }>["input"]) => runtime.decide(
      { id: crypto.randomUUID(), scope: crypto.randomUUID(), kind: "create-and-run", input },
      { login: "owner@example.com", conversationId: "active", authority: { isCurrent: () => current, refreshCurrent: async () => current } },
    ),
  };
}

function rows(bytes: string): WorkItem[] {
  return JSON.parse(bytes).items;
}

async function expectRetracted(h: Harness, itemId: number, runId: string, edited = false) {
  const engine = h.makeEngine();
  await engine.adoptParkedTemplateRuns();
  const items = rows(readFileSync(h.boardPath, "utf8"));
  expect(items).toEqual(edited ? [expect.objectContaining({ id: itemId, title: "Desktop edit", priority: "high" })] : []);
  expect(items[0]?.remoteProvisional).toBeUndefined();
  expect(items[0]?.runId).toBeUndefined();
  expect(items[0]?.runHistory).toBeUndefined();
  const stored = await h.board.runs.list();
  expect(stored).toMatchObject({ status: "found", runs: [] });
  expect(await engine.retryStage(itemId, { runId, stageId: "a", attempt: 1 })).toMatchObject({ ok: false });
  expect(await engine.continueRun(itemId, { runId })).toMatchObject({ ok: false });
  expect(h.sweeps.at(-1)).not.toContain(runId);
}

it("replays the durable state at every remote start suspension before the accepting write", async () => {
  let launched = false;
  let markerAtLaunch: WorkItem["remoteProvisional"];
  const h: Harness = await stageRunHarness({ observeRunWork: true, onSpawn: () => {
    launched = true;
    markerAtLaunch = rows(readFileSync(h.boardPath, "utf8"))[0]?.remoteProvisional;
  } });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    const remote = remoteStart(h);
    const runPath = join(h.dir, "workflow-runs.json");
    const context = new AsyncLocalStorage<boolean>();
    const promises = new Set<number>();
    const snapshots = new Map<string, { board: string; runs: string; row: WorkItem }>();
    let awaits = 0;
    let marked = false;
    let clearedBeforeLaunch = false;
    // Promise continuations include awaits inside called storage and workspace functions.
    // Every suspension with identical durable bytes has the same post-crash input.
    const hook = createHook({
      init(id, type) { if (type === "PROMISE" && context.getStore()) promises.add(id); },
      before(id) {
        if (launched || !promises.has(id) || !existsSync(h.boardPath)) return;
        const board = readFileSync(h.boardPath, "utf8");
        const row = rows(board)[0];
        if (!row) return;
        if (marked && row.remoteProvisional === undefined) {
          clearedBeforeLaunch = true;
          return;
        }
        marked ||= row.remoteProvisional !== undefined;
        const runs = readFileSync(runPath, "utf8");
        snapshots.set(JSON.stringify([board, runs]), { board, runs, row });
        awaits += 1;
      },
      destroy(id) { promises.delete(id); },
    });
    const outcome = await (async () => {
      hook.enable();
      try { return await context.run(true, () => remote.decide({ ...h.pinOf(version), title: "Remote work" })); }
      finally { hook.disable(); }
    })();
    if (!outcome.ok || outcome.kind !== "create-and-run") throw new Error("Control launch did not accept");
    expect(markerAtLaunch).toBeUndefined();
    expect(clearedBeforeLaunch).toBe(false);
    expect(awaits).toBeGreaterThan(snapshots.size);
    // Cover creation alone, the run-file write before the row names the run,
    // and the first running attempt with a prepared stage folder.
    const states = [...snapshots.values()];
    expect(states.some(({ runs, row }) => JSON.parse(runs).runs.length === 0 && row.runId === undefined)).toBe(true);
    expect(states.some(({ runs, row }) => JSON.parse(runs).runs.length === 1 && row.runId === undefined)).toBe(true);
    expect(states.some(({ runs }) => JSON.parse(runs).runs[0]?.stageRuns[0]?.workspace !== undefined)).toBe(true);

    (await h.untilSpawned(1))[0].finish();
    await h.drainAllRunWork();
    const launches = h.children.length;
    const audits = remote.log.mock.calls.length;
    for (const { board, runs, row } of states) {
      expect(row.remoteProvisional).toEqual({ createdAt: row.created_at, mutationRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
      writeFileSync(h.boardPath, board);
      writeFileSync(runPath, runs);
      await expectRetracted(h, row.id, outcome.runId);
    }
    expect(h.children).toHaveLength(launches);
    expect(remote.log).toHaveBeenCalledTimes(audits);
  });
});

it("commits first launch once when multiple stages are ready", async () => {
  const h = await stageRunHarness({ observeRunWork: true, script: () => ({ ok: true }) });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const accept = vi.spyOn(h.board, "acceptProvisionalTemplateStart");
    const remote = remoteStart(h);
    const result = await remote.decide({ ...h.pinOf(version), title: "Remote work" });
    expect(result).toMatchObject({ ok: true });
    await h.untilSpawned(2);
    expect(accept).toHaveBeenCalledOnce();
    expect(remote.log).toHaveBeenCalledOnce();
  });
});

it("refuses launch when authority is revoked at the accepting board write", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  const entered = deferred<void>();
  const release = deferred<void>();
  const rewrite = storage.rewriteKeepingBytes;
  const intercept = vi.spyOn(storage, "rewriteKeepingBytes").mockImplementation(async (...args) => {
    if (args[0] === h.boardPath && args[2].didCommit) {
      entered.resolve();
      await release.promise;
    }
    return rewrite(...args);
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    const remote = remoteStart(h);
    const pending = remote.decide({ ...h.pinOf(version), title: "Remote work" });
    try {
      await Promise.race([entered.promise, pending.then(result => { throw new Error(`Start returned before accepting: ${JSON.stringify(result)}`); })]);
      expect(rows(readFileSync(h.boardPath, "utf8"))[0]).toHaveProperty("remoteProvisional");
      remote.revoke();
      release.resolve();
      expect(await pending).toMatchObject({ ok: false, error: "remote-controller-authority-revoked" });
      expect(rows(readFileSync(h.boardPath, "utf8"))).toEqual([]);
      expect(await h.board.runs.list()).toMatchObject({ status: "found", runs: [] });
      expect(h.children).toHaveLength(0);
      expect(remote.log).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      intercept.mockRestore();
      await pending;
    }
  });
});

it.each([
  { point: "repository discovery", command: ["rev-parse", "--show-toplevel"], edited: false },
  { point: "repository discovery", command: ["rev-parse", "--show-toplevel"], edited: true },
  { point: "Git setup", command: ["worktree", "add"], edited: false },
  { point: "Git setup", command: ["worktree", "add"], edited: true },
])("retracts a remote start suspended in $point (desktop edit: $edited)", async ({ command, edited }) => {
  const fixture = gitFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const git = createHostGit({ env: fixture.env });
  const run: HostGit["run"] = async (cwd, args, call) => {
    if (command.every((arg, i) => arg === args[i])) {
      entered.resolve();
      await release.promise;
      throw new Error("Initial workspace opening interrupted");
    }
    return git.run(cwd, args, call);
  };
  const { additionalDirectories } = readPermissionSettings().permissions;
  try {
    expect(ensureAveHomePrivate()).not.toMatchObject({ enforcement: "none" });
    await writePermissionSettings({ additionalDirectories: [fixture.repo] });
    let runId: string | undefined;
    const h = await stageRunHarness({ wiring: (_store, { workspace }) => {
      const provider = createStageWorkspaceProvider({ git: { ...git, run } });
      return { workspace: { ...workspace, async open(ref, root) { runId = ref.runId; return provider.open(ref, root); } } };
    } });
    await h.runThenEnd(async () => {
      const version = await h.confirm([stageOf("a")]);
      const remote = remoteStart(h);
      const pending = remote.decide({ ...h.pinOf(version), title: "Remote work", projectRoot: fixture.repo });
      try {
        await Promise.race([entered.promise, pending.then(result => { throw new Error(`Start returned before opening: ${JSON.stringify(result)}`); })]);
        const [row] = rows(readFileSync(h.boardPath, "utf8"));
        if (!row || !runId) throw new Error("Provisional start was missing");
        expect.soft(row).toHaveProperty("remoteProvisional");
        expect.soft(await h.board.list()).toMatchObject({ items: [] });
        expect(await h.start(row.id, h.local(version, fixture.repo))).toMatchObject({ status: "not_found" });
        if (edited) expect(await h.board.update(row.id, { title: "Desktop edit", priority: "high" })).toMatchObject({ status: "updated" });
        remote.revoke();
        await expectRetracted(h, row.id, runId, edited);
        expect(h.children).toHaveLength(0);
        expect(remote.log).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    });
  } finally {
    try { await writePermissionSettings({ additionalDirectories }); }
    finally { await fixture.done(); }
  }
});

// Register the orchestration awaits from row creation through first-launch acceptance.
// The replay above samples every promise continuation, including the I/O these calls await.
const span = {
  "main/tailnet-work-decisions.ts": ["start"],
  "core/work-board-engine.ts": ["runItem", "recover"],
  "main/work-board-store.ts": ["create", "beginRun", "setRunStatus", "acceptProvisionalTemplateStart", "commit", "updateRun"],
  "main/storage/feature-namespace.ts": ["writeFileAtomicAtPathIf"],
  "main/storage/rewrite-keeping-bytes.ts": ["rewriteKeepingBytes"],
  "work-board/workflow/stage-run-engine.ts": ["start", "checkStart", "beginStart", "handle", "runEffects", "writeRun", "spawnStageChild", "resolvePinned", "verdictFor", "runProjectOf"],
  "work-board/workflow/stage-workspaces.ts": ["gitProject", "openIn", "prepare", "prepareGit", "recordRegistration", "assertRepository", "repositoryMismatch", "commonDirOf", "refStoreOf", "checkOut", "prepareFolder", "usesFilter"],
} as const;

function awaitedName(node: ts.Expression): string {
  if (ts.isNewExpression(node)) return `new ${node.expression.getText()}`;
  if (ts.isCallExpression(node)) return `${awaitedName(node.expression)}()`;
  if (ts.isPropertyAccessExpression(node)) return `${awaitedName(node.expression)}.${node.name.getText()}`;
  return node.getText().replace(/\s+/gu, " ");
}

it("registers every await in the remote create-to-launch source span", () => {
  const sources = new Map(Object.keys(span).map(file => [file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")]));
  const syntax = parseSourceTexts(sources);
  const inventory: Record<string, string[]> = {};
  for (const [path, file] of syntax) {
    const owners: readonly string[] = span[path as keyof typeof span];
    const visit = (node: ts.Node, owner?: string) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && owners.includes(node.name.getText())) {
        owner = node.name.getText();
        inventory[`${path}#${owner}`] ??= [];
      }
      const awaited = ts.isAwaitExpression(node) ? node.expression
        : ts.isForOfStatement(node) && node.awaitModifier ? node.expression : undefined;
      if (owner && awaited) inventory[`${path}#${owner}`].push(awaitedName(awaited));
      node.forEachChild(child => visit(child, owner));
    };
    visit(file as ts.SourceFile);
  }
  expect(Object.entries(inventory).sort().map(([owner, awaits]) => `${owner}: ${awaits.join(", ")}`).join("\n")).toMatchInlineSnapshot(`
    "core/work-board-engine.ts#recover: store.recoverRuns()
    core/work-board-engine.ts#runItem: recover(), stageRuns.reconsider(), stageRuns.reconsider(), store.get()
    main/storage/feature-namespace.ts#writeFileAtomicAtPathIf: preparePrivateFileDirectory()
    main/storage/rewrite-keeping-bytes.ts#rewriteKeepingBytes: readAveHomeInput(), copyHolds(), writeFileAtomicAtPath().then(), writeFileAtomicAtPath()
    main/tailnet-work-decisions.ts#start: templates.get(), templates.resolveVersion(), authority.refreshCurrent(), board.create(), new Promise, board.rollbackProvisionalTemplateStart()
    main/work-board-store.ts#acceptProvisionalTemplateStart: this.ensureLoaded(), withInProcessFileQueue(), this.readBoard(), authority.refreshCurrent(), this.commit()
    main/work-board-store.ts#beginRun: this.ensureLoaded(), this.readBoard(), readBoardOnDisk(), this.runs.put(), this.commit(), this.settleUnstarted().catch(), this.pruneAfterWrite(), appendActivity()
    main/work-board-store.ts#commit: this.legacyCopyHolds(), this.runs.heldRuns(), rewriteKeepingBytes(), this.landedAnyway()
    main/work-board-store.ts#create: this.ensureLoaded(), this.legacyCopyHolds(), this.readBoard(), this.runs.issueRowId().catch(), this.commit(), appendActivity()
    main/work-board-store.ts#setRunStatus: this.ensureLoaded(), this.readBoard(), authority.refreshCurrent(), this.commit(), appendActivity()
    main/work-board-store.ts#updateRun: this.ensureLoaded(), readBoardOnDisk()
    work-board/workflow/stage-run-engine.ts#beginStart: workspace.open(), authority.refreshCurrent(), verdictFor(), records.begin(), abandonStart(), records.update(), abandonStart(), abandonStart(), store.setRunStatus(), abandonStart(), records.read().then(), enqueue().catch(), abandonStart()
    work-board/workflow/stage-run-engine.ts#checkStart: runProjectOf(), verdictFor(), resolvePinned()
    work-board/workflow/stage-run-engine.ts#handle: records.get(), hold(), unwind(), hold(), resolvePinned(), unwind(), writeRun(), hold(), unwind(), hold(), finish(), unwind(), runEffects()
    work-board/workflow/stage-run-engine.ts#resolvePinned: templates.resolveVersion()
    work-board/workflow/stage-run-engine.ts#runEffects: workspace.seal().catch(), writeRun(), deps.passConditions.evaluate(), sealStage(), sealStage(), workspace.integrate(), finish(), workspace.release().catch()
    work-board/workflow/stage-run-engine.ts#runProjectOf: deps.attachments.getAttachment()
    work-board/workflow/stage-run-engine.ts#spawnStageChild: records.get(), store.get(), resolvePinned(), verdictFor(), authorise(), workspace.release(), workspace.prepare(), authorise(), deps.lane.admit(), deps.getAgentProfile(), writeRun(), authorise(), pendingStart.acceptance, running
    work-board/workflow/stage-run-engine.ts#start: adopted(), store.get(), records.get(), checkStart(), beginStart(), firstResult()
    work-board/workflow/stage-run-engine.ts#verdictFor: templates.get(), deps.attachments.readScheduleRunAuthority(), templates.resolveVersion()
    work-board/workflow/stage-run-engine.ts#writeRun: records.update(), records.classes().catch()
    work-board/workflow/stage-workspaces.ts#assertRepository: repositoryMismatch()
    work-board/workflow/stage-workspaces.ts#checkOut: assertRepository(), driversIn(), gitIn()()
    work-board/workflow/stage-workspaces.ts#commonDirOf: gitOut()
    work-board/workflow/stage-workspaces.ts#gitProject: git.run(), git.run(), git.run(), git.run()
    work-board/workflow/stage-workspaces.ts#openIn: gitProject(), git.floorHolds(), git.drivers(), usesFilter(), commonDirOf(), refStoreOf(), chain.run.anchor(), chain.project.remove().catch(), dropPin().catch(), assertRepository(), git.run(), assertRepository(), git.run().catch(), recordRegistration(), checkOut(), gitIn()(), releaseIn().catch(), at.project.remove().catch()
    work-board/workflow/stage-workspaces.ts#prepare: removeStage(), prepareGit(), prepareFolder(), removeStage().catch()
    work-board/workflow/stage-workspaces.ts#prepareFolder: listSeedFiles(), copySeedFiles(), plain.done()
    work-board/workflow/stage-workspaces.ts#prepareGit: git.drivers(), gitOut(), assertRepository(), git.run().catch(), recordRegistration(), checkOut(), gitIn()(), held.walk().remove(), removeStage().catch()
    work-board/workflow/stage-workspaces.ts#recordRegistration: found.held.anchor(), found.worktrees.remove().catch(), dropAdminPin().catch()
    work-board/workflow/stage-workspaces.ts#refStoreOf: git.run()
    work-board/workflow/stage-workspaces.ts#repositoryMismatch: git.floorHolds(), commonDirOf().catch(), refStoreOf().catch()
    work-board/workflow/stage-workspaces.ts#usesFilter: gitOut(), gitOut()"
  `);
});
