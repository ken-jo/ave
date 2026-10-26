/** Give each test file its own home within the per-run root, removed at teardown. */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// Do not import the guard before suite mocks register. Module isolation is required for per-file homes.

const runHome = process.env.AVE_TEST_RUN_HOME;
if (runHome === undefined) {
  throw new Error(
    "AVE_TEST_RUN_HOME is unset: vitest.globalSetup.ts makes the run's Ave home before any test file loads",
  );
}
process.env.AVE_HOME = mkdtempSync(join(runHome, "f-"));
