// Published terminal helpers may lack execute bits; restore them after installation.
// Native prebuild installation does not repair those modes.
import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findSpawnHelpers(ptyRoot) {
  const helpers = [];
  const prebuilds = path.join(ptyRoot, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const helper = path.join(prebuilds, entry.name, "spawn-helper");
      if (existsSync(helper)) helpers.push(helper);
    }
  }
  const built = path.join(ptyRoot, "build", "Release", "spawn-helper");
  if (existsSync(built)) helpers.push(built);
  return helpers.sort();
}

export function nonExecutableSpawnHelpers(ptyRoot) {
  return findSpawnHelpers(ptyRoot).filter((helper) => {
    try {
      accessSync(helper, constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
}

// Preserve other mode bits and fail if a helper remains non-executable.
export function restoreSpawnHelperExecBit(ptyRoot, { platform = process.platform } = {}) {
  if (platform === "win32") return [];
  const changed = [];
  for (const helper of nonExecutableSpawnHelpers(ptyRoot)) {
    chmodSync(helper, statSync(helper).mode | 0o111);
    changed.push(helper);
  }
  const still = nonExecutableSpawnHelpers(ptyRoot);
  if (still.length > 0) {
    throw new Error(`node-pty spawn-helper is still not executable: ${still.join(", ")}`);
  }
  return changed;
}

function main() {
  const ptyRoot = path.join(PROJECT_ROOT, "node_modules", "node-pty");
  if (!existsSync(path.join(ptyRoot, "package.json"))) {
    throw new Error(`node-pty is not installed at ${ptyRoot}; it is a runtime dependency of the terminal`);
  }
  const changed = restoreSpawnHelperExecBit(ptyRoot);
  for (const helper of changed) {
    console.log(`[node-pty] restored execute bit: ${path.relative(PROJECT_ROOT, helper)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[node-pty] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
