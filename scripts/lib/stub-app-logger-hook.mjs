// Why stub: source validation needs the same silent logger substitution as contract bundles.
// Replace the resolved logger module without loading its worker transport.
import nodeModule from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const LOGGER_URL = pathToFileURL(
  realpathSync(fileURLToPath(new URL("../../src/lib/logger.ts", import.meta.url))),
).href;

const SILENT_LOGGER_SOURCE = `const silent = () => {};
const logger = { debug: silent, info: silent, warn: silent, error: silent, trace: silent, fatal: silent, child: () => logger };
export function createLogger() { return logger; }
`;

const SILENT_LOGGER_URL = `data:text/javascript,${encodeURIComponent(SILENT_LOGGER_SOURCE)}`;

// Resolve first so aliases and alternate extensions reach the same substitution.
function substitute(resolved) {
  if (resolved.url !== LOGGER_URL) return resolved;
  return { url: SILENT_LOGGER_URL, format: "module", shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
  return substitute(await nextResolve(specifier, context));
}

// Register the same hook kind as the source loader; in-thread and loader-thread hooks do not chain.
function tsxRegistersInThread() {
  if (typeof nodeModule.registerHooks !== "function") return false;
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3);
  if (major === 24) return minor > 11 || (minor === 11 && patch >= 1);
  if (major === 25) return minor >= 1;
  return major >= 26;
}

if (tsxRegistersInThread()) {
  nodeModule.registerHooks({ resolve: (specifier, context, nextResolve) => substitute(nextResolve(specifier, context)) });
} else if (isMainThread) {
  // Only the main-thread import registers; the loader thread evaluates this module again.
  nodeModule.register(import.meta.url);
}
