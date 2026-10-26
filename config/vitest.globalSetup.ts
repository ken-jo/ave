import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { claimRunDir, ensureRunTmpRoot, ensureTestTmpRoot, RUN_OWNER_FILE, runTmpRoot, sweepStaleRunDirs } from "../src/__tests__/support/test-run-dirs.js";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Capture before redirecting the inherited environment, including across projects.
const REAL_PROGRAM_DATA = process.platform === "win32" ? process.env.ProgramData ?? "C:\\ProgramData" : null;
const REAL_ACCOUNT_HOME = (() => {
  try {
    return userInfo().homedir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return homedir();
  }
})();

// Validate every manifest fixture before tests and report all schema failures together.
// A missing host-owned schema fails closed.
async function validateJsonFixtures(): Promise<void> {
  const { buildManifestValidator } = await import("../src/plugins/runtime/manifest-validation.js");
  const validate = await buildManifestValidator();

  const jsonFixtures = await collectJsonFixtures(join(HERE, "src"));

  const failures: string[] = [];
  for (const file of jsonFixtures) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      failures.push(`${relative(HERE, file)}: not valid JSON`);
      continue;
    }
    if (!validate(data)) {
      failures.push(`${relative(HERE, file)}: ${validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join(", ") ?? "unknown error"}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`[fixture-validator] ${failures.length} manifest fixture(s) fail schema:\n${failures.join("\n")}`);
  }
}

interface RunDirs {
  sandboxBase: string;
  aveHomeBase: string;
  tmpBase: string;
  pluginChildEntryPath: string;
  users: number;
}

// Share run directories across projects so later setup cannot replace inherited paths.
const RUN_DIRS = Symbol.for("ave.vitest.runDirs");
type RunDirsHolder = { [RUN_DIRS]?: RunDirs };

// Create test-tmp before mkdtemp; its path avoids short-name failures on Windows.
export async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Stores must load after each file sets AVE_HOME; reused module graphs break isolation.
  // VM pools give each file a fresh context regardless of isolate.
  if (project.config.isolate === false && !project.config.pool.startsWith("vm")) {
    throw new Error(
      `${project.name ? `vitest project "${project.name}": ` : ""}isolate: false shares modules between test files, `
        + "so a store would keep the Ave home an earlier file resolved. Run with the default isolate: true.",
    );
  }
  const holder = globalThis as RunDirsHolder;
  const existing = holder[RUN_DIRS];
  if (existing !== undefined) {
    existing.users += 1;
    project.provide("pluginChildEntryPath", existing.pluginChildEntryPath);
    project.provide("realProgramData", REAL_PROGRAM_DATA);
    project.provide("realAccountHome", REAL_ACCOUNT_HOME);
    return () => releaseRunDirs(holder);
  }

  const testTmp = join(homedir(), ".ave", "test-tmp");
  // Reject links before sweeping so cleanup cannot enter another tree.
  ensureTestTmpRoot(testTmp, (path) => mkdirSync(path, { recursive: true }));
  // Claim the run temp root first; rejected roots must leave no unowned run directories.
  // Teardown reports leaks here, and the sweep removes only directories from dead runs.
  const tmpRoot = runTmpRoot();
  ensureRunTmpRoot(tmpRoot);
  const tmpBase = mkdtempSync(join(tmpRoot, "t-"));
  // Confined test processes need a separate private root; app startup clears the app sandbox.
  // Keep paths short for socket limits.
  const sandboxBase = mkdtempSync(join(testTmp, "sbx-"));
  // Override inherited AVE_HOME so default stores stay inside this run.
  // aveHome() rejects real-home paths outside test-tmp.
  const aveHomeBase = mkdtempSync(join(testTmp, "h-"));
  let pluginChildEntryPath: string | undefined;
  process.env.AVE_TEST_SANDBOX_BASE = sandboxBase;
  process.env.AVE_TEST_RUN_HOME = aveHomeBase;
  process.env.AVE_HOME = aveHomeBase;
  // os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows.
  for (const name of TMP_ENV) process.env[name] = tmpBase;
  if (process.platform === "win32") {
    const programData = join(tmpBase, "program-data");
    mkdirSync(join(programData, "Ave"), { recursive: true });
    for (const name of ["ProgramData", "PROGRAMDATA", "ALLUSERSPROFILE"]) process.env[name] = programData;
  }
  try {
    // Owner records keep live runs out of another run's sweep.
    claimRunDir(sandboxBase);
    claimRunDir(aveHomeBase);
    claimRunDir(tmpBase);
    // Global setup must resolve the same isolation guard as workers.
    const seam = await import("../src/shared/ave-home-test-guard.js");
    if (!seam.AVE_HOME_ISOLATION_GUARD_ACTIVE) {
      throw new Error(
        "the Ave home isolation guard is not in place: config/vitest.analysis.config.ts must resolve "
          + "src/shared/ave-home-test-guard.ts to src/__tests__/support/ave-home-isolation-guard.ts",
      );
    }
    // Load app modules only after AVE_HOME is set; sweep dead runs and preserve live ones.
    const sweeps = [await sweepStaleRunDirs(testTmp, removeRunDir), await sweepStaleRunDirs(tmpRoot, removeRunDir)];
    const swept = { stranded: sweeps.flatMap((s) => s.stranded), leftAside: sweeps.flatMap((s) => s.leftAside) };
    for (const aside of swept.stranded) {
      console.warn(`[vitest setup] left ${aside} in place: it changed between being judged abandoned and being taken aside`);
    }
    for (const aside of swept.leftAside) {
      console.warn(`[vitest setup] left ${aside} in place: renamed aside for removal, but not removed; look at it, or a later run removes it once its owner is shown gone`);
    }
    await validateJsonFixtures();
    pluginChildEntryPath = await buildRunPluginChildEntry();
  } catch (error) {
    // Failed setup gets no teardown; these unused directories can be removed directly.
    await rm(sandboxBase, { recursive: true, force: true });
    await rm(aveHomeBase, { recursive: true, force: true });
    await rm(tmpBase, { recursive: true, force: true });
    if (pluginChildEntryPath !== undefined) await rm(dirname(pluginChildEntryPath), { recursive: true, force: true });
    throw error;
  }
  project.provide("pluginChildEntryPath", pluginChildEntryPath);
  project.provide("realProgramData", REAL_PROGRAM_DATA);
  project.provide("realAccountHome", REAL_ACCOUNT_HOME);
  holder[RUN_DIRS] = { sandboxBase, aveHomeBase, tmpBase, pluginChildEntryPath, users: 1 };
  return () => releaseRunDirs(holder);
}

async function releaseRunDirs(holder: RunDirsHolder): Promise<void> {
  const dirs = holder[RUN_DIRS];
  if (dirs === undefined) return;
  dirs.users -= 1;
  if (dirs.users > 0) return;
  delete holder[RUN_DIRS];
  await removeRunDir(dirs.sandboxBase);
  await removeRunDir(dirs.aveHomeBase);
  const leaked = leftInTmpBase(dirs.tmpBase);
  if (leaked !== "") {
    console.warn(`[vitest teardown] tests left these in the temp directory without removing them (removed now; fix the test that makes them): ${leaked}`);
  }
  await removeRunDir(dirs.tmpBase);
  await rm(dirname(dirs.pluginChildEntryPath), { recursive: true, force: true });
}

// Unlink junctions before recursive removal so cleanup cannot delete their targets.
// Restore owner access without following links; load app modules only after AVE_HOME is set.
async function removeRunDir(path: string): Promise<void> {
  const { removeLinksUnder } = await import("../src/__tests__/support/tmp-dir-teardown.js");
  const { removeOwnedPluginTree, restoreOwnerAccess } = await import("../src/plugins/installed-entry-fs.js");
  try {
    removeLinksUnder(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !existsSync(path)) return;
    if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") throw error;
    // Restore owner access without following links, then retry the walk.
    await restoreOwnerAccess(path);
    removeLinksUnder(path);
  }
  await removeOwnedPluginTree(path);
}

const TMP_ENV = ["TMPDIR", "TEMP", "TMP"] as const;

// Fold mkdtemp suffixes into one entry per leaking test.
function leftInTmpBase(tmpBase: string): string {
  const counts = new Map<string, number>();
  for (const name of readdirSync(tmpBase)) {
    if (name === RUN_OWNER_FILE || (process.platform === "win32" && name === "program-data")) continue;
    const key = name.replace(/^(.*[-_.])[A-Za-z0-9]{6}$/, "$1*");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => (count > 1 ? `${key} x${count}` : key))
    .join(", ");
}

// Source checkouts need a bundled plugin child entry with the shipped build boundary.
// Use a per-run repository cache directory so externals resolve without concurrent rewrites.
async function buildRunPluginChildEntry(): Promise<string> {
  const { buildChildEntry, childBundleDir } = await import("../src/plugins/isolation/__tests__/child-entry-bundle.js");
  const cacheName = "plugin-child-runtime";
  const cacheRoot = childBundleDir(cacheName);
  mkdirSync(cacheRoot, { recursive: true });
  const runDir = mkdtempSync(join(cacheRoot, "run-"));
  try {
    return await buildChildEntry(join(cacheName, basename(runDir)));
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

async function collectJsonFixtures(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile()
        && entry.name.endsWith(".json")
        && dir.includes("__tests__")
        && (
          entry.name.startsWith("manifest")
          || entry.name.startsWith("plugin")
          || entry.name.endsWith("-fixture.json")
        )
      ) {
        results.push(full);
      }
    }
  }
  await walk(root);
  return results;
}
