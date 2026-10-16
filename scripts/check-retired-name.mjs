#!/usr/bin/env node
/**
 * check-retired-name.mjs — a retired internal product name never comes back.
 *
 * The name is retired; see the private workspace for what it was. It may not
 * appear in any tracked file's content or path. The pattern is assembled from
 * code points below so that this gate does not spell it either.
 *
 * Every tracked file is scanned (binary files excepted), documentation included.
 * The match needs a non-letter before the name, so words that merely contain the
 * letters never match. ALLOWLIST is empty and should stay that way; an entry
 * that no longer matches any file is stale and fails as well, so the list can
 * only shrink. Run standalone with `node scripts/check-retired-name.mjs`; the
 * scanner is exported so `test/scripts/retired-name.test.mjs` can exercise it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutGitContext } from "./lib/git-process-environment.mjs";

/** Retired internal product name; see the private workspace. Lower case. */
export const RETIRED_NAME = String.fromCodePoint(0x6c, 0x76, 0x69, 0x73);

export const RETIRED_NAME_PATTERN = new RegExp(`(?<![A-Za-z])${RETIRED_NAME}`, "i");

/**
 * Where the name may stay: `[path, reason]`. An entry ending in `/` covers
 * every tracked file under it; any other entry is one exact path. Empty.
 */
export const ALLOWLIST = Object.freeze([]);

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

// Same guard shape as `check-source-text-safe.mjs`.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const { offenders, stale } = scanRetiredName(resolve(import.meta.dirname, ".."));
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
  console.log("[retired-name] OK");
}
