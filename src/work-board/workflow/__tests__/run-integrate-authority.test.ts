import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { createHostGit, type HostGit } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { removeTree, stageOf, writeUnder as write } from "./stage-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("a queued integration whose run authority is revoked before it starts collects nothing", async () => {
  const base = mkdtempSync(join(tmpdir(), "ria-"));
  const project = join(base, "project");
  mkdirSync(project);
  writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  write(project, "notes.txt", "notes\n");
  write(project, ".gitignore", "ignored.txt\n");
  const real = createHostGit({ env });
  const held = deferred<void>();
  const holding = deferred<void>();
  let hold = false;
  const git: HostGit = { ...real, run: async (cwd, args, call) => {
    if (hold) {
      hold = false;
      holding.resolve();
      await held.promise;
    }
    return real.run(cwd, args, call);
  } };
  const run: RunRef = { itemId: 7, runId: `run-authority-${process.pid}-${Date.now()}`, runKey: "key", projectRoot: project };
  const provider = createStageWorkspaceProvider({ plainCeiling: base, git });
  cleanups.push(async () => {
    held.resolve();
    await provider.release(run, "all");
    removeTree(base);
  });
  const opened = await provider.open(run, project);
  if (!opened.ok || opened.workspace.kind !== "folder" || opened.workspace.outputDir === undefined) throw new Error("expected a folder workspace");
  const out = opened.workspace.outputDir;
  const prepared = await provider.prepare(run, stageOf("s1", { outputs: ["plan.md"] }), 1);
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  write(prepared.workspace.root, "plan.md", "the plan\n");
  expect(await provider.seal(run, "s1")).toEqual({ ok: true });

  // Another call of the run holds the run's queue; the integration waits behind it.
  hold = true;
  const preparing = provider.prepare(run, stageOf("s2", { inputFiles: [{ from: "project", paths: ["notes.txt"] }] }), 1);
  await Promise.race([holding.promise, preparing.then(() => { throw new Error("the held call never reached git"); })]);
  const authority = new AbortController();
  const integrated = provider.integrate(run, "j1", ["s1"], authority.signal);
  authority.abort(new Error("the run was stopped"));
  held.resolve();
  await preparing;
  await expect(integrated).rejects.toThrow("the run was stopped");
  expect(existsSync(join(out, "plan.md"))).toBe(false);

  // The same join with standing authority collects the sealed file.
  expect(await provider.integrate(run, "j1", ["s1"], new AbortController().signal)).toEqual({ ok: true });
  expect(existsSync(join(out, "plan.md"))).toBe(true);
});
