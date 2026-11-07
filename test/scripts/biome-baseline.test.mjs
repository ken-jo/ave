import test from "node:test";
import assert from "node:assert/strict";
import {
  BIOME_BASELINE_SCHEMA_VERSION,
  compareBiomeBaseline,
  evaluateBiomeBaseline,
  normalizeBiomeDiagnostics,
} from "../../scripts/lib/biome-baseline.mjs";

function report(diagnostics, diagnosticsNotPrinted = 0) {
  return { summary: { diagnosticsNotPrinted }, diagnostics };
}

function diagnostic(file, category, line = 1) {
  return { category, severity: "error", location: { path: file, start: { line, column: 1 } } };
}

test("counts diagnostics per file and category, dropping positions and path separators", () => {
  const entries = normalizeBiomeDiagnostics(report([
    diagnostic("src/b.ts", "lint/style/useConst", 9),
    diagnostic("src\\a.ts", "lint/suspicious/noDebugger", 3),
    diagnostic("src/b.ts", "lint/style/useConst", 40),
    { ...diagnostic("src/a.ts", "parse"), location: { path: { file: "src/a.ts" } } },
  ]));

  assert.deepEqual(entries, [
    { file: "src/a.ts", category: "lint/suspicious/noDebugger", count: 1 },
    { file: "src/a.ts", category: "parse", count: 1 },
    { file: "src/b.ts", category: "lint/style/useConst", count: 2 },
  ]);
});

test("refuses a truncated report and a diagnostic without a file", () => {
  assert.throws(() => normalizeBiomeDiagnostics(report([], 3)), /withheld 3/);
  assert.throws(
    () => normalizeBiomeDiagnostics(report([{ category: "lint/x/y", location: {} }])),
    /has no file path/,
  );
  assert.throws(() => normalizeBiomeDiagnostics({}), /missing its diagnostics array/);
});

test("reports count growth as added and count shrinkage as resolved", () => {
  const accepted = [
    { file: "src/a.ts", category: "lint/style/useConst", count: 2 },
    { file: "src/gone.ts", category: "lint/style/useConst", count: 1 },
  ];
  const current = [
    { file: "src/a.ts", category: "lint/style/useConst", count: 3 },
    { file: "src/new.ts", category: "lint/suspicious/noDebugger", count: 1 },
  ];

  assert.deepEqual(compareBiomeBaseline(current, accepted), {
    added: [
      { file: "src/a.ts", category: "lint/style/useConst", count: 1 },
      { file: "src/new.ts", category: "lint/suspicious/noDebugger", count: 1 },
    ],
    resolved: [{ file: "src/gone.ts", category: "lint/style/useConst", count: 1 }],
  });
  assert.deepEqual(
    compareBiomeBaseline(accepted, accepted),
    { added: [], resolved: [] },
  );
  assert.deepEqual(
    compareBiomeBaseline([{ ...accepted[0], count: 1 }], [accepted[0]]).resolved,
    [{ file: "src/a.ts", category: "lint/style/useConst", count: 1 }],
  );
});

test("sorts entries by code unit, not locale collation", () => {
  const entries = normalizeBiomeDiagnostics(report([
    diagnostic("src/b.ts", "lint/x/y"),
    diagnostic("src/B.ts", "lint/x/y"),
    diagnostic("src/a-b.ts", "lint/x/y"),
    diagnostic("src/a_b.ts", "lint/x/y"),
  ]));
  assert.deepEqual(entries.map((entry) => entry.file), ["src/B.ts", "src/a-b.ts", "src/a_b.ts", "src/b.ts"]);
});

const VERSION = "2.6.5";
const accepted = [{ file: "src/a.ts", category: "lint/style/useConst", count: 2 }];
function snapshot(entries = accepted, biomeVersion = VERSION) {
  return { schemaVersion: BIOME_BASELINE_SCHEMA_VERSION, biomeVersion, entries };
}

test("check mode fails on growth", () => {
  const result = evaluateBiomeBaseline(
    [{ ...accepted[0], count: 3 }],
    snapshot(),
    VERSION,
  );
  assert.match(result.failure.message, /new lint diagnostics exceed the reviewed baseline/);
  assert.deepEqual(result.failure.details, ["src/a.ts lint/style/useConst x1"]);
});

test("check mode fails on growth even when another entry shrinks, listing only the growth", () => {
  const result = evaluateBiomeBaseline(
    [
      { ...accepted[0], count: 1 },
      { file: "src/b.ts", category: "lint/suspicious/noDebugger", count: 1 },
    ],
    snapshot(),
    VERSION,
  );
  assert.match(result.failure.message, /new lint diagnostics exceed the reviewed baseline/);
  assert.deepEqual(result.failure.details, ["src/b.ts lint/suspicious/noDebugger x1"]);
  assert.equal(result.notice, null);
});

test("check mode passes on shrinkage with a lock-in notice", () => {
  const result = evaluateBiomeBaseline([{ ...accepted[0], count: 1 }], snapshot(), VERSION);
  assert.equal(result.failure, null);
  assert.match(result.notice.message, /^1 diagnostic\(s\) fixed; run `bun run check:biome:update` to lock in$/);
  assert.deepEqual(result.notice.details, ["src/a.ts lint/style/useConst x1"]);
  assert.deepEqual(evaluateBiomeBaseline(accepted, snapshot(), VERSION).notice, null);
});

test("check mode fails on a Biome version or schema mismatch", () => {
  assert.throws(
    () => evaluateBiomeBaseline(accepted, snapshot(accepted, "2.6.4"), VERSION),
    /baseline version 2\.6\.4 does not match 2\.6\.5/,
  );
  assert.throws(
    () => evaluateBiomeBaseline(accepted, { ...snapshot(), schemaVersion: 99 }, VERSION),
    /unsupported Biome baseline schema 99/,
  );
  assert.throws(
    () => evaluateBiomeBaseline(accepted, { ...snapshot(), entries: null }, VERSION),
    /entries must be an array/,
  );
});
