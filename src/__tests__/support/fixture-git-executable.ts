import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";
import { buildSafeChildEnv } from "../../tools/safe-env.js";

const DEFAULT_FIXTURE_GIT = {
  win32: "C:\\Program Files\\Git\\cmd\\git.exe",
  darwin: "/Library/Developer/CommandLineTools/usr/bin/git",
  linux: "/usr/bin/git",
} as Partial<Record<NodeJS.Platform, string>>;

export function requireFixtureGit(spawn = spawnSync) {
  const pathApi = process.platform === "win32" ? win32 : posix;
  const configured = process.env.AVE_TEST_GIT_EXECUTABLE ?? DEFAULT_FIXTURE_GIT[process.platform];
  if (!configured || !pathApi.isAbsolute(configured)) throw new Error("Set AVE_TEST_GIT_EXECUTABLE to an absolute Git executable");
  const path = pathApi.normalize(configured);
  const options = {
    env: buildSafeChildEnv({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_ALLOW_PROTOCOL: "file",
    }),
    encoding: "utf8" as const,
  };
  const capability = spawn(path, ["--no-lazy-fetch", "--version"], options);
  if (capability.status !== 0 || !capability.stdout?.startsWith("git version ")) {
    throw new Error("Set AVE_TEST_GIT_EXECUTABLE to an absolute Git executable with --no-lazy-fetch support");
  }
  return { path, options };
}
