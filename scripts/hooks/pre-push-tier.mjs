// Scoped pre-push tiers for change sets the fast source tier cannot trace.
//
// Every pull request's CI runs the full suite and the build (scripts/run-ci-suite.mjs
// and ci.yml), so the local hook runs them only on request (run-local-checks.mjs
// lists the cases). Every other push runs a scoped tier, and its log line says
// "full suite deferred to CI". pre-push-source-policy.mjs still decides what the
// fast tier can trace; CI reuses it unchanged, and its "full checks" wording is
// CI's decision for a non-integration base. This module decides what the hook
// runs instead of the full suite for the rest:
//
//   fast          traced changes (selectFastSourceChecks), plus scripts/** and
//                 .github/**: `vitest related` on a changed script or workflow
//                 helper module and the tests that name a changed path in a
//                 string literal. Every test that names a .github path reads
//                 workflow or gate files (the naming and home-path gate suite,
//                 packaging-discipline-source.test.ts, the test/scripts suites
//                 that parse ci.yml), so any non-Markdown .github change runs
//                 all of them; Markdown under .github/ takes the document
//                 safety checks and the tests that name that file.
//   global-input  dependency, compiler and test-runner inputs (package.json,
//                 bun.lock, bunfig.toml, tsconfig*, vitest.config*, config/**,
//                 the Vitest setup files, declaration and entry-point files and
//                 the rest of FULL_CHECK_GLOBAL_INPUT_FILES), changes the
//                 import graph cannot trace (a deleted module, a mode change, a
//                 test-read document with no recorded reader, a path that is
//                 unsafe on a command line) and change sets the hook could not
//                 resolve completely: every lock suite, a frozen-lockfile
//                 install dry run, the typecheck gate (which includes
//                 check:typecheck-tests), `vitest related` on each changed
//                 importable module, and the tests that name a changed path.
//
// A changed module that no test imports runs the tests that name it, the
// must-run tests of config/ci-must-run-tests.json that cover it (the
// out-of-process group, whose child processes load code the import graph
// cannot see, and every directory group holding its path) and the lock suites
// it triggers (selectUntestedModuleTests). Only when all of those are empty is
// it reported as having no local test; the push continues either way.
//
// A message catalog change selectMessageCatalogChecks cannot attribute
// (structural edits, barrels, a dynamic consumer, a namespace no file names)
// runs the i18n suites, the catalog and barrel checks, and every file that
// names a touched namespace as a string prefix (selectUnattributedCatalogChecks).

import { classifyDocumentationChanges, isCanonicalGitPath } from "./pre-push-markdown-policy.mjs";
import {
  isCollectedVitestFile,
  isFullCheckGlobalInput,
  isMessageCatalogPath,
  readMessageCatalogEntries,
  selectFastSourceChecks,
  selectTriggeredLockSuites,
} from "./pre-push-source-policy.mjs";
import { namedRepositoryPaths, namesChangedPath } from "../run-ci-suite.mjs";

export const FAST_TIER = "fast";
export const GLOBAL_INPUT_TIER = "global-input";
export const FULL_SUITE_DEFERRED = "full suite deferred to CI";

/** The middle tier's lockfile sanity check: exits nonzero on drift and writes nothing. */
export const FROZEN_LOCKFILE_ARGS = Object.freeze(["install", "--frozen-lockfile", "--dry-run"]);

const MAX_SCOPED_ARGUMENT_CHARS = 16_384;
const safeCliPath = /^[A-Za-z0-9._+@/-]+$/;
const moduleExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const markdownPath = /\.(?:md|html)$/i;
const githubPathLiteral = /["'`](?:\.\/)?(\.github(?:\/[^"'`\s$]*)?)["'`]/gu;

function isSafePath(path) {
  return isCanonicalGitPath(path) && safeCliPath.test(path);
}

function isRegularFileChange(entry) {
  return /^[AM]$/.test(entry.status) && entry.newMode === "100644" &&
    (entry.status === "A" || entry.oldMode === "100644");
}

/**
 * Plan the scoped tier for a change set that is not docs-only.
 *
 * `entries` are the raw diff entries ({ status, oldMode, newMode, path, ... }).
 * `unresolvedReasons` name what the hook could not resolve (a failed diff, a
 * full-tier input in pushed history); any one keeps the global-input tier.
 * Returns { tier, reason, reasons, testFiles, relatedFiles,
 * messageCatalogEntries, documentationEntries, namedPaths }: namedPaths are
 * the changed paths whose literal readers run (selectNamedPathTests).
 */
export function selectScopedTier(entries, unresolvedReasons = []) {
  const reasons = [...unresolvedReasons];
  const relatedFiles = new Set();
  const namedPaths = new Set();
  const documentationEntries = [];
  const traced = [];
  let scriptPaths = 0;
  let githubPaths = 0;
  for (const entry of entries) {
    const path = entry?.path;
    if (!isSafePath(path)) {
      // Never handed to a command line; the reason keeps the middle tier.
      reasons.push(`${path || "unknown path"} is not a safe command-line path`);
      continue;
    }
    const scriptLike = path.startsWith("scripts/") || path.startsWith(".github/");
    if (scriptLike) {
      if (path.startsWith(".github/")) githubPaths += 1;
      else scriptPaths += 1;
      namedPaths.add(path);
      if (path.startsWith(".github/") && markdownPath.test(path) && isRegularFileChange(entry)) {
        documentationEntries.push(entry);
      } else if (entry.status !== "D" && moduleExtension.test(path)) {
        relatedFiles.add(path);
      }
      continue;
    }
    if (isFullCheckGlobalInput(path)) {
      reasons.push(`${path} is a global test or build input`);
      namedPaths.add(path);
      if (entry.status !== "D" && /^(?:src|test)\//.test(path) && moduleExtension.test(path)) relatedFiles.add(path);
      continue;
    }
    traced.push(entry);
  }

  let fast = traced.length > 0 ? selectFastSourceChecks(traced) : null;
  if (fast?.eligible) {
    documentationEntries.push(...fast.documentationEntries);
  } else if (fast) {
    // Keep each traceable entry; an untraceable one names its reason and
    // keeps the middle tier with the tests that name its path.
    const kept = [];
    for (const entry of traced) {
      if (classifyDocumentationChanges([entry]).docsOnly) {
        documentationEntries.push(entry);
        continue;
      }
      const single = selectFastSourceChecks([entry]);
      if (single.eligible) {
        kept.push(entry);
        continue;
      }
      reasons.push(single.reason);
      namedPaths.add(entry.path);
    }
    fast = kept.length > 0 ? selectFastSourceChecks(kept) : null;
    if (fast?.eligible) {
      documentationEntries.push(...fast.documentationEntries.filter((entry) => !documentationEntries.includes(entry)));
    } else if (fast) {
      reasons.push(fast.reason);
      for (const entry of kept) namedPaths.add(entry.path);
      fast = null;
    }
  }

  const testFiles = fast?.testFiles ?? [];
  for (const path of fast?.relatedFiles ?? []) relatedFiles.add(path);
  const sortedRelated = [...relatedFiles].sort();
  const argumentChars = [...testFiles, ...sortedRelated].reduce((total, file) => total + file.length + 3, 0);
  if (argumentChars > MAX_SCOPED_ARGUMENT_CHARS) {
    reasons.push("changed file arguments exceed the safe command limit");
    sortedRelated.length = 0;
  }
  const tier = reasons.length > 0 ? GLOBAL_INPUT_TIER : FAST_TIER;
  const traceReason = fast?.eligible ? fast.reason : `${sortedRelated.length} source module(s) and ${testFiles.length} test file(s) changed`;
  const extra = [
    scriptPaths > 0 ? `${scriptPaths} scripts/ path(s)` : "",
    githubPaths > 0 ? `${githubPaths} .github/ path(s)` : "",
  ].filter(Boolean);
  return {
    tier,
    reason: tier === GLOBAL_INPUT_TIER
      ? [...new Set(reasons)].join("; ")
      : `${traceReason}${extra.length > 0 ? `, with ${extra.join(" and ")}` : ""}`,
    reasons: [...new Set(reasons)],
    testFiles,
    relatedFiles: sortedRelated,
    messageCatalogEntries: fast?.messageCatalogEntries ?? [],
    documentationEntries,
    namedPaths: [...namedPaths].sort(),
  };
}

function githubLiterals(text) {
  return [...text.matchAll(githubPathLiteral)].map(([, path]) => path);
}

/**
 * The collected tests that name a changed path in a string literal (the CI
 * rule, namedRepositoryPaths), plus the .github rule above: Markdown under
 * .github/ selects the tests that name that file, any other .github change
 * every test that names a .github path. A test whose text cannot be read is
 * selected.
 */
export function selectNamedPathTests(paths, trackedTests, readText) {
  const github = paths.filter((path) => path.startsWith(".github/"));
  const githubCode = github.some((path) => !markdownPath.test(path));
  const githubDocuments = github.filter((path) => markdownPath.test(path));
  const others = paths.filter((path) => !path.startsWith(".github/"));
  const selected = [];
  for (const test of trackedTests) {
    const text = readText(test);
    if (typeof text !== "string") {
      selected.push(test);
      continue;
    }
    if (github.length > 0) {
      const literals = githubLiterals(text);
      if (githubCode && literals.length > 0 ||
          githubDocuments.some((changed) => literals.some((named) => namesChangedPath(named, changed)))) {
        selected.push(test);
        continue;
      }
    }
    if (others.length === 0) continue;
    const named = namedRepositoryPaths(test, text);
    if (others.some((changed) => named.some((path) => namesChangedPath(path, changed)))) selected.push(test);
  }
  return [...new Set(selected)].sort();
}

function mustRunEntryTests(entry, trackedTests) {
  return entry.endsWith("/")
    ? trackedTests.filter((test) => test.startsWith(entry))
    : trackedTests.filter((test) => test === entry);
}

/**
 * The extra tests a changed module with no related test file runs: the tests
 * that name it (`namedTests`, from selectNamedPathTests), the must-run tests
 * that cover it, and the lock suites it triggers. `mustRunDocument` is
 * config/ci-must-run-tests.json. Returns { module, namedTests, mustRunTests,
 * lockSuites, untested }; `untested` is true when all three are empty.
 */
export function selectUntestedModuleTests(module, namedTests, mustRunDocument, trackedTests) {
  const mustRun = new Set();
  for (const [group, entries] of Object.entries(mustRunDocument?.groups ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.length === 0) continue;
      // A directory group covers the modules beside its tests.
      const area = entry.endsWith("/") ? entry.replace(/(?:^|\/)__tests__\/$/u, "/") : null;
      if (group === "out-of-process" || (area !== null && module.startsWith(area))) {
        for (const test of mustRunEntryTests(entry, trackedTests)) mustRun.add(test);
      }
    }
  }
  const lockSuites = selectTriggeredLockSuites([module]).map(({ suite }) => suite);
  const mustRunTests = [...mustRun].sort();
  return {
    module,
    namedTests,
    mustRunTests,
    lockSuites,
    untested: namedTests.length === 0 && mustRunTests.length === 0 && lockSuites.length === 0,
  };
}

const messageCatalogDirectory = "src/i18n/messages/";
const messageCatalogBarrel = /^src\/i18n\/messages\/(?:generated\/index|generated-locales\/[^/]+)\.ts$/;
const messageCatalogFragment = /^src\/i18n\/messages\/generated\/([A-Za-z0-9_]+)\.ts$/;
const scannedModulePath = /^(?:src|test)\/(?:[^/]+\/)*[^/]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const deniedTestTreeSegments = new Set(["e2e", "screenshots"]);

function changedCatalogKeys(before, after) {
  if (after === null || before === undefined) return null;
  const keys = new Set();
  for (const key of new Set([...(before?.keys() ?? []), ...after.keys()])) {
    if (JSON.stringify(before?.get(key) ?? null) !== JSON.stringify(after.get(key) ?? null)) keys.add(key);
  }
  return keys;
}

function namespaceOf(key) {
  const dot = key.indexOf(".");
  if (key.length === 0 || dot === 0) return null;
  return dot > 0 ? key.slice(0, dot) : key;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The checks for message catalog changes selectMessageCatalogChecks cannot
 * attribute. Same inputs as selectMessageCatalogChecks. A file's touched
 * namespaces are those of the keys whose values differ between its two
 * versions; a fragment whose versions do not parse, or that differ only in
 * structure, touches its own namespace (generated/<namespace>.ts). A barrel,
 * or a seed catalog that does not parse, touches no namespace this reader can
 * name and runs the i18n suites and the catalog checks only.
 *
 * The consumers are every Vitest file and module under src/ or test/ that
 * names a touched namespace as a string prefix (`"ns.`, `'ns.`, or a template
 * `ns.${...}` start, so a dynamic consumer with a literal namespace counts),
 * every one outside src/i18n that reads the catalog itself, and the i18n
 * suites. A consumer that is a global input stays out of `vitest related`
 * and is reported. Returns { namespaces, unattributedFiles, testFiles,
 * consumerModules, skippedConsumers }.
 */
export function selectUnattributedCatalogChecks(entries, { readBlob, trackedFiles, readTrackedFile }) {
  const namespaces = new Set();
  const unattributedFiles = [];
  for (const entry of entries) {
    const path = entry?.path;
    if (!isMessageCatalogPath(path) || messageCatalogBarrel.test(path)) {
      unattributedFiles.push(path);
      continue;
    }
    const after = entry.status === "D" ? new Map() : readMessageCatalogEntries(readBlob(entry.localSha, path), path);
    const before = entry.status === "A" ? null : readMessageCatalogEntries(readBlob(entry.baseSha, path), path) ?? undefined;
    const keys = changedCatalogKeys(before, after);
    const fragment = messageCatalogFragment.exec(path)?.[1];
    const touched = [...(keys ?? [])].map(namespaceOf).filter((namespace) => namespace !== null);
    if (touched.length > 0) for (const namespace of touched) namespaces.add(namespace);
    else if (fragment) namespaces.add(fragment);
    else unattributedFiles.push(path);
  }

  const patterns = [...namespaces].map((namespace) => new RegExp(`["'\`]${escapeRegExp(namespace)}[."'\`]`, "u"));
  const testFiles = new Set();
  const consumerModules = new Set();
  const skippedConsumers = [];
  for (const path of trackedFiles) {
    if (!scannedModulePath.test(path) || path.startsWith(messageCatalogDirectory)) continue;
    if (path.split("/").some((segment) => deniedTestTreeSegments.has(segment))) continue;
    const text = readTrackedFile(path);
    const isI18nSuite = path.startsWith("src/i18n/__tests__/") && isCollectedVitestFile(path);
    const consumer = typeof text !== "string" || isI18nSuite ||
      (!path.startsWith("src/i18n/") && text.includes("i18n/messages")) ||
      patterns.some((pattern) => pattern.test(text));
    if (!consumer) continue;
    if (isCollectedVitestFile(path)) testFiles.add(path);
    else if (isFullCheckGlobalInput(path) || !isSafePath(path)) skippedConsumers.push(path);
    else consumerModules.add(path);
  }
  let sortedModules = [...consumerModules].sort();
  const argumentChars = [...testFiles, ...sortedModules].reduce((total, file) => total + file.length + 3, 0);
  if (argumentChars > MAX_SCOPED_ARGUMENT_CHARS) {
    skippedConsumers.push(...sortedModules);
    sortedModules = [];
  }
  return {
    namespaces: [...namespaces].sort(),
    unattributedFiles: unattributedFiles.sort(),
    testFiles: [...testFiles].sort(),
    consumerModules: sortedModules,
    skippedConsumers: skippedConsumers.sort(),
  };
}

/** The pre-push log line of a scoped tier: it names the tier, what runs and why. */
export function describeScopedTier({ tier, runs, reason }) {
  return `[checks] tier=${tier} pre-push: running ${runs}; ${FULL_SUITE_DEFERRED} ` +
    `(${reason}; AVE_PREPUSH_FULL=1 runs the full checks)`;
}
