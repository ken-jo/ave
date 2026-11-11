import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverScriptTests } from "../../scripts/run-script-tests.mjs";

test("discovers every script test in the repository", () => {
  const directory = new URL("./", import.meta.url);
  const expected = readdirSync(directory).filter((name) => name.endsWith(".test.mjs")).sort();
  assert.deepEqual(discoverScriptTests(directory), expected);
  assert.ok(expected.includes("run-script-tests.test.mjs"));
});

test("discovers newly added tests and excludes other entries", () => {
  const root = mkdtempSync(join(tmpdir(), "script-discovery-"));
  try {
    writeFileSync(join(root, "first.test.mjs"), "");
    writeFileSync(join(root, "helper.mjs"), "");
    mkdirSync(join(root, "directory.test.mjs"));
    assert.deepEqual(discoverScriptTests(root), ["first.test.mjs"]);
    writeFileSync(join(root, "added.test.mjs"), "");
    assert.deepEqual(discoverScriptTests(root), ["added.test.mjs", "first.test.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
