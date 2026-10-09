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

// Nothing here loads the isolation guard (or anything that imports it): a
// module loaded by a setup file is already evaluated when the test file's
// `vi.mock` calls register, so the guard would keep the real `node:os` that a
// suite standing in a scratch account for the person's has mocked.
// `vitest.globalSetup.ts` checks the guard is in place.
//
// Each file's stores take this file's home only because each file loads its
// own modules; `vitest.globalSetup.ts` refuses a run with isolate: false.

const runHome = process.env.AVE_TEST_RUN_HOME;
if (runHome === undefined) {
  throw new Error(
    "AVE_TEST_RUN_HOME is unset: vitest.globalSetup.ts makes the run's Ave home before any test file loads",
  );
}
process.env.AVE_HOME = mkdtempSync(join(runHome, "f-"));
