// Fast pre-push tier for ordinary source changes.
//
// The full suite and the build run once, at merge time, on the exact
// main + PR merged tree (the workspace merge gate), and in CI. A branch push
// therefore runs what can be scoped to the change: the typecheck gate, the
// duplicate-helper scan, the lock suites, the changed test files, and the
// Vitest tests related to the changed modules.
//
// `vitest related` follows the module import graph. Anything that reaches a
// test without being imported — a setup file named in the Vitest config, a
// file read with `fs`, a build script, a dependency or compiler setting —
// is invisible to it. Those paths are global inputs and keep the full checks.

import {
  classifyDocumentationChanges,
  isCanonicalGitPath,
} from "./pre-push-markdown-policy.mjs";

const MAX_FAST_ARGUMENT_CHARS = 16_384;

/**
 * Suites that pin cross-cutting contracts (IPC channels, preload bridge,
 * settings shape, package scripts and guidance text, renderer error copy,
 * settings anchors, repository tooling). A change can break them without
 * importing them, so the fast tier runs them on every source push.
 */
export const AVE_APP_LOCK_SUITES = Object.freeze([
  "src/__tests__/packaging-discipline-source.test.ts",
  "src/__tests__/preload-shape.test.ts",
  "src/__tests__/preload.test.ts",
  "src/data/__tests__/settings-store.test.ts",
  "src/ipc/__tests__/channel-inventory.test.ts",
  "src/ipc/__tests__/domain-exports.test.ts",
  "src/ipc/__tests__/host-renderer-only-channels.test.ts",
  "src/ui/renderer/__tests__/format-ipc-error-coverage.test.ts",
  "src/ui/renderer/__tests__/settings-section-anchors.test.ts",
  "test/scripts",
]);

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
      return ineligible(`${path} is documentation that tests or the build read`);
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
      `${sortedTestFiles.length} test file(s) changed`,
    testFiles: sortedTestFiles,
    relatedFiles: sortedRelatedFiles,
    documentationEntries,
  };
}
