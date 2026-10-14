/**
 * restore-node-pty-exec-bit.mjs — make node-pty's `spawn-helper` executable
 * after install.
 *
 * node-pty forks `spawn-helper` to give the shell its controlling TTY. The
 * published tarball stores `prebuilds/<platform>-<arch>/spawn-helper` as mode
 * 0644 (the file modes are in the tarball itself; the extractor only preserves
 * them), and node-pty's own install scripts restore nothing because they use
 * the prebuild as shipped. A fresh install therefore leaves the helper
 * non-executable, and every terminal spawn fails with `posix_spawnp failed`.
 *
 * Packaging already sets and asserts the bit on the packaged copy
 * (`assertNodePtyBinary` in electron-after-pack.cjs). This is the same repair
 * for the installed copy the dev app and the test suite load.
 *
 * Every `spawn-helper` node-pty ships or builds is covered (`prebuilds/*` and
 * `build/Release`), whatever the host platform: on Windows the chmod is a
 * no-op and the helper is never used. A helper that exists but cannot be made
 * executable fails the install.
 *
 * Usage: node scripts/restore-node-pty-exec-bit.mjs   (postinstall)
 */
import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every spawn-helper under one node-pty package root. */
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

/** Helpers under `ptyRoot` that the current user cannot execute. */
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

/**
 * Add the execute bits to every helper under `ptyRoot`, keeping its other mode
 * bits. Returns the helpers changed. Throws when one stays non-executable.
 */
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
