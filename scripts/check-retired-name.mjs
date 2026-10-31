#!/usr/bin/env node
// Reject retired names and plugin ids in tracked paths and content.
// Exact-text exceptions must stay necessary; stale exceptions fail.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutGitContext } from "./lib/git-process-environment.mjs";
import { RETIRED_PLUGIN_IDS, retiredPluginId, retiredPluginPattern } from "./lib/retired-plugin-ids.mjs";

export const RETIRED_NAME = String.fromCodePoint(0x6c, 0x76, 0x69, 0x73);

const ANY_CASE = [...RETIRED_NAME].map((letter) => `[${letter}${letter.toUpperCase()}]`).join("");
const CAPITALIZED = RETIRED_NAME[0].toUpperCase() + RETIRED_NAME.slice(1);
const CAPITALS = RETIRED_NAME.toUpperCase();

// Keep camel-case matching case-sensitive to avoid crossing unrelated word boundaries.
export const RETIRED_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z])${ANY_CASE}|(?<=[a-z0-9])${CAPITALIZED}|(?<=[a-z0-9])${CAPITALS}`,
  "u",
);

// A trailing slash covers a directory; other entries name exact paths.
export const ALLOWLIST = Object.freeze([]);

// Mask only exact allowed text, preserving surrounding boundaries.
// {id} and {Id} expand the stored id without spelling retired names here.
export const RETIRED_PLUGIN_ALLOWLIST = Object.freeze([]);

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

function matchingLines(text) {
  const lines = [];
  text.split("\n").forEach((line, index) => {
    if (RETIRED_NAME_PATTERN.test(line)) lines.push(index + 1);
  });
  return lines;
}

// Report path and content matches separately; unused allow-list entries are stale.
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
          remainder = remainder.replaceAll(item.needle, " ".repeat(item.needle.length));
        }
        if (pattern.test(remainder)) hits.push(index + 1);
      });
      if (inPath || hits.length > 0) offenders.push({ path, id, inPath, lines: hits });
    }
  }
  const stale = allowed.filter((item) => !used.has(item)).map((item) => `${item.path}: ${item.needle}`);
  return { offenders, stale };
}

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
