// Pair refusal cases with passing controls so an always-failing gate cannot pass.
// Use captured diagnostics; invoke the compiler only to resolve effective configuration.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToBaseline,
  countErrorsByFile,
  expectedSourceFilesFromGitOutput,
  isEmptyMeasurementAgainstBaseline,
  main,
  missingExpectedSources,
  nonSourceMeasurements,
  nonTestEntries,
  programSourceFiles,
  readBaselineFilesOrEmpty,
  readExpectedSourceFiles,
  runGate,
  runTsc,
  unattributedDiagnostics,
} from "./check-test-typecheck-baseline.mjs";

const failures = [];
function check(name, condition) {
  if (!condition) failures.push(name);
}

// Cover path syntax, quoted error text and indented continuation diagnostics.
const TSC_OUTPUT = [
  `src/a/__tests__/x.test.ts(12,5): error TS2345: Argument of type 'A' is not assignable.`,
  `src/a/__tests__/x.test.ts(40,1): error TS2304: Cannot find name 'Foo'.`,
  `src\\b\\__tests__\\y.test.tsx(3,9): error TS2551: Property 'z' does not exist.`,
  `  Type '{ msg: "error TS9999: fake" }' is not assignable to type 'never'.`,
  // An indented related-location span must not create another diagnostic.
  `    related.test.ts(7,3): error TS2322: Type 'string' is not assignable.`,
  `test/scripts/z.test.ts(1,1): error TS2307: Cannot find module 'q'.`,
  ``,
  `Found 4 errors in 3 files.`,
].join("\n");

const counts = countErrorsByFile(TSC_OUTPUT);
check("parses one entry per diagnostic line", counts.size === 3);
check("counts repeated errors in one file", counts.get("src/a/__tests__/x.test.ts") === 2);
check("normalizes Windows separators", counts.get("src/b/__tests__/y.test.tsx") === 1);
check("counts files under test/", counts.get("test/scripts/z.test.ts") === 1);
// A full diagnostic span on an indented continuation still must not count.
check("ignores an indented continuation line", !counts.has("related.test.ts"));
check("never captures a file name with leading space", ![...counts.keys()].some((f) => /^\s/.test(f)));
check("ignores the trailing summary line", !counts.has("Found 4 errors in 3 files."));

const EDGE_OUTPUT = [
  // Parentheses in a source path must not hide its diagnostics.
  `src/__tests__/odd(name).test.ts(3,1): error TS2304: Cannot find name 'Q'.`,
  // Compiler paths containing spaces are unquoted and must still parse.
  `src/__tests__/two words.test.ts(4,2): error TS2304: Cannot find name 'R'.`,
  `src/__tests__/nope.test.ts(5,3): error : missing code`,
  `src/__tests__/nope.test.ts(6,4): warning TS6133: 'x' is declared but never used.`,
].join("\n");
const edge = countErrorsByFile(EDGE_OUTPUT);
check("parses a path containing parentheses", edge.get("src/__tests__/odd(name).test.ts") === 1);
check("parses a path containing a space", edge.get("src/__tests__/two words.test.ts") === 1);
check("ignores a span with no error code", !edge.has("src/__tests__/nope.test.ts"));
check("ignores a non-error severity", edge.get("src/__tests__/nope.test.ts") === undefined);
check("counts exactly the two real diagnostics", edge.size === 2);
// Require a location span so program errors cannot be counted as source diagnostics.
check(
  "a diagnostic with no (line,col) span is not a per-file diagnostic",
  countErrorsByFile(`tsconfig.json: error TS5023: Unknown compiler option 'x'.`).size === 0,
);
// A location quoted in the message must not steal attribution from the first span.
check(
  "a span quoted inside a message does not steal attribution",
  countErrorsByFile(
    `src/__tests__/q.test.ts(1,2): error TS2322: see other(9,9): error TS1: x`,
  ).get("src/__tests__/q.test.ts") === 1,
);

const baseline = { "a.test.ts": 2, "b.test.ts": 1 };

check(
  "unchanged counts hold",
  compareToBaseline(new Map([["a.test.ts", 2], ["b.test.ts", 1]]), baseline).regressed.length === 0,
);
check(
  "a file gaining an error regresses",
  compareToBaseline(new Map([["a.test.ts", 3], ["b.test.ts", 1]]), baseline).regressed.length === 1,
);
// New files start with a zero-error baseline.
check(
  "a NEW file with any error regresses",
  compareToBaseline(new Map([["brand-new.test.ts", 1]]), baseline).regressed.length === 1,
);
check(
  "a file losing an error is an improvement, not a failure",
  (() => {
    const r = compareToBaseline(new Map([["a.test.ts", 1], ["b.test.ts", 1]]), baseline);
    return r.regressed.length === 0 && r.improved.length === 1;
  })(),
);
check(
  "a file dropping to zero is reported as fixed",
  (() => {
    const r = compareToBaseline(new Map([["a.test.ts", 2]]), baseline);
    return r.regressed.length === 0 && r.fixed.includes("b.test.ts");
  })(),
);
// Comparison alone treats empty output as fixed; the runner must refuse it when errors were expected.
check(
  "an empty run reports every baselined file as fixed",
  compareToBaseline(new Map(), baseline).fixed.length === 2,
);
check(
  "an empty measurement against a non-empty baseline is refused",
  isEmptyMeasurementAgainstBaseline(new Map(), baseline) === true,
);
check(
  "an empty measurement against an EMPTY baseline is allowed",
  isEmptyMeasurementAgainstBaseline(new Map(), {}) === false,
);
check(
  "a non-empty measurement is never treated as empty",
  isEmptyMeasurementAgainstBaseline(new Map([["a.test.ts", 1]]), baseline) === false,
);

// Compare listFiles from the measured invocation with an independent source inventory.
const EXPECTED_SOURCE_INVENTORY = expectedSourceFilesFromGitOutput(
  [
    "src/a.test.ts",
    "scripts/check.mts",
    "test/runner.cts",
    "src/__probes__/excluded.ts",
    "src/preload.cjs.ts",
    "README.md",
    "",
  ].join("\0"),
  () => true,
);
check(
  "the independent source inventory includes intended TypeScript files only",
  [...EXPECTED_SOURCE_INVENTORY].sort().join(",")
    === "scripts/check.mts,src/a.test.ts,test/runner.cts",
);
check(
  "a source deleted from disk is not required by the inventory",
  !expectedSourceFilesFromGitOutput(
    "src/present.test.ts\0src/deleted.test.ts\0",
    (path) => !path.endsWith("deleted.test.ts"),
  ).has("src/deleted.test.ts"),
);
const LISTED_PROGRAM_SOURCES = programSourceFiles(
  [
    "src/a.test.ts",
    "scripts/check.mts",
    "test/runner.cts",
    "src/__probes__/excluded.ts",
    "node_modules/typescript/lib/lib.es2023.d.ts",
  ].join("\n"),
);
check("listFiles parsing keeps intended program sources", LISTED_PROGRAM_SOURCES.has("src/a.test.ts"));
check("listFiles parsing ignores dependency declarations", !LISTED_PROGRAM_SOURCES.has("node_modules/typescript/lib/lib.es2023.d.ts"));
const SELF_TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
check(
  "listFiles parsing normalizes an absolute source path",
  programSourceFiles(resolve(SELF_TEST_ROOT, "src", "a.test.ts")).has("src/a.test.ts"),
);
check(
  "coverage reports an expected source omitted from the compiler program",
  missingExpectedSources(EXPECTED_SOURCE_INVENTORY, new Set(["src/a.test.ts", "scripts/check.mts"]))
    .join(",") === "test/runner.cts",
);
let measuredCompilerArgs = [];
const measuredListFiles = runTsc((_command, args) => {
  measuredCompilerArgs = args;
  return {
    status: 1,
    signal: null,
    stdout: "src/a.test.ts\nscripts/check.mts\n",
    stderr: "",
  };
});
check(
  "the diagnostic measurement asks its same compiler invocation for listFiles",
  measuredCompilerArgs.includes("--listFiles")
    && measuredListFiles.programFiles.has("src/a.test.ts")
    && measuredListFiles.programFiles.has("scripts/check.mts"),
);
let inventoryCommand;
let inventoryArgs;
const measuredInventory = readExpectedSourceFiles(
  (command, args) => {
    inventoryCommand = command;
    inventoryArgs = args;
    return {
      status: 0,
      signal: null,
      stdout: args.includes("--others")
        ? "src/tracked.test.ts\0src/untracked.test.ts\0"
        : "src/tracked.test.ts\0",
      stderr: "",
    };
  },
  () => true,
);
let emptyTrackedRefused = false;
try {
  readExpectedSourceFiles((command, args) => ({
    status: 0, signal: null,
    stdout: args.includes("--others") ? "src/untracked.test.ts\0" : "",
    stderr: "",
  }), () => true);
} catch (error) {
  emptyTrackedRefused = /empty tracked TypeScript source inventory/.test(String(error));
}
check("an untracked-only inventory cannot establish coverage", emptyTrackedRefused);
check(
  "the independent inventory asks Git for tracked and untracked intended sources",
  inventoryCommand === "git"
    && inventoryArgs.join(",")
      === "ls-files,-z,--cached,--others,--exclude-standard,--,src,scripts,test"
    && measuredInventory.has("src/tracked.test.ts")
    && measuredInventory.has("src/untracked.test.ts"),
);

const RUNNER_BASELINE = {
  exists: true,
  files: { "src/a.test.ts": 2, "src/b.test.ts": 1 },
};
const RUNNER_EXPECTED = new Set(["src/a.test.ts", "src/b.test.ts"]);
function gateMeasurement(counts, programFiles = RUNNER_EXPECTED, tscStdout = "") {
  return { counts, programFiles: new Set(programFiles), tscStdout };
}
const RUNNER_HELD = gateMeasurement(
  new Map([["src/a.test.ts", 2], ["src/b.test.ts", 1]]),
);
function gateDeps(overrides = {}) {
  return {
    argv: [],
    loadBaseline: () => RUNNER_BASELINE,
    measure: () => RUNNER_HELD,
    loadExpectedInventory: () => RUNNER_EXPECTED,
    ...overrides,
  };
}
function runGateCase(overrides = {}) {
  const writes = [];
  const stdout = [];
  const stderr = [];
  const exitCode = runGate(gateDeps({
    saveBaseline: (payload) => writes.push(payload),
    writeStdout: (message) => stdout.push(message),
    writeStderr: (message) => stderr.push(message),
    ...overrides,
  }));
  return { exitCode, writes, stdout, stderr };
}

const emptyUpdate = runGateCase({
  argv: ["--update-baseline"],
  measure: () => gateMeasurement(new Map(), new Set()),
});
check(
  "runner refuses an empty update before it writes",
  emptyUpdate.exitCode === 1
    && emptyUpdate.writes.length === 0
    && emptyUpdate.stderr.join("").includes("produced no diagnostics"),
);
const emptyCompare = runGateCase({
  measure: () => gateMeasurement(new Map(), new Set()),
});
check(
  "runner refuses an empty measurement before it compares",
  emptyCompare.exitCode === 1
    && emptyCompare.writes.length === 0
    && emptyCompare.stdout.length === 0
    && emptyCompare.stderr.join("").includes("produced no diagnostics"),
);
const nonSourceUpdate = runGateCase({
  argv: ["--update-baseline"],
  measure: () => gateMeasurement(new Map([["tsconfig.json", 1]]), new Set()),
});
check(
  "runner refuses a non-source update before it writes",
  nonSourceUpdate.exitCode === 1
    && nonSourceUpdate.writes.length === 0
    && nonSourceUpdate.stderr.join("").includes("non-source files"),
);
const narrowedProgramUpdate = runGateCase({
  argv: ["--update-baseline"],
  measure: () => gateMeasurement(
    new Map([["src/a.test.ts", 2]]),
    new Set(["src/a.test.ts"]),
  ),
});
check(
  "runner refuses a non-empty but narrowed program before it writes",
  narrowedProgramUpdate.exitCode === 1
    && narrowedProgramUpdate.writes.length === 0
    && narrowedProgramUpdate.stderr.join("").includes("omitted 1 expected"),
);
const narrowedProgramCompare = runGateCase({
  measure: () => gateMeasurement(
    new Map([["src/a.test.ts", 2]]),
    new Set(["src/a.test.ts"]),
  ),
});
check(
  "runner refuses a non-empty but narrowed program before it compares",
  narrowedProgramCompare.exitCode === 1
    && narrowedProgramCompare.writes.length === 0
    && narrowedProgramCompare.stdout.length === 0
    && narrowedProgramCompare.stderr.join("").includes("omitted 1 expected"),
);
const emptyInventoryUpdate = runGateCase({
  argv: ["--update-baseline"],
  loadExpectedInventory: () => new Set(),
});
check(
  "runner refuses an empty independent inventory before it writes",
  emptyInventoryUpdate.exitCode === 1
    && emptyInventoryUpdate.writes.length === 0
    && emptyInventoryUpdate.stderr.join("").includes("inventory was empty"),
);
let measuredAfterInventoryError = false;
const inventoryError = runGateCase({
  loadExpectedInventory: () => {
    throw new Error("git returned an empty tracked TypeScript source inventory");
  },
  measure: () => {
    measuredAfterInventoryError = true;
    return RUNNER_HELD;
  },
});
check(
  "runner refuses an inventory error before it starts the compiler",
  inventoryError.exitCode === 1
    && !measuredAfterInventoryError
    && inventoryError.writes.length === 0
    && inventoryError.stderr.join("").includes("empty tracked TypeScript source inventory"),
);
const emptyInventoryCompare = runGateCase({
  loadExpectedInventory: () => new Set(),
});
check(
  "runner refuses an empty independent inventory before it compares",
  emptyInventoryCompare.exitCode === 1
    && emptyInventoryCompare.writes.length === 0
    && emptyInventoryCompare.stdout.length === 0
    && emptyInventoryCompare.stderr.join("").includes("inventory was empty"),
);
const bootstrapWrite = runGateCase({
  argv: ["--update-baseline"],
  loadBaseline: () => ({ exists: false, files: {} }),
  loadExpectedInventory: () => new Set(["src/bootstrap.test.ts"]),
  measure: () => gateMeasurement(
    new Map([["src/bootstrap.test.ts", 1]]),
    new Set(["src/bootstrap.test.ts"]),
  ),
});
check(
  "a complete first program bootstraps a baseline",
  bootstrapWrite.exitCode === 0
    && bootstrapWrite.writes.length === 1
    && bootstrapWrite.writes[0].files["src/bootstrap.test.ts"] === 1,
);
const heldRunner = runGateCase();
check(
  "a complete unchanged program holds",
  heldRunner.exitCode === 0
    && heldRunner.writes.length === 0
    && heldRunner.stdout.join("").includes("baseline held"),
);
const originalExitCode = process.exitCode;
process.exitCode = 0;
const regressionExitCode = main(gateDeps({
  measure: () => gateMeasurement(
    new Map([["src/a.test.ts", 3], ["src/b.test.ts", 1]]),
  ),
  writeStdout: () => {},
  writeStderr: () => {},
}));
const assignedExitCode = process.exitCode;
process.exitCode = originalExitCode ?? 0;
check(
  "a regression reaches the CLI exit code",
  regressionExitCode === 1 && assignedExitCode === 1,
);
const signalFailure = runGateCase({
  measure: () => runTsc(() => ({
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  })),
});
check(
  "a compiler signal becomes a failing runner exit",
  signalFailure.exitCode === 1 && signalFailure.stderr.join("").includes("terminated by signal"),
);
const unexpectedStatus = runGateCase({
  measure: () => runTsc(() => ({
    status: 3,
    signal: null,
    stdout: "",
    stderr: "",
  })),
});
check(
  "an unaccepted compiler status becomes a failing runner exit",
  unexpectedStatus.exitCode === 1 && unexpectedStatus.stderr.join("").includes("tsc exited 3"),
);

// Program-construction failures may have no source location and no measured errors.
const CONFIG_UNATTRIBUTED = [
  `error TS6059: File 'C:/x/outside.ts' is not under 'rootDir' 'C:/x/src'. 'rootDir' is expected to contain all source files.`,
  `  The file is in the program because:`,
  `    Matched by include pattern '../outside.ts' in 'C:/x/tsconfig.json'`,
].join("\n");
check(
  "an unattributed config diagnostic yields no per-file counts",
  countErrorsByFile(CONFIG_UNATTRIBUTED).size === 0,
);
check(
  "an unattributed diagnostic is detected as program-level",
  unattributedDiagnostics(CONFIG_UNATTRIBUTED).length === 1,
);
// Per-file diagnostics must not be mistaken for program errors.
check(
  "a real per-file diagnostic is not program-level",
  unattributedDiagnostics(TSC_OUTPUT).length === 0,
);
// Empty measurements must be refused outside the per-file parser.
check(
  "and is therefore caught by the empty-measurement refusal",
  isEmptyMeasurementAgainstBaseline(countErrorsByFile(CONFIG_UNATTRIBUTED), baseline) === true,
);

// Attributed configuration errors need the non-source check, even with non-empty output.
const CONFIG_ATTRIBUTED = countErrorsByFile(
  `../../tmp/cfg/tsconfig.json(1,76): error TS5023: Unknown compiler option 'typo'.`,
);
check("a config diagnostic attributed to tsconfig does parse", CONFIG_ATTRIBUTED.size === 1);
check(
  "a measurement naming a non-source file is refused",
  nonSourceMeasurements(CONFIG_ATTRIBUTED).length === 1,
);
check(
  "real TypeScript sources are never flagged as non-source",
  nonSourceMeasurements(
    new Map([
      ["src/a.test.ts", 1],
      ["src/b.test.tsx", 1],
      // Directory dots are not file extensions.
      ["src/v1.2/c.test.ts", 1],
      // Declaration modules are source files, not configuration diagnostics.
      ["scripts/electron-flags.d.mts", 1],
      ["scripts/uv-targets.d.mts", 1],
      ["scripts/legacy.cts", 1],
    ]),
  ).length === 0,
);
// The generated note must distinguish production entries from tests.
const ENTRIES = {
  "src/a/__tests__/x.test.ts": 1,
  "src/__probes__/p.ts": 1,
  "test/renderer/helpers.ts": 1,
  "src/preload/internal-surface.ts": 4,
  "src/main/main-window.ts": 1,
};
check(
  "reports production files as non-test",
  nonTestEntries(ENTRIES).join(",")
    === "src/preload/internal-surface.ts,src/main/main-window.ts",
);
check("never reports a __tests__ file", !nonTestEntries(ENTRIES).some((f) => f.includes("__tests__")));
check("never reports a __probes__ file", !nonTestEntries(ENTRIES).some((f) => f.includes("__probes__")));
check("never reports a test/ file", !nonTestEntries(ENTRIES).some((f) => f.startsWith("test/")));

// Incremental caches from different options can change counts for unchanged source.
// Ask the compiler for the effective setting; config resolution is not a typecheck.
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function effectiveIncremental(configName) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(ROOT_DIR, "node_modules", "typescript", "lib", "tsc.js"),
      "-p", resolve(ROOT_DIR, configName), "--showConfig",
    ],
    { cwd: ROOT_DIR, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tsc --showConfig failed: ${result.stderr}`);
  return JSON.parse(result.stdout)?.compilerOptions?.incremental;
}
// Undefined also means incremental compilation is off; do not require an explicit false.
check("the gate's program is not incremental", effectiveIncremental("tsconfig.tests.json") !== true);

// Only missing baseline files may bootstrap; corrupt or unreadable files must throw.
const scratch = mkdtempSync(join(tmpdir(), "typecheck-gate-selftest-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const goodPath = join(scratch, "good.json");
writeFileSync(goodPath, JSON.stringify({ schemaVersion: 1, files: { "a.test.ts": 2 } }), "utf8");
const badPath = join(scratch, "bad.json");
writeFileSync(badPath, "not json at all", "utf8");
check(
  "a MISSING baseline reads as empty, so bootstrapping is possible",
  Object.keys(readBaselineFilesOrEmpty(join(scratch, "absent.json"))).length === 0,
);
check("a valid baseline returns its files", readBaselineFilesOrEmpty(goodPath)["a.test.ts"] === 2);
check(
  "a MALFORMED baseline throws rather than reading as empty",
  (() => {
    try { readBaselineFilesOrEmpty(badPath); return false; } catch { return true; }
  })(),
);
// Use a directory for a portable non-ENOENT read failure; permission fixtures vary by platform.
check(
  "a non-ENOENT read error throws rather than reading as empty",
  (() => {
    try { readBaselineFilesOrEmpty(scratch); return false; } catch { return true; }
  })(),
);
const invalidBaselines = [
  ["a non-object baseline", []],
  ["a baseline with a stale schema", { schemaVersion: 0, files: {} }],
  ["a baseline missing files", { schemaVersion: 1 }],
  ["a baseline with null files", { schemaVersion: 1, files: null }],
  ["a baseline with array files", { schemaVersion: 1, files: [] }],
  ["a baseline with a negative count", { schemaVersion: 1, files: { "a.test.ts": -1 } }],
  ["a baseline with a fractional count", { schemaVersion: 1, files: { "a.test.ts": 1.5 } }],
  ["a baseline with a string count", { schemaVersion: 1, files: { "a.test.ts": "1" } }],
];
for (const [name, payload] of invalidBaselines) {
  const invalidPath = join(scratch, `${name.replaceAll(" ", "-")}.json`);
  writeFileSync(invalidPath, JSON.stringify(payload), "utf8");
  check(
    `${name} throws rather than reading as empty`,
    (() => {
      try { readBaselineFilesOrEmpty(invalidPath); return false; } catch { return true; }
    })(),
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `[test-typecheck-self-test] the gate is not detecting what it claims:\n  ${failures.join("\n  ")}\n`,
  );
  process.exit(1);
}
process.stdout.write("[test-typecheck-self-test] OK\n");
