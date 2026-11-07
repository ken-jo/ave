import test from "node:test";
import assert from "node:assert/strict";
import {
  compareBiomeBaseline,
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
