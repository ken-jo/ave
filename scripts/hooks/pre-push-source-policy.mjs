// Fast pre-push tier for ordinary source changes.
//
// The full suite and the build run once, at merge time, on the exact
// main + PR merged tree (the workspace merge gate), and in CI. A branch push
// therefore runs what can be scoped to the change: the typecheck gate, the
// duplicate-helper scan, the lock suites whose trigger paths changed, the
// changed test files, the recorded readers of changed test-read documents,
// and the Vitest tests related to the changed modules (bounded, below).
//
// `vitest related` follows the module import graph. Anything that reaches a
// test without being imported — a setup file named in the Vitest config, a
// file read with `fs`, a build script, a dependency or compiler setting —
// is invisible to it. Those paths are global inputs and keep the full checks.
// Message catalog data is the one input selected another way: by the code
// that names a changed key (selectMessageCatalogChecks).

import { posix } from "node:path";
import * as ast from "typescript/unstable/ast";
import { parseSourceTexts, withParsedSourceTexts } from "../lib/ts7-ast.mjs";
import { createMessageConsumerReader } from "./pre-push-message-consumers.mjs";

import {
  classifyDocumentationChanges,
  getRecordedDocumentReaders,
  isCanonicalGitPath,
} from "./pre-push-markdown-policy.mjs";

const MAX_FAST_ARGUMENT_CHARS = 16_384;

/**
 * Suites that pin cross-cutting contracts (IPC channels, preload bridge,
 * settings shape, package scripts and guidance text, renderer error copy,
 * settings anchors, repository tooling). Each reaches some of its inputs
 * without importing them (a directory scan, a file read, a module it does not
 * import yet), so `vitest related` cannot see that a change reaches it. The
 * fast tier runs a suite when a changed path starts with one of its triggers:
 * the paths it scans or reads plus the modules it pins. Import-reachable
 * inputs are already covered by `vitest related`, and boundRelatedTests
 * never cuts a lock suite out of a related set.
 *
 * The IPC and preload suites reach src/shared/ipc-channels.ts only through
 * the contract barrel src/contract/app-contract.ts, so every suite whose
 * import graph reaches that barrel also triggers on the barrel's own imports
 * (pinned by test/scripts/pre-push-source-policy.test.ts, which walks the
 * graphs).
 *
 * `test/scripts` holds the hook, gate and repository-tooling suites; its
 * triggers (`scripts/`, `package.json`) are also global inputs, so on a
 * fast push it runs only through a changed test file or a recorded document
 * reader. Non-test-only category PRs and periodic full CI runs cover it all.
 */
export const AVE_APP_LOCK_SUITE_TRIGGERS = Object.freeze({
  "src/__tests__/packaging-discipline-source.test.ts": Object.freeze([
    "AGENTS.md",
    "CLAUDE.md",
    "docs/references/production-release-checklist.md",
    "resources/",
    "src/lib/log-file-sink.ts",
    "src/main/ave-protocol-registration.ts",
  ]),
  "src/__tests__/preload-shape.test.ts": Object.freeze([
    "src/contract/",
    "src/preload",
    "src/shared/ipc-channels.ts",
    "src/ui/renderer/types.ts",
  ]),
  "src/__tests__/preload.test.ts": Object.freeze([
    "src/contract/",
    "src/preload",
    "src/shared/ipc-channels.ts",
    "src/ui/renderer/types.ts",
  ]),
  "src/data/__tests__/settings-store.test.ts": Object.freeze([
    "src/data/secret-document-store.ts",
    "src/data/settings-",
    "src/shared/settings",
  ]),
  "src/ipc/__tests__/channel-inventory.test.ts": Object.freeze(["src/contract/", "src/ipc/", "src/shared/ipc-channels.ts"]),
  "src/ipc/__tests__/domain-exports.test.ts": Object.freeze(["src/ipc/domains/", "src/shared/ipc-channels.ts"]),
  "src/ipc/__tests__/host-renderer-only-channels.test.ts": Object.freeze([
    "src/contract/",
    "src/ipc/",
    "src/shared/ipc-channels.ts",
  ]),
  "src/ui/renderer/__tests__/format-ipc-error-coverage.test.ts": Object.freeze([
    "src/alerts/",
    "src/ipc/domains/",
    "src/shared/alerts-types.ts",
    "src/ui/renderer/format-ipc-error.ts",
  ]),
  "src/ui/renderer/__tests__/settings-section-anchors.test.ts": Object.freeze([
    "src/shared/settings-tabs.ts",
    "src/ui/renderer/",
  ]),
  "test/scripts": Object.freeze(["package.json", "scripts/"]),
});

export const AVE_APP_LOCK_SUITES = Object.freeze(Object.keys(AVE_APP_LOCK_SUITE_TRIGGERS));

/**
 * The lock suites a change set triggers, each with the first changed path
 * that triggered it, in table order.
 */
export function selectTriggeredLockSuites(changedPaths) {
  const selected = [];
  for (const [suite, triggers] of Object.entries(AVE_APP_LOCK_SUITE_TRIGGERS)) {
    const path = changedPaths.find((changed) => triggers.some((trigger) => changed.startsWith(trigger)));
    if (path !== undefined) selected.push({ suite, path });
  }
  return selected;
}

/**
 * Inputs every test or the build depends on without importing them. A change
 * here can move any result, so it keeps the full checks.
 *
 * - dependency and compiler inputs: package.json, bun.lock, bunfig.toml,
 *   tsconfig*.json
 * - test runner inputs: vitest.config.ts, everything under config/ (the
 *   Vitest config and global setup, the Playwright config, and the gate
 *   baselines), and the per-project setup files the Vitest config names
 * - the test-only module the Vitest config injects by file identity
 * - build inputs: webpack, PostCSS and shadcn configs, and scripts/ (the
 *   build script chain, the Vitest runner, and this hook)
 * - .github/: CI workflows and their scripts
 */
export const FULL_CHECK_GLOBAL_INPUT_FILES = Object.freeze([
  "bun.lock",
  "bunfig.toml",
  "components.json",
  "package.json",
  "postcss.config.cjs",
  "src/__tests__/support/ave-home-isolation-guard.ts",
  "src/__tests__/vitest-ave-home.ts",
  "src/__tests__/vitest-model-catalog.ts",
  "src/__tests__/vitest-renderer-web-streams.ts",
  "src/__tests__/vitest-vm-exit-hooks.ts",
  "src/i18n/testing/vitest-ambient-intl.ts",
  "src/shared/ave-home-test-guard.ts",
  "tsconfig.json",
  "tsconfig.tests.json",
  "vitest.config.ts",
  "webpack.config.cjs",
]);

const FULL_CHECK_GLOBAL_INPUT_PREFIXES = Object.freeze([
  ".github/",
  "config/",
  "scripts/",
]);

/**
 * Message catalog data: the seed catalogs (`src/i18n/messages/<locale>.ts`),
 * the per-surface fragments (`generated/<namespace>.ts`) and the generated
 * barrels (`generated/index.ts`, `generated-locales/<locale>.ts`).
 *
 * `vitest related` cannot scope a change here. src/i18n/translate.ts imports
 * the loader src/i18n/messages/index.ts, which imports the English barrel and
 * lazily the locale barrels, so every test that reaches `t()` (about 1100 of
 * the suite) is "related" to every fragment, and no test imports a fragment
 * directly, so the bound below cannot narrow it either. What decides which
 * results a text change can move is which code names the changed keys: a
 * string changes only what `t()` returns for its key. selectMessageCatalogChecks
 * therefore runs the tests of the modules that name a changed key's namespace,
 * the tests that name it or read the catalog themselves, the i18n suites, and
 * the catalog and barrel checks. The loader itself (src/i18n/messages/index.ts)
 * and any other file in that directory stay global inputs: the Vitest setup
 * file executes the loader for every test.
 */
const MESSAGE_CATALOG_DIRECTORY = "src/i18n/messages/";
const messageCatalogSeedPath = /^src\/i18n\/messages\/[a-z]{2}(?:-[A-Z]{2})?\.ts$/;
const messageCatalogFragmentPath = /^src\/i18n\/messages\/generated\/[A-Za-z0-9_]+\.ts$/;
const messageCatalogBarrelPath = /^src\/i18n\/messages\/(?:generated\/index|generated-locales\/[a-z]{2}(?:-[A-Z]{2})?)\.ts$/;

function isMessageCatalogBarrel(relativePath) {
  return messageCatalogBarrelPath.test(relativePath);
}

export function isMessageCatalogPath(relativePath) {
  return isMessageCatalogBarrel(relativePath) ||
    messageCatalogSeedPath.test(relativePath) ||
    messageCatalogFragmentPath.test(relativePath);
}

const safeCliPath = /^[A-Za-z0-9._+@/-]+$/;
const collectedVitestPath = /^(?:src\/(?:[^/]+\/)*__tests__\/(?:[^/]+\/)*|test\/(?:[^/]+\/)*)(?:[^/]+)\.(?:test|spec)\.(?:ts|tsx)$/;
const deniedTestTreeSegments = new Set(["e2e", "screenshots"]);
const importableModulePath = /^(?:src|test)\/(?:[^/]+\/)*[^/]+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

export function isFullCheckGlobalInput(relativePath) {
  return (
    FULL_CHECK_GLOBAL_INPUT_FILES.includes(relativePath) ||
    /(?:^|\/)tsconfig[^/]*\.json$/.test(relativePath) ||
    /\.d\.(?:ts|mts|cts)$/.test(relativePath) ||
    /(?:^|\/)[^/]*(?:preload|worker-entry|worker-main|child-main)\.(?:ts|tsx|js|mjs|cjs)$/.test(relativePath) ||
    FULL_CHECK_GLOBAL_INPUT_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
    (relativePath.startsWith(MESSAGE_CATALOG_DIRECTORY) && !isMessageCatalogPath(relativePath))
  );
}

/** A path Vitest collects as a test file (see the Vitest config's include globs). */
export function isCollectedVitestFile(relativePath) {
  if (!collectedVitestPath.test(relativePath)) return false;
  const segments = relativePath.split("/");
  return !segments.some((segment) => deniedTestTreeSegments.has(segment));
}

/** Local test helpers and fixture assets, excluding every shared global input. */
export function isTestSupportFile(path) {
  return isCanonicalGitPath(path) && safeCliPath.test(path) && !isFullCheckGlobalInput(path) &&
    !isCollectedVitestFile(path) && !path.split("/").some((segment) => deniedTestTreeSegments.has(segment)) &&
    (/^(?:src|test)\/(?:[^/]+\/)*__tests__\/.+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) ||
      // Fixtures belong to a test tree: anywhere under test/, and in src/ only
      // under a __tests__ directory (src/main/fixtures/ is product data).
      /^(?:test\/|src\/(?:.*\/)?__tests__\/)(?:.*\/)?fixtures\/.+/.test(path));
}

const testModuleExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const testHelperLocation = /^test\/|(?:^|\/)(?:__tests__|__mocks__)\//;

/**
 * A test helper or setup module: an importable file in a test tree (anything
 * under test/, or under a __tests__ or __mocks__ directory, fixtures there
 * included) that
 * Vitest does not collect. One helper can change what any number of tests
 * observe, and the import graph only sees the importers it can trace, so CI
 * never treats a helper change as test-only and runs the full suite for it on
 * every base but integration/* (scripts/run-ci-suite.mjs). The Vitest setup
 * files are also global inputs (FULL_CHECK_GLOBAL_INPUT_FILES).
 */
export function isTestHelperModule(path) {
  return isCanonicalGitPath(path) && testModuleExtension.test(path) &&
    !isCollectedVitestFile(path) && testHelperLocation.test(path);
}

/**
 * A test-only diff changes collected Vitest files and fixture assets, nothing
 * else: no test helper or setup module (isTestHelperModule), no global input
 * (the Vitest config and setup files, config/, scripts/ including the CI
 * selection itself, .github/), no symlink and no mode change.
 * Renames arrive as deletion + addition (--no-renames). Deleted tests drop.
 */
export function isTestOnlyDiff(changes) {
  const regularModes = new Set(["100644", "100755"]);
  return Array.isArray(changes) && changes.length > 0 && changes.every(({ path, status, oldMode, newMode }) =>
    isCanonicalGitPath(path) && safeCliPath.test(path) && !isFullCheckGlobalInput(path) &&
    !isTestHelperModule(path) && (isCollectedVitestFile(path) || isTestSupportFile(path)) &&
    ((status === "A" && oldMode === "000000" && regularModes.has(newMode)) ||
      (status === "M" && regularModes.has(oldMode) && oldMode === newMode) ||
      (status === "D" && regularModes.has(oldMode) && newMode === "000000")));
}

function ineligible(reason) {
  return { eligible: false, reason, testFiles: [], relatedFiles: [], messageCatalogEntries: [], documentationEntries: [] };
}

/**
 * Validate per-module discovery coverage. A changed module with no related
 * test files keeps the full checks. A message consumer (an unchanged module
 * that names a changed message key, see selectMessageCatalogChecks) may have
 * none: no Vitest file reaches it, so no Vitest run, the full suite included,
 * can observe its text.
 */
export function getRelatedCoverageFullReason(relatedFiles, coverage, messageConsumerFiles = []) {
  const sources = [...relatedFiles, ...messageConsumerFiles];
  if (!Array.isArray(coverage) || coverage.length !== sources.length || new Set(sources).size !== sources.length) {
    return "related test coverage could not be resolved";
  }
  for (const source of sources) {
    const records = coverage.filter((record) => record?.source === source);
    if (records.length !== 1 || !Array.isArray(records[0].tests)) {
      return `${source} has no related test files`;
    }
    if (records[0].tests.length === 0 && !messageConsumerFiles.includes(source)) {
      return `${source} has no related test files`;
    }
    if (!records[0].tests.every((path) => isCanonicalGitPath(path) && safeCliPath.test(path) && isCollectedVitestFile(path))) {
      return `${source} has unrecognized related test files`;
    }
  }
  return null;
}

/**
 * `vitest related` follows every transitive importer, so one shared module
 * (a schema, a contract) can pull a large part of the suite into a branch
 * push: `src/audit/audit-schema.ts` alone reached 160 of the ~1450 test
 * files, 73 s of a 140 s fast run. Above RELATED_TEST_BOUND test files the
 * fast tier keeps every related test of a narrow module and narrows each
 * module whose fan-out exceeds FAN_OUT_SOURCE_BOUND to the test files that
 * import it directly, plus every lock suite in its related set: a lock suite
 * often reaches a shared contract through a barrel (the IPC suites reach
 * src/shared/ipc-channels.ts through src/contract/app-contract.ts), and
 * cutting it would drop exactly the cross-cutting check the change needs.
 * The full transitive set runs in CI's affected selection.
 */
export const RELATED_TEST_BOUND = 150;
const FAN_OUT_SOURCE_BOUND = 25;
const MODULE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\(\s*|\brequire\(\s*)["']([^"']+)["']/g;

function isLockSuiteFile(relativePath) {
  return AVE_APP_LOCK_SUITES.some((suite) => relativePath === suite || relativePath.startsWith(`${suite}/`));
}

function importsModuleDirectly(text, testPath, source) {
  if (typeof text !== "string") return false;
  const target = source.replace(MODULE_EXTENSION, "");
  for (const [, specifier] of text.matchAll(MODULE_SPECIFIER)) {
    if (!specifier.startsWith(".")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(testPath), specifier));
    if (resolved.replace(MODULE_EXTENSION, "") === target) return true;
  }
  return false;
}

/**
 * Resolve the related test files to run from per-module discovery coverage
 * (already validated by getRelatedCoverageFullReason). Returns
 * { tests, narrowed } — `narrowed` lists each module cut down to its direct
 * importers and the lock suites among its related tests — or { reason } when the bound cannot be met without dropping a
 * module's coverage, which keeps the full checks.
 *
 * `readText(path)` returns a test file's source, or null.
 */
export function boundRelatedTests(coverage, readText) {
  const union = (records) => [...new Set(records.flatMap((record) => record.tests))].sort();
  const all = union(coverage);
  if (all.length <= RELATED_TEST_BOUND) return { tests: all, narrowed: [] };
  const narrowed = [];
  const records = [];
  for (const record of coverage) {
    if (record.tests.length <= FAN_OUT_SOURCE_BOUND) {
      records.push(record);
      continue;
    }
    const direct = record.tests.filter((test) => importsModuleDirectly(readText(test), test, record.source));
    if (direct.length === 0) {
      return {
        reason: `${record.source} reaches ${record.tests.length} related test files and none imports it directly; full checks required`,
      };
    }
    const lockSuites = record.tests.filter((test) => isLockSuiteFile(test) && !direct.includes(test));
    narrowed.push({ source: record.source, related: record.tests.length, direct: direct.length, lockSuites: lockSuites.length });
    records.push({ source: record.source, tests: [...direct, ...lockSuites] });
  }
  const tests = union(records);
  if (tests.length > RELATED_TEST_BOUND) {
    return { reason: `related tests still exceed ${RELATED_TEST_BOUND} files after narrowing (${tests.length}); full checks required` };
  }
  return { tests, narrowed };
}

/**
 * Decide whether a pushed change set can take the fast source tier.
 *
 * `changes` are the raw diff entries the hook resolved ({ status, oldMode,
 * newMode, path, ... }). Returns the changed test files to run directly, the
 * changed modules to hand to `vitest related`, and the unconsumed documents
 * whose pushed bytes still get the document safety check.
 */
export function selectFastSourceChecks(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return ineligible("no changed files were resolved");
  }

  const testFiles = new Set();
  const relatedFiles = new Set();
  const documentationEntries = [];
  const messageCatalogEntries = [];
  let readDocuments = 0;
  for (const change of changes) {
    const path = change?.path;
    if (!isCanonicalGitPath(path) || !safeCliPath.test(path)) {
      return ineligible(`${path || "unknown path"} is not a safe command-line path`);
    }
    if (isFullCheckGlobalInput(path)) {
      return ineligible(`${path} is a global test or build input`);
    }
    if (classifyDocumentationChanges([change]).docsOnly) {
      documentationEntries.push(change);
      continue;
    }
    if (/\.(?:md|html)$/i.test(path)) {
      // A test-read document runs its recorded readers instead of the suite.
      const readers = getRecordedDocumentReaders(path);
      if (readers === null) {
        return ineligible(`${path} is documentation that tests or the build read, with no recorded reader set`);
      }
      if (!/^[AM]$/.test(change.status) || change.newMode !== "100644" ||
          (change.status === "M" && change.oldMode !== "100644")) {
        return ineligible(`${path} change status or mode requires full checks`);
      }
      for (const reader of readers) {
        if (isCollectedVitestFile(reader)) testFiles.add(reader);
        else if (importableModulePath.test(reader) && !isFullCheckGlobalInput(reader)) relatedFiles.add(reader);
        else return ineligible(`${path} is read by ${reader}, which no targeted test run covers`);
      }
      readDocuments += 1;
      documentationEntries.push(change);
      continue;
    }
    if (change.status === "D") {
      // A deleted test file leaves nothing to run. A deleted module leaves
      // consumers that the import graph of the new tree no longer shows.
      if (isCollectedVitestFile(path) && change.oldMode === "100644") continue;
      return ineligible(`deleting ${path} requires full checks`);
    }
    if (change.status !== "A" && change.status !== "M") {
      return ineligible(`Git status ${change.status || "unknown"} requires full checks`);
    }
    if (change.newMode !== "100644" || (change.status === "M" && change.oldMode !== change.newMode)) {
      return ineligible(`${path} file mode ${change.newMode} requires full checks`);
    }
    if (isCollectedVitestFile(path)) {
      testFiles.add(path);
      continue;
    }
    if (isMessageCatalogPath(path)) {
      // Selected by key, not by import graph: see selectMessageCatalogChecks.
      messageCatalogEntries.push(change);
      continue;
    }
    if (importableModulePath.test(path)) {
      relatedFiles.add(path);
      continue;
    }
    return ineligible(`${path} is not a module that vitest related can trace`);
  }

  const sortedTestFiles = [...testFiles].sort();
  const sortedRelatedFiles = [...relatedFiles].sort();
  const argumentChars = [...AVE_APP_LOCK_SUITES, ...sortedTestFiles, ...sortedRelatedFiles]
    .reduce((total, file) => total + file.length + 3, 0);
  if (argumentChars > MAX_FAST_ARGUMENT_CHARS) {
    return ineligible("changed file arguments exceed the safe command limit");
  }
  if (sortedTestFiles.length === 0 && sortedRelatedFiles.length === 0 && messageCatalogEntries.length === 0) {
    return ineligible("no source or test module changed");
  }

  return {
    eligible: true,
    reason:
      `${sortedRelatedFiles.length} source module(s) and ` +
      `${sortedTestFiles.length} test file(s) changed` +
      (messageCatalogEntries.length > 0 ? `, with ${messageCatalogEntries.length} message catalog file(s)` : "") +
      (readDocuments > 0 ? ` (including the readers of ${readDocuments} test-read document(s))` : ""),
    testFiles: sortedTestFiles,
    relatedFiles: sortedRelatedFiles,
    messageCatalogEntries,
    documentationEntries,
  };
}

/** Catalog checks every message catalog change runs (package scripts). */
export const MESSAGE_CATALOG_CHECK_SCRIPTS = Object.freeze(["check:i18n-catalog", "check:i18n-barrels"]);
const I18N_SUITE_DIRECTORY = "src/i18n/__tests__/";
const scannedModulePath = /^(?:src|test)\/(?:[^/]+\/)*[^/]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const isStaticString = (node) => node !== undefined && (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node));

function readCatalogString(node) {
  if (isStaticString(node)) return node.text;
  if (node && ast.isBinaryExpression(node) && node.operatorToken.kind === ast.SyntaxKind.PlusToken) {
    const left = readCatalogString(node.left);
    const right = readCatalogString(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

function isExported(node) {
  return node.modifiers?.length === 1 && node.modifiers[0].kind === ast.SyntaxKind.ExportKeyword;
}

function isEnglishKeyType(node) {
  return node && ast.isTypeOperatorNode(node) && node.operator === ast.SyntaxKind.KeyOfKeyword &&
    ast.isTypeQueryNode(node.type) && ast.isIdentifier(node.type.exprName) && node.type.exprName.text === "en" &&
    !node.type.typeArguments;
}

function isTranslationType(node, seed) {
  if (!node || !ast.isTypeReferenceNode(node) || !ast.isIdentifier(node.typeName) || node.typeName.text !== "Record") return false;
  const args = node.typeArguments;
  return args?.length === 2 && args[1].kind === ast.SyntaxKind.StringKeyword &&
    (seed ? ast.isTypeReferenceNode(args[0]) && ast.isIdentifier(args[0].typeName) &&
      args[0].typeName.text === "SeedMessageKey" && !args[0].typeArguments : isEnglishKeyType(args[0]));
}

/**
 * Read key -> locale values from a fully validated seed or fragment module.
 */
export function readMessageCatalogEntries(text, relativePath) {
  return readMessageCatalogModule(text, relativePath)?.entries ?? null;
}

/**
 * readMessageCatalogEntries for many modules at once, keyed by relative path.
 * Each compiler session is a native child process, so reading the catalog's
 * ~190 modules one by one costs ~190 process spawns; this parses them all in
 * one session and validates each module exactly as the single-module reader.
 */
export function readMessageCatalogEntriesByPath(texts) {
  const readable = new Map([...texts].filter(([, text]) => isReadableCatalogText(text)));
  const sources = parseCatalogSources(readable);
  return new Map([...texts.keys()].map((path) =>
    [path, readParsedMessageCatalog(sources?.get(path), path)?.entries ?? null]));
}

function isReadableCatalogText(text) {
  return typeof text === "string" && !/[\u2028\u2029]/u.test(text);
}

function parseCatalogSources(texts) {
  try {
    return parseSourceTexts(texts);
  } catch {
    return null;
  }
}

/**
 * Preserve each locale's property order and the source ranges of its values.
 * Only the shipped declarations, type-only seed scaffolding and static string
 * properties are accepted. Unknown syntax or a different binding layout keeps
 * the full tier; declaration order must never stand in for locale identity.
 */
function readMessageCatalogModule(text, relativePath) {
  if (!isReadableCatalogText(text)) return null;
  const parsePath = relativePath ?? "catalog.ts";
  return readParsedMessageCatalog(parseCatalogSources(new Map([[parsePath, text]]))?.get(parsePath), relativePath);
}

function readParsedMessageCatalog(source, relativePath) {
  if (!source) return null;
  const fragment = relativePath === undefined
    ? source.statements.filter(ast.isVariableStatement).length === 2
    : messageCatalogFragmentPath.test(relativePath) && !isMessageCatalogBarrel(relativePath);
  const locale = relativePath === undefined
    ? source.statements[0] && ast.isImportDeclaration(source.statements[0]) ? "ko" : "en"
    : posix.basename(relativePath, ".ts");
  if (!fragment && relativePath !== undefined &&
      (!messageCatalogSeedPath.test(relativePath) || !["en", "ko"].includes(locale))) return null;
  const statements = [...source.statements];
  if (!fragment && locale === "ko") {
    const statement = statements.shift();
    const clause = statement && ast.isImportDeclaration(statement) && statement.importClause;
    const bindings = clause && clause.namedBindings;
    if (!clause?.isTypeOnly || clause.name || !bindings || !ast.isNamedImports(bindings) || bindings.elements.length !== 1 ||
        bindings.elements[0].name.text !== "SeedMessageKey" || bindings.elements[0].propertyName ||
        !ast.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "./en.js" || statement.attributes) return null;
  }
  const entries = new Map();
  const orderedEntries = [];
  for (const binding of fragment ? ["en", "ko"] : [locale]) {
    const statement = statements.shift();
    if (!statement || !ast.isVariableStatement(statement) || !isExported(statement) ||
        statement.declarationList.flags !== ast.NodeFlags.Const || statement.declarationList.declarations.length !== 1) return null;
    const declaration = statement.declarationList.declarations[0];
    if (!ast.isIdentifier(declaration.name) || declaration.name.text !== binding || declaration.exclamationToken ||
        (binding === "en" ? declaration.type !== undefined :
          declaration.type === undefined ? !fragment : !isTranslationType(declaration.type, !fragment))) return null;
    let body = declaration.initializer;
    if (body && ast.isAsExpression(body)) {
      if (!ast.isTypeReferenceNode(body.type) || !ast.isIdentifier(body.type.typeName) ||
          body.type.typeName.text !== "const" || body.type.typeArguments) return null;
      body = body.expression;
    }
    if (!body || !ast.isObjectLiteralExpression(body)) return null;
    const keys = new Set();
    for (const property of body.properties) {
      if (!ast.isPropertyAssignment(property) || !ast.isStringLiteral(property.name)) return null;
      const key = property.name.text;
      const value = readCatalogString(property.initializer);
      if (value === null || keys.has(key)) return null;
      keys.add(key);
      const values = entries.get(key) ?? {};
      values[binding] = value;
      entries.set(key, values);
      orderedEntries.push({ binding, key, value, start: property.initializer.getStart(source), end: property.initializer.end });
    }
  }
  if (!fragment && locale === "en" && statements.length === 1) {
    const statement = statements.shift();
    if (!ast.isTypeAliasDeclaration(statement) || !isExported(statement) || statement.name.text !== "SeedMessageKey" ||
        statement.typeParameters || !isEnglishKeyType(statement.type)) return null;
  }
  if (fragment && [...entries.values()].some((values) => !("en" in values) || !("ko" in values))) return null;
  return statements.length === 0 ? { entries, orderedEntries } : null;
}

function readCatalogValueChanges(beforeText, afterText, before, after) {
  if (before === null) return new Set(after.entries.keys());
  if (before.orderedEntries.length !== after.orderedEntries.length) return null;
  const changedKeys = new Set();
  const beforeParts = [];
  const afterParts = [];
  let beforeEnd = 0;
  let afterEnd = 0;
  for (let index = 0; index < before.orderedEntries.length; index += 1) {
    const previous = before.orderedEntries[index];
    const next = after.orderedEntries[index];
    // Property order is observable independently for every locale binding.
    if (previous.binding !== next.binding || previous.key !== next.key) return null;
    if (previous.value === next.value) continue;
    changedKeys.add(next.key);
    beforeParts.push(beforeText.slice(beforeEnd, previous.start));
    afterParts.push(afterText.slice(afterEnd, next.start));
    beforeEnd = previous.end;
    afterEnd = next.end;
  }
  beforeParts.push(beforeText.slice(beforeEnd));
  afterParts.push(afterText.slice(afterEnd));
  // Only changed static value initializers may differ. Preserve all remaining
  // source, including comments, trivia, unchanged literals and scaffolding.
  return JSON.stringify(beforeParts) === JSON.stringify(afterParts) ? changedKeys : null;
}


/**
 * Select the checks for the message catalog files of a fast push.
 *
 * `entries` are the catalog changes from selectFastSourceChecks, each with
 * the `baseSha` and `localSha` it was diffed between. `readBlob(sha, path)`
 * returns a file's text at a commit (or null), `trackedFiles` lists the
 * pushed tree's paths, and `readTrackedFile(path)` returns one's text.
 *
 * An existing module must keep each locale's key order and identical source
 * outside changed static value initializers. A new module names every key it
 * declares. Each changed key names a namespace (the part before its first dot).
 * Structural edits and changes without attributable values keep full checks.
 * The selection is every Vitest file and module under src/ or test/ that names a changed namespace
 * as a static string (`t("ns.key")` or a literal key table), every
 * one outside src/i18n that reads the catalog itself (it mentions
 * `i18n/messages`), and the i18n suites. Modules go to `vitest related`, so
 * their tests run. A namespace no file names may be reached through a
 * computed key this scan cannot see, so it keeps the full checks. Runtime
 * references require a resolved named import and a literal-key call matching
 * the export's signature, or the same call through a direct useTranslation()
 * destructure. Each callee must resolve to its proven declaring binding in the
 * compiler's lexical scope. Other runtime references and unresolved key tables keep
 * full checks even when another file names every changed namespace.
 * Unsupported catalog modules and unreadable or unparseable consumers keep
 * full checks too.
 *
 * Returns { namespaces, testFiles, consumerModules } or { reason }.
 */
export function selectMessageCatalogChecks(entries, { readBlob, trackedFiles, readTrackedFile }) {
  const changedNamespaces = new Set();
  for (const entry of entries) {
    if (!isMessageCatalogPath(entry?.path)) return { reason: `${entry?.path} is not a message catalog file` };
    if (isMessageCatalogBarrel(entry.path)) {
      return { reason: `${entry.path} changes catalog assembly without attributable message values; full checks required` };
    }
    const afterText = readBlob(entry.localSha, entry.path);
    const beforeText = entry.status === "A" ? null : readBlob(entry.baseSha, entry.path);
    const after = readMessageCatalogModule(afterText, entry.path);
    const before = entry.status === "A" ? null : readMessageCatalogModule(beforeText, entry.path);
    if (after === null || entry.status !== "A" && before === null) {
      return { reason: `${entry.path} has a shape the message key reader does not accept; full checks required` };
    }
    const changedKeys = readCatalogValueChanges(beforeText, afterText, before, after);
    if (changedKeys === null) {
      return { reason: `${entry.path} has changes outside attributable message values; full checks required` };
    }
    if (changedKeys.size === 0) {
      return { reason: `${entry.path} has no attributable message value change; full checks required` };
    }
    for (const key of changedKeys) {
      const dot = key.indexOf(".");
      if (key.length === 0 || dot === 0) return { reason: `${entry.path} has no attributable message namespace; full checks required` };
      changedNamespaces.add(dot > 0 ? key.slice(0, dot) : key);
    }
  }
  if (changedNamespaces.size === 0) return { reason: "no changed message namespace could be attributed; full checks required" };

  const texts = new Map();
  for (const path of trackedFiles) {
    if (!scannedModulePath.test(path) || path.startsWith(MESSAGE_CATALOG_DIRECTORY)) continue;
    const text = readTrackedFile(path);
    if (typeof text !== "string") return { reason: `${path} could not be read for message consumers; full checks required` };
    texts.set(path, text);
  }
  try {
    return withParsedSourceTexts(texts, (sources, resolveDeclarations) =>
      selectParsedMessageConsumers(texts, sources, resolveDeclarations, changedNamespaces, trackedFiles));
  } catch {
    return { reason: "message consumers could not be analyzed; full checks required" };
  }
}

function selectParsedMessageConsumers(texts, sources, resolveDeclarations, changedNamespaces, trackedFiles) {
  const named = new Set();
  const testFiles = new Set();
  const consumerModules = new Set();
  const readConsumers = createMessageConsumerReader(sources, trackedFiles, resolveDeclarations);
  for (const [path, text] of texts) {
    const isI18nSuite = path.startsWith(I18N_SUITE_DIRECTORY) && isCollectedVitestFile(path);
    const source = sources.get(path);
    if (!source) return { reason: `${path} could not be parsed for message consumers; full checks required` };
    let consumers;
    try {
      consumers = readConsumers(path, changedNamespaces);
    } catch {
      return { reason: `${path} has an unsupported message consumer shape; full checks required` };
    }
    if (consumers.unresolved) return { reason: `${path} has an unresolved dynamic message consumer; full checks required` };
    const namespaces = [...consumers.named];
    for (const namespace of namespaces) named.add(namespace);
    const readsCatalog = !path.startsWith("src/i18n/") && text.includes("i18n/messages");
    if (!isI18nSuite && namespaces.length === 0 && !readsCatalog) continue;
    // Playwright specs and screenshot trees are outside every Vitest run.
    if (path.split("/").some((segment) => deniedTestTreeSegments.has(segment))) continue;
    if (isCollectedVitestFile(path)) testFiles.add(path);
    else if (isFullCheckGlobalInput(path)) return { reason: `${path} names a changed message namespace and is a global test or build input` };
    else if (!safeCliPath.test(path) || !isCanonicalGitPath(path)) return { reason: `${path} is not a safe command-line path` };
    else consumerModules.add(path);
  }
  const unnamed = [...changedNamespaces].filter((namespace) => !named.has(namespace)).sort();
  if (unnamed.length > 0) {
    return { reason: `no source file names message namespace ${unnamed.join(", ")}; a computed key may reach it, full checks required` };
  }
  const sortedTests = [...testFiles].sort();
  const sortedModules = [...consumerModules].sort();
  const argumentChars = [...sortedTests, ...sortedModules].reduce((total, file) => total + file.length + 3, 0);
  if (argumentChars > MAX_FAST_ARGUMENT_CHARS) {
    return { reason: "message consumer arguments exceed the safe command limit; full checks required" };
  }
  return { namespaces: [...changedNamespaces].sort(), testFiles: sortedTests, consumerModules: sortedModules };
}
