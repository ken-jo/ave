import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEmulatedViewports } from "../../scripts/check-e2e-window-size.mjs";

test("rejects emulated viewport calls in nested test helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "window-size-guard-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested/helper.ts"), "await page.setViewportSize ({ width: 900, height: 720 });\n");
    assert.deepEqual(findEmulatedViewports(root), ["nested/helper.ts:1"]);
    writeFileSync(join(root, "nested/helper.ts"), "\nawait page.setViewportSize\n({ width: 900, height: 720 });\n");
    assert.deepEqual(findEmulatedViewports(root), ["nested/helper.ts:2"]);
    writeFileSync(join(root, "nested/helper.ts"), "await setWindowSize(app, 900, 720);\n");
    assert.deepEqual(findEmulatedViewports(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
