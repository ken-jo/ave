/**
 * Test fixture: a {@link GitRunner} over the host's git with a real askpass
 * broker, an empty generated global config and Ave-owned empty directories.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskpassBroker } from "../../git/askpass.js";
import { detectGitRuntime, type GitExecutable, nodeGitDetectionDeps } from "../../git/detect.js";
import { GitRunner, type GitRunnerOptions } from "../../git/run-git.js";

export interface TestGitRunner {
  runner: GitRunner;
  broker: AskpassBroker;
  git: GitExecutable;
  dir: string;
  cleanup(): Promise<void>;
}

export async function hostGitExecutable(): Promise<GitExecutable> {
  const detection = await detectGitRuntime("system", nodeGitDetectionDeps(async () => null));
  if (detection.state !== "ready") throw new Error(`host git is not usable for tests: ${detection.state}`);
  return detection.git;
}

export async function createTestGitRunner(
  options: { tokens?: Record<string, string> } & Partial<Pick<GitRunnerOptions, "resolveProxy">> = {},
): Promise<TestGitRunner> {
  const dir = mkdtempSync(join(tmpdir(), "ave-git-runner-"));
  const emptyDir = join(dir, "empty");
  mkdirSync(emptyDir);
  const globalConfigPath = join(dir, "gitconfig");
  writeFileSync(globalConfigPath, "");
  const git = await hostGitExecutable();
  const tokens = options.tokens ?? {};
  const broker = await AskpassBroker.start({ getToken: (host) => tokens[host] ?? null });
  const runner = new GitRunner({
    git,
    globalConfigPath,
    emptyDir,
    askpass: broker,
    ...(options.resolveProxy ? { resolveProxy: options.resolveProxy } : {}),
  });
  return {
    runner,
    broker,
    git,
    dir,
    async cleanup() {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
