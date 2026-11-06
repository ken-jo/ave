import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEmulatedViewports } from "../../scripts/check-e2e-window-size.mjs";

const forbiddenMethod = ["setViewport", "Size"].join("");

test("rejects direct, computed and destructured emulation in every test subtree", () => {
  const root = mkdtempSync(join(tmpdir(), "window-size-guard-"));
  try {
    for (const directory of ["e2e/ui", "screenshots", "scripts"]) {
      mkdirSync(join(root, directory), { recursive: true });
      for (const source of [
        `await page.${forbiddenMethod}({ width: 900, height: 720 });`,
        `await page.${forbiddenMethod}\n({ width: 900, height: 720 });`,
        `await page["${forbiddenMethod}"]({ width: 900, height: 720 });`,
        `const { ${forbiddenMethod}: resize } = page;`,
      ]) {
        writeFileSync(join(root, directory, "helper.ts"), `\n${source}\n`);
        assert.deepEqual(findEmulatedViewports(root), [`${join(directory, "helper.ts")}:2`]);
      }
      writeFileSync(join(root, directory, "helper.ts"), "await setWindowSize(app, 900, 720);\n");
      assert.deepEqual(findEmulatedViewports(root), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model layout specs use the shared native resize helper", () => {
  for (const name of ["model-capability-reports", "settings-model-list-layout", "settings-subscription-model-popup"]) {
    const source = readFileSync(new URL(`../e2e/ui/${name}.spec.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bsetContentSize\b/);
    assert.doesNotMatch(source, /(?:async\s+)?function\s+setWindowSize\b/);
    assert.match(source, /import\s*\{[^}]*\bsetWindowSize\b[^}]*}\s*from\s*["']\.\/seeded-electron\.js["']/);
    assert.match(source, /\bsetWindowSize\s*\(/);
  }
});
