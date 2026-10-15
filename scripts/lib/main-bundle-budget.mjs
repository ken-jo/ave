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
 * A growth ratchet, not a target. `entryBytes` and `initialBytes` are the ones that cost
 * the user startup time; `totalBytes` bounds how much the main process can grow overall.
 *
 * Last measured on `main`: entry 1_464_068, initial 5_049_267, total 10_984_203 — i.e.
 * `totalBytes` had 15_797 bytes of headroom, which the MCP resource-template work then
 * spent (+20_980 total, of which only +8_474 is initial). Raised once here rather than
 * trimming, because the growth is functionality reaching main, not weight: the startup
 * numbers still sit ~200 KB and ~240 KB under their own ceilings. Record the new
 * measurement here whenever this line moves, so the next bump argues against a number
 * instead of against a feeling. The chat-turn progress lifecycle is a main-process
 * feature for sub-agent transcript snapshots. Its latest measurement is entry 313_848,
 * initial 5_253_957, total 9_160_964; the initial ceiling therefore moves to 5_255_000
 * rather than hiding the functionality behind a build-only workaround. The built-in
 * search, web and memory tools are registered with the tool registry at boot, so their
 * definitions sit in the initial graph; with them the measurement is entry 416_271,
 * initial 5_273_794, total 8_909_524, and the initial ceiling moves to 5_275_000.
 * Joined with main's terminal blocks (terminal_read registers at boot too), the
 * measurement is entry 415_595, initial 5_297_263, total 8_937_183, and the initial
 * ceiling moves to 5_300_000. Joined again with main after skills-on-demand, chat-ux and
 * release-ci, the measurement is entry 419_912, initial 5_313_199, total 8_951_548, and
 * the initial ceiling moves to 5_315_000.
 * Remote-connection joined with that main measures entry 423_044, initial 5_326_014,
 * total 8_967_523, and the initial ceiling moves to 5_330_000. Permission rules (rule
 * files, scopes, the shell prefix/exfiltration matchers) and approval-memory identity are
 * consulted by the permission manager on every tool call, so they belong in the initial
 * graph; with the permissions category joined with that `main` the measurement is entry
 * 423_073, initial 5_389_392, total 9_031_357, and the initial ceiling moves to 5_390_000.
 * The agent browser tools keep their schemas, execute bodies and CDP page actions out of
 * the initial graph (desktop-boot and dynamic imports); what joins it is what boot wires
 * eagerly: the browser tab registry and its IPC domain, guest tracking on did-attach, the
 * tools' en/ko catalog fragments (the catalog barrel imports every fragment) and the
 * approval card's browser-scope strings. Measured entry 425_021, initial 5_410_703,
 * total 9_079_452; the initial ceiling moves to 5_412_000.
 * Concrete browser document authority, input attribution and navigation
 * provenance remain in the initial registry graph. Measured entry 425_021,
 * initial 5_413_433, total 9_091_289; the ceiling moves from 5_412_000 to
 * 5_415_000 to cover that functionality.
 * The PowerShell shell floors (bounded command analysis, file execution provenance,
 * native launchers, remote output sinks and credential-store rows) are read by the
 * permission manager on every PowerShell call, so they join the initial graph too:
 * entry 423_073, initial 5_470_098, total 9_112_063; the initial ceiling remains 5_475_000.
 * Merged with the browser tools: entry 425_021, initial 5_494_317, total 9_173_400; ceiling 5_495_000.
 * Shared runner argument analysis: entry 425_021, initial 5_498_372, total 9_177_455; ceiling 5_500_000.
 * Runner task-data options: entry 425_021, initial 5_499_048, total 9_178_131; ceiling 5_500_000.
 * Runner option roles and ordinary asks: entry 425_021, initial 5_501_684, total 9_180_767; ceiling 5_505_000.
 * Runner source roles and wrapper asks: entry 425_021, initial 5_503_162, total 9_182_245; ceiling 5_505_000.
 * Package source aliases and implicit file inputs: entry 425_021, initial 5_504_377, total 9_183_460; ceiling 5_505_000.
 * Proven package operands and registry choices: entry 425_021, initial 5_505_213, total 9_184_296; ceiling 5_510_000.
 */
export const MAIN_BUNDLE_BUDGETS = Object.freeze({
  entryBytes: 1_700_000,
  initialBytes: 5_510_000,
  totalBytes: 11_050_000,
});

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
  for (const key of ["entryBytes", "initialBytes", "totalBytes"]) {
    if (!Number.isFinite(measurement[key]) || measurement[key] < 0) {
      failures.push(`${key} is not a non-negative finite number`);
    } else if (measurement[key] > budgets[key]) {
      failures.push(`${key} ${measurement[key]} exceeds ${budgets[key]}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`main bundle budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
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
