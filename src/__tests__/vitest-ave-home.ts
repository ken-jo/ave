/** Give each test file its own home within the per-run root, removed at teardown. */
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach } from "vitest";

// Do not import the guard before suite mocks register. Module isolation is required for per-file homes.

const runHome = process.env.AVE_TEST_RUN_HOME;
if (runHome === undefined) {
  throw new Error(
    "AVE_TEST_RUN_HOME is unset: vitest.globalSetup.ts makes the run's Ave home before any test file loads",
  );
}
process.env.AVE_HOME = mkdtempSync(join(runHome, "f-"));

beforeEach(async () => {
  const { configureHostResources } = await import("../main/host-resources.js");
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
});
