// Raw control bytes can hide files from text review and policy scans; test every verdict.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { scanSourceTextSafety } from "../../scripts/check-source-text-safe.mjs";

test("rejects unregistered document reads in this check and spawned Node checks", () => {
  const guide = resolve(import.meta.dirname, "../../docs/guides/getting-started.md");
  assert.throws(() => readFileSync(guide, "utf8"), /document-consumer/);
  const child = spawnSync(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1])", guide], {
    encoding: "utf8",
    env: process.env,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /document-consumer/);
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "ave-text-safe-"));
  mkdirSync(join(root, "src"));
  return root;
}

test("flags a raw control byte and reports where it is", () => {
  const root = fixtureRoot();
  try {
    // A raw control byte inside a regex character class must still be detected.
    writeFileSync(join(root, "src", "bad.ts"), Buffer.from("const RE = /[\u0000-\u001f]/;\n", "latin1"));
    const { offenders, stale } = scanSourceTextSafety(root, ["src"], []);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0], /^src\/bad\.ts: offset \d+ = 0x00/);
    assert.deepEqual(stale, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts the escaped spelling, plus tab, LF, and CR", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "src", "good.ts"),
      "const RE = /[\\u0000-\\u001f\\u007f]/;\r\n\tconst indented = RE;\n",
    );
    assert.deepEqual(scanSourceTextSafety(root, ["src"], []), { offenders: [], stale: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exempts a grandfathered file but reports it once it is clean", () => {
  const root = fixtureRoot();
  try {
    const rel = "src/legacy.ts";
    writeFileSync(join(root, "src", "legacy.ts"), Buffer.from("const x = \"\u0000\";\n", "latin1"));
    assert.deepEqual(scanSourceTextSafety(root, ["src"], [rel]), { offenders: [], stale: [] });

    writeFileSync(join(root, "src", "legacy.ts"), "const x = \"\\u0000\";\n");
    assert.deepEqual(scanSourceTextSafety(root, ["src"], [rel]), { offenders: [], stale: [rel] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores files that are not source", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, "src", "fixture.bin"), Buffer.from([0x00, 0x01, 0x02]));
    assert.deepEqual(scanSourceTextSafety(root, ["src"], []), { offenders: [], stale: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
