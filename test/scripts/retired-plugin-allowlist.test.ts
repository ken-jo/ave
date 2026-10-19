import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import { scanRetiredPluginIds } from "../../scripts/check-retired-name.mjs";
import { RETIRED_PLUGIN_IDS, retiredPluginId, retiredPluginPattern } from "../../scripts/lib/retired-plugin-ids.mjs";

const entry = RETIRED_PLUGIN_IDS.find((item) => item.words.join(" ") === "page index")!;
const id = retiredPluginId(entry);
const libraryName = entry.words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
const path = "guide.md";
const libraryAllowance = { path, words: entry.words, text: "{Id}", reason: "external indexing library" };
const pinAllowance = { path, words: entry.words, text: "`{id}==0.2.8`", reason: "external library pin" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "ave-retired-plugin-allowlist-"));
  roots.push(root);
  const env = gitFixtureEnv(root);
  execFileSync("git", ["-C", root, "init", "-q"], { env });
  writeFileSync(join(root, path), content);
  execFileSync("git", ["-C", root, "add", "--", path], { env });
  return root;
}

test("rejects a retired id beside an allowed phrase on the same line", () => {
  const root = fixture(`${libraryName} pluginId="${id}"\n`);
  expect(scanRetiredPluginIds(root, [libraryAllowance], [entry])).toEqual({
    offenders: [{ path, id, inPath: false, lines: [1] }],
    stale: [],
  });
});

test.each(["before", "after"] as const)("rejects a retired id glued directly %s an allowed phrase", (placement) => {
  const [anchorEntry] = RETIRED_PLUGIN_IDS;
  const anchorId = retiredPluginId(anchorEntry);
  const anchor = `](#10-${anchorId}--heading)`;
  const allowance = { path, words: anchorEntry.words, text: "](#10-{id}--heading)", reason: "kept heading anchor" };
  const content = placement === "before" ? `${anchorId}${anchor}label` : `[Board${anchor}${anchorId}`;
  const root = fixture(`${content}\n`);
  expect(scanRetiredPluginIds(root, [allowance], [anchorEntry])).toEqual({
    offenders: [{ path, id: anchorId, inPath: false, lines: [1] }],
    stale: [],
  });
});

test("accepts an allowed phrase alone", () => {
  const root = fixture(`${libraryName}\n`);
  expect(scanRetiredPluginIds(root, [libraryAllowance], [entry])).toEqual({ offenders: [], stale: [] });
});

test("masks every occurrence of every matching allowance on a line", () => {
  const root = fixture(`${libraryName} \`${id}==0.2.8\` ${libraryName} \`${id}==0.2.8\`\n`);
  expect(scanRetiredPluginIds(root, [libraryAllowance, pinAllowance], [entry])).toEqual({ offenders: [], stale: [] });
});

test("rejects a retired id after multiple allowed phrases on the same line", () => {
  const root = fixture(`${libraryName} \`${id}==0.2.8\` pluginId="${id}"\n`);
  expect(scanRetiredPluginIds(root, [libraryAllowance, pinAllowance], [entry])).toEqual({
    offenders: [{ path, id, inPath: false, lines: [1] }],
    stale: [],
  });
});

test("reports each stale allowance even when another allowance matches", () => {
  const root = fixture(`${libraryName}\n`);
  expect(scanRetiredPluginIds(root, [libraryAllowance, pinAllowance], [entry])).toEqual({
    offenders: [],
    stale: [`${path}: \`${id}==0.2.8\``],
  });
});

test("keeps the external underscored API distinct from the retired id", () => {
  const pattern = retiredPluginPattern(entry);
  expect(pattern.test(`${entry.words.join("_")}()`)).toBe(false);
  expect(pattern.test(`pluginId="${id}"`)).toBe(true);
});
