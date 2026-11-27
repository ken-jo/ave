import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { WINDOWS_MEMORY_CLASS_A_FILES } from "./support/windows-memory-class-a.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function resolveCommit(...args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveMainBaseline(): string {
  const originMain = resolveCommit("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
  if (originMain) return originMain;

  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Cannot resolve origin/main for the Class A gate. The CI checkout must fetch refs/remotes/origin/main.");
  }

  const mergeBase = resolveCommit("merge-base", "HEAD", "refs/heads/main");
  if (mergeBase) return mergeBase;
  throw new Error("Cannot resolve origin/main or a main merge base for the Class A gate");
}

let baseline: string;
beforeAll(() => {
  baseline = resolveMainBaseline();
});

it.each(WINDOWS_MEMORY_CLASS_A_FILES)("keeps %s byte-identical to main", file => {
  const mainBlob = execFileSync("git", ["-C", ROOT, "cat-file", "blob", `${baseline}:${file}`]);
  expect(readFileSync(join(ROOT, file)).equals(mainBlob), `${file} differs from main (${baseline})`).toBe(true);
});
