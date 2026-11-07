// Fail on any Biome lint diagnostic the reviewed baseline does not accept, and
// on baseline entries that no longer exist, so fixed debt shrinks the snapshot.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIOME_BASELINE_SCHEMA_VERSION,
  compareBiomeBaseline,
  countBiomeDiagnostics,
  formatBiomeEntry,
  normalizeBiomeDiagnostics,
} from "./lib/biome-baseline.mjs";
import { readJsonFile, writeKnipBaselineAtomicSync } from "./lib/knip-baseline.mjs";

const DEFAULT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const BIOME_PACKAGE = "@biomejs/biome";
const DEFAULT_BIOME_BINARY = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

function parseOptions(argv) {
  const options = {
    root: DEFAULT_ROOT,
    baseline: "config/biome-baseline.json",
    biomeBinary: DEFAULT_BIOME_BINARY,
    updateBaseline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--update-baseline") {
      options.updateBaseline = true;
      continue;
    }
    const value = argv[index + 1];
    if (["--root", "--baseline", "--biome-binary"].includes(argument)) {
      if (!value) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--root") options.root = value;
      if (argument === "--baseline") options.baseline = value;
      if (argument === "--biome-binary") options.biomeBinary = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  options.root = resolve(options.root);
  const fromRoot = (path) => isAbsolute(path) ? path : resolve(options.root, path);
  options.baseline = fromRoot(options.baseline);
  options.biomeBinary = fromRoot(options.biomeBinary);
  return options;
}

function fail(message, details = []) {
  console.error(`[biome-gate] ${message}`);
  for (const detail of details) console.error(`  ${detail}`);
  process.exitCode = 1;
}

// Biome exits non-zero whenever an error-severity diagnostic exists, which the
// baseline accepts, so the JSON report rather than the exit status is the result.
function runBiome(options) {
  const result = spawnSync(
    process.execPath,
    [options.biomeBinary, "lint", "--reporter=json", "--max-diagnostics=none"],
    {
      cwd: options.root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Biome terminated by signal ${result.signal}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Biome did not produce a JSON report (exit ${result.status}): ${error.message}\n`
      + result.stderr.trim(),
    );
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  const packageJson = readJsonFile(join(options.root, "package.json"), "package.json");
  const expectedBiomeVersion = packageJson.devDependencies?.[BIOME_PACKAGE];
  if (typeof expectedBiomeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedBiomeVersion)) {
    throw new Error(`package.json must pin an exact ${BIOME_PACKAGE} devDependency version`);
  }
  const installedBiomePackage = readJsonFile(
    resolve(dirname(options.biomeBinary), "..", "package.json"),
    "installed Biome package.json",
  );
  if (installedBiomePackage.version !== expectedBiomeVersion) {
    throw new Error(
      `installed Biome version ${installedBiomePackage.version} does not match ${expectedBiomeVersion}`,
    );
  }

  const entries = normalizeBiomeDiagnostics(runBiome(options));
  if (options.updateBaseline) {
    const baseline = {
      schemaVersion: BIOME_BASELINE_SCHEMA_VERSION,
      biomeVersion: expectedBiomeVersion,
      entries,
    };
    writeKnipBaselineAtomicSync(options.baseline, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `[biome-gate] wrote ${entries.length} entries (${countBiomeDiagnostics(entries)} diagnostics)`
      + " to biome-baseline.json",
    );
  } else {
    const baseline = readJsonFile(options.baseline, "biome-baseline.json");
    if (baseline.schemaVersion !== BIOME_BASELINE_SCHEMA_VERSION) {
      throw new Error(`unsupported Biome baseline schema ${baseline.schemaVersion}`);
    }
    // The JSON reporter is experimental, so a Biome bump must regenerate the snapshot.
    if (baseline.biomeVersion !== expectedBiomeVersion) {
      throw new Error(
        `Biome baseline version ${baseline.biomeVersion} does not match ${expectedBiomeVersion}`
        + " — run `bun run check:biome:update`",
      );
    }
    if (!Array.isArray(baseline.entries)) {
      throw new Error("Biome baseline entries must be an array");
    }

    const { added, resolved } = compareBiomeBaseline(entries, baseline.entries);
    if (added.length > 0) {
      fail(
        "new lint diagnostics exceed the reviewed baseline — fix them"
        + " (`bunx biome lint <file>` shows each one)",
        added.map(formatBiomeEntry),
      );
    } else if (resolved.length > 0) {
      fail(
        `the baseline still lists ${countBiomeDiagnostics(resolved)} diagnostic(s)`
        + " that no longer exist — run `bun run check:biome:update` to record the removal",
        resolved.map(formatBiomeEntry),
      );
    } else {
      console.log(
        `[biome-gate] baseline passed: ${countBiomeDiagnostics(entries)} accepted diagnostics`
        + ` in ${entries.length} file/rule entries`,
      );
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
