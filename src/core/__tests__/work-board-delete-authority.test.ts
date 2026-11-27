import { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import * as hostGitLaunch from "../../shared/host-git.js";
import { discoverHostGitAsync } from "../../shared/host-git-executable.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { fixturePushRemote, gitFixture } from "../../work-board/workflow/__tests__/stage-git-fixture.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { configuredWorkflowPush, createHostGit, executeWorkflowPush, type HostGit } from "../../work-board/workflow/host-git.js";
import { runBranch } from "../../work-board/workflow/workspace-layout.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Whether the board file on disk lists the row `itemId`. */
const listsRow = (boardPath: string, itemId: number): boolean =>
  (JSON.parse(readFileSync(boardPath, "utf8")) as { items: { id: number }[] }).items.some(item => item.id === itemId);

/** A template run whose one stage is live, with the run id its row names. */
async function liveRun() {
  const h = await stageRunHarness({ observeRunWork: true });
  cleanups.push(async () => {
    await h.drainRunWork();
    await h.cleanup();
  });
  const version = await h.confirm([stageOf("review")]);
  const itemId = await h.addItem(version);
  const started = h.start(itemId, h.local(version));
  cleanups.push(async () => { await started.catch(() => undefined); });
  await h.untilLive(1);
  const { runId } = await h.item(itemId);
  if (!runId) throw new Error("Missing run id");
  return { h, itemId, runId, boardPath: join(h.dir, "board.json") };
}

it("revokes a run's authority before its row's deleting write returns, so a push released then spawns nothing", async () => {
  const { h, itemId, runId, boardPath } = await liveRun();
  const fixture = gitFixture();
  cleanups.push(() => fixture.done());
  const receiver = join(fixture.base, "endpoint.git");
  const remote = fixturePushRemote(fixture, receiver);
  fixture.userGit(fixture.base, "init", "-q", "--bare", receiver);
  fixture.userGit(fixture.repo, "update-ref", `refs/heads/${runBranch(runId)}`, "HEAD");
  fixture.userGit(fixture.repo, "remote", "add", "origin", remote);
  const bound = await configuredWorkflowPush(createHostGit({ env: fixture.env }), fixture.repo, runId, { remote: "origin" });
  if (!("binding" in bound)) throw new Error("Expected an approved push binding");

  // The push is prepared and waits in the launcher, past every check before the spawn.
  const { git } = await discoverHostGitAsync(null);
  if (git === null) throw new Error("expected fixture git");
  const discovering = deferred<void>();
  const launch = deferred<void>();
  let holdNext = false;
  const paused = createHostGit({ env: fixture.env, resolve: async use => {
    if (holdNext) {
      holdNext = false;
      discovering.resolve();
      await launch.promise;
    }
    return use({ path: git.path, identity: git.identity });
  } });
  const runner: HostGit = { ...paused, run: (cwd, gitArgs, call) => {
    if (gitArgs[0] === "push") holdNext = true;
    return paused.run(cwd, gitArgs, call);
  } };
  const spawn = vi.spyOn(hostGitLaunch, "spawnHostGitIfWorkspaceFree");
  const authority = h.board.runAuthority(itemId, runId);
  const pushed = executeWorkflowPush(runner, fixture.repo, runId, { ...bound.binding }, () => true, authority);
  await discovering.promise;

  // The board's directory close is held after a successful sync, once the renamed board no longer lists the row.
  const closing = deferred<void>();
  const held = deferred<void>();
  const open = fsPromises.open.bind(fsPromises);
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await open(...args);
    if (args[0] !== dirname(boardPath) || args[1] !== "r") return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      if (!listsRow(boardPath, itemId)) {
        held.resolve();
        await closing.promise;
      }
      return close();
    };
    return handle;
  });
  const removing = h.board.remove(itemId);
  await held.promise;
  try {
    expect(listsRow(boardPath, itemId)).toBe(false);
    expect(authority.aborted).toBe(true);
    expect(h.board.admitsRunEffect(itemId, runId)).toBe(false);
    launch.resolve();
    await expect(pushed).resolves.toEqual({ status: "failed", detail: "output-execution-interrupted" });
    expect(spawn.mock.calls.filter(([, , launched]) => launched.includes("push"))).toEqual([]);
    expect(fixture.userGit(receiver, "for-each-ref", "--format=%(refname)")).toBe("");
  } finally {
    launch.resolve();
    closing.resolve();
  }
  await expect(removing).resolves.toMatchObject({ status: "deleted" });
});

it("a delete whose board write fails leaves its row with the run revoked and stopped", async () => {
  const { h, itemId, runId, boardPath } = await liveRun();
  const authority = h.board.runAuthority(itemId, runId);
  const rename = fsPromises.rename.bind(fsPromises);
  const renames = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    if (to === boardPath) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return rename(from, to);
  });
  await expect(h.board.remove(itemId)).rejects.toThrow("no space left on device");
  renames.mockRestore();
  expect(listsRow(boardPath, itemId)).toBe(true);
  expect(authority.aborted).toBe(true);
  expect(h.board.admitsRunEffect(itemId, runId)).toBe(false);
  // The run is stopped as by Stop, not left live without authority.
  await h.until(itemId, row => row.runStatus === "cancelled");
  expect(h.board.runAuthority(itemId, runId).aborted).toBe(true);
});
