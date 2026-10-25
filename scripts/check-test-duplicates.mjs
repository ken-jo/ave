// Exact normalized helper copies fail; near-copies are advisory candidates for sharing.
import { basename, relative } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isSourceFile,
  isVariableDeclaration,
} from "typescript/unstable/ast";
import { walkSourceFiles } from "./lib/source-walk.mjs";
import { parseSourceFiles } from "./lib/ts7-ast.mjs";

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  ".git",
  // Generated dependency caches can contain their packages' own test suites.
  ".cache",
  // Exclude transient worktrees so helpers are not counted as copies of themselves.
  ".claude",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "release-staging",
]);

const TEST_SOURCE_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js)$/;
const JS_TS_FILE_RE = /\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_HELPER_FILE_RE =
  /(?:^|[-_])(?:test-)?helpers?\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_FIXTURE_FILE_RE =
  /(?:^|[-_])(?:fixtures?|fixture-support|mock-server|fake-[A-Za-z0-9_-]+)\.(?:ts|tsx|mts|mjs|js)$/;
const SHARED_RENDERER_MOCK_FILE_RE = /^mock-ave-api\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_SUPPORT_PATH_RE = /(?:^|\/)(?:test|__tests__|fixtures)(?:\/|$)/;
const HELPER_NAME_RE =
  /^(?:make|create|write|setup|fixture|mock|fake|stub|build)[A-Z_][A-Za-z0-9_]*$/;
// Apply size thresholds only to advisory hotspots and same-file pairs.
// Cross-file exact duplicates count at every length.
const MIN_GENERAL_HELPER_BODY_LENGTH = 80;
const IGNORED_HELPER_NAMES = new Set([
  "setup",
  "fixture",
  "mock",
]);

export function normalizeRepoPath(filePath, root = ROOT) {
  const relativePath = relative(root, filePath);
  const isOutsideRoot = relativePath.startsWith("..") || relativePath === "";
  return (isOutsideRoot ? filePath : relativePath).split("\\").join("/");
}

export function isScannedTestSource(filePath, root = ROOT) {
  const normalizedPath = normalizeRepoPath(filePath, root);
  const fileName = basename(normalizedPath);
  if (!JS_TS_FILE_RE.test(fileName)) return false;
  const isBareFileName = !normalizedPath.includes("/");
  const isTestSupportPath = TEST_SUPPORT_PATH_RE.test(normalizedPath);
  return (
    TEST_SOURCE_FILE_RE.test(fileName) ||
    SHARED_RENDERER_MOCK_FILE_RE.test(fileName) ||
    (isBareFileName && (TEST_HELPER_FILE_RE.test(fileName) || TEST_FIXTURE_FILE_RE.test(fileName))) ||
    isTestSupportPath
  );
}

export function walk(dir, out = [], root = ROOT) {
  return walkSourceFiles(
    dir,
    { skipDirs: SKIP_DIRS, accept: (filePath) => isScannedTestSource(filePath, root) },
    out,
  );
}

export function collectHelpers(files, root = ROOT) {
  const byName = new Map();
  const byBody = new Map();
  const byShape = new Map();
  const sources = parseSourceFiles(files);
  for (const file of files) {
    const sourceFile = sources.get(file);
    if (!sourceFile) continue;
    const rel = relative(root, file);
    const visit = (node) => {
      const helper = getHelperNode(node);
      if (!helper) {
        node.forEachChild(visit);
        return;
      }
      const { name, body } = helper;
      if (!name) {
        node.forEachChild(visit);
        return;
      }
      const normalizedBody = normalizeHelperBody(body.getText(sourceFile));
      if (!normalizedBody) {
        node.forEachChild(visit);
        return;
      }
      // Count shareable helpers at every length, excluding nested closures and empty placeholders.
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const candidate = isHelperCandidate(name, normalizedBody);
      if (isShareableScope(node) && hasSubstance(normalizedBody)) {
        if (!byBody.has(normalizedBody)) byBody.set(normalizedBody, []);
        byBody.get(normalizedBody).push({ name, rel, line, candidate });
        // Collapsing names makes trivial bodies identical; require enough structure for this advisory.
        if (normalizedBody.length >= MIN_GENERAL_HELPER_BODY_LENGTH) {
          const shape = normalizeHelperShape(normalizedBody);
          if (!byShape.has(shape)) byShape.set(shape, []);
          byShape.get(shape).push({ name, rel, line, candidate, body: normalizedBody });
        }
      }
      if (candidate) {
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(rel);
      }

      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return { byName, byBody, byShape };
}

function getHelperNode(node) {
  if (isFunctionDeclaration(node) && node.name && node.body) {
    return { name: node.name.text, body: node.body };
  }
  if (
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    node.initializer &&
    (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
  ) {
    return { name: node.name.text, body: node.initializer.body };
  }
  return null;
}

// Shareable helpers live at module scope or directly inside describe, never inside test bodies.
function isShareableScope(node) {
  let current = node.parent;
  while (current && !isSourceFile(current)) {
    if (isFunctionLikeDeclaration(current)) {
      const call = current.parent;
      const isDescribeCallback =
        call &&
        isCallExpression(call) &&
        isIdentifier(call.expression) &&
        call.expression.text === "describe";
      if (!isDescribeCallback) return false;
    }
    current = current.parent;
  }
  return true;
}

const PLACEHOLDER_TOKENS = new Set(["undefined", "null", "true", "false", "void", "return"]);

// A meaningful body names an identifier or literal instead of being an empty placeholder.
function hasSubstance(normalizedBody) {
  const tokens = normalizedBody.match(/[A-Za-z_$][A-Za-z0-9_$]*|"[^"]*"|'[^']*'|`[^`]*`|\d+/g) ?? [];
  return tokens.some((token) => !PLACEHOLDER_TOKENS.has(token));
}

function isHelperCandidate(name, normalizedBody) {
  if (!normalizedBody) return false;
  if (IGNORED_HELPER_NAMES.has(name)) {
    return normalizedBody.length >= MIN_GENERAL_HELPER_BODY_LENGTH;
  }
  return (
    HELPER_NAME_RE.test(name) ||
    normalizedBody.length >= MIN_GENERAL_HELPER_BODY_LENGTH
  );
}

export function collectDuplicateNames(byName) {
  return [...byName.entries()]
    .filter(([, locations]) => locations.size > 1)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
}

// Cross-file exact copies always count; same-file wrappers need a matching name or size.
export function collectDuplicateBodies(byBody) {
  return [...byBody.entries()]
    .map(([body, entries]) => {
      const uniqueLocations = new Set(entries.map((entry) => entry.rel));
      const uniqueNames = new Set(entries.map((entry) => entry.name));
      return { body, entries, uniqueLocations, uniqueNames };
    })
    .filter(
      (group) =>
        group.entries.length > 1 &&
        (group.uniqueLocations.size > 1 || group.entries.some((entry) => entry.candidate)),
    )
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        b.uniqueLocations.size - a.uniqueLocations.size ||
        [...a.uniqueNames][0].localeCompare([...b.uniqueNames][0]),
    );
}

export function normalizeHelperBody(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "do", "else", "export", "false", "finally", "for", "function",
  "if", "import", "in", "instanceof", "let", "new", "null", "of", "return",
  "switch", "this", "throw", "true", "try", "typeof", "undefined", "var",
  "void", "while", "yield",
]);

// Normalize names, literals and optional rejection handles to detect structurally equivalent helpers.
export function normalizeHelperShape(normalizedBody) {
  return normalizedBody
    .replace(/\b(?:reject|rej)\b\s*=\s*[A-Za-z_$][\w$]*\s*;?/g, "")
    .replace(/,\s*\b(?:reject|rej)\b|\b(?:reject|rej)\b\s*,|\b(?:reject|rej)\b/g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '"$"')
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (word) => (KEYWORDS.has(word) ? word : "$"))
    .replace(/\s+/g, "");
}

// Report near-copies only across files and exclude groups already caught by exact matching.
export function collectParaphraseGroups(byShape) {
  return [...byShape.entries()]
    .map(([shape, entries]) => ({
      shape,
      entries,
      uniqueLocations: new Set(entries.map((entry) => entry.rel)),
      uniqueBodies: new Set(entries.map((entry) => entry.body)),
      uniqueNames: new Set(entries.map((entry) => entry.name)),
    }))
    .filter((group) => group.uniqueLocations.size > 1 && group.uniqueBodies.size > 1)
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        b.uniqueLocations.size - a.uniqueLocations.size ||
        [...a.uniqueNames][0].localeCompare([...b.uniqueNames][0]),
    );
}

export function analyzeDuplicateHelpers(root = ROOT) {
  const testFiles = walk(root, [], root);
  const { byName, byBody, byShape } = collectHelpers(testFiles, root);
  return {
    files: testFiles,
    duplicateBodies: collectDuplicateBodies(byBody),
    duplicateNames: collectDuplicateNames(byName),
    paraphraseGroups: collectParaphraseGroups(byShape),
  };
}

function parseLimit(args) {
  return Number.parseInt(
    args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length) ?? "40",
    10,
  );
}

export function runDuplicateCli(args = process.argv.slice(2), options = {}) {
  const root = options.root ?? ROOT;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const failOnDuplicates = args.includes("--fail-on-duplicates");
  const showNameHotspots = args.includes("--name-hotspots");
  const showParaphrases = args.includes("--paraphrases");
  const limit = parseLimit(args);
  const { files, duplicateBodies, duplicateNames, paraphraseGroups } =
    analyzeDuplicateHelpers(root);

  stdout(`test files: ${files.length}`);
  stdout(`duplicate helper implementations: ${duplicateBodies.length}`);
  for (const group of duplicateBodies.slice(0, limit)) {
    stdout(`\n${group.uniqueLocations.size}x ${[...group.uniqueNames].join(" / ")}`);
    for (const entry of group.entries.slice(0, 8)) {
      stdout(`  - ${entry.rel}:${entry.line} (${entry.name})`);
    }
    if (group.entries.length > 8) stdout(`  - ... ${group.entries.length - 8} more`);
  }

  // Near-copy findings are advisory.
  stdout(`paraphrased helper implementations (advisory): ${paraphraseGroups.length}`);
  if (showParaphrases) {
    for (const group of paraphraseGroups.slice(0, limit)) {
      stdout(`\n${group.uniqueLocations.size}x ${[...group.uniqueNames].join(" / ")}`);
      for (const entry of group.entries.slice(0, 8)) {
        stdout(`  - ${entry.rel}:${entry.line} (${entry.name})`);
      }
      if (group.entries.length > 8) stdout(`  - ... ${group.entries.length - 8} more`);
    }
  }

  if (showNameHotspots) {
    stdout(`helper-name hotspots (advisory): ${duplicateNames.length}`);
    for (const [name, locations] of duplicateNames.slice(0, limit)) {
      stdout(`\n${locations.size}x ${name}`);
      for (const location of [...locations].slice(0, 8)) {
        stdout(`  - ${location}`);
      }
      if (locations.size > 8) stdout(`  - ... ${locations.size - 8} more`);
    }
  }

  if (failOnDuplicates && duplicateBodies.length > 0) {
    stderr(
      `\nDuplicate test helper implementations remain. Refactor shared fixtures or add a targeted exception only with rationale.`,
    );
    return 1;
  }
  return 0;
}

function main() {
  process.exitCode = runDuplicateCli(process.argv.slice(2), { root: ROOT });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
