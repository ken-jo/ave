/**
 * Self-test for the legacy product name gate.
 *
 * The gate keeps the app's former name (RETIREDNAME) out of every tracked file except
 * the legacy module and a short list of historical or published records. A gate
 * nobody has watched fail is a gate nobody can trust, so this pins each outcome
 * against throwaway Git repositories.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import { ALLOWLIST, LEGACY_NAME_PATTERN, scanLegacyProductName } from "../../scripts/check-legacy-product-name.mjs";

/** A repository whose index tracks `tracked`; `untracked` files are written but never added. */
function fixture(tracked, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), "ave-legacy-name-"));
  const env = gitFixtureEnv(root);
  execFileSync("git", ["-C", root, "init", "-q"], { env });
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  write(tracked);
  if (Object.keys(tracked).length > 0) execFileSync("git", ["-C", root, "add", "--", ...Object.keys(tracked)], { env });
  write(untracked);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("flags the former name in any tracked file, docs included, with its lines", () => {
  const f = fixture({
    "src/a.ts": "const x = 1;\nconst home = process.env.RETIREDNAME_HOME;\n",
    "docs/guide.md": "# Guide\n\nRun it from `~/.retiredname`.\n",
    "config/x.json": '{ "key": "xyz.retiredname-namespace" }\n',
  });
  try {
    const { offenders, stale } = scanLegacyProductName(f.root, []);
    assert.deepEqual(offenders, [
      { path: "config/x.json", lines: [1] },
      { path: "docs/guide.md", lines: [3] },
      { path: "src/a.ts", lines: [2] },
    ]);
    assert.deepEqual(stale, []);
  } finally {
    f.cleanup();
  }
});

test("does not match words that only contain the letters", () => {
  const f = fixture({ "src/b.ts": "const modelVisible = true; // Vision, devisable, ELVISH\n" });
  try {
    assert.deepEqual(scanLegacyProductName(f.root, []), { offenders: [], stale: [] });
  } finally {
    f.cleanup();
  }
  for (const word of ["modelVisible", "Vision", "ELVIS"]) assert.equal(LEGACY_NAME_PATTERN.test(word), false, word);
  for (const word of ["RETIREDNAME", "retiredname-app", "RETIREDNAMEKEEP", "_RETIREDNAME_HOME"]) assert.equal(LEGACY_NAME_PATTERN.test(word), true, word);
});

test("ignores untracked and binary files", () => {
  const f = fixture(
    { "assets/blob.bin": Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from("RETIREDNAME")]) },
    { "notes/scratch.md": "RETIREDNAME\n" },
  );
  try {
    assert.deepEqual(scanLegacyProductName(f.root, []), { offenders: [], stale: [] });
  } finally {
    f.cleanup();
  }
});

test("exempts allowlisted paths and prefixes, and reports an entry once nothing needs it", () => {
  const allowlist = [
    ["CHANGELOG.md", "release history"],
    ["published/1/", "published schemas"],
    ["docs/old.md", "nothing left here"],
  ];
  const f = fixture({
    "CHANGELOG.md": "- RETIREDNAME 0.1\n",
    "published/1/schema.json": '{ "$id": "https://retiredname.example/1" }\n',
    "docs/old.md": "Clean now.\n",
  });
  try {
    assert.deepEqual(scanLegacyProductName(f.root, allowlist), { offenders: [], stale: ["docs/old.md"] });
  } finally {
    f.cleanup();
  }
});

test("gives every real allowlist entry a reason and covers the legacy module", () => {
  for (const [entry, reason] of ALLOWLIST) {
    assert.ok(entry.length > 0 && !entry.startsWith("/"), entry);
    assert.ok(typeof reason === "string" && reason.trim().length > 0, entry);
  }
  assert.ok(ALLOWLIST.some(([entry]) => entry === "src/shared/legacy-product-name.ts"));
});
