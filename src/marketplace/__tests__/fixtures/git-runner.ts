/**
 * Test fixture: a {@link GitRunner} over the host's git with a real askpass
 * broker, an empty generated global config and Ave-owned empty directories.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskpassBroker } from "../../git/askpass.js";
import { detectGitRuntime, type GitExecutable, nodeGitDetectionDeps } from "../../git/detect.js";
import { GitRunner, type GitRunnerOptions } from "../../git/run-git.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

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
  options: { tokens?: Record<string, string>; runtime?: Pick<TestGitRunner, "git" | "broker"> } & Partial<Pick<GitRunnerOptions, "resolveProxy" | "lookup" | "readSshConfig" | "_scheduleTimeoutForTest">> = {},
): Promise<TestGitRunner> {
  if (options.runtime && options.tokens) throw new Error("a shared broker owns its token store");
  const dir = mkdtempSync(join(tmpdir(), "ave-git-runner-"));
  const emptyDir = join(dir, "empty");
  mkdirSync(emptyDir);
  const globalConfigPath = join(dir, "gitconfig");
  writeFileSync(globalConfigPath, "");
  const git = options.runtime?.git ?? await hostGitExecutable();
  const tokens = options.tokens ?? {};
  const broker = options.runtime?.broker ?? await AskpassBroker.start({ getToken: (host) => tokens[host] ?? null });
  const runner = new GitRunner({
    git,
    globalConfigPath,
    emptyDir,
    askpass: broker,
    ...(options.resolveProxy ? { resolveProxy: options.resolveProxy } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.readSshConfig ? { readSshConfig: options.readSshConfig } : {}),
    ...(options._scheduleTimeoutForTest ? { _scheduleTimeoutForTest: options._scheduleTimeoutForTest } : {}),
  });
  return {
    runner,
    broker,
    git,
    dir,
    async cleanup() {
      if (!options.runtime) await broker.close();
      await cleanupTmpDir(dir);
    },
  };
}
