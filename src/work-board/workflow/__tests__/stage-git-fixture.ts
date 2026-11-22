import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostGit } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider, type StageWorkspaceOptions } from "../stage-workspaces.js";
import { stageOf, writeUnder } from "./stage-fixtures.js";

export interface GitHandle { provider: ReturnType<typeof createStageWorkspaceProvider>; run: RunRef }
export interface GitFixture {
  base: string;
  /** A repository with one commit on `main` holding `a.txt` and `b.txt`. */
  repo: string;
  env: NodeJS.ProcessEnv;
  /** Plain git, the way the user would run it: hooks and drivers active. */
  userGit(cwd: string, ...args: string[]): string;
  commitAll(message: string): string;
  /** A provider and a run of its own; `release(run, "all")` follows in `done`. */
  start(options?: StageWorkspaceOptions, itemId?: number): GitHandle;
  done(): Promise<void>;
}

let runs = 0;

export function gitFixture(): GitFixture {
  const base = mkdtempSync(join(tmpdir(), "swg-"));
  const repo = join(base, "project");
  mkdirSync(repo);
  writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const opened: GitHandle[] = [];
  const userGit = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commitAll = (message: string): string => { userGit(repo, "add", "-A"); userGit(repo, "commit", "-q", "-m", message); return userGit(repo, "rev-parse", "HEAD"); };
  userGit(repo, "init", "-q");
  userGit(repo, "config", "user.name", "Alice Example");
  userGit(repo, "config", "user.email", "alice@example.com");
  writeUnder(repo, "a.txt", "one\n");
  writeUnder(repo, "b.txt", "one\n");
  commitAll("first");
  return {
    base, repo, env, userGit, commitAll,
    start: (options = {}, itemId = 7) => {
      runs += 1;
      const handle = { provider: createStageWorkspaceProvider({ git: createHostGit({ env }), ...options }), run: { itemId, runId: `run-git-${process.pid}-${Date.now()}-${runs}`, runKey: "key" } };
      opened.push(handle);
      return handle;
    },
    done: async () => { for (const { provider, run } of opened.splice(0)) await provider.release(run, "all"); },
  };
}

export async function stageRoot(handle: GitHandle, stageId: string, attempt = 1): Promise<string> {
  const prepared = await handle.provider.prepare(handle.run, stageOf(stageId), attempt);
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  return prepared.workspace.root;
}

export async function sealed(handle: GitHandle, stageId: string): Promise<string | undefined> {
  const result = await handle.provider.seal(handle.run, stageId);
  if (!result.ok) throw new Error(`seal refused: ${result.code}`);
  return result.sealCommit;
}
