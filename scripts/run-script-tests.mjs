import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EMPTY_TEST_ONLY_NOTICE, intersectTestOnlyFiles, readTestOnlyFiles } from "./lib/ci-test-only-selection.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEST_DIRECTORY = new URL("../test/scripts/", import.meta.url);

export function discoverScriptTests(directory = TEST_DIRECTORY) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tests = discoverScriptTests();
  if (tests.length === 0) throw new Error("No script tests found");
  const files = intersectTestOnlyFiles(tests.map(name => `test/scripts/${name}`), readTestOnlyFiles());
  if (files.length === 0) {
    console.log(EMPTY_TEST_ONLY_NOTICE);
    process.exit(0);
  }
  const result = spawnSync(process.execPath, [
    "--import", "./scripts/lib/document-consumer-guard.mjs", "--test",
    ...files.map(path => join(PROJECT_ROOT, path)),
  ], { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
