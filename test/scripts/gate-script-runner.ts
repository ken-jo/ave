import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Run gates as child processes to verify exit codes and operator output.
// AVE_TEST_NODE_EXEC_PATH selects a plain interpreter when the suite runtime is not one.
export function runGateScript(
  scriptPath: string,
  root: string,
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const nodeCommand = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
  return spawnSync(nodeCommand, [scriptPath, "--root", root], {
    cwd: process.cwd(),
    encoding: "utf-8",
    ...(env ? { env } : {}),
  });
}

export function writeFixtureFile(root: string, rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

// Package exports expose only the library; resolve the CLI through its bin metadata.
// Real fixture archives preserve the packaged header and unpacked-sidecar layout.
export function asarCliPath(): string {
  const libraryEntry = createRequire(import.meta.url).resolve("@electron/asar");
  for (let directory = dirname(libraryEntry); directory !== dirname(directory); directory = dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: string; bin?: string | Record<string, string> };
    if (manifest.name !== "@electron/asar") continue;
    // Package bin metadata may be a string or a name-to-path map.
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.asar;
    if (typeof bin !== "string") throw new Error(`@electron/asar at ${directory} declares no "asar" bin`);
    return join(directory, bin);
  }
  throw new Error(`no @electron/asar package.json above ${libraryEntry}`);
}
