#!/usr/bin/env node
/**
 * check-retired-name.mjs — a retired internal product name never comes back.
 *
 * The name is retired; see the private workspace for what it was. It may not
 * appear in any tracked file's content or path. The pattern is assembled from
 * code points below so that this gate does not spell it either.
 *
 * Every tracked file is scanned (binary files excepted), documentation included.
 * The name matches in any case after a non-letter (`_X_HOME`, `@x/plugin`), and
 * inside an identifier after a lower-case letter or digit when written
 * Capitalized or in capitals (`defineXPluginConfig`, `sourceX`). Words that
 * merely contain the letters (an `l` that ends one camelCase part before a
 * `Vis…` part, or a capital before the name) never match. The pattern is pinned
 * by sha256 in the self-test. ALLOWLIST is empty and should stay that way; an entry
 * that no longer matches any file is stale and fails as well, so the list can
 * only shrink. Run standalone with `node scripts/check-retired-name.mjs`; the
 * scanner is exported so `test/scripts/retired-name.test.mjs` can exercise it.
 *
 * The same gate keeps retired plugin ids out. Their list lives in
 * `scripts/lib/retired-plugin-ids.mjs`, the one source the host-source and tour
 * audits read as well. An id may stay only within the exact text that
 * RETIRED_PLUGIN_ALLOWLIST names, for a use that is not the retired plugin
 * (a third-party library, a heading anchor generated from kept prose); a stale
 * entry fails.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutGitContext } from "./lib/git-process-environment.mjs";
import { RETIRED_PLUGIN_IDS, retiredPluginId, retiredPluginPattern } from "./lib/retired-plugin-ids.mjs";

/** Retired internal product name; see the private workspace. Lower case. */
export const RETIRED_NAME = String.fromCodePoint(0x6c, 0x76, 0x69, 0x73);

const ANY_CASE = [...RETIRED_NAME].map((letter) => `[${letter}${letter.toUpperCase()}]`).join("");
const CAPITALIZED = RETIRED_NAME[0].toUpperCase() + RETIRED_NAME.slice(1);
const CAPITALS = RETIRED_NAME.toUpperCase();

/**
 * Case-sensitive on purpose: a case-insensitive camelCase branch would match
 * an `l` that ends one word part before a capitalized `Vis…` part.
 */
export const RETIRED_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z])${ANY_CASE}|(?<=[a-z0-9])${CAPITALIZED}|(?<=[a-z0-9])${CAPITALS}`,
  "u",
);

/**
 * Where the name may stay: `[path, reason]`. An entry ending in `/` covers
 * every tracked file under it; any other entry is one exact path. Empty.
 */
export const ALLOWLIST = Object.freeze([]);

/**
 * Exact text where a retired plugin id may stay: `{ path, words, text, reason }`.
 * `words` names the id as `RETIRED_PLUGIN_IDS` stores it. Only occurrences of
 * `text` in `path` are exempt; the rest of each line is still scanned. In `text`,
 * `{id}` stands for the id as spelled and `{Id}` for its Capitalized words,
 * so this list never spells an id either.
 */
export const RETIRED_PLUGIN_ALLOWLIST = Object.freeze([
  Object.freeze({
    path: "docs/ko/architecture/architecture.md",
    words: Object.freeze(["agent", "hub"]),
    text: "](#10-{id}--사용자-레플리카-메시지-보드-및-업무-보드)",
    reason: "table-of-contents link to the kept section heading; the anchor is generated from the heading's prose name",
  }),
  Object.freeze({
    path: "docs/ko/architecture/architecture.md",
    words: Object.freeze(["page", "index"]),
    text: "{Id}",
    reason: "the third-party tree-indexing library of that name, not the plugin id",
  }),
  Object.freeze({
    path: "docs/ko/architecture/architecture.md",
    words: Object.freeze(["page", "index"]),
    text: "`{id}==0.2.8`",
    reason: "the third-party library's pip pin, not the plugin id",
  }),
]);

const BINARY_PROBE_BYTES = 8000;

function trackedFiles(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "buffer", env: withoutGitContext(), maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`[retired-name] git ls-files failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function allowlistEntry(path, allowlist) {
  return allowlist.find(([entry]) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** Lines (1-based) of `text` that carry the name. */
function matchingLines(text) {
  const lines = [];
  text.split("\n").forEach((line, index) => {
    if (RETIRED_NAME_PATTERN.test(line)) lines.push(index + 1);
  });
  return lines;
}

/**
 * Scan the tracked files of `repoRoot`. `offenders` are files outside the
 * allowlist whose path or content carries the name: `lines` lists the content
 * lines, and `inPath` says whether the path itself does. `stale` are allowlist
 * entries that no tracked file needs any more.
 */
export function scanRetiredName(repoRoot, allowlist = ALLOWLIST) {
  const offenders = [];
  const used = new Set();
  for (const path of trackedFiles(repoRoot)) {
    const inPath = RETIRED_NAME_PATTERN.test(path);
    let lines = [];
    let bytes = null;
    try {
      bytes = readFileSync(resolve(repoRoot, path));
    } catch (error) {
      // A tracked path deleted in the working tree carries no content to check.
      if (error?.code !== "ENOENT") throw error;
    }
    if (bytes && !bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) lines = matchingLines(bytes.toString("utf8"));
    if (!inPath && lines.length === 0) continue;
    const entry = allowlistEntry(path, allowlist);
    if (entry) {
      used.add(entry[0]);
      continue;
    }
    offenders.push({ path, inPath, lines });
  }
  const stale = allowlist.map(([entry]) => entry).filter((entry) => !used.has(entry));
  return { offenders, stale };
}

function retiredEntry(words) {
  const entry = RETIRED_PLUGIN_IDS.find((candidate) => candidate.words.join(" ") === words.join(" "));
  if (!entry) throw new Error(`[retired-name] allowlist names an unknown retired id: ${words.join(" ")}`);
  return entry;
}

function allowedText(entry, text) {
  const capitalized = entry.words.map((word) => word[0].toUpperCase() + word.slice(1)).join(entry.join);
  return text.replaceAll("{id}", retiredPluginId(entry)).replaceAll("{Id}", capitalized);
}

/**
 * Scan the tracked files of `repoRoot` for retired plugin ids. `offenders` are
 * `{ path, id, inPath, lines }` for each file and id outside the allowlist;
 * `stale` are the allowlist entries (as `path: text`) that no line needs.
 */
export function scanRetiredPluginIds(repoRoot, allowlist = RETIRED_PLUGIN_ALLOWLIST, ids = RETIRED_PLUGIN_IDS) {
  const patterns = ids.map((entry) => [retiredPluginId(entry), retiredPluginPattern(entry)]);
  const allowed = allowlist.map((item) => {
    const entry = retiredEntry(item.words);
    return { ...item, id: retiredPluginId(entry), needle: allowedText(entry, item.text) };
  });
  const used = new Set();
  const offenders = [];
  for (const path of trackedFiles(repoRoot)) {
    let text = "";
    try {
      const bytes = readFileSync(resolve(repoRoot, path));
      if (!bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) text = bytes.toString("utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const lines = text.split("\n");
    for (const [id, pattern] of patterns) {
      const inPath = pattern.test(path);
      const hits = [];
      lines.forEach((line, index) => {
        let remainder = line;
        for (const item of allowed) {
          if (item.path !== path || item.id !== id || !line.includes(item.needle)) continue;
          used.add(item);
          remainder = remainder.replaceAll(item.needle, "");
        }
        if (pattern.test(remainder)) hits.push(index + 1);
      });
      if (inPath || hits.length > 0) offenders.push({ path, id, inPath, lines: hits });
    }
  }
  const stale = allowed.filter((item) => !used.has(item)).map((item) => `${item.path}: ${item.needle}`);
  return { offenders, stale };
}

// Same guard shape as `check-source-text-safe.mjs`.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const { offenders, stale } = scanRetiredName(repoRoot);
  if (stale.length > 0) {
    console.error(
      "[retired-name] FAIL — these ALLOWLIST entries no longer match any file and\n"
        + "must be removed from scripts/check-retired-name.mjs:\n"
        + stale.map((entry) => `  ${entry}`).join("\n"),
    );
    process.exit(1);
  }
  if (offenders.length > 0) {
    console.error(
      "[retired-name] FAIL — a retired internal product name appears in these tracked files.\n"
        + "Use the current name (Ave).\n"
        + offenders.map(({ path, inPath, lines }) =>
          `  ${path}${inPath ? " (path)" : ""}${lines.length > 0 ? `:${lines.slice(0, 8).join(",")}` : ""}`).join("\n"),
    );
    process.exit(1);
  }
  const plugins = scanRetiredPluginIds(repoRoot);
  if (plugins.stale.length > 0) {
    console.error(
      "[retired-name] FAIL — these RETIRED_PLUGIN_ALLOWLIST entries no longer match any line and\n"
        + "must be removed from scripts/check-retired-name.mjs:\n"
        + plugins.stale.map((entry) => `  ${entry}`).join("\n"),
    );
    process.exit(1);
  }
  if (plugins.offenders.length > 0) {
    console.error(
      "[retired-name] FAIL — a retired plugin id (scripts/lib/retired-plugin-ids.mjs) appears in these tracked files.\n"
        + "Use a neutral, hyphen-free fixture id in tests and a generic stand-in in documentation.\n"
        + plugins.offenders.map(({ path, id, inPath, lines }) =>
          `  ${path}${inPath ? " (path)" : ""}${lines.length > 0 ? `:${lines.slice(0, 8).join(",")}` : ""} [${id}]`).join("\n"),
    );
    process.exit(1);
  }
  console.log("[retired-name] OK");
}
