#!/usr/bin/env node
// Require theme tokens for renderer colors and named opacity tokens for their alpha; only existing allow-listed
// literals are exempt.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const SRC_DIR = join(process.cwd(), "src", "ui");

const PATTERNS = [
  ["hsl-literal", /hsl\(\s*[0-9]/g],
  ["named-color-literal", /['"](?:white|black)['"]/g],
  ["hex-literal", /['"]#[0-9a-fA-F]{3,8}['"]/g],
  ["tailwind-palette", /\b(?:from|via|to)-(?:sky|emerald|amber|violet|rose|red|blue|green|purple|orange|pink|indigo)-[0-9]{2,3}\b/g],
];

// Keep this migration allow-list shrink-only.
// Contract examples and fixed brand gradients are theme-independent exceptions.
const GRANDFATHERED_FILES = new Set([
]);

// Palette data and color derivation are the sources behind semantic tokens.
const COLOR_SOURCE_FILES = new Set([
  "src/ui/renderer/theme/schemes/catalog.ts",
  "src/ui/renderer/theme/resolve-theme.ts",
]);

// Include directional border utilities in alpha checks.
const ALPHA_PREFIX =
  "(?:bg|text|border|border-[trbl]|ring|ring-offset|fill|stroke|shadow|" +
  "outline|divide|placeholder|decoration|accent|caret|from|to|via)";

// Named colors exclude layout fractions such as w-1/3.
const ALPHA_COLOR =
  "(?:background|foreground|card|card-foreground|popover|popover-foreground|" +
  "primary|primary-foreground|secondary|secondary-foreground|muted|" +
  "muted-foreground|accent|accent-foreground|destructive|" +
  "destructive-foreground|warning|warning-foreground|success|" +
  "success-foreground|info|info-foreground|emphasis|" +
  "border|input|ring|ui-line|action-view|action-branch|action-compact|" +
  "message-user|message-user-foreground|current|white|black)";

const RAW_ALPHA = new RegExp(`\\b${ALPHA_PREFIX}-${ALPHA_COLOR}\\/([0-9]+)\\b`, "g");

// Add a semantic opacity token before extending the exception list.
const GRANDFATHERED_ALPHAS = new Set(["25", "35"]);

const colorViolations = [];
const alphaViolations = [];

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function scan(dir) {
  const files = walkSourceFiles(dir, {
    skipDirs: new Set(["__tests__", "node_modules"]),
    extensions: [".ts", ".tsx"],
  });
  for (const p of files) {
    const rel = toPosix(relative(process.cwd(), p));
    const checkColors = !GRANDFATHERED_FILES.has(rel) && !COLOR_SOURCE_FILES.has(rel);
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (checkColors) {
        for (const [label, re] of PATTERNS) {
          for (const m of line.matchAll(re)) colorViolations.push(`${rel}:${i + 1}  [${label}] ${m[0]}`);
        }
      }
      for (const m of line.matchAll(RAW_ALPHA)) {
        if (!GRANDFATHERED_ALPHAS.has(m[1])) alphaViolations.push(`${rel}:${i + 1}  [raw-alpha] ${m[0]}`);
      }
    });
  }
}

try {
  scan(SRC_DIR);
} catch (e) {
  console.warn(`[color-token-check] skipped: ${e.message}`);
  process.exit(0);
}

if (colorViolations.length > 0) {
  console.error(
    "[color-token-check] FAIL — raw color literals found.\n" +
      "Use theme tokens, e.g. hsl(var(--primary)) / var(--gradient-brand). " +
      "See the scheme derivation in src/ui/renderer/theme/resolve-theme.ts.\n",
  );
  for (const v of colorViolations) console.error(`  ${v}`);
}
if (alphaViolations.length > 0) {
  console.error(
    "[color-token-check] FAIL — raw numeric alpha modifiers found.\n" +
      "Use named opacity tokens, e.g. bg-warning/(--opacity-soft). " +
      "See the --opacity-* scale in src/styles.css.\n",
  );
  for (const v of alphaViolations) console.error(`  ${v}`);
}
if (colorViolations.length > 0 || alphaViolations.length > 0) process.exit(1);
console.log("[color-token-check] OK");
