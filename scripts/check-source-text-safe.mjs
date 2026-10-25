#!/usr/bin/env node
// Reject raw control bytes that hide source from diffs and policy scans; use textual escapes.
// Ordinary tabs and line endings remain allowed.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const ROOTS = ["src", "scripts", "test"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", ".css"];
const ALLOWED_BYTES = new Set([0x09, 0x0a, 0x0d]);
const MAX_HITS_PER_FILE = 4;

// Existing control-byte exceptions are shrink-only; clean entries are stale.
const GRANDFATHERED = [
  "src/mcp/__tests__/mcp-app-download.test.ts",
  "src/shared/__tests__/mcp-app-partition.test.ts",
];

function controlByteHits(bytes) {
  const hits = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if ((byte < 0x20 && !ALLOWED_BYTES.has(byte)) || byte === 0x7f) hits.push([i, byte]);
    if (hits.length >= MAX_HITS_PER_FILE) break;
  }
  return hits;
}

export function scanSourceTextSafety(repoRoot, roots = ROOTS, grandfathered = GRANDFATHERED) {
  const exempt = new Set(grandfathered);
  const offenders = [];
  const stale = [];
  for (const root of roots) {
    const files = walkSourceFiles(resolve(repoRoot, root), {
      skipDirs: new Set(["node_modules", "dist"]),
      extensions: EXTENSIONS,
      tolerateUnreadableDirs: true,
    });
    for (const file of files) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      const hits = controlByteHits(readFileSync(file));
      if (hits.length === 0) {
        if (exempt.has(rel)) stale.push(rel);
        continue;
      }
      if (exempt.has(rel)) continue;
      const where = hits
        .map(([offset, byte]) => `offset ${offset} = 0x${byte.toString(16).padStart(2, "0")}`)
        .join(", ");
      offenders.push(`${rel}: ${where}`);
    }
  }
  return { offenders, stale };
}

// Guard absent script paths so imports from interactive processes cannot throw.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const { offenders, stale } = scanSourceTextSafety(resolve(import.meta.dirname, ".."));

  if (stale.length > 0) {
    console.error(
      "[source-text-safe] FAIL — these files no longer contain raw control bytes and\n"
        + "must be removed from GRANDFATHERED in this script:\n"
        + stale.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error(
      "[source-text-safe] FAIL — raw control bytes in source. Git may treat the file as\n"
        + "binary, which hides it from diffs, review, ripgrep, and the naming gate.\n"
        + "Write the character as escape TEXT instead (\\u0000, \\x1f, \\u007f).\n"
        + offenders.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }

  console.log("[source-text-safe] OK");
}
