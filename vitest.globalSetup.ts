import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Vitest global setup — creates ~/.ave/test-tmp/ before any tests run, and
 * the per-run AVE_HOME and sandbox base inside it.
 *
 * Tests use ~/.ave/test-tmp/ as the base directory for mkdtempSync() to
 * avoid Windows 8.3 short-path (RUNNER~1) issues with os.tmpdir().
 * mkdtempSync() requires the parent directory to already exist.
 */
export async function setup(): Promise<() => Promise<void>> {
  const testTmp = join(homedir(), ".ave", "test-tmp");
  mkdirSync(testTmp, { recursive: true });
  // The sandbox private roots (every confined process's HOME and temp
  // directory) for a test that clears AVE_HOME, one directory per run
  // (`sandboxPrivateBase` in asrt-sandbox.ts). Never `~/.ave/sandbox`: a
  // running app's boot empties that, and a sweep from a test would empty a
  // running app's. Short, for the socket-path limit some suites run into.
  const sandboxBase = mkdtempSync(join(testTmp, "sbx-"));
  process.env.AVE_TEST_SANDBOX_BASE = sandboxBase;
  // The run's Ave homes: each test file starts in its own directory inside
  // this one (`src/__tests__/vitest-ave-home.ts`), so whatever a test does not
  // point elsewhere — an AuditLogger, a session store, a settings file built
  // with its defaults — lands there, never in the developer's real ~/.ave.
  // AVE_HOME is replaced whatever the shell exported, so one left over from
  // an app session cannot reach the tests. `aveHome()` refuses a path under
  // the real home that is not test-tmp.
  const aveHomeBase = mkdtempSync(join(testTmp, "h-"));
  process.env.AVE_TEST_RUN_HOME = aveHomeBase;
  process.env.AVE_HOME = aveHomeBase;
  // The app modules load only now: some resolve a store's directory from
  // `aveHome()` when they load, which in this process would otherwise be the
  // real ~/.ave (and is refused under the test runner).
  const { removeOwnedPluginTree } = await import("./src/plugins/plugin-removal-transaction.js");
  await validateJsonFixtures();
  return async () => {
    // Takes back the modes a confined process may narrow inside its own
    // directory, and follows no link out of the base.
    await removeOwnedPluginTree(sandboxBase);
    await removeOwnedPluginTree(aveHomeBase);
  };
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
