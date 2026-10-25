/** Unload the lock library's own signal-exit instance before VM teardown to remove stale process.emit hooks. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll } from "vitest";

const lockfileRequire = createRequire(createRequire(import.meta.url).resolve("proper-lockfile"));
const SIGNAL_EXIT_URL = pathToFileURL(lockfileRequire.resolve("signal-exit")).href;

afterAll(async () => {
  const signalExit: { default: { unload(): void } } = await import(SIGNAL_EXIT_URL);
  signalExit.default.unload();
});
