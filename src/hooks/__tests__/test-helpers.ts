import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiscoveredHook } from "../hook-discovery.js";

// Interpreter-dependent fixtures skip when the binary cannot answer --version on PATH.
export function hasExecutable(binary: string): boolean {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function writeJsonConfig(configPath: string, obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

export function writeExecutableHook(
  hooksDir: string,
  name: string,
  body = "#!/bin/sh\necho '{}'\n",
): void {
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o700);
}

export function fixtureHook(
  fixtureRoot: string,
  fileName: string,
  type: "pre" | "post" | "perm" = "pre",
): DiscoveredHook {
  return {
    path: resolve(fixtureRoot, fileName),
    fileName,
    hookType: type,
    sha256: "test",
    size: 0,
  };
}

export interface HookDirLayout {
  hooksDir: string;
  disabledDir: string;
  lockfilePath: string;
}

export function hookDirLayout(tmpDir: string): HookDirLayout {
  const hooksDir = join(tmpDir, "hooks");
  return {
    hooksDir,
    disabledDir: join(hooksDir, ".disabled"),
    lockfilePath: join(hooksDir, ".lockfile.json"),
  };
}

// The repo's checked-in hook fixture tree, the root every hook suite spawns from.
export const REPO_HOOK_FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");

export function repoFixtureHook(
  fileName: string,
  type: "pre" | "post" | "perm" = "pre",
): DiscoveredHook {
  return fixtureHook(REPO_HOOK_FIXTURE_ROOT, fileName, type);
}
