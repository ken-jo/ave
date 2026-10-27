/** Give each test file its own home within the per-run root, removed at teardown. */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModule } from "node:process";
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import { installWindowsNativeTripwire } from "./support/windows-native-tripwire.js";

// Capture the real host before suite code can replace process.platform.
const HOST_TYPE = getBuiltinModule("node:os").type();
const host = HOST_TYPE === "Windows_NT" ? "win32" : HOST_TYPE === "Darwin" ? "darwin" : "linux";
let tripwire = await installWindowsNativeTripwire(host, () => expect.getState().testPath);
const reportNativeViolation = (): void => {
  // Native readers deliberately catch I/O errors. A caught violation must still
  // fail the suite with the original actionable diagnostic.
  const error = tripwire.takeViolation();
  if (error) throw error;
};
afterEach(reportNativeViolation);
beforeEach(async () => {
  tripwire.restore();
  tripwire = await installWindowsNativeTripwire(host, () => expect.getState().testPath);
});
afterAll(() => {
  tripwire.restore();
  reportNativeViolation();
});

// Do not import the guard before suite mocks register. Module isolation is required for per-file homes.

const runHome = process.env.AVE_TEST_RUN_HOME;
if (runHome === undefined) {
  throw new Error(
    "AVE_TEST_RUN_HOME is unset: vitest.globalSetup.ts makes the run's Ave home before any test file loads",
  );
}
process.env.AVE_HOME = mkdtempSync(join(runHome, "f-"));
