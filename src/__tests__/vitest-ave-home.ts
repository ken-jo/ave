/**
 * Test setup — gives every test file its own Ave home.
 *
 * `vitest.globalSetup.ts` makes one directory per run under
 * `~/.ave/test-tmp` and publishes it as `AVE_TEST_RUN_HOME`; this runs before
 * each test file and points `AVE_HOME` at a fresh directory inside it. Every
 * store a test builds with its defaults (an `AuditLogger`, a session store, a
 * settings file) resolves through `aveHome()`, so it lands there: never in
 * the developer's real `~/.ave`, and never in a file another test file is
 * writing at the same moment from another worker. A suite that sets or clears
 * `AVE_HOME` itself restores this value, since it is what the suite saw at
 * load.
 *
 * The run's teardown removes the run directory, these included.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const runHome = process.env.AVE_TEST_RUN_HOME;
if (runHome === undefined) {
  throw new Error(
    "AVE_TEST_RUN_HOME is unset: vitest.globalSetup.ts makes the run's Ave home before any test file loads",
  );
}
process.env.AVE_HOME = mkdtempSync(join(runHome, "f-"));
