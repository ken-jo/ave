import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupCommittedAveHome } from "../../../__tests__/support/committed-ave-home.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { foldCanonicalPathSeparators } from "../../../permissions/sensitive-paths.js";
import { aveHome } from "../../../shared/ave-home.js";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { runBranch, runRootOf } from "../workspace-layout.js";
import { stageOf } from "./stage-fixtures.js";
import { gitFixture } from "./stage-git-fixture.js";
import { stageRunHarness } from "./stage-run-harness.js";

setupCommittedAveHome("provisional-workspace-");

it.each([
  { title: "removes the branch after Git creates it and the host stops", point: "branch" },
  { title: "preserves an independently recreated branch at the original commit", point: "branch", replaced: true },
  { title: "retries workspace cleanup after a boot cannot verify the repository", point: "worktree" },
  { title: "retries workspace cleanup after retracting a start with a desktop edit", point: "worktree", edited: true },
  { title: "keeps the recovery root when Git cannot delete the confirmed branch", point: "worktree", refLocked: true },
] as const)("$title", async (scenario) => {
  const fixture = gitFixture();
  const { repo, userGit } = fixture;
  const git = createHostGit({ env: fixture.env });
  const reached = deferred<void>();
  const unwind = deferred<void>();
  let worktree: string | undefined;
  let unverified = false;
  let verificationFailures = 0;
  const sweepGit: HostGit["run"] = (cwd, args, call) => {
    if (unverified && args.includes("--git-common-dir")) {
      verificationFailures += 1;
      return Promise.reject(new HostGitError("timeout", "Git did not answer the common-directory query"));
    }
    return git.run(cwd, args, call);
  };
  const openingGit: HostGit["run"] = async (cwd, args, call) => {
    const result = await git.run(cwd, args, call);
    const createsBranch = args[0] === "update-ref" && args.at(-1) === "";
    const addsWorktree = args[0] === "worktree" && args[1] === "add";
    if (scenario.point === "branch" ? createsBranch : addsWorktree) {
      expect(result.code).toBe(0);
      if (addsWorktree) worktree = args.at(-2);
      reached.resolve();
      await unwind.promise;
      throw new HostGitError("terminated", "Workspace opening interrupted");
    }
    return result;
  };

  try {
    userGit(repo, "config", "core.logAllRefUpdates", "false");
    const h = await stageRunHarness({ wiring: () => ({
      workspace: createStageWorkspaceProvider({ git: { ...git, run: sweepGit } }),
    }) });
    await h.runThenEnd(async () => {
      const version = await h.confirm([stageOf("a")]);
      const canonicalRoot = realpathSync.native(repo);
      const projectRoot = foldCanonicalPathSeparators(canonicalRoot);
      const created = await h.board.create({ title: "Remote work", templateId: version.templateId, projectRoot },
        { isCurrent: () => true, refreshCurrent: async () => true });
      if (created.status !== "created" || !created.item.remoteProvisional?.workspace) throw new Error("The provisional workspace was not reserved");
      const itemId = created.itemId;
      const { runId } = created.item.remoteProvisional.workspace;
      const branch = runBranch(runId);
      const fullRef = `refs/heads/${branch}`;
      const runRoot = runRootOf(realpathSync.native(aveHome()), process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot, itemId, runId);
      const boardOnDisk = () => JSON.parse(readFileSync(h.boardPath, "utf8"));
      const branches = () => userGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
      const worktrees = () => userGit(repo, "worktree", "list", "--porcelain");
      const initial = createStageWorkspaceProvider({ git: { ...git, run: openingGit } });
      const opening = initial.open({ itemId, runId, runKey: `work-board:${itemId}#${runId}`, projectRoot }, projectRoot);
      try {
        await Promise.race([reached.promise, opening.then(result => { throw new Error(`Workspace opening returned early: ${JSON.stringify(result)}`); })]);
        expect(branches()).toContain(branch);
        expect(existsSync(runRoot)).toBe(true);
        expect(await h.board.runs.list()).toMatchObject({ status: "found", runs: [] });
        if ("replaced" in scenario) {
          const oid = userGit(repo, "rev-parse", fullRef);
          userGit(repo, "update-ref", "-d", fullRef, oid);
          userGit(repo, "update-ref", "--create-reflog", "-m", "independent creation", fullRef, oid, "");
        }
        if ("edited" in scenario) {
          expect(await h.board.update(itemId, { title: "Desktop edit" })).toMatchObject({ status: "updated" });
        }

        const expectRetracted = async () => {
          const engine = h.makeEngine();
          await engine.adoptParkedTemplateRuns();
          const items = "edited" in scenario ? [expect.objectContaining({ id: itemId, title: "Desktop edit" })] : [];
          expect(boardOnDisk().items).toEqual(items);
          expect(boardOnDisk().items[0]?.remoteProvisional).toBeUndefined();
          const listed = await h.board.list();
          expect(listed).toMatchObject({ status: "ok", items });
          if (listed.status === "ok" && listed.items.length > 0) {
            expect(listed.items[0]).not.toHaveProperty("remoteProvisional");
            expect(listed.items[0]).not.toHaveProperty("runId");
          }
          expect(await h.board.runs.list()).toMatchObject({ status: "found", runs: [] });
          expect(await engine.retryStage(itemId, { runId, stageId: "a", attempt: 1 })).toMatchObject({ ok: false });
          expect(await engine.continueRun(itemId, { runId })).toMatchObject({ ok: false });
        };

        const refLock = "refLocked" in scenario ? join(repo, ".git", `${fullRef}.lock`) : undefined;
        if (refLock !== undefined) writeFileSync(refLock, "", { flag: "wx" });
        unverified = scenario.point === "worktree" && refLock === undefined;
        await expectRetracted();
        if (unverified || refLock !== undefined) {
          expect(branches()).toContain(branch);
          expect(existsSync(runRoot)).toBe(true);
          expect(boardOnDisk().provisionalWorkspaces).toEqual({ [runId]: { itemId, projectRoot } });
          if (refLock !== undefined) {
            expect(worktrees()).not.toContain(`branch ${fullRef}`);
            unlinkSync(refLock);
          } else {
            expect(verificationFailures).toBeGreaterThan(0);
            expect(worktrees()).toContain(`branch ${fullRef}`);
            expect(worktree && existsSync(worktree)).toBe(true);
            unverified = false;
          }
          await expectRetracted();
        }

        expect(branches()).toEqual("replaced" in scenario ? [branch, "main"] : ["main"]);
        expect(worktrees().match(/^worktree /gmu)).toHaveLength(1);
        if (worktree !== undefined) expect(existsSync(worktree)).toBe(false);
        expect(existsSync(runRoot)).toBe(false);
        expect(boardOnDisk().provisionalWorkspaces).toBeUndefined();
        expect(h.children).toHaveLength(0);
      } finally {
        unwind.resolve();
        await opening;
      }
    });
  } finally {
    await fixture.done();
  }
});
