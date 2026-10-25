#!/usr/bin/env node
// App-owned pre-commit / pre-push checks for ave.
//
// Migrated out of the vendored dev-tools runner so ave owns its own gate
// (build-time audit #8). Scope is ave only: the dev-tools runner's
// multi-repo dispatch, canonical-file drift detection, and plugin-manifest
// validation (all for sibling repos) are intentionally not carried here.
//
// The one behavioural improvement over the dev-tools original is a self-healing
// Electron-ABI step (see ensureAppTestRuntimeAbi): a stray `npm rebuild` that
// rebuilt better-sqlite3 for the Node ABI used to kill every push with a
// confusing NODE_MODULE_VERSION mismatch under the Electron test runner. We now
// realign it the same way `postinstall` does, then re-probe.
//
// Stages: pre-commit | pre-push | manual. Bypass once with AVE_HOOKS_SKIP=1.
//
// Pre-push tiers (the log names the tier and why). Every pull request's CI
// runs the build and the test scope scripts/run-ci-suite.mjs picks (full, or
// affected tests only; a test-only diff is never run whole), so a push runs
// the full suite only on request; the log line of every scoped tier says
// "remaining tests and build deferred to CI, whose scope scripts/run-ci-suite.mjs picks":
//   none          a new branch at a commit the remote's default or
//                 integration/* branches already contain: no new commit
//   docs-only     unconsumed documentation: document safety and policy checks
//   comment-only  standalone comment edits: typecheck gate
//   test-only     test code only: typecheck gate, duplicates, targeted Vitest
//   fast          other branch changes: typecheck gate, duplicates, the lock
//                 suites whose trigger paths changed, changed tests, the
//                 recorded readers of changed test-read documents, and
//                 `vitest related`, bounded for a shared module's fan-out
//                 (see pre-push-source-policy.mjs). A message catalog change
//                 adds the i18n catalog and barrel checks, the i18n suites,
//                 and the tests and modules that name a changed key's
//                 namespace (selectMessageCatalogChecks, or, for a change it
//                 cannot attribute, selectUnattributedCatalogChecks). A
//                 scripts/** or .github/** change adds `vitest related` on
//                 the changed script and the tests that name it; Markdown
//                 under .github/ takes the document safety checks. A changed
//                 module with no related test file runs the tests that name
//                 it, its must-run tests (config/ci-must-run-tests.json) and
//                 its lock suites, and is logged as having no local test when
//                 all of those are empty (pre-push-tier.mjs)
//   global-input  package.json, bun.lock, bunfig.toml, tsconfig*,
//                 vitest.config*, config/**, the Vitest setup files and the
//                 other global test/build inputs, changes the import graph
//                 cannot trace (a deleted module, a mode change, a test-read
//                 document with no recorded reader, a noncanonical path), a
//                 full-tier input in pushed history, and pushes whose change
//                 set could not be resolved: what fast runs, plus every lock
//                 suite and `bun install --frozen-lockfile --dry-run`
//   full          only on request: AVE_PREPUSH_FULL=1, the manual stage, a
//                 direct push to the default branch or an integration/*
//                 branch, a tag or other non-branch update, or a deletion:
//                 typecheck gate, `bun run test`, `bun run build`,
//                 `check:gate-core`
// Set AVE_PREPUSH_FULL=1 to run the full tier for any push. Otherwise the build
// of a scoped push runs in the PR's CI on the merged tree, and its test scope
// there follows scripts/run-ci-suite.mjs (a test-only diff never runs the full
// suite; a non-test-only category PR does).
//
// Host admission (pre-push-host-lock.mjs): a full run holds one exclusive
// host-wide lock, so two full suites never share a machine; a fast or
// global-input run holds one of AVE_PREPUSH_FAST_SLOTS (default 4) shared
// slots. A waiting run prints the holder's PID; one that waits past
// AVE_PREPUSH_LOCK_TIMEOUT_S (default 3600) fails the push. A dead holder's lock is reclaimed by PID
// liveness. The lock orders checks and never skips one.
//
// Multi-stage PRs: a sub-branch is cut from origin/integration/<category> and
// merged into it by PR; the category branch reaches main through one PR whose
// CI runs the full suite for non-test-only changes, and builds every source
// change. A sub-branch push therefore runs only the
// checks scoped to its own commits: a new branch is diffed against the
// closest merge-base with a live default or integration/* tip on the remote
// (findNewBranchBase), not only the default branch. For every branch push,
// pushed commits that a live default or integration/* tip already contains
// are not the branch's own: merging the base in does not move the tier, while
// own commits and a merge's conflict resolutions still do (scanPushedHistory).
// A direct push TO an integration/* branch is treated like the default
// branch (full checks):
// those branches advance through reviewed PR merges and lead-run merges of
// main, so a direct push is the exceptional case and has to carry the whole
// proof itself.
// A non-fast-forward push of a branch (a rebase, an amend) is diffed like a
// new branch, against its merge-base with the closest live default or
// integration/* tip, and also against the remote commit it replaces: a commit
// the rewrite drops changes the remote tree back, so its files are checked too.
// Every non-deletion update must name HEAD (an annotated tag through the
// commit it peels to) and the tracked checkout must be clean before and after
// checks. Deletion-only pushes have no tree to check.
// Every pushed commit must also share history with the remote's default
// branch (pre-push-shared-history.mjs): a clone of the history replaced on
// 2026-10-17 would otherwise upload the old objects under a new branch name.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  chooseNewBranchBase,
  findMissingCandidateTips,
  isIntegrationBranchRef,
  parseGitRawDiff,
  parsePrePushUpdates,
  parseRemoteHeads,
  readPrePushInput,
  resolveHeadUpdates,
  selectBaseCandidates,
} from "./pre-push-ref-updates.mjs";
import { checkPushedDocumentation } from "./pre-push-document-safety.mjs";
import { checkSharedHistory } from "./pre-push-shared-history.mjs";
import { withoutGitContext } from "../lib/git-process-environment.mjs";
import { basename, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { withElectronNativeRebuildLock } from "../lib/electron-native-modules.mjs";
import { ensureElectronAbiBetterSqlite3 } from "./node-native-abi.mjs";
import { readJsonFile } from "../lib/knip-baseline.mjs";
import { findTlsBypass, isTlsBypassScanTarget } from "../lib/tls-bypass-patterns.mjs";
import { runCommand, splitArgumentsWithinBudget, spawnSyncPortable as spawnSync } from "./spawn-command.mjs";
import {
  APP_TYPECHECK_GATE_SCRIPTS,
  getMissingPackageScripts,
} from "./app-typecheck-gate.mjs";
import {
  classifyDocumentationChanges,
  isCanonicalGitPath,
} from "./pre-push-markdown-policy.mjs";
import { selectCommentOnlyAveAppFiles } from "./pre-push-comment-policy.mjs";
import { selectTargetedAveAppVitestFiles } from "./pre-push-test-policy.mjs";
import {
  AVE_APP_LOCK_SUITES,
  boundRelatedTests,
  getRelatedCoverageFullReason,
  isCollectedVitestFile,
  MESSAGE_CATALOG_CHECK_SCRIPTS,
  RELATED_TEST_BOUND,
  selectFastSourceChecks,
  selectMessageCatalogChecks,
  selectTriggeredLockSuites,
} from "./pre-push-source-policy.mjs";
import {
  describeScopedTier,
  FROZEN_LOCKFILE_ARGS,
  FULL_SUITE_DEFERRED,
  GLOBAL_INPUT_TIER,
  selectNamedPathTests,
  selectScopedTier,
  selectUnattributedCatalogChecks,
  selectUntestedModuleTests,
} from "./pre-push-tier.mjs";
import { MUST_RUN_TESTS_PATH } from "../run-ci-suite.mjs";
import { resolveHostLockSettings, withHostLock } from "./pre-push-host-lock.mjs";

const isWindows = process.platform === "win32";

const commands = {
  bun: isWindows ? "bun.exe" : "bun",
  git: "git",
  node: isWindows ? "node.exe" : "node",
  npm: isWindows ? "npm.cmd" : "npm",
  npx: isWindows ? "npx.cmd" : "npx",
};

function parseArgs(argv) {
  const parsed = {
    stage: "manual",
    repo: process.cwd(),
    remote: null,
    remoteLocation: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stage") {
      parsed.stage = argv[++i];
      continue;
    }
    if (arg === "--repo") {
      parsed.repo = argv[++i];
      continue;
    }
    if (arg === "--remote") {
      parsed.remote = argv[++i] ?? null;
      continue;
    }
    if (arg === "--remote-location") {
      parsed.remoteLocation = argv[++i] ?? null;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  parsed.repo = resolve(parsed.repo);
  return parsed;
}

function hasFile(path) {
  return existsSync(path);
}

function hasPackageScript(dir, name) {
  const packageJsonPath = join(dir, "package.json");
  if (!hasFile(packageJsonPath)) return false;
  return Boolean(readJsonFile(packageJsonPath).scripts?.[name]);
}

function isNamedPackage(dir, name) {
  const packageJsonPath = join(dir, "package.json");
  if (!hasFile(packageJsonPath)) return false;
  try {
    return readJsonFile(packageJsonPath).name === name;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function capture(cmd, args, cwd, env = process.env) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `${cmd} ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

/** The branch HEAD names and its tip, or null for a detached HEAD. */
function headBranch(repoRoot) {
  const ref = captureOptional("git", ["symbolic-ref", "-q", "HEAD"], repoRoot);
  if (!ref) return null;
  const sha = captureOptional("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], repoRoot);
  return sha ? { ref, sha } : null;
}

function captureOptional(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return (result.stdout || "").trim();
}

function run(cmd, args, cwd, env = process.env) {
  console.log("");
  runCommand(cmd, args, { cwd, env, label: `checks ${basename(cwd)}` });
}

function available(...candidates) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      env: process.env,
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Electron test-runtime ABI (self-healing)
// ---------------------------------------------------------------------------

function requireElectronNodeVitest(dir) {
  const packageJsonPath = join(dir, "package.json");
  if (!hasFile(packageJsonPath)) {
    throw new Error("[electron-vitest-runner-required] ave package.json is missing");
  }
  const parsed = readJsonFile(packageJsonPath);
  if (
    parsed.scripts?.["test:vitest"] !==
    "node scripts/run-vitest-under-electron.mjs"
  ) {
    throw new Error(
      "[electron-vitest-runner-required] ave must define the canonical test:vitest script"
    );
  }
}

function resolveElectronVersion(dir) {
  const packageJsonPath = join(dir, "node_modules", "electron", "package.json");
  if (!hasFile(packageJsonPath)) return null;
  try {
    return readJsonFile(packageJsonPath).version || null;
  } catch {
    return null;
  }
}

function rebuildBetterSqlite3ForElectron(dir) {
  return withElectronNativeRebuildLock(dir, () => {
    // A launcher or another hook may have repaired the shared checkout while
    // this process waited. Avoid a second mutation of the same native tree.
    try {
      ensureElectronAbiBetterSqlite3(dir);
      return;
    } catch {
      // The caller already recorded the original probe failure. Continue with
      // the canonical hook repair and let its final probe surface any failure.
    }

    const version = resolveElectronVersion(dir);
    const rebuildArgs = [
      "electron-rebuild",
      "-f",
      "--only",
      "better-sqlite3",
      ...(version ? ["-v", version] : []),
    ];
    const bun = available(commands.bun);
    if (bun) {
      run(bun, ["x", ...rebuildArgs], dir);
      return;
    }
    const npx = available(commands.npx);
    if (npx) {
      run(npx, ["-y", ...rebuildArgs], dir);
      return;
    }
    throw new Error(
      "[electron-rebuild-unavailable] bun or npx is required to realign better-sqlite3 to the Electron ABI"
    );
  });
}

function ensureAppTestRuntimeAbi(dir) {
  requireElectronNodeVitest(dir);
  try {
    return ensureElectronAbiBetterSqlite3(dir);
  } catch (error) {
    // better-sqlite3 drifted off the Electron ABI (classically a stray
    // `npm rebuild` that rebuilt it for the Node ABI, shadowing the shipped
    // N-API prebuild with a Node-ABI `build/Release`). `postinstall` does NOT
    // rebuild native modules — this hook is the only electron-rebuild caller —
    // so realign here and re-probe: one self-healing chokepoint so a push never
    // dies on a confusing NODE_MODULE_VERSION mismatch.
    console.log(`[checks] ${basename(dir)} :: ${error.message}`);
    console.log(
      `[checks] ${basename(dir)} :: realigning better-sqlite3 to the Electron test ABI…`
    );
    rebuildBetterSqlite3ForElectron(dir);
    return ensureElectronAbiBetterSqlite3(dir);
  }
}

// The background-shell suites load the git-ignored Windows job launcher. The
// full tier builds it through `test:prepare`; the test-only, fast and
// global-input tiers call `test:vitest` directly, so they run the same check here.
function ensureWindowsJobLauncher(dir) {
  if (!isWindows) return;
  run(commands.node, [join(dir, "scripts/prepare-windows-job.mjs")], dir);
}

// ---------------------------------------------------------------------------
// Push / commit branch policy
// ---------------------------------------------------------------------------

function getProtectedBranchNames(repoRoot) {
  const names = new Set(["main", "master"]);
  const remotes = captureOptional(commands.git, ["remote"], repoRoot)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const remote of remotes) {
    const remoteHead = captureOptional(
      commands.git,
      ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`],
      repoRoot
    );
    if (!remoteHead.startsWith(`${remote}/`)) continue;
    const branchName = remoteHead.slice(remote.length + 1);
    if (branchName) {
      names.add(branchName);
    }
  }

  return names;
}

function runPushPolicyChecks(repoRoot, parsedUpdates) {
  if (!parsedUpdates.complete) {
    throw new Error(
      "[PRE_PUSH_REF_PARSE] refusing push because ref updates could not be parsed completely."
    );
  }
  const { updates } = parsedUpdates;

  const protectedBranchNames = getProtectedBranchNames(repoRoot);
  const blocked = updates
    .filter((update) => update.remoteRef.startsWith("refs/heads/"))
    .map((update) => update.remoteRef.slice("refs/heads/".length))
    .filter((branchName) => protectedBranchNames.has(branchName));

  if (blocked.length === 0) return;

  const uniqueBlocked = [...new Set(blocked)].sort();
  throw new Error(
    [
      "[DEFAULT_BRANCH_DIRECT_PUSH] refusing direct push to protected branch.",
      `Blocked branch(es): ${uniqueBlocked.join(", ")}`,
      "Create a non-default branch and merge through a pull request.",
    ].join("\n")
  );
}

// An annotated tag object never equals HEAD, so an update that pushes one is
// bound to the commit the tag peels to. Release tags must be annotated (the
// build-installers workflow verifies the tag's peeled commit), so refusing
// tag objects outright would make a release impossible without bypassing the
// hook. A tag of a tree or blob, or a nested tag that does not end at a
// commit, has no commit tree to check and is refused.
function resolvePushedCommit(readCheckout, sha) {
  const type = readCheckout(["cat-file", "-t", sha]);
  if (type === "commit") return { commitSha: sha };
  if (type !== "tag") return { error: `${sha} is a ${type}, not a commit or an annotated tag of a commit.` };
  let commitSha;
  try {
    commitSha = readCheckout(["rev-parse", "--verify", `${sha}^{commit}`]).toLowerCase();
  } catch {
    commitSha = "";
  }
  if (!/^[0-9a-f]{40,64}$/.test(commitSha)) {
    return { error: `${sha} is an annotated tag that does not peel to a commit (a tag of a tree, a blob, or another non-commit).` };
  }
  return { commitSha, tagged: true };
}

function runPushCheckoutChecks(repoRoot, parsedUpdates) {
  const updates = parsedUpdates.updates.filter((update) => !isNullObjectId(update.localSha));
  if (updates.length === 0) return { treeRequired: false, commitByLocalSha: new Map() };
  const readCheckout = (args) => capture(commands.git, ["-C", repoRoot, ...args], repoRoot, withoutGitContext());
  const head = readCheckout(["rev-parse", "--verify", "HEAD"]).toLowerCase();
  const commitByLocalSha = new Map();
  const nonCommits = [];
  for (const sha of new Set(updates.map((update) => update.localSha.toLowerCase()))) {
    const resolved = resolvePushedCommit(readCheckout, sha);
    if (resolved.error) nonCommits.push(`  ${resolved.error}`);
    else commitByLocalSha.set(sha, resolved);
  }
  if (nonCommits.length > 0) {
    throw new Error([
      "[PRE_PUSH_REF_NOT_COMMIT] refusing a ref update that has no commit tree to check.",
      ...nonCommits,
      "Push a branch, a lightweight tag of a commit, or an annotated tag of a commit.",
    ].join("\n"));
  }
  const mismatched = [...commitByLocalSha].filter(([, resolved]) => resolved.commitSha !== head);
  if (mismatched.length > 0) {
    const checkoutInstructions = mismatched.flatMap(([sha, resolved]) => {
      if (!resolved.tagged) return [`  git checkout --detach ${sha}`];
      return [
        `  ${sha} is an annotated tag object; the hook validates the commit it peels to (${resolved.commitSha}).`,
        `  Check out that commit with git checkout --detach ${sha}^{commit}, then push the tag.`,
      ];
    });
    throw new Error([
      `[PRE_PUSH_CHECKOUT_MISMATCH] refusing to check a push against unrelated HEAD ${head}.`,
      "Check out each pushed commit and push it separately:",
      ...checkoutInstructions,
    ].join("\n"));
  }
  const hiddenTrackedFiles = readCheckout(["ls-files", "-v", "-z"]).split("\0")
    .filter((entry) => /^[a-zS] /.test(entry));
  if (hiddenTrackedFiles.length > 0) {
    throw new Error([
      "[PRE_PUSH_HIDDEN_TRACKED_FILES] cannot verify tracked files marked assume-unchanged or skip-worktree.",
      "Clear those index flags and restore a complete checkout before pushing.",
      `Check out the pushed commit: git checkout --detach ${head}`,
    ].join("\n"));
  }
  const dirty = readCheckout(["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none"]);
  if (dirty) {
    throw new Error([
      "[PRE_PUSH_DIRTY_TREE] refusing push validation with tracked working-tree or index changes.",
      `Commit or restore those changes, then check out the pushed commit: git checkout --detach ${head}`,
    ].join("\n"));
  }
  return { treeRequired: true, commitByLocalSha };
}

// Replaces an annotated tag object's sha with its peeled commit (keeping the
// tag sha in `localTagSha`) before classification. Today this changes no
// result: classifyPrePushChanges sends every non-refs/heads update, which
// includes every tag push, to the full tier before any diff or rev-list, so
// no tag sha reaches those commands. It keeps that invariant if a future
// classifier change lets a tag update reach the commit-range checks.
function withPushedCommits(parsedUpdates, commitByLocalSha) {
  return {
    ...parsedUpdates,
    updates: parsedUpdates.updates.map((update) => {
      const resolved = commitByLocalSha.get(update.localSha.toLowerCase());
      if (!resolved?.tagged) return update;
      return { ...update, localSha: resolved.commitSha, localTagSha: update.localSha };
    }),
  };
}

// On deploy hosts (operator-marked via env `AVE_DEPLOY_HOST=1`), refuse
// `git commit` on a protected branch — a host-local commit on main can change
// the host's git state before any push. Dev hosts (no env) → no-op. Detached
// HEAD → no-op. Escape hatch: `git commit --no-verify` (auditable via reflog).
function runCommitPolicyChecks(repoRoot) {
  if (process.env.AVE_DEPLOY_HOST !== "1") return;
  const currentBranch = captureOptional(
    commands.git,
    ["symbolic-ref", "--short", "HEAD"],
    repoRoot
  ).trim();
  if (!currentBranch) return;
  const protectedBranchNames = getProtectedBranchNames(repoRoot);
  if (!protectedBranchNames.has(currentBranch)) return;
  throw new Error(
    [
      "[DEPLOY_HOST_DIRECT_COMMIT] refusing direct commit on a protected branch on the deploy host.",
      `Blocked branch: ${currentBranch}`,
      "On deploy hosts (AVE_DEPLOY_HOST=1), commit on a feature branch and push to origin, then merge via PR.",
      "Recovery escape hatch: `git commit --no-verify` (audit via `git reflog`).",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Pre-push change classification (docs-only / comment-only / targeted tests)
// ---------------------------------------------------------------------------

function isNullObjectId(sha) {
  return /^0+$/.test(sha);
}

function isUsableRemoteLocation(remoteLocation) {
  return typeof remoteLocation === "string" &&
    remoteLocation.length > 0 &&
    !/[\0\r\n]/.test(remoteLocation);
}

function gitRunner(repoRoot, timeout) {
  return (args) => {
    const result = spawnSync(commands.git, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    return {
      status: result.error ? null : result.status,
      stdout: result.stdout || "",
      stderr: result.error ? result.error.message : (result.stderr || "").trim(),
    };
  };
}

// A new branch has no remote ref to diff against. Its base is the closest
// merge-base with a live tip of the remote's default or integration/* branches
// (see pre-push-ref-updates.mjs): sub-branches are cut from
// origin/integration/<category>, and a stale local tracking ref does not
// matter because the tips come from the remote itself. Tips missing from the
// local object store are fetched once (objects only: no tags, no ref or
// FETCH_HEAD update) before the base is chosen. A non-fast-forward update is
// measured from the same base (classifyPrePushChanges).
function findNewBranchBase(repoRoot, update, remoteLocation) {
  const live = listLiveBaseTips(repoRoot, remoteLocation);
  if (!live.candidates) return { reason: `no conservative base found for ${update.localRef}: ${live.reason}` };
  const chosen = chooseNewBranchBase(update.localSha, live.candidates, gitRunner(repoRoot, 15_000));
  if (!chosen) {
    return {
      reason: `no conservative base found for ${update.localRef}: it shares no history with a default or integration branch tip on the remote`,
    };
  }
  const kind = /^[0-9a-f]*[1-9a-f][0-9a-f]*$/i.test(update.remoteSha ?? "") ? "non-fast-forward update" : "new branch";
  console.log(
    `[checks] ${kind} ${update.localRef}: base is the merge-base with ${chosen.ref} ` +
      `(${chosen.sha.slice(0, 12)}, ${chosen.count} pushed commit(s))`
  );
  return { sha: chosen.sha, tips: live.candidates.map(({ sha }) => sha) };
}

// The live default and integration/* tips of the remote that are present
// locally, after one fetch of any that are missing. They choose a new branch's
// base and, for every branch push, mark the pushed commits that are not the
// branch's own (scanPushedHistory).
function listLiveBaseTips(repoRoot, remoteLocation) {
  if (!isUsableRemoteLocation(remoteLocation)) return { reason: "the push remote location is unusable" };
  const git = gitRunner(repoRoot, 15_000);
  const listing = git(["ls-remote", "--symref", "--", remoteLocation, "HEAD", "refs/heads/*"]);
  const remoteHeads = listing.status === 0 ? parseRemoteHeads(listing.stdout) : null;
  if (!remoteHeads) return { reason: "the remote's branch heads could not be listed" };
  const candidates = selectBaseCandidates(remoteHeads);
  const missing = findMissingCandidateTips(candidates, git);
  if (missing.length > 0) {
    console.log(`[checks] fetching ${missing.length} remote branch tip(s) missing locally to choose a base`);
    const fetched = gitRunner(repoRoot, 120_000)([
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remoteLocation,
      ...missing.map((candidate) => candidate.ref),
    ]);
    const fetchReason = fetched.status === 0
      ? "the fetch succeeded but the live tip is still absent (the branch moved after ls-remote)"
      : `git fetch exited ${fetched.status ?? "abnormally"}: ${fetched.stderr.split(/\r?\n/).at(-1) || "no error output"}`;
    // A candidate that is still missing is skipped as a base; say which and why.
    for (const candidate of findMissingCandidateTips(missing, git)) {
      console.log(`[checks] skipping base candidate ${candidate.ref} (${candidate.sha.slice(0, 12)}): ${fetchReason}`);
    }
  }
  const absent = new Set(findMissingCandidateTips(candidates, git).map(({ ref }) => ref));
  return { candidates: candidates.filter(({ ref }) => !absent.has(ref)) };
}

function runSharedHistoryGuard(repoRoot, parsedUpdates, remote, remoteLocation) {
  const verdict = checkSharedHistory({
    updates: parsedUpdates.updates,
    remoteName: remote,
    remoteLocation,
    git: gitRunner(repoRoot, 15_000),
    fetchGit: gitRunner(repoRoot, 120_000),
  });
  if (verdict.kind === "refuse") throw new Error(verdict.message);
  console.log(
    verdict.kind === "ok"
      ? `[checks] shared history: ${verdict.message}`
      : `[checks] shared-history guard skipped: ${verdict.message}`
  );
}

function isFastForwardUpdate(repoRoot, remoteSha, localSha) {
  const result = spawnSync(
    commands.git,
    ["merge-base", "--is-ancestor", remoteSha, localSha],
    {
      cwd: repoRoot,
      stdio: "ignore",
    }
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  return result.status === 0;
}

function decodeUtf8Strict(output) {
  if (!Buffer.isBuffer(output)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    return null;
  }
}

function getChangedEntries(repoRoot, baseSha, localSha) {
  const result = spawnSync(
    commands.git,
    ["diff", "--no-renames", "--raw", "-z", `${baseSha}..${localSha}`, "--"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.error || result.status !== 0) return null;

  const decoded = decodeUtf8Strict(result.stdout);
  if (decoded === null) return null;
  return parseGitRawDiff(decoded);
}

function getGitBlob(repoRoot, objectId, relativePath) {
  const result = spawnSync(commands.git, ["show", `${objectId}:${relativePath}`], {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return decodeUtf8Strict(result.stdout);
}

// The tier of a push is decided from the branch's own commits: those in
// base..local that no live default or integration/* tip of the remote already
// contains (`excludedTips`). A sub-branch that merges its integration base
// therefore does not inherit the base's global-input changes; those commits
// were checked when they reached that tip. A merge commit's own change is the
// set of paths where it differs from every parent (its conflict resolutions):
// what it takes unchanged from one parent is that parent's history, which is
// either checked here as own commits or already on a live tip.
//
// Returns { reason } when the pushed history needs the full checks, else
// { ownCommits, excludedCommits, ownPaths }. ownPaths is null when nothing was
// excluded, so the whole base..local diff is the branch's own.
function scanPushedHistory(repoRoot, baseSha, localSha, excludedTips = []) {
  const history = captureOptional(commands.git, ["rev-list", "--parents", `${baseSha}..${localSha}`], repoRoot);
  if (!history) return { reason: "pushed history could not be resolved" };
  let own = history.split("\n");
  if (excludedTips.length > 0) {
    const scoped = spawnSync(
      commands.git,
      ["rev-list", "--parents", localSha, `^${baseSha}`, ...excludedTips.map((sha) => `^${sha}`), "--"],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (scoped.error || scoped.status !== 0) return { reason: "pushed history could not be scoped to own commits" };
    own = (scoped.stdout || "").split("\n").filter(Boolean);
  }
  const excludedCommits = history.split("\n").length - own.length;
  const ownPaths = excludedCommits > 0 ? new Set() : null;
  for (const line of own) {
    const [commit, ...parents] = line.split(" ");
    if (parents.length === 0 || ![commit, ...parents].every((sha) => /^[0-9a-f]{40,64}$/.test(sha))) {
      return { reason: "pushed history has no conservative parent" };
    }
    const perParent = [];
    for (const parent of parents) {
      const entries = getChangedEntries(repoRoot, parent, commit);
      if (entries === null) return { reason: "pushed history diff failed" };
      perParent.push(entries);
    }
    const entries = perParent.length === 1
      ? perParent[0]
      : perParent[0].filter(({ path }) => perParent.every((list) => list.some((entry) => entry.path === path)));
    for (const { path } of entries) ownPaths?.add(path);
    if (entries.length === 0 || classifyDocumentationChanges(entries).docsOnly) continue;
    const selection = selectFastSourceChecks(entries);
    if (!selection.eligible) return { reason: `${selection.reason} in pushed history` };
  }
  return { ownCommits: own.length, excludedCommits, ownPaths };
}

// The checks for the message catalog files of a fast push (see
// selectMessageCatalogChecks). The pushed commit is the clean checked-out
// HEAD (runPushCheckoutChecks), so the working tree is the pushed tree.
function getMessageCatalogSelection(repoRoot, entries) {
  const listing = spawnSync(commands.git, ["ls-files", "-z", "--", "src", "test"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const decoded = listing.error || listing.status !== 0 ? null : decodeUtf8Strict(listing.stdout);
  if (decoded === null) return { reason: "tracked files could not be listed for message consumers; full checks required" };
  return selectMessageCatalogChecks(entries, {
    readBlob: (sha, relativePath) => getGitBlob(repoRoot, sha, relativePath),
    trackedFiles: decoded.split("\0").filter(Boolean),
    readTrackedFile: (relativePath) => {
      try {
        return readFileSync(join(repoRoot, relativePath), "utf8");
      } catch {
        return null;
      }
    },
  });
}

// The selection for catalog changes selectMessageCatalogChecks cannot
// attribute (see selectUnattributedCatalogChecks): the same reads as
// getMessageCatalogSelection, without its full-checks reasons.
function getUnattributedCatalogSelection(repoRoot, entries) {
  const listing = spawnSync(commands.git, ["ls-files", "-z", "--", "src", "test"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const decoded = listing.error || listing.status !== 0 ? null : decodeUtf8Strict(listing.stdout);
  if (decoded === null) return { reason: "tracked files could not be listed for message consumers" };
  return selectUnattributedCatalogChecks(entries, {
    readBlob: (sha, relativePath) => getGitBlob(repoRoot, sha, relativePath),
    trackedFiles: decoded.split("\0").filter(Boolean),
    readTrackedFile: (relativePath) => {
      try {
        return readFileSync(join(repoRoot, relativePath), "utf8");
      } catch {
        return null;
      }
    },
  });
}

// A non-fast-forward update replaces a remote commit the local object store
// may not hold. Its objects are fetched once (no tags, no ref or FETCH_HEAD
// update) so the commits it drops can be diffed. Returns whether it is present.
function ensureReplacedRemoteCommit(repoRoot, update, remoteLocation) {
  const git = gitRunner(repoRoot, 15_000);
  const present = () => git(["cat-file", "-e", `${update.remoteSha}^{commit}`]).status === 0;
  if (present()) return true;
  if (!isUsableRemoteLocation(remoteLocation)) return false;
  console.log(`[checks] fetching the replaced remote commit ${update.remoteSha.slice(0, 12)} of ${update.remoteRef}`);
  gitRunner(repoRoot, 120_000)([
    "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remoteLocation, update.remoteRef,
  ]);
  return present();
}

// Only the request cases below (a deletion, the default branch, an
// integration branch, a tag or other non-branch update) return the full
// tier from here; the manual stage and AVE_PREPUSH_FULL=1 are decided by the
// dispatch. Every other push returns a scoped tier (pre-push-tier.mjs): what
// the hook cannot resolve or trace keeps the global-input tier, never the
// full suite, which every pull request's CI runs.
function classifyPrePushChanges(repoRoot, parsedUpdates, remoteLocation) {
  if (!parsedUpdates.complete || parsedUpdates.updates.length === 0) {
    return { docsOnly: false, reason: "ref updates could not be classified" };
  }

  const changedFiles = new Set();
  const changedEntries = [];
  const unresolvedReasons = [];
  let commentOnlyEligible = true;
  let updatesAlreadyOnRemote = 0;
  const protectedBranchNames = getProtectedBranchNames(repoRoot);
  let liveTips = null;
  for (const update of parsedUpdates.updates) {
    if (isNullObjectId(update.localSha)) {
      return { docsOnly: false, reason: `deleted ref ${update.remoteRef} requires full checks` };
    }
    // runPushPolicyChecks refuses these pushes first; the classifier does not
    // rely on that ordering to keep the default branch on the full checks.
    if (
      update.remoteRef.startsWith("refs/heads/") &&
      protectedBranchNames.has(update.remoteRef.slice("refs/heads/".length))
    ) {
      return { docsOnly: false, reason: `push to default branch ${update.remoteRef} requires full checks` };
    }
    // Integration branches advance through reviewed merges; see the header.
    if (isIntegrationBranchRef(update.remoteRef)) {
      return { docsOnly: false, reason: `push to integration branch ${update.remoteRef} requires full checks` };
    }
    if (
      !update.localRef.startsWith("refs/heads/") ||
      !update.remoteRef.startsWith("refs/heads/")
    ) {
      return { docsOnly: false, reason: "non-branch updates require full checks" };
    }

    const isNewBranch = isNullObjectId(update.remoteSha);
    // A rewritten branch (non-fast-forward) is measured like a new branch,
    // plus the replaced remote commit (see the header). null: that commit is
    // not available, so the commits the push drops cannot be listed.
    const replacesRemote = isNewBranch
      ? false
      : ensureReplacedRemoteCommit(repoRoot, update, remoteLocation)
        ? isFastForwardUpdate(repoRoot, update.remoteSha, update.localSha) !== true
        : null;
    if (replacesRemote === null) {
      unresolvedReasons.push(
        `the replaced remote commit ${update.remoteSha} of ${update.remoteRef} is not available locally, so the commits it drops cannot be listed`
      );
    }
    const measuredLikeNewBranch = isNewBranch || replacesRemote !== false;
    if (measuredLikeNewBranch) commentOnlyEligible = false;
    const base = measuredLikeNewBranch
      ? findNewBranchBase(repoRoot, update, remoteLocation)
      : { sha: update.remoteSha };
    if (!base.sha) {
      unresolvedReasons.push(base.reason);
      console.log(`[checks] ${update.localRef}: ${base.reason}; no changed-file tests could be selected for this update; CI runs the full suite`);
      continue;
    }
    const baseSha = base.sha;
    // A new branch at a commit the remote's default or integration branches
    // already contain (cut and pushed before any commit) adds nothing to check.
    if (isNewBranch && baseSha.toLowerCase() === update.localSha.toLowerCase()) {
      updatesAlreadyOnRemote += 1;
      continue;
    }

    // A branch's own commits decide its tier; see scanPushedHistory. A listing
    // failure only loses the scoping: every pushed commit then counts as own.
    // A new or rewritten branch already holds the tips its base came from.
    if (base.tips === undefined && liveTips === null) {
      const live = listLiveBaseTips(repoRoot, remoteLocation);
      if (!live.candidates) console.log(`[checks] own-commit scoping skipped: ${live.reason}`);
      liveTips = live.candidates?.map(({ sha }) => sha) ?? [];
    }
    const history = scanPushedHistory(repoRoot, baseSha, update.localSha, base.tips ?? liveTips);
    // An unresolved history keeps the global-input tier and loses the scoping.
    if (history.reason) unresolvedReasons.push(history.reason);
    // Commits a rewrite drops still change the remote, so only a push that
    // replaces nothing can be wholly already on the remote.
    else if (history.ownCommits === 0 && replacesRemote === false) {
      updatesAlreadyOnRemote += 1;
      continue;
    }
    const diff = getChangedEntries(repoRoot, baseSha, update.localSha);
    if (diff === null) {
      const reason = `git diff failed for ${update.localRef}`;
      unresolvedReasons.push(reason);
      console.log(`[checks] ${update.localRef}: ${reason}; no changed-file tests could be selected for this update; CI runs the full suite`);
      continue;
    }
    const entries = history.ownPaths ? diff.filter(({ path }) => history.ownPaths.has(path)) : diff;
    if (history.ownPaths) {
      console.log(
        `[checks] ${update.localRef}: ${history.excludedCommits} pushed commit(s) already on a live default or ` +
          `integration branch are excluded; the tier follows ${history.ownCommits} own commit(s) and ${entries.length} path(s)`
      );
    }
    const diffs = [{ entries, baseSha }];
    // A commit of the replaced remote branch that the push drops changes the
    // remote tree back: the diff from the replaced commit names its files.
    if (replacesRemote === true) {
      const replaced = getChangedEntries(repoRoot, update.remoteSha, update.localSha);
      if (replaced === null) unresolvedReasons.push(`git diff against the replaced remote commit failed for ${update.localRef}`);
      else diffs.push({ entries: replaced, baseSha: update.remoteSha });
    }
    for (const diff of diffs) {
      for (const entry of diff.entries) {
        changedFiles.add(entry.path);
        changedEntries.push({ ...entry, baseSha: diff.baseSha, localSha: update.localSha });
      }
    }
  }

  if (changedFiles.size === 0 && unresolvedReasons.length === 0 && updatesAlreadyOnRemote === parsedUpdates.updates.length) {
    return {
      docsOnly: false,
      alreadyOnRemote: true,
      reason: "every pushed commit is already on a default or integration branch of the remote",
    };
  }
  if (changedFiles.size === 0 && unresolvedReasons.length === 0) {
    unresolvedReasons.push("no changed files were resolved");
  }
  if (unresolvedReasons.length === 0) {
    const documentation = classifyDocumentationChanges(changedEntries);
    if (documentation.docsOnly) return { ...documentation, pushedEntries: changedEntries };
    // The safety ceiling applies before the narrower comment and test tiers.
    const fastSelection = selectFastSourceChecks(changedEntries);
    if (fastSelection.eligible && commentOnlyEligible && fastSelection.messageCatalogEntries.length === 0) {
      const commentSelection = selectCommentOnlyAveAppFiles(
        changedEntries,
        (objectId, relativePath) => getGitBlob(repoRoot, objectId, relativePath)
      );
      if (commentSelection.eligible) {
        return {
          docsOnly: false,
          commentOnly: true,
          commentFiles: commentSelection.files,
          reason: commentSelection.reason,
        };
      }
    }
    if (fastSelection.eligible) {
      const selection = selectTargetedAveAppVitestFiles(changedEntries);
      if (selection.eligible) {
        return {
          docsOnly: false,
          testOnly: true,
          testFiles: selection.files,
          testSupportFiles: selection.supportFiles,
          supportTestFiles: selection.supportTestFiles,
          reason: selection.reason,
        };
      }
    }
  }

  const scoped = selectScopedTier(changedEntries, unresolvedReasons);
  let tier = scoped.tier;
  const tierReasons = [...scoped.reasons];
  let messageCatalog = null;
  if (scoped.messageCatalogEntries.length > 0) {
    messageCatalog = getMessageCatalogSelection(repoRoot, scoped.messageCatalogEntries);
    if (messageCatalog.reason) {
      // An unattributable catalog change keeps the catalog checks, the i18n
      // suites and the namespace consumers, never the full suite.
      const unattributedReason = messageCatalog.reason;
      const fallback = getUnattributedCatalogSelection(repoRoot, scoped.messageCatalogEntries);
      if (fallback.reason) {
        tier = GLOBAL_INPUT_TIER;
        tierReasons.push(`${unattributedReason}; ${fallback.reason}`);
      }
      messageCatalog = {
        namespaces: fallback.namespaces ?? [],
        testFiles: fallback.testFiles ?? [],
        consumerModules: fallback.consumerModules ?? [],
        unattributed: {
          reason: unattributedReason,
          files: fallback.unattributedFiles ?? [],
          skippedConsumers: fallback.skippedConsumers ?? [],
        },
      };
    }
  }
  return {
    docsOnly: false,
    fastSource: true,
    tier,
    tierReasons,
    lockSuites: selectTriggeredLockSuites([...changedFiles]),
    testFiles: [...new Set([...scoped.testFiles, ...(messageCatalog?.testFiles ?? [])])].sort(),
    relatedFiles: scoped.relatedFiles,
    droppedRelatedFiles: scoped.droppedRelatedFiles,
    namedPaths: scoped.namedPaths,
    messageCatalog: messageCatalog && {
      files: scoped.messageCatalogEntries.map(({ path }) => path),
      namespaces: messageCatalog.namespaces,
      consumerModules: messageCatalog.consumerModules.filter((path) => !scoped.relatedFiles.includes(path)),
      ...(messageCatalog.unattributed ? { unattributed: messageCatalog.unattributed } : {}),
    },
    documentationEntries: scoped.documentationEntries,
    reason: tier === GLOBAL_INPUT_TIER ? tierReasons.join("; ") : scoped.reason,
  };
}

// ---------------------------------------------------------------------------
// Staged safety scan (merge markers, TLS-verification bypass)
// ---------------------------------------------------------------------------

// Git writes the separator as exactly seven `=` on their own line. A longer
// run of `=` is a Markdown setext heading underline (upstream licence texts
// shipped verbatim use them), not a conflict.
const mergeMarkers = /^(<<<<<<< |=======\r?$|>>>>>>> )/m;

function getStagedFiles(repoRoot) {
  const output = capture(
    commands.git,
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    repoRoot
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getStagedFileContent(repoRoot, relativePath) {
  const result = spawnSync(commands.git, ["show", `:${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout ?? "";
}

function runStagedSafetyChecks(repoRoot) {
  run(commands.git, ["diff", "--cached", "--check"], repoRoot);
  const files = getStagedFiles(repoRoot);
  const violations = [];
  for (const relativePath of files) {
    const stagedContent = getStagedFileContent(repoRoot, relativePath);
    if (!stagedContent || stagedContent.includes(String.fromCharCode(0))) continue;
    if (mergeMarkers.test(stagedContent)) {
      violations.push(`${relativePath}: merge conflict markers`);
    }
    // Same pattern list the build runs over dist/ (scripts/lib/tls-bypass-patterns.mjs).
    if (!isTlsBypassScanTarget(relativePath)) continue;
    for (const label of findTlsBypass(stagedContent)) {
      violations.push(`${relativePath}: TLS verification bypass (${label})`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`staged safety checks failed:\n- ${violations.join("\n- ")}`);
  }
}

// ---------------------------------------------------------------------------
// Package checks
// ---------------------------------------------------------------------------

function getPackageManager(dir) {
  const bun = available(commands.bun);
  const npm = available(commands.npm);
  if (hasFile(join(dir, "bun.lock")) || hasFile(join(dir, "bun.lockb"))) {
    if (bun) return bun;
    if (npm) return npm;
    throw new Error(`bun or npm is required for ${dir}`);
  }
  if (hasFile(join(dir, "package-lock.json"))) {
    if (npm) return npm;
    if (bun) return bun;
    throw new Error(`npm or bun is required for ${dir}`);
  }
  if (bun) return bun;
  if (npm) return npm;
  throw new Error(`bun or npm is required for ${dir}`);
}

/**
 * Run the named package scripts, or fail if any of them is absent.
 *
 * A check whose target does not exist must never read as a passing check.
 * This runner used to `continue` past a missing script name, so a stale or
 * misspelled name became a permanently green no-op that left no trace in the
 * log. The runner is scoped to ave (the dispatch below rejects any other
 * repo), so "this repo happens not to define that script" is not a legitimate
 * state — it is a broken reference, and the push gate must say so.
 */
function runPackageScripts(dir, scriptNames, checkLabel) {
  if (!hasFile(join(dir, "package.json"))) {
    throw new Error(`${checkLabel} requires a package.json in ${dir}`);
  }
  const missingScripts = getMissingPackageScripts(
    scriptNames,
    (scriptName) => hasPackageScript(dir, scriptName)
  );
  if (missingScripts.length > 0) {
    throw new Error(
      `${checkLabel} requires package script(s): ${missingScripts.join(", ")}`
    );
  }
  const packageManager = getPackageManager(dir);
  for (const scriptName of scriptNames) {
    run(packageManager, ["run", scriptName], dir,
      scriptName === "test" ? withoutGitContext() : process.env);
  }
}

function runAppTypecheckGate(dir, checkLabel) {
  runPackageScripts(dir, APP_TYPECHECK_GATE_SCRIPTS, `ave ${checkLabel}`);
}

// The full tier holds the exclusive host lock for its whole run, so two full
// suites never share a machine (see pre-push-host-lock.mjs); a waiting run
// prints who holds the lock and fails the push at AVE_PREPUSH_LOCK_TIMEOUT_S.
function runAppChecks(dir) {
  const bun = available(commands.bun);
  if (!bun) {
    throw new Error("bun is required for ave checks");
  }
  const { directory, timeoutMs } = resolveHostLockSettings();
  withHostLock({ name: "full", label: "full-tier", directory, timeoutMs }, () => runAppChecksHoldingLock(dir));
}

function runAppChecksHoldingLock(dir) {
  ensureAppTestRuntimeAbi(dir);
  runAppTypecheckGate(dir, "full checks");
  runPackageScripts(dir, ["test", "build"], "ave full checks");
  // After the suite and the build, not before them and not inside `build`.
  // `check:gate-core` is the one inventory of the hygiene gates CI and this
  // hook share (Knip baseline, duplicate-helper scan, sunset ledger, shape
  // ledger); ci.yml
  // calls the same script, so the two lists cannot drift. Each of them reads
  // a ledger that an unrelated change can make stale; ahead of the suite that
  // failure would end the push gate without a test having run. The sunset
  // ledger used to be the first command of the `build` script, which is
  // where CI hit exactly that. CI-only on purpose, for the pre-push time
  // budget: `check:test-coverage` and the Knip self-test (`test:knip-gate`).
  runPackageScripts(dir, ["check:gate-core"], "ave full checks");
  // Plugin tool names are validated where the names actually enter the host:
  // `validatePluginManifest` rejects any name outside ^[a-zA-Z_][a-zA-Z0-9_]*$
  // and any duplicate within a manifest, and `ToolRegistry` rejects a name
  // already owned by a different owner. A repo-side scanner would need bundled
  // plugin manifests to read, and the host no longer vendors any — the
  // marketplace is the single source. A second scanner could only drift from
  // the two runtime authorities, so there is deliberately none here.
}

function runAppTargetedVitestChecks(dir, testFiles, supportTestFiles = []) {
  const bun = available(commands.bun);
  if (!bun) {
    throw new Error("bun is required for targeted ave Vitest checks");
  }
  if (!hasPackageScript(dir, "check:test-duplicates")) {
    throw new Error(
      "ave targeted Vitest checks require the check:test-duplicates script"
    );
  }
  const targetTestFiles = [...new Set([...testFiles, ...supportTestFiles])].sort();
  if (targetTestFiles.length === 0) {
    throw new Error("targeted ave Vitest checks resolved no test files");
  }
  for (const relativePath of targetTestFiles) {
    if (!hasFile(join(dir, relativePath))) {
      throw new Error(`targeted ave Vitest file is missing: ${relativePath}`);
    }
  }

  runAppTypecheckGate(dir, "targeted Vitest checks");
  run(bun, ["run", "check:test-duplicates", "--", "--fail-on-duplicates"], dir);
  ensureAppTestRuntimeAbi(dir);
  ensureWindowsJobLauncher(dir);
  const vitestArgs = targetTestFiles.map((file) => `./${file}`);
  runVitestChunks(bun, dir, vitestArgs, (chunk) => ["run", "test:vitest", "--", "run", ...chunk]);
}

// vitestArgs is the command (`run` or `related`), its flags, then the file
// arguments; the file arguments may span several Vitest runs (runVitestChunks),
// each with its own JSON report, and the zero-test check applies to their sum.
function runVitestWithReport(bun, dir, vitestArgs, emptyMessage) {
  const [mode, ...rest] = vitestArgs;
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const files = rest.filter((arg) => !arg.startsWith("--"));
  const reportDirectory = mkdtempSync(join(tmpdir(), "ave-related-check-"));
  // Fixed-width names: every chunk's command line is measured with its own path.
  const reportPath = (index) => join(reportDirectory, `report-${String(index).padStart(4, "0")}.json`);
  try {
    const chunks = runVitestChunks(bun, dir, files, (chunk, index) =>
      ["run", "test:vitest", "--", mode, "--reporter=default", "--reporter=json", `--outputFile=${reportPath(index)}`, ...flags, ...chunk]);
    let total = 0;
    let passed = 0;
    for (const index of chunks.keys()) {
      const report = readJsonFile(reportPath(index));
      if (!Number.isSafeInteger(report.numTotalTests) || !Number.isSafeInteger(report.numPassedTests)) {
        throw new Error(emptyMessage);
      }
      total += report.numTotalTests;
      passed += report.numPassedTests;
    }
    if (total <= 0 || passed <= 0) throw new Error(emptyMessage);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

// Runs `bun <buildArgs(chunk, index)>` once per chunk of fileArgs that fits the
// command-line budget (splitArgumentsWithinBudget): the chunks together carry
// exactly fileArgs, and the first failing chunk fails the check. A file list
// over the budget used to reach Windows as one spawn and fail with
// ENAMETOOLONG. Returns the chunks.
function runVitestChunks(bun, dir, fileArgs, buildArgs) {
  const chunks = splitArgumentsWithinBudget(bun, fileArgs, buildArgs);
  for (const [index, chunk] of chunks.entries()) {
    if (chunks.length > 1) {
      console.log(`[checks] Vitest chunk ${index + 1}/${chunks.length}: ${chunk.length} of ${fileArgs.length} file argument(s)`);
    }
    run(bun, buildArgs(chunk, index), dir, withoutGitContext());
  }
  return chunks;
}

// lockSuites: the suites whose trigger paths changed. relatedSelection: the
// discovered related tests ({ tests, narrowed, sources }); when nothing was
// narrowed `vitest related` runs on its sources (the changed modules and the
// message consumers with tests), otherwise the bounded list runs explicitly.
// A Vitest call with no file arguments would run the whole suite, so an empty
// list skips its run instead. messageCatalog: the catalog checks run first.
// frozenLockfile (the global-input tier): a frozen-lockfile install dry run
// (FROZEN_LOCKFILE_ARGS) runs before everything else; it writes nothing.
// The run holds one of AVE_PREPUSH_FAST_SLOTS shared host slots.
function runAppFastSourceChecks(dir, lockSuites, testFiles, relatedSelection, messageCatalog, { frozenLockfile = false } = {}) {
  const bun = available(commands.bun);
  if (!bun) {
    throw new Error("bun is required for fast ave source checks");
  }
  if (!hasPackageScript(dir, "check:test-duplicates")) {
    throw new Error("ave fast source checks require the check:test-duplicates script");
  }
  for (const relativePath of [...lockSuites, ...testFiles, ...relatedSelection.sources, ...relatedSelection.tests]) {
    if (!hasFile(join(dir, relativePath))) {
      throw new Error(`fast ave source check input is missing: ${relativePath}`);
    }
  }
  const { directory, timeoutMs, fastSlots } = resolveHostLockSettings();
  withHostLock({ name: "fast", label: "fast-tier", directory, timeoutMs, slots: fastSlots }, () =>
    runAppFastSourceChecksHoldingSlot(dir, bun, lockSuites, testFiles, relatedSelection, messageCatalog, frozenLockfile));
}

function runAppFastSourceChecksHoldingSlot(dir, bun, lockSuites, testFiles, relatedSelection, messageCatalog, frozenLockfile) {
  if (frozenLockfile) run(bun, [...FROZEN_LOCKFILE_ARGS], dir);
  runAppTypecheckGate(dir, "fast source checks");
  if (messageCatalog) runPackageScripts(dir, MESSAGE_CATALOG_CHECK_SCRIPTS, "ave message catalog checks");
  run(bun, ["run", "check:test-duplicates", "--", "--fail-on-duplicates"], dir);
  ensureAppTestRuntimeAbi(dir);
  ensureWindowsJobLauncher(dir);
  const direct = [...new Set([...lockSuites, ...testFiles])];
  const directArgs = direct.map((file) => `./${file}`);
  if (directArgs.length > 0) {
    runVitestChunks(bun, dir, directArgs, (chunk) => ["run", "test:vitest", "--", "run", ...chunk]);
  }
  if (relatedSelection.sources.length === 0) return;
  if (relatedSelection.narrowed.length === 0) {
    const relatedArgs = relatedSelection.sources.map((file) => `./${file}`);
    runVitestWithReport(bun, dir, ["related", "--run", ...relatedArgs],
      "related tests ran zero tests; rerun with AVE_PREPUSH_FULL=1");
    return;
  }
  const alreadyRun = new Set(direct);
  const boundedArgs = relatedSelection.tests.filter((file) => !alreadyRun.has(file)).map((file) => `./${file}`);
  if (boundedArgs.length > 0) {
    runVitestWithReport(bun, dir, ["run", ...boundedArgs],
      "bounded related tests ran zero tests; rerun with AVE_PREPUSH_FULL=1");
  }
}

// Per-module related-test discovery, then the bound of pre-push-source-policy.
// consumerModules are message consumers: unchanged modules that name a changed
// message key; one with no related test file is reported and left out. A
// changed module with no related test file is returned in untestedModules,
// whose extra selection sources the dispatch adds (selectUntestedModuleTests).
// Returns { tests, narrowed, sources, untestedConsumers, untestedModules } or
// { reason } (the global-input tier); sources are the modules `vitest
// related` runs on.
function getFastSourceRelatedSelection(dir, relatedFiles, consumerModules = []) {
  const discovered = [...relatedFiles, ...consumerModules];
  if (discovered.length === 0) return { tests: [], narrowed: [], sources: [], untestedConsumers: [], untestedModules: [] };
  // Discovery is per source, so the chunks' reports concatenate to the report
  // of one spawn over every source.
  const discoveryScript = join(dir, "scripts/hooks/pre-push-related-tests.mjs");
  const coverage = [];
  for (const chunk of splitArgumentsWithinBudget(commands.node, discovered, (sources) => [discoveryScript, ...sources])) {
    const result = spawnSync(commands.node, [discoveryScript, ...chunk], {
      cwd: dir,
      env: withoutGitContext(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return { reason: "related test discovery failed" };
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      return { reason: "related test discovery returned an invalid report" };
    }
    if (!Array.isArray(report)) return { reason: "related test coverage could not be resolved" };
    coverage.push(...report);
  }
  // Every source may have no related test here; the report's shape and paths
  // are still validated.
  const reason = getRelatedCoverageFullReason([], coverage, discovered);
  if (reason) return { reason };
  const tested = coverage.filter((record) => record.tests.length > 0);
  const bounded = boundRelatedTests(tested, (relativePath) => {
    try {
      return readFileSync(join(dir, relativePath), "utf8");
    } catch {
      return null;
    }
  });
  if (bounded.reason) return bounded;
  return {
    ...bounded,
    sources: tested.map((record) => record.source),
    untestedConsumers: coverage.filter((record) => record.tests.length === 0 && !relatedFiles.includes(record.source))
      .map((record) => record.source),
    untestedModules: coverage.filter((record) => record.tests.length === 0 && relatedFiles.includes(record.source))
      .map((record) => record.source),
  };
}

// The tests a scoped tier adds beyond the changed tests and `vitest related`:
// the tests that name a changed path of namedPaths or an untested module, and
// the must-run tests and lock suites of each untested module
// (selectUntestedModuleTests). The pushed commit is the clean checked-out
// HEAD, so the working tree is the pushed tree.
function getScopedExtraTests(repoRoot, namedPaths, untestedModules) {
  if (namedPaths.length === 0 && untestedModules.length === 0) return { namedTests: [], untested: [] };
  const listing = spawnSync(commands.git, ["ls-files", "-z", "--", "src", "test"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const decoded = listing.error || listing.status !== 0 ? null : decodeUtf8Strict(listing.stdout);
  if (decoded === null) throw new Error("[PRE_PUSH_TRACKED_TESTS] tracked test files could not be listed for the scoped tier");
  const trackedTests = decoded.split("\0").filter((path) => path && isCollectedVitestFile(path)).sort();
  const texts = new Map();
  const readText = (relativePath) => {
    if (!texts.has(relativePath)) {
      try {
        texts.set(relativePath, readFileSync(join(repoRoot, relativePath), "utf8"));
      } catch {
        texts.set(relativePath, null);
      }
    }
    return texts.get(relativePath);
  };
  const namedTests = selectNamedPathTests(namedPaths, trackedTests, readText);
  if (untestedModules.length === 0) return { namedTests, untested: [] };
  const mustRunDocument = readJsonFile(join(repoRoot, MUST_RUN_TESTS_PATH));
  const untested = untestedModules.map((module) =>
    selectUntestedModuleTests(module, selectNamedPathTests([module], trackedTests, readText), mustRunDocument, trackedTests));
  return { namedTests, untested };
}

// Completes a scoped tier's run list after related-test discovery. The
// global-input tier runs every lock suite. Discovery that fails, or a bound
// that cannot be met without dropping a module's coverage, drops `vitest
// related` and keeps the global-input tier; every changed module then counts
// as untested, so the tests that name it and its must-run tests still run.
function resolveScopedTier(repoRoot, classification) {
  const consumerModules = classification.messageCatalog?.consumerModules ?? [];
  let relatedSelection = getFastSourceRelatedSelection(repoRoot, classification.relatedFiles, consumerModules);
  let { tier, tierReasons } = classification;
  if (relatedSelection.reason) {
    tier = GLOBAL_INPUT_TIER;
    tierReasons = [...tierReasons, relatedSelection.reason.replace(/; full checks required$/u, "")];
    relatedSelection = {
      tests: [], narrowed: [], sources: [], untestedConsumers: consumerModules, untestedModules: classification.relatedFiles,
    };
  }
  const extra = getScopedExtraTests(repoRoot, classification.namedPaths, relatedSelection.untestedModules);
  const untestedTests = extra.untested.flatMap(({ namedTests, mustRunTests }) => [...namedTests, ...mustRunTests]);
  return {
    ...classification,
    tier,
    tierReasons,
    reason: tier === GLOBAL_INPUT_TIER ? tierReasons.join("; ") : classification.reason,
    lockSuites: tier === GLOBAL_INPUT_TIER
      ? AVE_APP_LOCK_SUITES.map((suite) => ({ suite, path: "a global-input change" }))
      : classification.lockSuites,
    testFiles: [...new Set([...classification.testFiles, ...extra.namedTests, ...untestedTests])].sort(),
    namedTests: extra.namedTests,
    untestedModules: extra.untested,
    relatedSelection,
  };
}

// The retired-name gate scans the tracked tree in well under a second, so every
// pre-push tier runs it; the full tier gets it through `check:gate-core`.
function runRetiredNameGate(repoRoot) {
  run(commands.node, ["--test", "test/scripts/retired-name.test.mjs"], repoRoot);
  run(commands.node, ["scripts/check-retired-name.mjs"], repoRoot);
}

function runAppCommentOnlyChecks(dir) {
  runAppTypecheckGate(dir, "comment-only checks");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const { stage, repo, remote, remoteLocation } = parseArgs(process.argv.slice(2));
const repoRoot = resolve(repo);
const prePushUpdates =
  stage === "pre-push"
    ? resolveHeadUpdates(parsePrePushUpdates(readPrePushInput()), () => headBranch(repoRoot))
    : null;
let pushCheckout;
if (stage === "pre-push") {
  runPushPolicyChecks(repoRoot, prePushUpdates);
  runSharedHistoryGuard(repoRoot, prePushUpdates, remote, remoteLocation);
  pushCheckout = runPushCheckoutChecks(repoRoot, prePushUpdates);
}

if (!isNamedPackage(repoRoot, "ave") && basename(repoRoot) !== "ave") {
  // App-scoped runner: fail loudly if a mis-wired hook points it at another
  // repo, rather than silently skipping that repo's checks.
  throw new Error(
    `[app-checks-scope] run-local-checks is ave only (repo=${basename(repoRoot)})`
  );
}

console.log(`[checks] stage=${stage} repo=${basename(repoRoot)}`);

if (stage === "pre-push" && !pushCheckout.treeRequired) {
  console.log("[checks] deletion-only or empty push: no commit tree requires checks");
  process.exit(0);
}

if (stage === "pre-commit") {
  runCommitPolicyChecks(repoRoot);
  runStagedSafetyChecks(repoRoot);
} else if (stage === "pre-push" || stage === "manual") {
  runStagedSafetyChecks(repoRoot);
  let classification =
    stage !== "pre-push"
      ? { docsOnly: false, reason: `${stage} stage runs the full checks` }
      : process.env.AVE_PREPUSH_FULL === "1"
        ? { docsOnly: false, reason: "AVE_PREPUSH_FULL=1 requested the full checks" }
        : classifyPrePushChanges(repoRoot, withPushedCommits(prePushUpdates, pushCheckout.commitByLocalSha), remoteLocation);
  if (classification.fastSource) classification = resolveScopedTier(repoRoot, classification);
  if (classification.alreadyOnRemote) {
    console.log(`[checks] tier=none pre-push: nothing to check (${classification.reason})`);
  } else if (classification.docsOnly) {
    checkPushedDocumentation(repoRoot, classification.pushedEntries);
    run(commands.node, ["--test", "test/scripts/check-asrt-version-claims.test.mjs"], repoRoot);
    run(commands.node, ["scripts/check-asrt-version-claims.mjs"], repoRoot);
    runRetiredNameGate(repoRoot);
    console.log(
      `[checks] tier=docs-only pre-push: skipping lint/typecheck/test/build; ${FULL_SUITE_DEFERRED} (${classification.reason})`
    );
  } else if (classification.commentOnly) {
    console.log(
      `[checks] tier=comment-only pre-push: running typecheck; ${FULL_SUITE_DEFERRED} (${classification.reason})`
    );
    runRetiredNameGate(repoRoot);
    runAppCommentOnlyChecks(repoRoot);
  } else if (classification.testOnly) {
    const testCodeFileCount =
      classification.testFiles.length + classification.testSupportFiles.length;
    console.log(
      `[checks] tier=test-only pre-push: running typecheck, duplicate-helper policy, and ` +
        `${testCodeFileCount} targeted Vitest code file(s); ${FULL_SUITE_DEFERRED} ` +
        `(${classification.reason})`
    );
    runRetiredNameGate(repoRoot);
    runAppTargetedVitestChecks(
      repoRoot,
      classification.testFiles,
      classification.supportTestFiles
    );
  } else if (classification.fastSource) {
    const { tier, lockSuites, relatedSelection, messageCatalog, untestedModules } = classification;
    const frozenLockfile = tier === GLOBAL_INPUT_TIER;
    console.log(describeScopedTier({
      tier,
      runs: "typecheck, duplicate-helper policy, " +
        (frozenLockfile ? "a frozen-lockfile install dry run, " : "") +
        (messageCatalog ? "the message catalog checks, " : "") +
        `${lockSuites.length} ${frozenLockfile ? "" : "triggered "}lock suite(s), ${classification.testFiles.length} changed, ` +
        `document-reader, message-consumer, path-naming or must-run test file(s), ` +
        `and Vitest related to ${relatedSelection.sources.length} module(s)`,
      reason: classification.reason,
    }));
    if (classification.droppedRelatedFiles.length > 0) {
      console.log(
        `[checks] dropped ${classification.droppedRelatedFiles.length} related module(s) from local discovery ` +
          `because changed file arguments exceed the safe command limit; CI covers them; path-naming tests still run`
      );
    }
    if (messageCatalog) {
      console.log(
        `[checks] message catalog: ${messageCatalog.files.length} file(s) change namespace(s) ` +
          `${messageCatalog.namespaces.join(", ") || "(none)"}; ${messageCatalog.consumerModules.length} consumer module(s)` +
          (relatedSelection.untestedConsumers.length > 0
            ? `, of which no Vitest file reaches ${relatedSelection.untestedConsumers.join(", ")}`
            : "")
      );
    }
    if (messageCatalog?.unattributed) {
      const { reason, files, skippedConsumers } = messageCatalog.unattributed;
      console.log(
        `[checks] message catalog not attributable (${reason}): running the i18n suites, the catalog checks ` +
          `and the files that name a touched namespace` +
          (files.length > 0 ? `; no namespace is readable from ${files.join(", ")}` : "") +
          (skippedConsumers.length > 0 ? `; left to CI: ${skippedConsumers.join(", ")}` : "")
      );
    }
    if (tier === GLOBAL_INPUT_TIER) {
      console.log(`[checks] global-input tier: every lock suite runs (${classification.tierReasons.join("; ")})`);
    }
    for (const { suite, path } of tier === GLOBAL_INPUT_TIER ? [] : lockSuites) {
      console.log(`[checks] lock suite ${suite}: triggered by ${path}`);
    }
    if (classification.namedTests.length > 0) {
      console.log(`[checks] ${classification.namedTests.length} test file(s) name a changed script, workflow or global path`);
    }
    for (const { module, namedTests, mustRunTests, lockSuites: moduleLockSuites, untested } of untestedModules) {
      console.log(untested
        ? `[checks] ${module} has no local test: no related, path-naming, must-run or lock-suite test file reaches it; continuing`
        : `[checks] ${module} has no related test file; running ${namedTests.length} path-naming, ` +
          `${mustRunTests.length} must-run and ${moduleLockSuites.length} lock-suite test file(s) instead`);
    }
    for (const { source, related, direct, lockSuites: keptLockSuites } of relatedSelection.narrowed) {
      console.log(
        `[checks] related tests bounded: ${source} reaches ${related} test file(s); running its ${direct} direct importer(s) ` +
          `and ${keptLockSuites} lock suite(s) ` +
          `(over ${RELATED_TEST_BOUND} related files in total; CI selects the rest)`
      );
    }
    if (classification.documentationEntries.length > 0) {
      checkPushedDocumentation(repoRoot, classification.documentationEntries);
      run(commands.node, ["--test", "test/scripts/check-asrt-version-claims.test.mjs"], repoRoot);
      run(commands.node, ["scripts/check-asrt-version-claims.mjs"], repoRoot);
    }
    runRetiredNameGate(repoRoot);
    runAppFastSourceChecks(
      repoRoot,
      lockSuites.map(({ suite }) => suite),
      classification.testFiles,
      relatedSelection,
      messageCatalog,
      { frozenLockfile }
    );
  } else {
    console.log(
      `[checks] tier=full ${stage}: running typecheck, full test, build, and gate-core ` +
        `(${classification.reason})`
    );
    runAppChecks(repoRoot);
  }
} else {
  throw new Error(`unsupported stage: ${stage}`);
}

if (stage === "pre-push") runPushCheckoutChecks(repoRoot, prePushUpdates);
