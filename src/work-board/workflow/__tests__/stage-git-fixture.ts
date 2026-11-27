import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { createHostGit, type HostGit } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider, type StageWorkspaceOptions } from "../stage-workspaces.js";
import { removeTree, stageOf, writeUnder } from "./stage-fixtures.js";

export interface GitHandle { provider: ReturnType<typeof createStageWorkspaceProvider>; run: RunRef }
export interface GitFixture {
  base: string;
  /** A repository with one commit on `main` holding `a.txt` and `b.txt`. */
  repo: string;
  env: NodeJS.ProcessEnv;
  git: HostGit;
  /** Plain git, the way the user would run it: hooks and drivers active. */
  userGit(cwd: string, ...args: string[]): string;
  commitAll(message: string): string;
  /** A provider and a run of its own, open on `project` (the repository unless given); `release(run, "all")` follows in `done`. */
  start(options?: StageWorkspaceOptions, itemId?: number, project?: string): GitHandle;
  done(): Promise<void>;
}

let runs = 0;

export function gitFixture(): GitFixture {
  return makeGitFixture();
}

/** Each case gets its own copy of the unmodified seed repository. The Git client and its global config are shared. */
export function seedGitFixtures(): () => GitFixture {
  let seed: GitFixture;
  beforeAll(() => { seed = makeGitFixture(); });
  afterAll(() => seed?.done());
  return () => makeGitFixture(seed);
}

function makeGitFixture(seed?: GitFixture): GitFixture {
  const base = mkdtempSync(join(tmpdir(), "swg-"));
  try {
    return madeIn(base, seed);
  } catch (error) {
    // No caller has the fixture yet, so what was made of it goes here. A removal that fails too is told along with the failure.
    try { removeTree(base); } catch (cleanup) { throw new AggregateError([error, cleanup], `a git fixture could not be made, and what was made of it stays: ${base}`); }
    throw error;
  }
}

function madeIn(base: string, seed?: GitFixture): GitFixture {
  const repo = join(base, "project");
  const config = join(base, "gitconfig");
  const env = seed?.env ?? { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const git = seed?.git ?? createHostGit({ env });
  const opened: GitHandle[] = [];
  const userGit = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commitAll = (message: string): string => { userGit(repo, "add", "-A"); userGit(repo, "commit", "-q", "-m", message); return userGit(repo, "rev-parse", "HEAD"); };
  if (seed === undefined) {
    mkdirSync(repo);
    writeFileSync(config, "[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
    userGit(repo, "init", "-q");
    userGit(repo, "config", "user.name", "Alice Example");
    userGit(repo, "config", "user.email", "alice@example.com");
    writeUnder(repo, "a.txt", "one\n");
    writeUnder(repo, "b.txt", "one\n");
    commitAll("first");
  } else {
    cpSync(seed.repo, repo, { recursive: true });
  }
  return {
    base, repo, env, git, userGit, commitAll,
    start: (options = {}, itemId = 7, project = repo) => {
      runs += 1;
      const handle = { provider: createStageWorkspaceProvider({ git, ...options }), run: { itemId, runId: `run-git-${process.pid}-${Date.now()}-${runs}`, runKey: "key", projectRoot: project } };
      opened.push(handle);
      return handle;
    },
    done: async () => {
      for (const { provider, run } of opened.splice(0)) await provider.release(run, "all");
      removeTree(base);
    },
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
