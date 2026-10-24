/**
 * Test setup (vm pools) — removes the exit hook signal-exit leaves on the
 * worker's real `process`.
 *
 * A vm pool runs each file in its own VM context inside a reused worker, but
 * every context shares the worker's `process`. signal-exit (loaded through
 * proper-lockfile by `src/lib/with-file-lock.ts`) replaces `process.emit`
 * when it loads, and that replacement reads the context's `global`. Once the
 * file's context is torn down, the worker's next `exit` emit runs the stale
 * replacement and throws `ReferenceError: global is not defined`, which
 * Vitest reports as an unhandled error against whichever file is running.
 *
 * Importing the signal-exit that proper-lockfile resolves (v3; other
 * packages nest v4) returns the instance this file's context loaded, and
 * `unload()` restores `process.emit` and `process.reallyExit` before the
 * context goes away. It is a no-op when nothing loaded the hook.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll } from "vitest";

const lockfileRequire = createRequire(createRequire(import.meta.url).resolve("proper-lockfile"));
const SIGNAL_EXIT_URL = pathToFileURL(lockfileRequire.resolve("signal-exit")).href;

afterAll(async () => {
  const signalExit: { default: { unload(): void } } = await import(SIGNAL_EXIT_URL);
  signalExit.default.unload();
});
