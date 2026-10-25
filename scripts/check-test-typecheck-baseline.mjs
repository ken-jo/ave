// Typecheck excluded sources with shrink-only per-file error counts.
// Reject empty/config-error output and missing program sources so narrowed checks cannot pass.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PROJECT = resolve(ROOT, "tsconfig.tests.json");
const BASELINE = resolve(ROOT, "config/test-typecheck-baseline.json");
export const SCHEMA_VERSION = 1;

const SOURCE_FILE_RE = /\.[cm]?tsx?$/;
const INTENDED_SOURCE_RE = /^(?:src|scripts|test)\//;

function normalizeRepoRelativePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isExpectedSourcePath(path) {
  return SOURCE_FILE_RE.test(path)
    && INTENDED_SOURCE_RE.test(path)
    && path !== "src/preload.cjs.ts"
    && !(path.startsWith("src/") && path.includes("/__probes__/"));
}

// Normalize compiler paths to repository-relative POSIX paths.
export function programSourceFiles(tscOutput) {
  const files = new Set();
  for (const raw of tscOutput.split(/\r?\n/)) {
    const candidate = raw.trim();
    if (!SOURCE_FILE_RE.test(candidate)) continue;
    const repoRelative = normalizeRepoRelativePath(relative(ROOT, resolve(ROOT, candidate)));
    if (INTENDED_SOURCE_RE.test(repoRelative)) files.add(repoRelative);
  }
  return files;
}

// Omit deleted working-tree paths; still-present sources missing from the program fail.
export function expectedSourceFilesFromGitOutput(gitOutput, exists = existsSync) {
  const files = new Set();
  for (const raw of gitOutput.split("\0")) {
    const path = normalizeRepoRelativePath(raw);
    if (!isExpectedSourcePath(path) || !exists(resolve(ROOT, path))) continue;
    files.add(path);
  }
  return files;
}

export function missingExpectedSources(expectedInventory, programFiles) {
  return [...expectedInventory].filter((file) => !programFiles.has(file)).sort();
}

// Diagnostics start at column zero; indented related spans are continuation text.
// Capture the first location lazily so parentheses in paths and quoted spans in messages stay intact.
const DIAGNOSTIC_RE = /^(?<file>[^\s].*?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+):/;

export function countErrorsByFile(tscStdout) {
  const counts = new Map();
  for (const raw of tscStdout.split(/\r?\n/)) {
    const match = DIAGNOSTIC_RE.exec(raw);
    if (!match?.groups) continue;
    const file = match.groups.file.replaceAll("\\", "/");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

// Regressions fail; improvements and fixed files require baseline updates.
export function compareToBaseline(counts, baseline) {
  const regressed = [];
  const improved = [];
  const fixed = [];
  for (const [file, count] of counts) {
    const before = baseline[file] ?? 0;
    if (count > before) regressed.push({ file, before, after: count });
    else if (count < before) improved.push({ file, before, after: count });
  }
  for (const file of Object.keys(baseline)) {
    if (!counts.has(file)) fixed.push(file);
  }
  regressed.sort((a, b) => a.file.localeCompare(b.file, "en"));
  improved.sort((a, b) => a.file.localeCompare(b.file, "en"));
  return { regressed, improved, fixed: fixed.sort() };
}

// Empty diagnostics need a separate boundary check before the independent source-inventory check.
export function isEmptyMeasurementAgainstBaseline(counts, baselineFiles) {
  return counts.size === 0 && Object.keys(baselineFiles).length > 0;
}

// Refuse diagnostics attributed to configuration files before comparison or baseline writes.
// All supported source extensions remain valid, including declaration modules.
export function nonSourceMeasurements(counts) {
  return [...counts.keys()].filter((f) => !SOURCE_FILE_RE.test(f));
}

// Program-level diagnostics enrich empty-measurement failures; they are not a separate refusal.
export function unattributedDiagnostics(tscStdout) {
  return tscStdout.split(/\r?\n/).filter((line) => /^error TS\d+:/.test(line));
}

export function runTsc(spawn = spawnSync) {
  const result = spawn(
    process.execPath,
    [resolve(ROOT, "node_modules", "typescript", "lib", "tsc.js"),
      "-p", PROJECT, "--noEmit", "--pretty", "false", "--listFiles"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`tsc terminated by signal ${result.signal}`);
  // Compiler exits 0, 1 and 2 can all be legitimate; policy checks decide whether the measurement is usable.
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) {
    throw new Error(`tsc exited ${result.status}\n${result.stdout}${result.stderr}`);
  }
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Program-construction errors already produce an empty measurement; retain their text for diagnosis.
  return {
    tscStdout: stdout,
    counts: countErrorsByFile(stdout),
    programFiles: programSourceFiles(stdout),
  };
}

// Use an independent inventory: a narrowed compiler config cannot reveal its own omissions.
// Include local untracked sources.
export function readExpectedSourceFiles(spawn = spawnSync, exists = existsSync) {
  // Require tracked sources so a foreign empty index cannot masquerade as this checkout.
  const tracked = spawn(
    "git",
    ["ls-files", "-z", "--cached", "--", "src", "scripts", "test"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (tracked.error) throw tracked.error;
  if (tracked.signal || tracked.status !== 0) {
    throw new Error(`git could not list tracked TypeScript sources: ${tracked.stderr ?? ""}`);
  }
  if (expectedSourceFilesFromGitOutput(tracked.stdout ?? "", exists).size === 0) {
    throw new Error("git returned an empty tracked TypeScript source inventory");
  }
  const result = spawn(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "scripts", "test"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git ls-files terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`git ls-files exited ${result.status}\n${result.stderr ?? ""}`);
  }
  return expectedSourceFilesFromGitOutput(result.stdout ?? "", exists);
}

// Imported production files may enter this baseline; preloads have no other typecheck.
// Generate this note with the baseline so updates preserve it.
const TEST_FILE_RE = /(^|\/)(__tests__|__probes__|test)\//;
export function nonTestEntries(files) {
  return Object.keys(files).filter((f) => !TEST_FILE_RE.test(f));
}

// Only ENOENT permits bootstrapping; unreadable or invalid existing baselines must never be overwritten.
function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateBaselineFiles(baseline, path) {
  if (!isPlainObject(baseline)) {
    throw new Error(`baseline ${path} must be a JSON object`);
  }
  if (baseline.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `baseline schemaVersion ${baseline.schemaVersion} != ${SCHEMA_VERSION}; repair or remove it deliberately before updating`,
    );
  }
  if (!isPlainObject(baseline.files)) {
    throw new Error(`baseline ${path} must contain a non-array files object`);
  }
  for (const [file, count] of Object.entries(baseline.files)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`baseline ${path} has an invalid error count for ${file}`);
    }
  }
  return baseline.files;
}

function readBaseline(path = BASELINE) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, files: {} };
    throw error;
  }
  return { exists: true, files: validateBaselineFiles(JSON.parse(raw), path) };
}

export function readBaselineFilesOrEmpty(path = BASELINE) {
  return readBaseline(path).files;
}

export function decide({ update, measurement, baseline, expectedInventory }) {
  const { counts, programFiles, tscStdout } = measurement;

  // Reject configuration diagnostics before both comparison and writes.
  const nonSource = nonSourceMeasurements(counts);
  if (nonSource.length > 0) {
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        `tsc attributed errors to non-source files (${nonSource.join(", ")}), which means it`
        + " was diagnosing the configuration. Refusing to compare or write a baseline.",
    };
  }

  // Guard both comparison and baseline writes here; moving this into either branch reopens fail-open behavior.
  const onDiskFiles = baseline.files;
  if (isEmptyMeasurementAgainstBaseline(counts, onDiskFiles)) {
    // Include program-level diagnostics in the shared refusal message for both callers.
    const programLevel = unattributedDiagnostics(tscStdout);
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        "tsc produced no diagnostics while the committed baseline expects them — the compiler"
        + " did not run. Refusing to treat that as an improvement or to write it to the"
        + " baseline."
        + (programLevel.length > 0
          ? `\n\ntsc reported these program-level errors:\n${programLevel.join("\n")}`
          : `\n\ntsc produced no program-level errors either. Full output:\n${tscStdout}`),
    };
  }

  // Validate complete program coverage before either branch; non-empty diagnostics prove only partial coverage.
  if (expectedInventory.size === 0) {
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        "the independent TypeScript source inventory was empty. Refusing to compare or write a"
        + " baseline because program coverage cannot be established.",
    };
  }
  const missingSources = missingExpectedSources(expectedInventory, programFiles);
  if (missingSources.length > 0) {
    const preview = missingSources.slice(0, 20);
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        `tsc omitted ${missingSources.length} expected TypeScript source file(s) from its`
        + " program. Refusing to compare or write a baseline.\n"
        + preview.map((file) => `  ${file}\n`).join("")
        + (missingSources.length > preview.length
          ? `  … and ${missingSources.length - preview.length} more\n`
          : ""),
    };
  }

  if (update) {
    const sorted = Object.fromEntries(
      [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "en")),
    );
    const nonTest = nonTestEntries(sorted);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      _note:
        "Generated by scripts/check-test-typecheck-baseline.mjs --update-baseline."
        + " Per-file error counts under tsconfig.tests.json; a file absent from `files`"
        + " must have zero errors."
        + (nonTest.length > 0
          ? ` Not every entry is a test file: ${nonTest.length} production file(s) are`
            + ` reached through test imports (${nonTest.join(", ")}). Those under`
            + " src/preload are excluded by the root tsconfig, so for them this gate is the"
            + " only typecheck rather than a duplicate of check:typecheck."
          : ""),
      files: sorted,
    };
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    return {
      kind: "write",
      exitCode: 0,
      payload,
      message: `[test-typecheck] baseline written: ${counts.size} files, ${total} errors\n`,
    };
  }

  if (!baseline.exists) {
    return {
      kind: "refuse",
      exitCode: 1,
      message: `baseline ${BASELINE} does not exist; run check:typecheck-tests:update to create it`,
    };
  }
  const { regressed, improved, fixed } = compareToBaseline(counts, onDiskFiles);

  if (regressed.length > 0) {
    return {
      kind: "regressed",
      exitCode: 1,
      message:
        "[test-typecheck] new type errors in files the baseline covers\n"
        + regressed.map((row) => `  ${row.file}: ${row.before} -> ${row.after}\n`).join("")
        + "\nThese files are typechecked by tsconfig.tests.json. Fix the errors — do NOT\n"
        + "re-baseline to make this pass. `bun run check:typecheck-tests:update` exists for\n"
        + "recording IMPROVEMENTS after you have cleaned a file.\n",
    };
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const changeSummary = improved.length > 0 || fixed.length > 0
    ? ` (${improved.length} file(s) improved, ${fixed.length} fully fixed — run`
      + " check:typecheck-tests:update to lock it in)"
    : "";
  return {
    kind: "hold",
    exitCode: 0,
    message: `[test-typecheck] baseline held: ${counts.size} files, ${total} errors${changeSummary}\n`,
  };
}

function writeBaseline(payload) {
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// Keep policy separate from I/O so tests can prove refusals precede baseline writes.
export function runGate({
  argv = process.argv.slice(2),
  loadBaseline = readBaseline,
  measure = runTsc,
  loadExpectedInventory = readExpectedSourceFiles,
  saveBaseline = writeBaseline,
  writeStdout = (message) => process.stdout.write(message),
  writeStderr = (message) => process.stderr.write(message),
} = {}) {
  try {
    // Reject invalid inventories before spending time on a compiler run.
    const expectedInventory = loadExpectedInventory();
    const decision = decide({
      update: argv.includes("--update-baseline"),
      baseline: loadBaseline(),
      measurement: measure(),
      expectedInventory,
    });
    if (decision.kind === "write") saveBaseline(decision.payload);
    if (decision.exitCode === 0) writeStdout(decision.message);
    else writeStderr(decision.message);
    return decision.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`[test-typecheck] ${message}\n`);
    return 1;
  }
}

export function main(deps) {
  const exitCode = runGate(deps);
  process.exitCode = exitCode;
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
