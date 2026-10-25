// Build positive controls from RETIRED_NAME without spelling the forbidden name.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import {
  ALLOWLIST,
  RETIRED_NAME,
  RETIRED_NAME_PATTERN,
  RETIRED_PLUGIN_ALLOWLIST,
  scanRetiredName,
  scanRetiredPluginIds,
} from "../../scripts/check-retired-name.mjs";
import { RETIRED_PLUGIN_IDS, retiredPluginId, retiredPluginPattern } from "../../scripts/lib/retired-plugin-ids.mjs";

const lower = RETIRED_NAME;
const upper = RETIRED_NAME.toUpperCase();
const capitalized = upper[0] + lower.slice(1);

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

// Pin code points independently of controls derived from the same constant.
test("pins the retired name by its sha256 and length", () => {
  assert.equal(RETIRED_NAME.length, 4);
  assert.equal(createHash("sha256").update(RETIRED_NAME).digest("hex"), "7899e2167ac27be58f7f4ed7adc44d7e2502353cc470275c3ad031f61145acb0");
});

test("pins the pattern by the sha256 of its source and its flags", () => {
  assert.equal(RETIRED_NAME_PATTERN.flags, "u");
  assert.equal(createHash("sha256").update(RETIRED_NAME_PATTERN.source).digest("hex"), "7b780cc632a81f66abba9aa6caf3a574890604a17bf2959f3a8c9ba7d84a8c44");
});

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
  const f = fixture({ "src/b.ts": "const modelVisible = true; // Vision, devisable, ELVISH, callVisitor\n" });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), { offenders: [], stale: [] });
  } finally {
    f.cleanup();
  }
  for (const word of ["modelVisible", "modelVision", "modelVisionEnabled", "toolVisibility", "Vision", "Elvis", "ELVIS", "visible", "callVisitor"]) {
    assert.equal(RETIRED_NAME_PATTERN.test(word), false, word);
  }
  for (const word of [upper, `${lower}-app`, `${upper}KEEP`, `@${lower}/plugin`, `_${upper}_HOME`]) assert.equal(RETIRED_NAME_PATTERN.test(word), true, word);
});

test("matches the name inside a camelCase identifier, Capitalized or in capitals", () => {
  for (const word of [`define${capitalized}PluginConfig`, `managed${capitalized}`, `source${upper}`, `v2${upper}_HOME`, `const x = new ${capitalized}Host();`]) {
    assert.equal(RETIRED_NAME_PATTERN.test(word), true, word);
  }
  const f = fixture({ "src/c.ts": `export default define${capitalized}PluginConfig([]);\nconst ok = modelVision;\nconst y = source${upper};\n` });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), { offenders: [{ path: "src/c.ts", inPath: false, lines: [1, 3] }], stale: [] });
  } finally {
    f.cleanup();
  }
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

// Derive retired plugin controls from the ID list without spelling forbidden IDs.
const cap = (word) => word[0].toUpperCase() + word.slice(1);

test("lists each retired id once, as lower-case words", () => {
  const ids = RETIRED_PLUGIN_IDS.map(retiredPluginId);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of RETIRED_PLUGIN_IDS) {
    assert.ok(entry.words.length >= 2, retiredPluginId(entry));
    for (const word of entry.words) assert.match(word, /^[a-z]+$/u);
    assert.ok(entry.reason.length > 0);
  }
});

test("matches a retired id as a plugin id, tool name, path segment and camelCase identifier", () => {
  for (const entry of RETIRED_PLUGIN_IDS) {
    const id = retiredPluginId(entry);
    const pattern = retiredPluginPattern(entry);
    const snake = id.replaceAll("-", "_");
    const camel = entry.words.map(cap).join("");
    for (const spelling of [
      `"${id}"`, `${snake}_list_items`, `${snake}.work_item.due_soon`, `~/.ave/plugins/${id}/data`,
      `persist:plugin-auth:${id}`, `migrate${camel}Board`, `${camel}Panel`, `const ${entry.words[0]}${cap(entry.words[1])} = 1`,
      `${snake.toUpperCase()}_HOME`,
    ]) {
      assert.equal(pattern.test(spelling), true, `${id}: ${spelling}`);
    }
  }
});

test("does not match a retired id's words as prose, inside a longer word, or as a live catalog name", () => {
  for (const entry of RETIRED_PLUGIN_IDS) {
    const id = retiredPluginId(entry);
    const pattern = retiredPluginPattern(entry);
    const prose = entry.words.map(cap).join(" ");
    for (const text of [`the ${prose} service`, `${prose} 플러그인`, `${id}s`, `x${entry.words.join("")}y`, "korea-weather", "imported-from-proactive"]) {
      assert.equal(pattern.test(text), false, `${id}: ${text}`);
    }
    if (entry.separator === "") assert.equal(pattern.test(entry.words.join("_")), false, `${id}: separated words are ordinary`);
  }
});

test("flags a retired id in tracked content and paths, and exempts only allowlisted lines by exact text", () => {
  const [entry] = RETIRED_PLUGIN_IDS;
  const id = retiredPluginId(entry);
  const f = fixture({
    "src/a.test.ts": `const ok = 1;\ninvoke("uninstall", "${id}");\n`,
    [`docs/${id}.md`]: "Clean.\n",
    "docs/kept.md": `- [Kept](#10-${id}--heading)\n- another \`${id}\` mention\n`,
  });
  const allowlist = [
    { path: "docs/kept.md", words: entry.words, text: "](#10-{id}--heading)", reason: "anchor" },
    { path: "docs/gone.md", words: entry.words, text: "{id}", reason: "nothing left here" },
  ];
  try {
    const { offenders, stale } = scanRetiredPluginIds(f.root, allowlist, [entry]);
    assert.deepEqual(offenders, [
      { path: `docs/${id}.md`, id, inPath: true, lines: [] },
      { path: "docs/kept.md", id, inPath: false, lines: [2] },
      { path: "src/a.test.ts", id, inPath: false, lines: [2] },
    ]);
    assert.deepEqual(stale, [`docs/gone.md: ${id}`]);
  } finally {
    f.cleanup();
  }
});

test("names only known ids in the real plugin allowlist, each with a reason", () => {
  for (const item of RETIRED_PLUGIN_ALLOWLIST) {
    assert.ok(RETIRED_PLUGIN_IDS.some((entry) => entry.words.join(" ") === item.words.join(" ")), item.path);
    assert.ok(item.reason.length > 0 && item.text.length > 0, item.path);
  }
});
