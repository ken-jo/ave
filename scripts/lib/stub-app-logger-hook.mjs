/**
 * Source mode of the plugin validator runs without the app logger
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, P2).
 *
 * Why stub: the name is the recipe's own. The plugin repositories' vendoring
 * refuses a bundle whose `logger` is not `"stub-app-logger"`, and this file is
 * that substitution for source mode — the same silent logger, on purpose.
 *
 * `bun run plugin:validate` loads this with `--import`, after `tsx`, in the
 * CLI and in the child it spawns. A module resolve hook replaces the module at
 * `<checkout>/src/lib/logger.ts` with the same silent `createLogger` the
 * plugin repositories' bundle recipe substitutes (`bundle-app-marketplace.mjs`
 * in the official repository), so all three ways of running the validator —
 * source, CLI bundle, child-main bundle — run without the app logger.
 *
 * REPLACING THE MODULE IS REQUIRED. The app logger picks its destination when
 * it is first imported, and both its pretty stream and its test-mode path
 * (`console.log` under `VITEST` or `NODE_ENV=test`) reach stdout — which is
 * the CLI's report and the child's protocol stream. Neither `LOG_LEVEL` nor a
 * rebound `process.stdout.write` covers every case. The stub exports only
 * `createLogger`, as the recipe's does, so a graph that imports anything else
 * from the logger fails to link here exactly as it fails to bundle there.
 */
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

/**
 * Let the next resolver (tsx, then Node's) resolve the specifier first, so the
 * substitution keys on the module a `.js` specifier actually reaches rather
 * than on how an importer happened to spell it.
 */
function substitute(resolved) {
  if (resolved.url !== LOGGER_URL) return resolved;
  return { url: SILENT_LOGGER_URL, format: "module", shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
  return substitute(await nextResolve(specifier, context));
}

/**
 * Whether tsx registered its hooks in-thread (`module.registerHooks`) rather
 * than on the loader thread (`module.register`). The two kinds do not chain
 * into each other — a loader-thread hook beside tsx's in-thread ones leaves a
 * `.ts` entry silently unrun — so this hook registers the same kind tsx did.
 * The versions are tsx 4.23's own gate (`node-features`: 22.22.3, 24.11.1,
 * 25.1.0, 26.0.0 and later), the version this checkout locks.
 */
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
  // The loader thread evaluates this module again; only the `--import` on
  // the main thread registers it.
  nodeModule.register(import.meta.url);
}
