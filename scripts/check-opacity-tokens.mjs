#!/usr/bin/env node
// Require semantic opacity tokens for renderer colors; existing exceptions must not grow.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const SRC_DIR = join(process.cwd(), "src", "ui");

// Include directional border utilities in alpha checks.
const PREFIX =
  "(?:bg|text|border|border-[trbl]|ring|ring-offset|fill|stroke|shadow|" +
  "outline|divide|placeholder|decoration|accent|caret|from|to|via)";

// Named colors exclude layout fractions such as w-1/3.
const COLOR =
  "(?:background|foreground|card|card-foreground|popover|popover-foreground|" +
  "primary|primary-foreground|secondary|secondary-foreground|muted|" +
  "muted-foreground|accent|accent-foreground|destructive|" +
  "destructive-foreground|warning|warning-foreground|success|" +
  "success-foreground|info|info-foreground|emphasis|emphasis-foreground|" +
  "border|input|ring|ui-line|action-view|action-branch|action-compact|" +
  "message-user|message-user-foreground|current|white|black)";

const RAW_ALPHA = new RegExp(`\\b${PREFIX}-${COLOR}\\/([0-9]+)\\b`, "g");

// Add a semantic token before extending the exception list.
const GRANDFATHERED = new Set(["25", "35"]);

const violations = [];

function scan(dir) {
  const files = walkSourceFiles(dir, {
    skipDirs: new Set(["__tests__", "node_modules"]),
    extensions: [".ts", ".tsx"],
  });
  for (const p of files) {
    const content = readFileSync(p, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(RAW_ALPHA)) {
        if (GRANDFATHERED.has(m[1])) continue;
        violations.push(`${relative(process.cwd(), p)}:${i + 1}  ${m[0]}`);
      }
    });
  }
}

try {
  scan(SRC_DIR);
} catch (e) {
  console.warn(`[opacity-token-check] skipped: ${e.message}`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error(
    "[opacity-token-check] FAIL — raw numeric alpha modifiers found.\n" +
      "Use named opacity tokens, e.g. bg-warning/(--opacity-soft). " +
      "See the --opacity-* scale in src/styles.css.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("[opacity-token-check] OK");
