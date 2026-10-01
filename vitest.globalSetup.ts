import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestValidator } from "./src/plugins/runtime/manifest-validation.js";
import { removeOwnedPluginTree } from "./src/plugins/plugin-removal-transaction.js";

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
 * Vitest global setup — creates ~/.ave/test-tmp/ before any tests run.
 *
 * Tests use ~/.ave/test-tmp/ as the base directory for mkdtempSync() to
 * avoid Windows 8.3 short-path (RUNNER~1) issues with os.tmpdir().
 * mkdtempSync() requires the parent directory to already exist.
 */
export async function setup(): Promise<() => Promise<void>> {
  const testTmp = join(homedir(), ".ave", "test-tmp");
  mkdirSync(testTmp, { recursive: true });
  // The sandbox private roots (every confined process's HOME and temp
  // directory) for a test with no AVE_HOME of its own, one directory per run
  // (`sandboxPrivateBase` in asrt-sandbox.ts). Never `~/.ave/sandbox`: a
  // running app's boot empties that, and a sweep from a test would empty a
  // running app's. Short, for the socket-path limit some suites run into.
  const sandboxBase = mkdtempSync(join(testTmp, "sbx-"));
  process.env.AVE_TEST_SANDBOX_BASE = sandboxBase;
  await validateJsonFixtures();
  return async () => {
    // Takes back the modes a confined process may narrow inside its own
    // directory, and follows no link out of the base.
    await removeOwnedPluginTree(sandboxBase);
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
