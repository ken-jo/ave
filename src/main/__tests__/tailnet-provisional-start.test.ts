import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript/unstable/ast";
import { expect, it, vi } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { setupCommittedAveHome } from "../../__tests__/support/committed-ave-home.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import * as atomicFile from "../../lib/atomic-file.js";
import { ensureAveHomePrivate } from "../../shared/ave-home.js";
import type { TailnetWorkDecisionRequest } from "../../shared/tailnet-work-decisions.js";
import type { WorkItem } from "../../shared/work-board-types.js";
import { createHostGit, type HostGit } from "../../work-board/workflow/host-git.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";
import { runBranch } from "../../work-board/workflow/workspace-layout.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { gitFixture } from "../../work-board/workflow/__tests__/stage-git-fixture.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { readPermissionSettings, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { RoutinesStore } from "../routines-store.js";
import * as featureStorage from "../storage/feature-namespace.js";
import * as storage from "../storage/rewrite-keeping-bytes.js";
import { createTailnetWorkDecisions } from "../tailnet-work-decisions.js";

setupCommittedAveHome("tailnet-provisional-start-");

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

it.each(["guarded writer", "atomic replacement"])("accepts a landed launch write at the %s and adopts it without launching twice", async boundary => {
  let launches = 0;
  const h = await stageRunHarness({ observeRunWork: true, onSpawn: () => { launches += 1; } });
  const write = featureStorage.writeFileAtomicAtPathIf;
  const replace = atomicFile.replaceUtf8FileAtomicSyncIf;
  let injected = false;
  let launchesAfterReplacement: number | undefined;
  function directorySyncFault(): never {
    injected = true;
    throw atomicFile.committedDirectorySyncError(Object.assign(new Error("Directory sync fault"), { code: "EIO" }));
  }
  const fault = boundary === "guarded writer"
    ? vi.spyOn(featureStorage, "writeFileAtomicAtPathIf").mockImplementation(async (path, body, check, didCommit) => {
      if (path !== h.boardPath || !didCommit) return write(path, body, check, didCommit);
      expect(await write(path, body, check)).toBe(true);
      directorySyncFault();
    })
    : vi.spyOn(atomicFile, "replaceUtf8FileAtomicSyncIf").mockImplementation((...args) => {
      const [path, body] = args;
      const committed = replace(...args);
      const row = path === h.boardPath ? rows(body)[0] : undefined;
      if (!committed || injected || row?.runId === undefined || row.remoteProvisional) return committed;
      queueMicrotask(() => { launchesAfterReplacement = launches; });
      directorySyncFault();
    });
  try {
    await h.runThenEnd(async () => {
      const version = await h.confirm([stageOf("a")]);
      const remote = remoteStart(h);
      const result = await remote.decide({ ...h.pinOf(version), title: "Remote work" });
      expect(injected).toBe(true);
      expect(result).toMatchObject({ ok: true, kind: "create-and-run" });
      if (!result.ok || result.kind !== "create-and-run") throw new Error("Committed launch was refused");
      if (boundary === "atomic replacement") expect(launchesAfterReplacement).toBe(1);
      expect(h.children).toHaveLength(1);
      expect(remote.log).toHaveBeenCalledOnce();
      expect(h.board.hasActiveProvisionalStart(result.itemId)).toBe(false);
      const [row] = rows(readFileSync(h.boardPath, "utf8"));
      expect(row).toMatchObject({ id: result.itemId, runId: result.runId });
      expect(row?.remoteProvisional).toBeUndefined();

      await h.makeEngine().adoptParkedTemplateRuns();
      expect(await h.board.list()).toMatchObject({ items: [{ id: result.itemId, runId: result.runId }] });
      expect(h.children).toHaveLength(1);
      expect(remote.log).toHaveBeenCalledOnce();
    });
  } finally { fault.mockRestore(); }
});

it("retracts a provisional create in the same process when the activity log fails", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    const remote = remoteStart(h);
    const landed: number[] = [];
    const unsubscribe = h.board.boardChanged.subscribe(() => {
      const row = rows(readFileSync(h.boardPath, "utf8"))[0];
      if (row?.remoteProvisional) landed.push(row.id);
    });
    try {
      mkdirSync(join(h.dir, "activity.jsonl"));
      await expect(remote.decide({ ...h.pinOf(version), title: "Remote work" })).rejects.toThrow();
      expect(landed).toEqual([expect.any(Number)]);
      expect(rows(readFileSync(h.boardPath, "utf8"))).toEqual([]);
      expect(h.board.hasActiveProvisionalStart(landed[0])).toBe(false);
      expect(h.children).toHaveLength(0);
      expect(remote.log).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});

it.each(["create", "store run", "link run", "show execution", "store workspace", "prepare stage", "retract"] as const)(
  "keeps an unaccepted start retracted after a landed %s write reports failure", async phase => {
    const h = await stageRunHarness({ observeRunWork: true });
    const rewrite = storage.rewriteKeepingBytes;
    let injected = false;
    let itemId: number | undefined;
    const fault = vi.spyOn(storage, "rewriteKeepingBytes").mockImplementation(async (...args) => {
      const [path, body] = args;
      const committed = await rewrite(...args);
      const isBoard = path === h.boardPath;
      const items = isBoard ? rows(body) : [];
      const row = items[0];
      if (row?.remoteProvisional) itemId = row.id;
      const run = path === join(h.dir, "workflow-runs.json") ? JSON.parse(body).runs[0] : undefined;
      const matches = phase === "retract" ? isBoard && itemId !== undefined && items.length === 0
        : phase === "store run" ? run !== undefined
        : phase === "store workspace" ? run?.runWorkspace !== undefined
        : phase === "prepare stage" ? run?.stageRuns.some((stage: { workspace?: unknown }) => stage.workspace !== undefined)
        : row?.remoteProvisional && (phase === "create" ? row.runId === undefined
          : phase === "link run" ? row.runStatus === "planning" : row.runStatus === "executing");
      if (committed && matches && !injected) {
        injected = true;
        throw atomicFile.committedDirectorySyncError(new Error("Directory sync fault"));
      }
      return committed;
    });
    try {
      await h.runThenEnd(async () => {
        const version = await h.confirm([stageOf("a")]);
        const remote = remoteStart(h);
        if (phase === "retract") mkdirSync(join(h.dir, "activity.jsonl"));
        const attempt = remote.decide({ ...h.pinOf(version), title: "Remote work" });
        if (phase === "create" || phase === "retract") await expect(attempt).rejects.toThrow();
        else expect(await attempt).toMatchObject({ ok: false });
        if (phase === "retract") await expect(attempt).rejects.not.toMatchObject({ committed: true });
        expect(injected).toBe(true);
        expect(rows(readFileSync(h.boardPath, "utf8"))).toEqual([]);
        expect(await h.board.runs.list()).toMatchObject({ status: "found", runs: [] });
        if (itemId === undefined) throw new Error("Provisional row was not written");
        expect(h.board.hasActiveProvisionalStart(itemId)).toBe(false);
        expect(h.children).toHaveLength(0);
        expect(remote.log).not.toHaveBeenCalled();
      });
    } finally { fault.mockRestore(); }
  },
);

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
  const addsWorktree = command[0] === "worktree";
  let worktreePath: string | undefined;
  const run: HostGit["run"] = async (cwd, args, call) => {
    if (command.every((arg, i) => arg === args[i])) {
      if (addsWorktree) {
        expect((await git.run(cwd, args, call)).code).toBe(0);
        worktreePath = args.at(-2);
      }
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
      return { workspace: {
        ...workspace,
        async open(ref, root) { runId = ref.runId; return provider.open(ref, root); },
        async sweep(active, projects, recovery) { await workspace.sweep(active, projects); await provider.sweep(active, projects, recovery); },
      } };
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
        const branch = runBranch(runId);
        const branches = () => fixture.userGit(fixture.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads");
        const worktrees = () => fixture.userGit(fixture.repo, "worktree", "list", "--porcelain");
        if (addsWorktree) {
          expect(row.remoteProvisional?.workspace).toEqual({ runId, projectRoot: fixture.repo });
          expect(worktreePath && existsSync(worktreePath)).toBe(true);
          expect(branches().split("\n")).toContain(branch);
          expect(worktrees()).toContain(`branch refs/heads/${branch}`);
          expect(await h.board.runs.list()).toMatchObject({ status: "found", runs: [] });
        }
        expect(await h.start(row.id, h.local(version, fixture.repo))).toMatchObject({ status: "not_found" });
        if (edited) expect(await h.board.update(row.id, { title: "Desktop edit", priority: "high" })).toMatchObject({ status: "updated" });
        remote.revoke();
        await expectRetracted(h, row.id, runId, edited);
        if (addsWorktree) {
          expect(branches()).toBe("main");
          expect(worktrees().match(/^worktree /gmu)).toHaveLength(1);
          expect(worktreePath && existsSync(worktreePath)).toBe(false);
        }
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

// Inventory whole owner files so new helpers and callbacks enter the guard without a name allow-list.
const OWNER_FILES = [
  "main/tailnet-work-decisions.ts",
  "core/work-board-engine.ts",
  "main/work-board-store.ts",
  "main/workflow-run-store.ts",
  "main/storage/feature-namespace.ts",
  "main/storage/rewrite-keeping-bytes.ts",
  "work-board/activity-log.ts",
  "work-board/workflow/run-state.ts",
  "work-board/workflow/stage-run-engine.ts",
  "work-board/workflow/stage-workspaces.ts",
] as const;

function awaitedName(node: ts.Expression): string {
  if (ts.isNewExpression(node)) return `new ${node.expression.getText()}`;
  if (ts.isCallExpression(node)) return `${awaitedName(node.expression)}()`;
  if (ts.isPropertyAccessExpression(node)) return `${awaitedName(node.expression)}.${node.name.getText()}`;
  return node.getText().replace(/\s+/gu, " ");
}

function ownerSources() {
  return new Map(OWNER_FILES.map(file => [file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")]));
}

function awaitInventory(sources: ReadonlyMap<string, string>): string {
  const syntax = parseSourceTexts(sources);
  expect([...syntax.keys()].sort()).toEqual([...sources.keys()].sort());
  const inventory = new Map<string, string[]>();
  for (const [path, file] of syntax) {
    const visit = (node: ts.Node, owner = "<module>") => {
      if (ts.isFunctionLikeDeclaration(node)) owner = functionBinding(node) ?? owner;
      const awaited = ts.isAwaitExpression(node) ? node.expression
        : ts.isForOfStatement(node) && node.awaitModifier ? node.expression : undefined;
      if (awaited) {
        const key = `${path}#${owner}`;
        const entries = inventory.get(key) ?? [];
        entries.push(awaitedName(awaited));
        inventory.set(key, entries);
      }
      node.forEachChild(child => visit(child, owner));
    };
    visit(file as ts.SourceFile);
  }
  return [...inventory].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([owner, awaits]) => `${owner}: ${awaits.join(", ")}`).join("\n");
}

function functionBinding(node: ts.FunctionLikeDeclaration): string | undefined {
  if ("name" in node && node.name) return node.name.getText();
  for (let parent = node.parent; parent && !ts.isFunctionLikeDeclaration(parent); parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText();
    if (ts.isStatement(parent)) break;
  }
  // An inline callback belongs to the nearest enclosing named binding.
  return undefined;
}

it.each([
  ["beginStart", /(async function beginStart[^\n]+\{)/u],
  ["adopted", /(const adopted = async [^\n]+\{)/u],
] as const)("detects a new await inside %s", (binding, opening) => {
  const path = "work-board/workflow/stage-run-engine.ts";
  const sources = ownerSources();
  const original = sources.get(path);
  if (!original) throw new Error(`Missing source ${path}`);
  const mutated = original.replace(opening, "$1\n    await Promise.resolve();");
  expect(mutated).not.toBe(original);
  const before = awaitInventory(sources);
  sources.set(path, mutated);
  const after = awaitInventory(sources);
  expect(after).not.toBe(before);
  expect(after.split("\n").find(line => line.startsWith(`${path}#${binding}: `))).toContain("Promise.resolve()");
});

it("registers every await in the remote create-to-launch source span", () => {
  expect(awaitInventory(ownerSources())).toMatchSnapshot();
});
