import { isAbsolute, normalize, posix, relative, resolve } from "node:path";
import { HEADLESS_CHILD_ENTRY_POINTS } from "./headless-bundle-boundary.mjs";

const LEGACY_SINGLE_MAIN_BUNDLE_BYTES = 10_828_547;
// Root-level main-process outputs are executable entrypoints. Keep this list
// explicit so package-footprint validation does not accidentally permit an
// arbitrary extra root JavaScript file in app.asar.
export const MAIN_BUNDLE_ROOT_FILES = Object.freeze([
  "main.js",
  "headless.js",
  ...Object.keys(HEADLESS_CHILD_ENTRY_POINTS).map((name) => `${name}.js`),
  "subscription-grok-tool-policy-hook.js",
  "subscription-tool-mcp-server.js",
  // Confined plugin child entry — its OWN root entrypoint because a different
  // process executes it (`spawnConfinedPluginChild` runs it directly; a module
  // buried inside main.js has no path to be run from). See build-main-esbuild.
  "plugin-child-main.js",
  "preview-document-child-main.js",
  "mxc-extension-supervisor.js",
  "mxc-packaged-probe.js",
]);

const MAIN_BUNDLE_CHUNK_PATH = /^chunks\/[a-zA-Z0-9_-]+\.js$/;

export function isMainBundleRootScriptPath(path) {
  return typeof path === "string"
    && !path.includes("/")
    && !path.includes("\\")
    && path.toLowerCase().endsWith(".js");
}

export function findUnexpectedMainBundleRootScripts(paths, manifestPaths) {
  const manifestPathSet = new Set(manifestPaths);
  return paths
    .filter(isMainBundleRootScriptPath)
    .filter((path) => !manifestPathSet.has(path));
}

export function isSafeMainBundleManifestPath(path) {
  return typeof path === "string" && (
    MAIN_BUNDLE_ROOT_FILES.includes(path) || MAIN_BUNDLE_CHUNK_PATH.test(path)
  );
}

/**
 * Tripwires, not a ratchet. `entryBytes` and `initialBytes` are what the user pays for at
 * launch; `totalBytes` bounds every emitted main output, lazy chunks included. They sit far
 * above the measurement on purpose so that ordinary feature growth never moves them; they
 * fire on a bundling mistake (a boot split undone, a dependency inlined twice), not on a
 * feature. The structural boot-boundary checks in `assertMainBundleBudget` are the
 * contract and stay exact. Do not record measurements here: the build prints them, and CI
 * writes them with each ceiling's headroom to the job summary.
 *
 * Total is derived from the entry and initial budgets plus a fixed lazy allowance.
 * The 4_300_000-byte allowance preserves the existing 14_000_000-byte tripwire;
 * it is additive budget headroom, not a separate cap on measured lazy bytes.
 * Initial already includes entry: this formula reserves an extra entry budget for
 * deferred and child-process outputs. Measurements still count every output once.
 * See docs/development/main-process-bundle.md for the accounting contract.
 */
export const MAIN_BUNDLE_BUDGETS = createMainBundleBudgets({
  entryBytes: 1_700_000,
  initialBytes: 8_000_000,
  lazyAllowanceBytes: 4_300_000,
});

export function createMainBundleBudgets({ entryBytes, initialBytes, lazyAllowanceBytes }) {
  const inputs = { entryBytes, initialBytes, lazyAllowanceBytes };
  for (const [key, value] of Object.entries(inputs)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`budget ${key} is not a positive integer`);
    }
  }
  const totalBytes = entryBytes + initialBytes + lazyAllowanceBytes;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error("budget totalBytes is not a positive integer");
  }
  return Object.freeze({ ...inputs, totalBytes });
}

const MAIN_BUNDLE_BUDGET_KEYS = Object.freeze(["entryBytes", "initialBytes", "totalBytes"]);
const MAIN_BUNDLE_BUDGET_SOURCE = "scripts/lib/main-bundle-budget.mjs";

function normalizedPath(path) {
  return normalize(path).replaceAll("\\", "/");
}

function resolveOutputImport(outputPath, importPath, outputKeys) {
  const normalizedImportPath = normalizedPath(importPath);
  const normalizedOutputPath = normalizedPath(outputPath);
  const candidates = [normalizedImportPath];
  if (!isAbsolute(normalizedImportPath)) {
    candidates.push(posix.join(posix.dirname(normalizedOutputPath), normalizedImportPath));
  }
  for (const candidate of candidates) {
    if (outputKeys.has(candidate)) return candidate;
  }
  return null;
}

function outputForEntryPoint(outputs, entryPoint) {
  const normalizedEntryPoint = normalizedPath(entryPoint);
  return [...outputs.entries()].find(([, output]) => {
    if (typeof output.entryPoint !== "string") return false;
    const candidate = normalizedPath(output.entryPoint);
    return candidate === normalizedEntryPoint
      || (!isAbsolute(candidate) && normalizedEntryPoint.endsWith(`/${candidate}`));
  });
}

function outputContainsInput(output, inputPath) {
  const normalizedInputPath = normalizedPath(inputPath);
  return Object.keys(output?.inputs ?? {}).some((path) => {
    const candidate = normalizedPath(path);
    return candidate === normalizedInputPath
      || (!isAbsolute(candidate) && normalizedInputPath.endsWith(`/${candidate}`));
  });
}

export function analyzeMainBundleMetafile(metafile, { entryPoint, requiredAsyncEntryPoint }) {
  if (!metafile || typeof metafile !== "object" || !metafile.outputs) {
    throw new Error("main bundle metafile is missing outputs");
  }

  const outputs = new Map(
    Object.entries(metafile.outputs).map(([path, value]) => [normalizedPath(path), value]),
  );
  const entry = outputForEntryPoint(outputs, entryPoint);
  if (!entry) throw new Error(`main bundle entry output not found for ${entryPoint}`);
  const requiredAsyncEntry = outputForEntryPoint(outputs, requiredAsyncEntryPoint);
  if (!requiredAsyncEntry) {
    throw new Error(`required async entry output not found for ${requiredAsyncEntryPoint}`);
  }

  const outputKeys = new Set(outputs.keys());
  const initial = new Set();
  const pending = [entry[0]];
  let hasRequiredAsyncBoundary = false;
  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (!outputPath || initial.has(outputPath)) continue;
    initial.add(outputPath);
    const output = outputs.get(outputPath);
    for (const imported of output?.imports ?? []) {
      if (imported.external === true) continue;
      const dependency = resolveOutputImport(outputPath, imported.path, outputKeys);
      if (!dependency && (imported.kind === "dynamic-import" || imported.kind === "import-statement")) {
        throw new Error(
          `main bundle import '${imported.path}' from '${outputPath}' has no emitted output`,
        );
      }
      if (dependency === requiredAsyncEntry[0] && imported.kind === "dynamic-import") {
        hasRequiredAsyncBoundary = true;
      }
      if (imported.kind !== "import-statement") continue;
      pending.push(dependency);
    }
  }

  const entryBytes = entry[1].bytes;
  const initialBytes = [...initial]
    .reduce((sum, outputPath) => sum + outputs.get(outputPath).bytes, 0);
  const totalBytes = [...outputs.values()].reduce((sum, output) => sum + output.bytes, 0);
  return {
    entryBytes,
    initialBytes,
    totalBytes,
    asyncBytes: totalBytes - initialBytes,
    initialFiles: initial.size,
    totalFiles: outputs.size,
    hasRequiredAsyncBoundary,
    requiredAsyncEntryIsInitial: initial.has(requiredAsyncEntry[0])
      || [...initial].some((outputPath) => (
        outputContainsInput(outputs.get(outputPath), requiredAsyncEntryPoint)
      )),
    legacyInitialReduction: 1 - (initialBytes / LEGACY_SINGLE_MAIN_BUNDLE_BYTES),
  };
}

export function assertMainBundleBudget(measurement, budgets) {
  const failures = [];
  if (!measurement.hasRequiredAsyncBoundary) {
    failures.push("required boot entry has no async bundle boundary");
  }
  if (measurement.requiredAsyncEntryIsInitial) {
    failures.push("required boot entry remains statically reachable from main");
  }
  let exceeded = false;
  for (const key of MAIN_BUNDLE_BUDGET_KEYS) {
    if (!Number.isSafeInteger(budgets?.[key]) || budgets[key] <= 0) {
      failures.push(`budget ${key} is not a positive integer`);
    } else if (!Number.isFinite(measurement[key]) || measurement[key] < 0) {
      failures.push(`${key} is not a non-negative finite number`);
    } else if (measurement[key] > budgets[key]) {
      failures.push(`${key} ${measurement[key]} exceeds ${budgets[key]}`);
      if (key === "totalBytes") {
        failures.push(
          `emitted output shares: entry=${measurement.entryBytes}, `
            + `initial shared=${measurement.initialBytes - measurement.entryBytes}, `
            + `lazy/other=${measurement.totalBytes - measurement.initialBytes}`,
        );
      }
      exceeded = true;
    }
  }
  if (exceeded) {
    failures.push(
      "these ceilings are tripwires far above normal growth: first look for a module that "
        + "belongs behind a dynamic import (startup code) or a dependency bundled twice; "
        + `if the growth is intended, raise the ceiling in ${MAIN_BUNDLE_BUDGET_SOURCE} `
        + "with the owner's approval; keep content under its owning cap and never move files just to evade it",
    );
  }
  if (failures.length > 0) {
    throw new Error(`main bundle budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

/**
 * The job-summary table CI shows for every main build: measurement, ceiling and headroom
 * per ceiling, plus the lazy (async) share that has no ceiling of its own.
 */
export function formatMainBundleSummary(measurement, budgets) {
  const bytes = (value) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "invalid");
  const rows = MAIN_BUNDLE_BUDGET_KEYS.map((key) => {
    const ceiling = budgets?.[key];
    const headroom = Number.isSafeInteger(ceiling) && ceiling > 0
      ? `${((1 - (measurement[key] / ceiling)) * 100).toFixed(1)}%`
      : "invalid";
    return `| ${key.replace(/Bytes$/, "")} | ${bytes(measurement[key])} | ${bytes(ceiling)} | ${headroom} |`;
  });
  return [
    "### Main bundle budget",
    "",
    "| Part | Measured bytes | Ceiling | Headroom |",
    "|---|---:|---:|---:|",
    ...rows,
    `| async (lazy) | ${bytes(measurement.asyncBytes)} | — | — |`,
    "",
    ...(Number.isSafeInteger(budgets?.lazyAllowanceBytes) ? [
      `Total ceiling = entry budget (${bytes(budgets.entryBytes)}) + initial budget (${bytes(budgets.initialBytes)}) + lazy allowance (${bytes(budgets.lazyAllowanceBytes)}).`,
      "Initial includes entry; the extra entry budget and lazy allowance reserve headroom for non-initial outputs.",
      "",
    ] : []),
  ].join("\n");
}

export function formatMainBundleBudget(measurement) {
  const reduction = (measurement.legacyInitialReduction * 100).toFixed(1);
  return [
    "[main-bundle-budget] passed",
    `entry=${measurement.entryBytes}`,
    `initial=${measurement.initialBytes}`,
    `async=${measurement.asyncBytes}`,
    `total=${measurement.totalBytes}`,
    `files=${measurement.initialFiles}/${measurement.totalFiles}`,
    `legacy-initial-reduction=${reduction}%`,
  ].join(" ");
}

export function createMainBundleManifest(metafile, { outdir, absWorkingDir = outdir }) {
  const normalizedOutdir = normalizedPath(outdir);
  const normalizedWorkingDir = normalizedPath(absWorkingDir);
  const files = Object.entries(metafile.outputs)
    .map(([path, output]) => ({
      path: normalizedPath(relative(
        normalizedOutdir,
        isAbsolute(path)
          ? normalizedPath(path)
          : normalizedPath(resolve(normalizedWorkingDir, path)),
      )),
      bytes: output.bytes,
    }))
    .filter((entry) => entry.path !== ".." && !entry.path.startsWith("../"))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (!files.some((entry) => entry.path === "main.js")) {
    throw new Error("main bundle manifest does not contain main.js");
  }
  return {
    schemaVersion: 1,
    entry: "main.js",
    files,
  };
}
