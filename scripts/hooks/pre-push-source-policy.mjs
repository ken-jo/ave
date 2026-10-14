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

import { posix } from "node:path";

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
 * inputs are already covered by `vitest related`.
 *
 * `test/scripts` holds the hook, gate and repository-tooling suites; its
 * triggers (`scripts/`, `package.json`) are also global inputs, so on a
 * fast push it runs only through a changed test file or a recorded document
 * reader. The category PR's full CI runs it on every merge to main.
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
  "src/__tests__/preload-shape.test.ts": Object.freeze(["src/contract/", "src/preload", "src/ui/renderer/types.ts"]),
  "src/__tests__/preload.test.ts": Object.freeze(["src/contract/", "src/preload", "src/ui/renderer/types.ts"]),
  "src/data/__tests__/settings-store.test.ts": Object.freeze([
    "src/data/secret-document-store.ts",
    "src/data/settings-",
    "src/shared/settings",
  ]),
  "src/ipc/__tests__/channel-inventory.test.ts": Object.freeze(["src/contract/", "src/ipc/"]),
  "src/ipc/__tests__/domain-exports.test.ts": Object.freeze(["src/ipc/domains/"]),
  "src/ipc/__tests__/host-renderer-only-channels.test.ts": Object.freeze(["src/contract/", "src/ipc/"]),
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
  "src/i18n/messages/",
]);

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
    FULL_CHECK_GLOBAL_INPUT_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function isCollectedVitestFile(relativePath) {
  if (!collectedVitestPath.test(relativePath)) return false;
  const segments = relativePath.split("/");
  return !segments.some((segment) => deniedTestTreeSegments.has(segment));
}

function ineligible(reason) {
  return { eligible: false, reason, testFiles: [], relatedFiles: [], documentationEntries: [] };
}

export function getRelatedCoverageFullReason(relatedFiles, coverage) {
  if (!Array.isArray(coverage) || coverage.length !== relatedFiles.length) {
    return "related test coverage could not be resolved";
  }
  for (const source of relatedFiles) {
    const records = coverage.filter((record) => record?.source === source);
    if (records.length !== 1 || !Array.isArray(records[0].tests) || records[0].tests.length === 0) {
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
 * import it directly. The full transitive set runs in the category PR's CI.
 */
export const RELATED_TEST_BOUND = 150;
const FAN_OUT_SOURCE_BOUND = 25;
const MODULE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\(\s*|\brequire\(\s*)["']([^"']+)["']/g;

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
 * importers — or { reason } when the bound cannot be met without dropping a
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
    narrowed.push({ source: record.source, related: record.tests.length, direct: direct.length });
    records.push({ source: record.source, tests: direct });
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
  if (sortedTestFiles.length === 0 && sortedRelatedFiles.length === 0) {
    return ineligible("no source or test module changed");
  }

  return {
    eligible: true,
    reason:
      `${sortedRelatedFiles.length} source module(s) and ` +
      `${sortedTestFiles.length} test file(s) changed` +
      (readDocuments > 0 ? ` (including the readers of ${readDocuments} test-read document(s))` : ""),
    testFiles: sortedTestFiles,
    relatedFiles: sortedRelatedFiles,
    documentationEntries,
  };
}
