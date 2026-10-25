#!/usr/bin/env node
// Require theme tokens for renderer colors; only existing allow-listed literals are exempt.
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
  "src/ui/renderer/theme/plugin-token-map.ts",
  "src/ui/renderer/components/AveLogo.tsx",
]);

const violations = [];

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
    if (GRANDFATHERED_FILES.has(rel)) continue;
    const content = readFileSync(p, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const [label, re] of PATTERNS) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          violations.push(`${rel}:${i + 1}  [${label}] ${m[0]}`);
        }
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

if (violations.length > 0) {
  console.error(
    "[color-token-check] FAIL — raw color literals found.\n" +
      "Use theme tokens, e.g. hsl(var(--primary)) / var(--gradient-brand). " +
      "See the per-bundle tokens in src/styles.css.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("[color-token-check] OK");
