#!/usr/bin/env node
// Require the named type scale for renderer text sizes; an arbitrary length ignores the
// appearance font-size scale. The scan covers what styles.css's `@source "./**/*.{ts,tsx,html}"`
// feeds Tailwind. A missing scan root fails closed rather than reporting a clean tree.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const SCAN_DIRS = ["src"];

// Matches `text-[11px]`, `text-[0.7rem]`, `text-[length:1.1em]`, any unit case, and variant or
// important forms such as `sm:!text-[9px]`. Colour forms (`text-[hsl(...)]`, `text-[CanvasText]`,
// `text-[var(--x)]`) do not start with a number and are left alone.
const ARBITRARY_SIZE = /\btext-\[(?:length:)?[0-9.]+(?:px|rem|em)\]/gi;

const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

function parseArgs(argv) {
  const flag = argv.indexOf("--root");
  if (flag === -1) return { root: process.cwd() };
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error("[type-token-check] FAIL — `--root` needs a directory, e.g. `--root /path/to/checkout`.");
    process.exit(1);
  }
  return { root: value };
}

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

const { root } = parseArgs(process.argv.slice(2));
const violations = [];
let scanned = 0;

for (const dir of SCAN_DIRS) {
  let files;
  try {
    files = walkSourceFiles(join(root, dir), {
      skipDirs: new Set(["__tests__", "node_modules"]),
      extensions: [".ts", ".tsx", ".html"],
      accept: (p) => !TEST_FILE.test(p),
    });
  } catch (error) {
    console.error(`[type-token-check] FAIL — cannot scan ${toPosix(dir)}: ${error.message}`);
    process.exit(1);
  }
  for (const p of files) {
    scanned += 1;
    const rel = toPosix(relative(root, p));
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(ARBITRARY_SIZE)) violations.push(`${rel}:${i + 1}  ${m[0]}`);
    });
  }
}

if (violations.length > 0) {
  console.error(
    "[type-token-check] FAIL — arbitrary text sizes found.\n" +
      "Use the type scale (text-tiny, text-dense, text-micro, text-caption, text-body-sm, text-body, text-xs, text-sm). " +
      "See the type scale in docs/DESIGN.md and --text-* in src/styles.css.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`[type-token-check] OK files=${scanned}`);
