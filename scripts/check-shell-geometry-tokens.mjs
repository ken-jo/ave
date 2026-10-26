#!/usr/bin/env node
// Compare mirrored CSS and script geometry constants without importing build output.
// Missing, duplicate or unresolved values fail closed; comments cannot stand in for declarations.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Register every token with a script-side twin, including one-level aliases.
// Insets and rail reserves affect both content clearance and window sizing.
const MIRRORS = [
  { css: "--chrome-gap", ts: "SHELL_GUTTER" },
  { css: "--chrome-gap-tight", ts: "CHROME_GAP_TIGHT" },
  { css: "--shell-card-inset", ts: "SHELL_GUTTER" },
  { css: "--shell-collapsed-rail-reserve", ts: "COLLAPSED_RAIL_RESERVE" },
  { css: "--chrome-icon-button", ts: "CHROME_ICON_BUTTON" },
  { css: "--chrome-gap-hair", ts: "CHROME_GAP_HAIR" },
];

const CONTAINER_MIRRORS = [
  { container: "chat-transcript", ts: "SETTINGS_NARROW_ENTER_WIDTH" },
];

const CSS_REL = join("src", "styles.css");
const TS_REL = join("src", "shared", "shell-geometry.ts");

function parseArgs(argv) {
  const flag = argv.indexOf("--root");
  if (flag === -1) return { root: process.cwd() };
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error("[shell-geometry-tokens] FAIL — `--root` needs a directory, e.g. `--root /path/to/checkout`.");
    process.exit(1);
  }
  return { root: value };
}

// Blank comments while preserving strings and newlines for accurate source positions.
function stripComments(source, { lineComments }) {
  let out = "";
  let quote = null;
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const span = end === -1 ? source.slice(i) : source.slice(i, end + 2);
      out += span.replace(/[^\n]/g, " ");
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (lineComments && char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      out += " ";
      i = end === -1 ? source.length : end;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

// Accept declarations without a trailing semicolon and ignore !important.
// Exclude var() references from declaration names.
function cssDeclarations(source) {
  const declarations = new Map();
  const re = /(?:^|[;{}\s])(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g;
  for (const match of source.matchAll(re)) {
    const value = match[2].replace(/!important\s*$/i, "").trim();
    const existing = declarations.get(match[1]);
    if (existing) existing.push(value);
    else declarations.set(match[1], [value]);
  }
  return declarations;
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;
const VAR_ALIAS = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/;

// Resolve at most one alias; deeper chains fail rather than needing cycle detection.
function resolvePx(name, declarations, { allowAlias = true } = {}) {
  const values = declarations.get(name);
  if (!values || values.length === 0) {
    return { error: `${name}: not declared in ${CSS_REL} (a commented-out declaration does not count)` };
  }
  const resolved = [];
  for (const value of values) {
    const px = PX.exec(value);
    if (px) {
      resolved.push(Number(px[1]));
      continue;
    }
    const alias = VAR_ALIAS.exec(value);
    if (alias && allowAlias) {
      const target = resolvePx(alias[1], declarations, { allowAlias: false });
      if (target.error) {
        return { error: `${name}: aliases ${alias[1]}, which does not resolve — ${target.error}` };
      }
      resolved.push(target.px);
      continue;
    }
    return {
      error: `${name}: value \`${value}\` is neither a px literal nor a single-level var() alias, so it has no number to compare`,
    };
  }
  const distinct = [...new Set(resolved)];
  if (distinct.length > 1) {
    return { error: `${name}: declared more than once with different values (${distinct.join(", ")}) in ${CSS_REL}` };
  }
  return { px: distinct[0] };
}

function tsConstants(source) {
  const constants = new Map();
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g;
  for (const match of source.matchAll(re)) {
    const existing = constants.get(match[1]);
    if (existing) existing.push(Number(match[2]));
    else constants.set(match[1], [Number(match[2])]);
  }
  return constants;
}

const { root } = parseArgs(process.argv.slice(2));

let cssSource;
let tsSource;
try {
  cssSource = readFileSync(join(root, CSS_REL), "utf8");
  tsSource = readFileSync(join(root, TS_REL), "utf8");
} catch (e) {
  console.error(`[shell-geometry-tokens] FAIL — cannot read a mirror side: ${e.message}`);
  process.exit(1);
}

const declarations = cssDeclarations(stripComments(cssSource, { lineComments: false }));
const constants = tsConstants(stripComments(tsSource, { lineComments: true }));
const failures = [];

const containerSource = stripComments(cssSource, { lineComments: false }).replace(
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  (quoted) => quoted.replace(/[^\n]/g, " "),
);
const containerQueries = [...containerSource.matchAll(
  /@container\s+([\w-]+)\s*\(min-width:\s*(\d+)px\)\s*\{/g,
)];
for (const { container, ts: tsName } of CONTAINER_MIRRORS) {
  const defined = constants.get(tsName);
  const matches = containerQueries.filter((query) => query[1] === container);
  if (defined?.length !== 1 || matches.length !== 1 || Number(matches[0][2]) !== defined[0]) {
    failures.push(`@container ${container} must appear once and match ${tsName} in ${TS_REL}`);
  }
}

for (const { css: cssName, ts: tsName } of MIRRORS) {
  const token = resolvePx(cssName, declarations);
  if (token.error) {
    failures.push(token.error);
    continue;
  }
  const defined = constants.get(tsName);
  if (!defined || defined.length === 0) {
    failures.push(`${tsName}: no numeric \`export const\` found in ${TS_REL} (a value quoted in a comment does not count)`);
    continue;
  }
  if (defined.length > 1) {
    failures.push(`${tsName}: defined ${defined.length} times in ${TS_REL} (${defined.join(", ")})`);
    continue;
  }
  if (token.px !== defined[0]) {
    failures.push(`${cssName} is ${token.px}px in ${CSS_REL} but ${tsName} is ${defined[0]} in ${TS_REL}`);
  }
}

if (failures.length > 0) {
  console.error(
    "[shell-geometry-tokens] FAIL — the CSS tokens and their TypeScript mirrors disagree.\n" +
      "These are one fact written in two languages; change both or neither.\n",
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`[shell-geometry-tokens] OK pairs=${MIRRORS.length} containers=${CONTAINER_MIRRORS.length}`);
