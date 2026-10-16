#!/usr/bin/env node
/**
 * check-legacy-product-name.mjs — the app's former name stays where it is explained.
 *
 * Ave was previously named RETIREDNAME. Nobody reading this tree should have to look up
 * what that name means, so it may appear only in:
 *
 *   - `src/shared/legacy-product-name.ts`, the one module that holds the literals
 *     the app still needs to reject or ignore artifacts made under the old name;
 *   - the historical or externally published records in ALLOWLIST, each with the
 *     reason it cannot be renamed.
 *
 * Every tracked file is scanned (binary files excepted), documentation included.
 * The match needs a non-letter before the name, so words that merely contain the
 * letters (`modelVisible`, `Vision`) never match. An ALLOWLIST entry that no
 * longer matches any file is stale and fails as well, so the list can only shrink.
 * Run standalone with `node scripts/check-legacy-product-name.mjs`; the scanner is
 * exported so `test/scripts/legacy-product-name.test.mjs` can exercise it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutGitContext } from "./lib/git-process-environment.mjs";

export const LEGACY_NAME_PATTERN = /(?<![A-Za-z])retiredname/i;

/**
 * Where the former name may stay. An entry ending in `/` covers every tracked
 * file under it; any other entry is one exact path.
 */
export const ALLOWLIST = Object.freeze([
  ["src/shared/legacy-product-name.ts", "the one module that holds the legacy literals the app still rejects or ignores"],
  ["src/plugins/public-contract.ts", "holds the refused legacy extension namespace; the file is vendored byte-for-byte into plugin repositories and cannot import the legacy module"],
  ["src/shared/__tests__/legacy-product-name.test.ts", "pins each legacy constant to its literal value, independently of the constants themselves"],
  ["src/permissions/judge/__tests__/judge-settings.test.ts", "proves the judge env refusal against the literal legacy variable name"],
  ["AGENTS.md", "the contributor contract's one line explaining the former name"],
  ["CHANGELOG.md", "release history; each entry keeps the names used when it was released"],
  ["web/public/schemas/plugin-host-protocol/1/", "published protocol 1 schemas; their `$id` keeps the origin they were published under (JSON carries no comment)"],
  ["web/public/schemas/plugin-host-protocol/2/", "published protocol 2 schemas; their `$id` keeps the origin they were published under (JSON carries no comment)"],
  ["web/infra/", "redirect infrastructure that answers the former site's hostnames; changing it redeploys production"],
  ["web/DEPLOY.md", "deploy runbook for that redirect infrastructure; any web/ change redeploys the site"],
  ["docs/blueprints/a2a-subagent-messaging.md", "merge evidence linking to repositories archived under the former name"],
  ["docs/design/plugin-hostapi-protocol.md", "historical evidence quotes from pinned commits of repositories archived under the former name"],
  ["docs/blueprints/multi-source-git-marketplace.md", "historical evidence quotes: the archived repositories by their real names"],
  ["docs/architecture/proposals/plugin-declared-category-legacy-removal.md", "historical record written under the former name; names and paths are as they were then"],
  ["docs/architecture/proposals/tailnet-observer-config-surface.md", "historical record written under the former name; names and paths are as they were then"],
  ["docs/blueprints/mcp-app-per-resource-capabilities.md", "historical record written under the former name; names and paths are as they were then"],
  ["docs/blueprints/memory-governance-p1-consolidation.md", "historical record written under the former name; names and paths are as they were then"],
  ["docs/ko/guides/local-plugin-development.md", "legacy-cleanup note for developers moving from the former name's directory layout"],
  ["src/marketplace/__tests__/fixtures/official-marketplace-6a4d3b3df.plugins.json", "a captured record of the official index as published at 6a4d3b3df"],
  ["test/scripts/web-site-contract.test.ts", "asserts the published schemas keep their original `$id` and the site never names the former product"],
  ["scripts/check-legacy-product-name.mjs", "this gate, which states the pattern"],
  ["test/scripts/legacy-product-name.test.mjs", "this gate's self-test fixtures"],
]);

const BINARY_PROBE_BYTES = 8000;

function trackedFiles(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "buffer", env: withoutGitContext(), maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`[legacy-product-name] git ls-files failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function allowlistEntry(path, allowlist) {
  return allowlist.find(([entry]) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** Lines (1-based) of `text` that carry the former name. */
function matchingLines(text) {
  const lines = [];
  text.split("\n").forEach((line, index) => {
    if (LEGACY_NAME_PATTERN.test(line)) lines.push(index + 1);
  });
  return lines;
}

/**
 * Scan the tracked files of `repoRoot`. `offenders` are files outside the
 * allowlist that carry the former name, with their line numbers; `stale` are
 * allowlist entries that no tracked file needs any more.
 */
export function scanLegacyProductName(repoRoot, allowlist = ALLOWLIST) {
  const offenders = [];
  const used = new Set();
  for (const path of trackedFiles(repoRoot)) {
    let bytes;
    try {
      bytes = readFileSync(resolve(repoRoot, path));
    } catch (error) {
      // A tracked path deleted in the working tree carries nothing to check.
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
    const lines = matchingLines(bytes.toString("utf8"));
    if (lines.length === 0) continue;
    const entry = allowlistEntry(path, allowlist);
    if (entry) {
      used.add(entry[0]);
      continue;
    }
    offenders.push({ path, lines });
  }
  const stale = allowlist.map(([entry]) => entry).filter((entry) => !used.has(entry));
  return { offenders, stale };
}

// Same guard shape as `check-source-text-safe.mjs`.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const { offenders, stale } = scanLegacyProductName(resolve(import.meta.dirname, ".."));
  if (stale.length > 0) {
    console.error(
      "[legacy-product-name] FAIL — these ALLOWLIST entries no longer match any file and\n"
        + "must be removed from scripts/check-legacy-product-name.mjs:\n"
        + stale.map((entry) => `  ${entry}`).join("\n"),
    );
    process.exit(1);
  }
  if (offenders.length > 0) {
    console.error(
      "[legacy-product-name] FAIL — the app's former name appears outside its allowlist.\n"
        + "Use the current name (Ave). Code that must still recognise an old artifact imports\n"
        + "the literal from src/shared/legacy-product-name.ts instead of spelling it.\n"
        + offenders.map(({ path, lines }) => `  ${path}:${lines.slice(0, 8).join(",")}`).join("\n"),
    );
    process.exit(1);
  }
  console.log("[legacy-product-name] OK");
}
