#!/usr/bin/env node
// App-owned pre-commit / pre-push checks for ave.
// Stages: pre-commit | pre-push | manual. Bypass once with AVE_HOOKS_SKIP=1.
// Pre-push runs static checks only: ref, shared-history and checkout guards,
// staged safety, document safety, the retired-name and Biome gates, and for a
// non-documentation push the typecheck gate, the duplicate-helper scan, the
// message catalog check and a frozen-lockfile dry run when their inputs
// change. Pull request CI runs the tests and the build (scripts/run-ci-suite.mjs).
// The manual stage runs typecheck, the full suite, the build and gate-core
// under one exclusive host lock (pre-push-host-lock.mjs).
// A new or rewritten branch is diffed from the closest merge-base with a live
// default or integration/* tip on the remote (findNewBranchBase); a rewrite is
// also diffed from the remote commit it replaces, since a dropped commit
// changes the remote tree back.
// Every non-deletion update must name HEAD (an annotated tag through the
// commit it peels to) and the tracked checkout must be clean before and after
// checks. Deletion-only pushes have no tree to check.
// Every pushed commit must also share history with the remote's default
// branch (pre-push-shared-history.mjs): a clone of the history replaced on
// 2026-10-17 would otherwise upload the old objects under a new branch name.
import { existsSync } from "node:fs";
import {
  chooseNewBranchBase,
  findMissingCandidateTips,
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
import { runCommand, spawnSyncPortable as spawnSync } from "./spawn-command.mjs";
import {
  APP_TYPECHECK_GATE_SCRIPTS,
  getMissingPackageScripts,
} from "./app-typecheck-gate.mjs";
import { classifyDocumentationChanges } from "./pre-push-markdown-policy.mjs";
import { isMessageCatalogPath, MESSAGE_CATALOG_CHECK_SCRIPTS } from "./pre-push-source-policy.mjs";
import { resolveHostLockSettings, withHostLock } from "./pre-push-host-lock.mjs";
const STATIC_PRE_PUSH_DEFERRED = "tests and build run in pull request CI (scripts/run-ci-suite.mjs)";
// Exits nonzero on lockfile drift and writes nothing.
const FROZEN_LOCKFILE_ARGS = Object.freeze(["install", "--frozen-lockfile", "--dry-run"]);
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
// Range checks need a commit ID rather than an annotated tag object ID.
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
// measured from the same base (collectPushedChanges).
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
  return { sha: chosen.sha };
}
// The live default and integration/* tips of the remote that are present
// locally, after one fetch of any that are missing. They choose a new branch's
// base.
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
// The pushed change set. An update is diffed from its remote commit; a new or
// rewritten branch from its merge-base with the closest live default or
// integration/* tip, and a rewrite also from the remote commit it replaces.
// Returns { alreadyOnRemote: true } or { entries, unresolved }.
function collectPushedChanges(repoRoot, parsedUpdates, remoteLocation) {
  const entries = [];
  const unresolved = parsedUpdates.complete ? [] : ["ref updates could not be parsed completely"];
  const updates = parsedUpdates.updates.filter((update) => !isNullObjectId(update.localSha));
  let alreadyOnRemote = 0;
  for (const update of updates) {
    const isNewBranch = isNullObjectId(update.remoteSha);
    const replacesRemote = isNewBranch
      ? false
      : ensureReplacedRemoteCommit(repoRoot, update, remoteLocation)
        ? isFastForwardUpdate(repoRoot, update.remoteSha, update.localSha) !== true
        : null;
    if (replacesRemote === null) {
      unresolved.push(`the replaced remote commit ${update.remoteSha} of ${update.remoteRef} is not available locally`);
    }
    const base = isNewBranch || replacesRemote !== false
      ? findNewBranchBase(repoRoot, update, remoteLocation)
      : { sha: update.remoteSha };
    if (!base.sha) {
      unresolved.push(base.reason);
      continue;
    }
    if (isNewBranch && base.sha.toLowerCase() === update.localSha.toLowerCase()) {
      alreadyOnRemote += 1;
      continue;
    }
    const bases = replacesRemote === true ? [base.sha, update.remoteSha] : [base.sha];
    for (const baseSha of bases) {
      const diff = getChangedEntries(repoRoot, baseSha, update.localSha);
      if (diff === null) unresolved.push(`git diff ${baseSha}..${update.localSha} failed for ${update.localRef}`);
      else for (const entry of diff) entries.push({ ...entry, baseSha, localSha: update.localSha });
    }
  }
  if (updates.length > 0 && alreadyOnRemote === updates.length && unresolved.length === 0) return { alreadyOnRemote: true };
  return { entries, unresolved };
}
const LOCKFILE_INPUTS = Object.freeze(["package.json", "bun.lock", "bunfig.toml", "patches/"]);
const documentPath = /\.(?:md|html)$/i;
// The static checks a push selects. An unresolved change set selects all of them.
function planStaticChecks({ entries, unresolved }) {
  const all = unresolved.length > 0;
  const docsOnly = !all && classifyDocumentationChanges(entries).docsOnly;
  const paths = entries.map(({ path }) => path);
  return {
    docsOnly,
    documents: docsOnly
      ? entries
      : entries.filter((entry) => /^[AM]$/.test(entry.status) && entry.newMode === "100644" && documentPath.test(entry.path)),
    frozenLockfile: !docsOnly && (all || paths.some((path) =>
      LOCKFILE_INPUTS.some((input) => (input.endsWith("/") ? path.startsWith(input) : path === input)))),
    messageCatalog: !docsOnly && (all || paths.some(isMessageCatalogPath)),
  };
}
// Staged safety scan (merge markers, TLS-verification bypass)
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
    if (!isTlsBypassScanTarget(relativePath)) continue;
    for (const label of findTlsBypass(stagedContent)) {
      violations.push(`${relativePath}: TLS verification bypass (${label})`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`staged safety checks failed:\n- ${violations.join("\n- ")}`);
  }
}
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
// The manual stage holds the exclusive host lock for its whole run, so two full
// suites never share a machine (see pre-push-host-lock.mjs); a waiting run
// prints who holds the lock and fails at AVE_PREPUSH_LOCK_TIMEOUT_S.
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
  runPackageScripts(dir, ["check:gate-core"], "ave full checks");
}
// Under a second; manual checks get it through `check:gate-core`.
function runRetiredNameGate(repoRoot) {
  run(commands.node, ["--test", "test/scripts/retired-name.test.mjs"], repoRoot);
  run(commands.node, ["scripts/check-retired-name.mjs"], repoRoot);
}
// About five seconds; manual checks and CI get it through `check:gate-core`.
function runBiomeGate(repoRoot) {
  run(commands.node, ["--test", "test/scripts/biome-baseline.test.mjs"], repoRoot);
  run(commands.node, ["scripts/check-biome-baseline.mjs"], repoRoot);
}
// Static checks for a push; tests and the build run in CI (scripts/run-ci-suite.mjs).
function runPrePushStaticChecks(dir, plan) {
  if (plan.documents.length > 0) {
    checkPushedDocumentation(dir, plan.documents);
    run(commands.node, ["--test", "test/scripts/check-asrt-version-claims.test.mjs"], dir);
    run(commands.node, ["scripts/check-asrt-version-claims.mjs"], dir);
  }
  runRetiredNameGate(dir);
  runBiomeGate(dir);
  if (plan.docsOnly) return;
  const bun = available(commands.bun);
  if (!bun) throw new Error("bun is required for ave pre-push checks");
  if (plan.frozenLockfile) run(bun, [...FROZEN_LOCKFILE_ARGS], dir);
  runAppTypecheckGate(dir, "pre-push checks");
  run(bun, ["run", "check:test-duplicates", "--", "--fail-on-duplicates"], dir);
  if (plan.messageCatalog) runPackageScripts(dir, MESSAGE_CATALOG_CHECK_SCRIPTS, "ave message catalog checks");
}
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
} else if (stage === "pre-push") {
  runStagedSafetyChecks(repoRoot);
  const pushed = collectPushedChanges(repoRoot, withPushedCommits(prePushUpdates, pushCheckout.commitByLocalSha), remoteLocation);
  if (pushed.alreadyOnRemote) {
    console.log("[checks] tier=none pre-push: nothing to check (every pushed commit is already on a default or integration branch of the remote)");
  } else {
    for (const reason of pushed.unresolved) console.log(`[checks] ${reason}; running every static check`);
    const plan = planStaticChecks(pushed);
    console.log(
      `[checks] tier=${plan.docsOnly ? "docs-only" : "static"} pre-push: ${pushed.entries.length} changed path(s); ` +
        `${STATIC_PRE_PUSH_DEFERRED}`
    );
    runPrePushStaticChecks(repoRoot, plan);
  }
} else if (stage === "manual") {
  runStagedSafetyChecks(repoRoot);
  console.log("[checks] tier=full manual: running typecheck, full test, build, and gate-core");
  runAppChecks(repoRoot);
} else {
  throw new Error(`unsupported stage: ${stage}`);
}
if (stage === "pre-push") runPushCheckoutChecks(repoRoot, prePushUpdates);
