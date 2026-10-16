/**
 * Self-test for the retired-name gate.
 *
 * The gate keeps a retired internal product name out of every tracked file's
 * content and path. A gate nobody has watched fail is a gate nobody can trust,
 * so this pins each outcome against throwaway Git repositories. Like the gate,
 * it never spells the name: every positive control is built from RETIRED_NAME.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import { ALLOWLIST, RETIRED_NAME, RETIRED_NAME_PATTERN, scanRetiredName } from "../../scripts/check-retired-name.mjs";

const lower = RETIRED_NAME;
const upper = RETIRED_NAME.toUpperCase();

/** A repository whose index tracks `tracked`; `untracked` files are written but never added. */
function fixture(tracked, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), "ave-retired-name-"));
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

test("flags the name in any tracked file, docs included, with its lines", () => {
  const f = fixture({
    "src/a.ts": `const x = 1;\nconst home = process.env.${upper}_HOME;\n`,
    "docs/guide.md": `# Guide\n\nRun it from \`~/.${lower}\`.\n`,
    "config/x.json": `{ "key": "xyz.${lower}ai" }\n`,
  });
  try {
    const { offenders, stale } = scanRetiredName(f.root, []);
    assert.deepEqual(offenders, [
      { path: "config/x.json", inPath: false, lines: [1] },
      { path: "docs/guide.md", inPath: false, lines: [3] },
      { path: "src/a.ts", inPath: false, lines: [2] },
    ]);
    assert.deepEqual(stale, []);
  } finally {
    f.cleanup();
  }
});

test("flags the name in a tracked path even when the content is clean, binary files included", () => {
  const f = fixture({
    [`docs/${lower}-notes.md`]: "Clean.\n",
    [`assets/${upper}.bin`]: Buffer.from([0x00, 0x01]),
  });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), {
      offenders: [
        { path: `assets/${upper}.bin`, inPath: true, lines: [] },
        { path: `docs/${lower}-notes.md`, inPath: true, lines: [] },
      ],
      stale: [],
    });
  } finally {
    f.cleanup();
  }
});

test("does not match words that only contain the letters", () => {
  const f = fixture({ "src/b.ts": "const modelVisible = true; // Vision, devisable, ELVISH\n" });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), { offenders: [], stale: [] });
  } finally {
    f.cleanup();
  }
  for (const word of ["modelVisible", "Vision", "ELVIS"]) assert.equal(RETIRED_NAME_PATTERN.test(word), false, word);
  for (const word of [upper, `${lower}-app`, `${upper}KEEP`, `_${upper}_HOME`]) assert.equal(RETIRED_NAME_PATTERN.test(word), true, word);
});

test("ignores untracked files and binary content", () => {
  const f = fixture(
    { "assets/blob.bin": Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(upper)]) },
    { "notes/scratch.md": `${upper}\n` },
  );
  try {
    assert.deepEqual(scanRetiredName(f.root, []), { offenders: [], stale: [] });
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
    "CHANGELOG.md": `- ${upper} 0.1\n`,
    "published/1/schema.json": `{ "$id": "https://${lower}.example/1" }\n`,
    "docs/old.md": "Clean now.\n",
  });
  try {
    assert.deepEqual(scanRetiredName(f.root, allowlist), { offenders: [], stale: ["docs/old.md"] });
  } finally {
    f.cleanup();
  }
});

test("keeps the real allowlist empty", () => {
  assert.deepEqual(ALLOWLIST, []);
});
