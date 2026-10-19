/**
 * The repository was re-created from a rewritten history on 2026-10-17. A clone
 * made before then still holds the old commits, and a new branch pushed from it
 * is not a non-fast-forward, so the server would accept it and store the old
 * history's objects. The pre-push guard refuses any update that shares no
 * history with the remote's default branch, and skips (saying why) when that
 * branch is unknown.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { checkSharedHistory, parseRemoteDefaultHead } from "../../scripts/hooks/pre-push-shared-history.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";

const HOOK = resolve("scripts/hooks/run-local-checks.mjs");
const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pre-push-shared-history-"));
  const env = gitFixtureEnv(root);
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
  const run = (cwd: string) => (args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const init = (dir: string) => {
    git(root, ["init", "-q", "-b", "main", dir]);
    git(dir, ["config", "user.name", "Fixture"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
  };
  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git(dir, ["add", file]);
    git(dir, ["commit", "-qm", `write ${file}`]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const update = (localSha: string, ref = "refs/heads/feat/x") => ({ localRef: ref, localSha, remoteRef: ref, remoteSha: ZERO });
  return { root, env, git, run, init, commit, update, cleanup: () => cleanupTmpDir(root) };
}

describe("parseRemoteDefaultHead", () => {
  it("reads the default branch and its tip", () => {
    expect(parseRemoteDefaultHead(`ref: refs/heads/main\tHEAD\n${A}\tHEAD\n`)).toEqual({ ref: "refs/heads/main", sha: A });
  });

  it("reports a remote with no HEAD as empty", () => {
    expect(parseRemoteDefaultHead("")).toEqual({ empty: true });
  });

  it.each([
    [`${A}\tHEAD\n`],
    ["ref: refs/heads/main\tHEAD\n"],
    [`ref: refs/tags/main\tHEAD\n${A}\tHEAD\n`],
    [`ref: refs/heads/main\tHEAD\n${A}\trefs/heads/main\n`],
    [`ref: refs/heads/main\tHEAD\nnot-a-sha\tHEAD\n`],
    [`ref: refs/heads/main\tHEAD\n${A}\tHEAD\n${B}\tHEAD\n`],
  ])("refuses a malformed listing %#", (text) => {
    expect(parseRemoteDefaultHead(text)).toBeNull();
  });
});

describe("checkSharedHistory against real repositories", () => {
  it("passes a branch cut from the remote's main, fetching a tip the clone does not have yet", async () => {
    const s = sandbox();
    try {
      const remote = join(s.root, "remote.git");
      const seed = join(s.root, "seed");
      const writer = join(s.root, "writer");
      s.git(s.root, ["init", "-q", "--bare", "-b", "main", remote]);
      s.init(seed);
      s.commit(seed, "a.txt", "a\n");
      s.git(seed, ["push", "-q", remote, "main"]);
      s.git(s.root, ["clone", "-q", remote, writer]);
      s.git(writer, ["config", "user.name", "Fixture"]);
      s.git(writer, ["config", "user.email", "fixture@example.invalid"]);
      // main moves on after the writer cloned: its tip is not in the writer's store.
      const moved = s.commit(seed, "b.txt", "b\n");
      s.git(seed, ["push", "-q", remote, "main"]);
      s.git(writer, ["checkout", "-qb", "feat/x"]);
      const local = s.commit(writer, "c.txt", "c\n");
      expect(s.run(writer)(["cat-file", "-e", `${moved}^{commit}`]).status).not.toBe(0);

      const verdict = checkSharedHistory({
        updates: [s.update(local)], remoteName: "origin", remoteLocation: remote,
        git: s.run(writer), fetchGit: s.run(writer),
      });
      expect(verdict).toEqual({
        kind: "ok",
        message: `every pushed commit shares history with the remote's refs/heads/main (${moved.slice(0, 12)})`,
      });
    } finally { await s.cleanup(); }
  });

  it("refuses a branch from an unrelated history and names it", async () => {
    const s = sandbox();
    try {
      const remote = join(s.root, "remote.git");
      const seed = join(s.root, "seed");
      const old = join(s.root, "old");
      s.git(s.root, ["init", "-q", "--bare", "-b", "main", remote]);
      s.init(seed);
      const tip = s.commit(seed, "a.txt", "rewritten\n");
      s.git(seed, ["push", "-q", remote, "main"]);
      s.init(old);
      const local = s.commit(old, "a.txt", "original\n");
      s.git(old, ["remote", "add", "origin", remote]);

      const verdict = checkSharedHistory({
        updates: [s.update(local)], remoteName: "origin", remoteLocation: remote,
        git: s.run(old), fetchGit: s.run(old),
      });
      expect(verdict.kind).toBe("refuse");
      expect(verdict.message).toContain(
        `[PRE_PUSH_UNRELATED_HISTORY] refusing push: these updates share no history with the remote's refs/heads/main (${tip.slice(0, 12)}):`,
      );
      expect(verdict.message).toContain(`  refs/heads/feat/x (${local.slice(0, 12)})`);
      expect(verdict.message).toContain("Clone the repository again");
    } finally { await s.cleanup(); }
  });

  it("skips a remote that has no default branch yet", async () => {
    const s = sandbox();
    try {
      const remote = join(s.root, "remote.git");
      const writer = join(s.root, "writer");
      s.git(s.root, ["init", "-q", "--bare", "-b", "main", remote]);
      s.init(writer);
      const local = s.commit(writer, "a.txt", "a\n");
      const verdict = checkSharedHistory({
        updates: [s.update(local, "refs/heads/main")], remoteName: "origin", remoteLocation: remote,
        git: s.run(writer), fetchGit: s.run(writer),
      });
      expect(verdict).toEqual({ kind: "skip", message: "the remote has no default branch yet (a fresh repository)" });
    } finally { await s.cleanup(); }
  });

  it("falls back to the local tracking ref when the remote cannot be listed", async () => {
    const s = sandbox();
    try {
      const writer = join(s.root, "writer");
      s.init(writer);
      const tracked = s.commit(writer, "a.txt", "a\n");
      s.git(writer, ["update-ref", "refs/remotes/origin/main", tracked]);
      const local = s.commit(writer, "b.txt", "b\n");
      const verdict = checkSharedHistory({
        updates: [s.update(local)], remoteName: "origin", remoteLocation: join(s.root, "missing.git"),
        git: s.run(writer), fetchGit: s.run(writer),
      });
      expect(verdict).toEqual({
        kind: "ok",
        message: `every pushed commit shares history with refs/remotes/origin/main (${tracked.slice(0, 12)})`,
      });
    } finally { await s.cleanup(); }
  });
});

describe("checkSharedHistory edge cases", () => {
  const listing = `ref: refs/heads/main\tHEAD\n${A}\tHEAD\n`;

  it("skips when no push remote was given and nothing is tracked", () => {
    const git = () => ({ status: 1, stdout: "", stderr: "" });
    expect(checkSharedHistory({ updates: [{ localRef: "refs/heads/x", localSha: B, remoteRef: "refs/heads/x", remoteSha: ZERO }], remoteName: null, remoteLocation: null, git, fetchGit: git }))
      .toEqual({ kind: "skip", message: "no push remote was given, so its default branch is unknown" });
  });

  it("skips a deletion-only push without touching git", () => {
    const git = () => { throw new Error("git must not run"); };
    expect(checkSharedHistory({ updates: [{ localRef: "(delete)", localSha: ZERO, remoteRef: "refs/heads/x", remoteSha: B }], remoteName: "origin", remoteLocation: "/remote", git, fetchGit: git }))
      .toEqual({ kind: "skip", message: "the push only deletes refs" });
  });

  it("refuses when the remote tip cannot be fetched", () => {
    const git = (args: string[]) => args[0] === "ls-remote"
      ? { status: 0, stdout: listing, stderr: "" }
      : { status: 1, stdout: "", stderr: "" };
    const fetchGit = () => ({ status: 128, stdout: "", stderr: "fatal: unable to access remote\nfatal: could not read from remote" });
    const verdict = checkSharedHistory({ updates: [{ localRef: "refs/heads/x", localSha: B, remoteRef: "refs/heads/x", remoteSha: ZERO }], remoteName: "origin", remoteLocation: "/remote", git, fetchGit });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.message).toContain("[PRE_PUSH_SHARED_HISTORY_UNVERIFIED]");
    expect(verdict.message).toContain("git fetch exited 128: fatal: could not read from remote");
    expect(verdict.message).toContain("Run `git fetch origin` and push again.");
  });

  it("refuses when merge-base fails for a reason other than unrelated history", () => {
    const git = (args: string[]) => {
      if (args[0] === "ls-remote") return { status: 0, stdout: listing, stderr: "" };
      if (args[0] === "cat-file") return { status: 0, stdout: "", stderr: "" };
      return { status: 128, stdout: "", stderr: "fatal: bad object" };
    };
    const verdict = checkSharedHistory({ updates: [{ localRef: "refs/heads/x", localSha: B, remoteRef: "refs/heads/x", remoteSha: ZERO }], remoteName: "origin", remoteLocation: "/remote", git, fetchGit: git });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.message).toContain("[PRE_PUSH_SHARED_HISTORY_UNVERIFIED]");
    expect(verdict.message).toContain("exited 128: fatal: bad object");
  });
});

describe("pre-push runner", () => {
  it("refuses an unrelated-history push before running any check", async () => {
    const s = sandbox();
    try {
      const remote = join(s.root, "remote.git");
      const seed = join(s.root, "seed");
      const old = join(s.root, "old");
      s.git(s.root, ["init", "-q", "--bare", "-b", "main", remote]);
      s.init(seed);
      s.commit(seed, "a.txt", "rewritten\n");
      s.git(seed, ["push", "-q", remote, "main"]);
      s.init(old);
      writeFileSync(join(old, "package.json"), '{"name":"ave"}\n');
      const local = s.commit(old, "a.txt", "original\n");
      const result = spawnSync("node", [HOOK, "--repo", old, "--stage", "pre-push", "--remote", "origin", "--remote-location", remote], {
        env: { ...s.env, AVE_HOME: join(s.root, "runtime"), AVE_PREPUSH_LOCK_DIR: join(s.root, "locks") },
        encoding: "utf8",
        input: `refs/heads/feat/x ${local} refs/heads/feat/x ${ZERO}\n`,
        timeout: 15_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[PRE_PUSH_UNRELATED_HISTORY]");
      expect(result.stdout).not.toContain("[checks] stage=pre-push");
    } finally { await s.cleanup(); }
  });
});
