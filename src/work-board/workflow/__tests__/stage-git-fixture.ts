import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { shellQuote } from "../../../lib/shell-resolver.js";
import { createHostGit } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider, type StageWorkspaceOptions } from "../stage-workspaces.js";
import { removeTree, stageOf, writeUnder } from "./stage-fixtures.js";

export interface GitHandle { provider: ReturnType<typeof createStageWorkspaceProvider>; run: RunRef }
export interface GitFixture {
  base: string;
  /** A repository with one commit on `main` holding `a.txt` and `b.txt`. */
  repo: string;
  env: NodeJS.ProcessEnv;
  /** Plain git, the way the user would run it: hooks and drivers active. */
  userGit(cwd: string, ...args: string[]): string;
  commitAll(message: string): string;
  /** A provider and a run of its own, open on `project` (the repository unless given); `release(run, "all")` follows in `done`. */
  start(options?: StageWorkspaceOptions, itemId?: number, project?: string): GitHandle;
  done(): Promise<void>;
}

let runs = 0;

export function gitFixture(): GitFixture {
  const base = mkdtempSync(join(tmpdir(), "swg-"));
  try {
    return madeIn(base);
  } catch (error) {
    // No caller has the fixture yet, so what was made of it goes here. A removal that fails too is told along with the failure.
    try { removeTree(base); } catch (cleanup) { throw new AggregateError([error, cleanup], `a git fixture could not be made, and what was made of it stays: ${base}`); }
    throw error;
  }
}

function madeIn(base: string): GitFixture {
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
    start: (options = {}, itemId = 7, project = repo) => {
      runs += 1;
      const handle = { provider: createStageWorkspaceProvider({ git: createHostGit({ env }), ...options }), run: { itemId, runId: `run-git-${process.pid}-${Date.now()}-${runs}`, runKey: "key", projectRoot: project } };
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

// Run the real Git receive protocol through a fixture SSH command without contacting a network host.
export function fixturePushRemote(fixture: GitFixture, receiver: string): string {
  const helper = join(fixture.base, "fixture-ssh.cjs");
  writeFileSync(helper, String.raw`
    const { spawnSync } = require("node:child_process");
    const { join } = require("node:path");
    const match = /^git-receive-pack '\/([a-z-]+\.git)'$/.exec(process.argv.at(-1));
    if (!match) process.exit(1);
    const child = spawnSync("git", ["receive-pack", join(__dirname, match[1])], { stdio: "inherit" });
    process.exit(child.status ?? 1);
  `);
  const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? "node";
  fixture.env.GIT_SSH_COMMAND = `${shellQuote(node)} ${shellQuote(helper)}`;
  fixture.env.GIT_SSH_VARIANT = "simple";
  return `ssh://example.test/${basename(receiver)}`;
}
