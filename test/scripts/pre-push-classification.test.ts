import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { findTlsBypass, isTlsBypassScanTarget } from "../../scripts/lib/tls-bypass-patterns.mjs";
import { classifyDocumentationChanges } from "../../scripts/hooks/pre-push-markdown-policy.mjs";
import { parseGitRawDiff } from "../../scripts/hooks/pre-push-ref-updates.mjs";
import { isMessageCatalogPath } from "../../scripts/hooks/pre-push-source-policy.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import { modifiedEntry as modified } from "../../src/__tests__/support/git-diff-entry.js";
// Async removal clears read-only loose-object attributes on Windows.
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";

const source = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
const start = source.indexOf("// The pushed change set.");
const end = source.indexOf("// Staged safety scan", start);
const baseSha = "a".repeat(40);
const localSha = "b".repeat(40);
const update = { localRef: "refs/heads/topic", remoteRef: "refs/heads/topic", localSha, remoteSha: baseSha };
type Entry = { status: string; oldMode: string; newMode: string; path: string };
interface PushOptions {
  update?: Partial<typeof update>;
  updates?: typeof update[];
  complete?: boolean;
  fastForward?: boolean;
  replacedRemoteAvailable?: boolean;
  newBranchBase?: string;
  baseFailure?: string;
  diffFailure?: boolean;
  // Per-base entries override the default diff entries.
  changedEntries?: (base: string) => Entry[];
}

// Exercise the actual collector and planner with controlled Git reads without running checks.
function plan(entries: Entry[], options: PushOptions = {}) {
  const { collectPushedChanges, planStaticChecks } = runInNewContext(
    `${source.slice(start, end)}; ({ collectPushedChanges, planStaticChecks })`,
    {
      isNullObjectId: (sha: string) => /^0+$/.test(sha),
      findNewBranchBase: () => options.baseFailure ? { reason: options.baseFailure } : { sha: options.newBranchBase ?? baseSha },
      ensureReplacedRemoteCommit: () => options.replacedRemoteAvailable !== false,
      isFastForwardUpdate: () => options.fastForward !== false,
      getChangedEntries: (_root: string, base: string) => options.diffFailure ? null : options.changedEntries?.(base) ?? entries,
      classifyDocumentationChanges,
      isMessageCatalogPath,
    },
  );
  const pushed = collectPushedChanges(
    "/fixture",
    { complete: options.complete !== false, updates: options.updates ?? [{ ...update, ...options.update }] },
    "origin",
  );
  return { pushed, plan: pushed.alreadyOnRemote ? null : planStaticChecks(pushed) };
}

describe("pre-push static check selection", () => {
  it("runs only the document checks for a documentation-only push", () => {
    const docs = [modified("docs/notes/example.md")];
    expect(plan(docs).plan).toEqual({ docsOnly: true, documents: [{ ...docs[0], baseSha, localSha }], frozenLockfile: false, messageCatalog: false });
  });

  it("runs the typecheck path for a source push and checks only its regular Markdown or HTML documents", () => {
    const result = plan([
      modified("src/lib/example.ts"),
      modified("docs/notes/example.md"),
      { status: "D", oldMode: "100644", newMode: "000000", path: "docs/notes/removed.md" },
      { status: "M", oldMode: "100644", newMode: "100755", path: "docs/notes/mode.html" },
    ]).plan;
    expect(result).toMatchObject({ docsOnly: false, frozenLockfile: false, messageCatalog: false });
    expect(result.documents.map(({ path }: Entry) => path)).toEqual(["docs/notes/example.md"]);
  });

  it.each(["package.json", "bun.lock", "bunfig.toml", "patches/example.patch"])(
    "adds the frozen-lockfile dry run when %s changes", (path) => {
      expect(plan([modified(path)]).plan).toMatchObject({ docsOnly: false, frozenLockfile: true, messageCatalog: false });
    },
  );

  it("adds the message catalog check when a locale catalog changes", () => {
    expect(plan([modified("src/i18n/messages/ko.ts")]).plan).toMatchObject({ docsOnly: false, frozenLockfile: false, messageCatalog: true });
  });

  it.each([
    ["an incomplete ref list", { complete: false }, "ref updates could not be parsed completely"],
    ["an unresolvable base", { update: { remoteSha: "0".repeat(40) }, baseFailure: "no conservative base found" }, "no conservative base found"],
    ["a failed diff", { diffFailure: true }, `git diff ${baseSha}..${localSha} failed for refs/heads/topic`],
    ["a missing replaced remote commit", { fastForward: false, replacedRemoteAvailable: false },
      `the replaced remote commit ${baseSha} of refs/heads/topic is not available locally`],
  ] as const)("runs every static check, never the docs-only path, for %s", (_kind, options, reason) => {
    const { pushed, plan: result } = plan([modified("docs/notes/example.md")], options);
    expect(pushed.unresolved).toContain(reason);
    expect(result).toMatchObject({ docsOnly: false, frozenLockfile: true, messageCatalog: true });
  });

  it("checks nothing for a new branch whose commit the remote already contains", () => {
    expect(plan([], { update: { remoteSha: "0".repeat(40) }, newBranchBase: localSha }).pushed).toEqual({ alreadyOnRemote: true });
  });

  it("diffs a rewritten branch from its merge-base and from the commit it replaces", () => {
    const newBase = "c".repeat(40);
    const { pushed, plan: result } = plan([], {
      fastForward: false,
      newBranchBase: newBase,
      changedEntries: (base) => base === newBase ? [modified("docs/notes/mine.md")] : [modified("docs/notes/dropped.md")],
    });
    expect(pushed.entries.map(({ path, baseSha: entryBase }: Entry & { baseSha: string }) => [path, entryBase]))
      .toEqual([["docs/notes/mine.md", newBase], ["docs/notes/dropped.md", baseSha]]);
    expect(result.docsOnly).toBe(true);
  });

  it("checks the files of a commit a rebase drops from the remote branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pre-push-rebase-"));
    const env = gitFixtureEnv(repo);
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
    try {
      git(["init", "-qb", "main"]);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "docs/shared.md"), "Shared 1.\n");
      git(["add", "."]);
      git(["commit", "-qm", "initial fixture"]);
      const main = git(["rev-parse", "HEAD"]);
      git(["checkout", "-qb", "topic"]);
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/theirs.ts"), "export const theirs = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "their commit"]);
      writeFileSync(join(repo, "docs/mine.md"), "Mine.\n");
      git(["add", "."]);
      git(["commit", "-qm", "my commit"]);
      const remote = git(["rev-parse", "HEAD"]);
      git(["checkout", "-qB", "topic", main]);
      git(["cherry-pick", remote]);
      const local = git(["rev-parse", "HEAD"]);
      expect(git(["diff", "--name-only", main, local])).toBe("docs/mine.md");
      const diff = (base: string) => parseGitRawDiff(execFileSync(
        "git", ["-C", repo, "diff", "--no-renames", "--raw", "-z", `${base}..${local}`, "--"], { env, encoding: "utf8" },
      ));
      const { pushed, plan: result } = plan([], {
        update: { localSha: local, remoteSha: remote },
        fastForward: false,
        newBranchBase: main,
        changedEntries: (base) => diff(base) ?? [],
      });
      expect(pushed.entries.map(({ path, status }: Entry) => `${status} ${path}`).sort())
        .toEqual(["A docs/mine.md", "D src/theirs.ts"]);
      expect(result).toMatchObject({ docsOnly: false });
    } finally {
      await cleanupTmpDir(repo);
    }
  });
});

// Evaluate the hook's staged scan over a fixed staged set without Git.
function stagedScan(files: Record<string, string>) {
  const markers = /^const mergeMarkers = .+;$/m.exec(source)?.[0] ?? "";
  const scanStart = source.indexOf("function runStagedSafetyChecks");
  const scanEnd = source.indexOf("function getPackageManager", scanStart);
  const { runStagedSafetyChecks } = runInNewContext(`${markers}\n${source.slice(scanStart, scanEnd)}; ({ runStagedSafetyChecks })`, {
    commands: { git: "git" },
    run: () => undefined,
    getStagedFiles: () => Object.keys(files),
    getStagedFileContent: (_root: string, path: string) => files[path],
    findTlsBypass,
    isTlsBypassScanTarget,
    String,
    Error,
  });
  return () => runStagedSafetyChecks("/fixture");
}

// Joined at runtime so this file does not trip the scan it tests.
const tlsBypass = ["rejectUnauthorized", "false"].join(": ");

describe("pre-push staged safety scan", () => {
  it("blocks a staged TLS verification bypass in a source file", () => {
    expect(stagedScan({ "src/client.ts": `request({ ${tlsBypass} });\n` }))
      .toThrow(/src\/client\.ts: TLS verification bypass/);
  });

  it("blocks staged merge conflict markers", () => {
    expect(stagedScan({ "src/a.ts": "a\n<<<<<<< HEAD\nb\n" })).toThrow(/src\/a\.ts: merge conflict markers/);
  });

  it("passes clean staged files and bypass prose in documents", () => {
    expect(stagedScan({ "src/a.ts": "export const a = 1;\n", "docs/notes.md": `${tlsBypass}\n` })).not.toThrow();
  });
});
