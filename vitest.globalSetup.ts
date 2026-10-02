import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { claimRunDir, ensureTestTmpRoot, sweepStaleRunDirs } from "./src/__tests__/support/test-run-dirs.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Validates all JSON test-fixture files matching the manifest glob pattern
 * against schemas/plugin-manifest.schema.json using the same AJV instance as the
 * production runtime (buildManifestValidator). Collects all failures before
 * throwing so CI surfaces every broken fixture in one pass.
 *
 * This runs BEFORE any test file, catching schema drift introduced alongside
 * a schema change without requiring every test to opt in.
 *
 * Fails closed if the host-owned schema cannot be resolved. Plugins vendor
 * the schema unchanged at an app release tag.
 */
async function validateJsonFixtures(): Promise<void> {
  const { buildManifestValidator } = await import("./src/plugins/runtime/manifest-validation.js");
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
  /** Projects in this run whose setup has not torn down yet. */
  users: number;
}

/**
 * One set of run directories per vitest process: setup runs once per project
 * (node and jsdom), and a second set would replace the environment the first
 * project's workers already inherited.
 */
const RUN_DIRS = Symbol.for("ave.vitest.runDirs");
type RunDirsHolder = { [RUN_DIRS]?: RunDirs };

/**
 * Vitest global setup — creates ~/.ave/test-tmp/ before any tests run, and
 * the per-run AVE_HOME and sandbox base inside it.
 *
 * Tests use ~/.ave/test-tmp/ as the base directory for mkdtempSync() to
 * avoid Windows 8.3 short-path (RUNNER~1) issues with os.tmpdir().
 * mkdtempSync() requires the parent directory to already exist.
 */
export async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Each test file gets its own Ave home (`src/__tests__/vitest-ave-home.ts`),
  // which isolates its stores only if their modules load after it is set:
  // under isolate: false a worker keeps the modules an earlier file loaded.
  // The vm pools give each file a fresh context whatever isolate says.
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
    return () => releaseRunDirs(holder);
  }

  const testTmp = join(homedir(), ".ave", "test-tmp");
  // A real directory, never a link: the sweep below removes what is in it.
  ensureTestTmpRoot(testTmp, (path) => mkdirSync(path, { recursive: true }));
  // The sandbox private roots (every confined process's HOME and temp
  // directory) for a test that clears AVE_HOME, one directory per run
  // (`testSandboxPrivateBase` in the isolation guard). Never `~/.ave/sandbox`:
  // a running app's boot empties that, and a sweep from a test would empty a
  // running app's. Short, for the socket-path limit some suites run into.
  const sandboxBase = mkdtempSync(join(testTmp, "sbx-"));
  // The run's Ave homes: each test file starts in its own directory inside
  // this one (`src/__tests__/vitest-ave-home.ts`), so whatever a test does not
  // point elsewhere — an AuditLogger, a session store, a settings file built
  // with its defaults — lands there, never in the developer's real ~/.ave.
  // AVE_HOME is replaced whatever the shell exported, so one left over from
  // an app session cannot reach the tests. `aveHome()` refuses a path under
  // the real home that is not test-tmp.
  const aveHomeBase = mkdtempSync(join(testTmp, "h-"));
  process.env.AVE_TEST_SANDBOX_BASE = sandboxBase;
  process.env.AVE_TEST_RUN_HOME = aveHomeBase;
  process.env.AVE_HOME = aveHomeBase;
  try {
    // Who made them, so another run's sweep keeps them while this one lives.
    claimRunDir(sandboxBase);
    claimRunDir(aveHomeBase);
    // The seam `aveHome()` calls must resolve to the isolation guard here as
    // in the workers (same configuration), or no check runs and nothing says so.
    const seam = await import("./src/shared/ave-home-test-guard.js");
    if (!seam.AVE_HOME_ISOLATION_GUARD_ACTIVE) {
      throw new Error(
        "the Ave home isolation guard is not in place: vitest.analysis.config.ts must resolve "
          + "src/shared/ave-home-test-guard.ts to src/__tests__/support/ave-home-isolation-guard.ts",
      );
    }
    // App modules load only now, after AVE_HOME names this run's home.
    const { removeOwnedPluginTree } = await import("./src/plugins/plugin-removal-transaction.js");
    // What a killed run could not remove; a live run's are kept.
    await sweepStaleRunDirs(testTmp, removeOwnedPluginTree);
    await validateJsonFixtures();
  } catch (error) {
    // Vitest calls no teardown for a setup that threw. Nothing has run in
    // these yet, so a plain removal takes them.
    await rm(sandboxBase, { recursive: true, force: true });
    await rm(aveHomeBase, { recursive: true, force: true });
    throw error;
  }
  holder[RUN_DIRS] = { sandboxBase, aveHomeBase, users: 1 };
  return () => releaseRunDirs(holder);
}

async function releaseRunDirs(holder: RunDirsHolder): Promise<void> {
  const dirs = holder[RUN_DIRS];
  if (dirs === undefined) return;
  dirs.users -= 1;
  if (dirs.users > 0) return;
  delete holder[RUN_DIRS];
  const { removeOwnedPluginTree } = await import("./src/plugins/plugin-removal-transaction.js");
  await removeOwnedPluginTree(dirs.sandboxBase);
  await removeOwnedPluginTree(dirs.aveHomeBase);
}

/** Recursively collect JSON files matching manifest/plugin/*-fixture naming under __tests__ dirs. */
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
