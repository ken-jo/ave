// Unreadable push input must fail closed; a genuine empty ref list is a valid no-op.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  chooseNewBranchBase,
  findMissingCandidateTips,
  isIntegrationBranchRef,
  parsePrePushUpdates,
  parseRemoteHeads,
  resolveHeadUpdates,
  selectBaseCandidates,
} from "../../scripts/hooks/pre-push-ref-updates.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";

const ZERO = "0".repeat(40);
const SHA = "5e544ff8f30aa915be9e0d9e66db564cf1e192f4";
const UPDATE = `refs/heads/topic ${SHA} refs/heads/topic ${ZERO}`;

describe("pre-push ref updates", () => {
  it("accepts a push that updates no ref", () => {
    // A no-op push cannot violate a ref-update policy.
    const result = parsePrePushUpdates({ readable: true, text: "" });
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([]);
  });

  it("refuses an input it could not read", () => {
    expect(parsePrePushUpdates({ readable: false, text: "" }).complete).toBe(false);
  });

  it("parses a real update", () => {
    const result = parsePrePushUpdates({ readable: true, text: UPDATE });
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([
      { localRef: "refs/heads/topic", localSha: SHA, remoteRef: "refs/heads/topic", remoteSha: ZERO },
    ]);
  });

  it("names the branch a HEAD push updates, and only when HEAD is that branch at the pushed commit", () => {
    const head = parsePrePushUpdates({ readable: true, text: `HEAD ${SHA} refs/heads/topic ${ZERO}` });
    expect(resolveHeadUpdates(head, () => ({ ref: "refs/heads/topic", sha: SHA })).updates[0]?.localRef)
      .toBe("refs/heads/topic");
    // Bind every pushed commit to checked-out HEAD, including detached checkouts.
    expect(resolveHeadUpdates(head, () => null).updates[0]?.localRef).toBe("HEAD");
    expect(resolveHeadUpdates(head, () => ({ ref: "refs/heads/topic", sha: "1".repeat(40) })).updates[0]?.localRef)
      .toBe("HEAD");
    const branch = parsePrePushUpdates({ readable: true, text: UPDATE });
    expect(resolveHeadUpdates(branch, () => { throw new Error("not consulted"); })).toBe(branch);
  });

  it("parses several updates and ignores blank lines", () => {
    const result = parsePrePushUpdates({ readable: true, text: `${UPDATE}\n\n${UPDATE}\n` });
    expect(result.complete).toBe(true);
    expect(result.updates).toHaveLength(2);
  });

  it.each([
    ["refs/heads/topic " + SHA + " refs/heads/topic", "too few fields"],
    ["refs/heads/topic " + SHA + " refs/heads/topic " + ZERO + " extra", "too many fields"],
    ["refs/heads/topic nothex refs/heads/topic " + ZERO, "a non-hex object id"],
    ["refs/heads/topic " + SHA.slice(0, 20) + " refs/heads/topic " + ZERO, "a truncated object id"],
  ])("refuses a line with %s (%s)", (line) => {
    // One unreadable line makes the ref set incomplete and unusable for policy enforcement.
    expect(parsePrePushUpdates({ readable: true, text: line }).complete).toBe(false);
  });

  it("refuses the whole set when one line of several is malformed", () => {
    const result = parsePrePushUpdates({ readable: true, text: `${UPDATE}\ngarbage line here` });
    expect(result.complete).toBe(false);
  });

  it("accepts sha256 object ids", () => {
    const sha256 = "a".repeat(64);
    const line = `refs/heads/topic ${sha256} refs/heads/topic ${"0".repeat(64)}`;
    expect(parsePrePushUpdates({ readable: true, text: line }).complete).toBe(true);
  });
});

// Measure sub-branches from the closest live default or integration tip, even with stale tracking refs.
describe("new-branch base", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);

  it("parses the remote's default branch and heads, and refuses malformed listings", () => {
    const listing = [
      "ref: refs/heads/main\tHEAD",
      `${A}\tHEAD`,
      `${A}\trefs/heads/main`,
      `${B}\trefs/heads/integration/permissions`,
      `${C}\trefs/heads/feat/judge-slot`,
      "",
    ].join("\n");
    const heads = parseRemoteHeads(listing);
    expect(heads?.defaultRef).toBe("refs/heads/main");
    expect(selectBaseCandidates(heads!)).toEqual([
      { ref: "refs/heads/main", sha: A },
      { ref: "refs/heads/integration/permissions", sha: B },
    ]);
    expect(parseRemoteHeads(`${A}\trefs/heads/main\n`)).toBeNull();
    expect(parseRemoteHeads(`ref: refs/heads/main\tHEAD\nnot-a-sha\trefs/heads/main\n`)).toBeNull();
    expect(parseRemoteHeads(`ref: refs/heads/main\tHEAD\n${A}\trefs/tags/v1\n`)).toBeNull();
    expect(parseRemoteHeads(`ref: refs/heads/main\tHEAD\n${A}\trefs/heads/other\n`)).toBeNull();
  });

  it.each([
    ["refs/heads/integration/permissions", true],
    ["refs/heads/integration/", false],
    ["refs/heads/feat/integration/x", false],
    ["refs/heads/main", false],
  ])("recognizes integration branch %s: %s", (ref, expected) => {
    expect(isIntegrationBranchRef(ref)).toBe(expected);
  });

  it("measures a sub-branch from its integration branch while the default tracking ref is stale", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pre-push-base-")));
    const env = gitFixtureEnv(root);
    const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
    const commit = (cwd: string, file: string, text: string) => {
      writeFileSync(join(cwd, file), text);
      git(cwd, ["add", file]);
      git(cwd, ["commit", "-qm", `change ${file}`]);
    };
    try {
      const remote = join(root, "remote.git");
      const seed = join(root, "seed");
      const writer = join(root, "writer");
      git(root, ["init", "-q", "--bare", "-b", "main", remote]);
      git(root, ["init", "-q", "-b", "main", seed]);
      git(seed, ["config", "user.name", "Fixture"]);
      git(seed, ["config", "user.email", "fixture@example.invalid"]);
      commit(seed, "base.txt", "base\n");
      git(seed, ["push", "-q", remote, "main"]);
      git(root, ["clone", "-q", remote, writer]);
      git(writer, ["config", "user.name", "Fixture"]);
      git(writer, ["config", "user.email", "fixture@example.invalid"]);
      git(seed, ["checkout", "-qb", "integration/permissions"]);
      for (let index = 0; index < 3; index += 1) commit(seed, `integration-${index}.txt`, `${index}\n`);
      git(seed, ["push", "-q", remote, "integration/permissions"]);
      git(seed, ["checkout", "-q", "main"]);
      commit(seed, "main-only.txt", "main\n");
      git(seed, ["push", "-q", remote, "main"]);
      git(writer, ["fetch", "-q", "origin", "integration/permissions:refs/remotes/origin/integration/permissions"]);
      const staleMain = git(writer, ["rev-parse", "refs/remotes/origin/main"]);
      expect(staleMain).not.toBe(git(seed, ["rev-parse", "main"]));
      git(writer, ["checkout", "-qb", "feat/judge-slot", "origin/integration/permissions"]);
      commit(writer, "judge.txt", "judge\n");
      const localSha = git(writer, ["rev-parse", "HEAD"]);

      const run = (args: string[]) => {
        const result = spawnSync("git", ["-C", writer, ...args], { env, encoding: "utf8" });
        return { status: result.status, stdout: result.stdout };
      };
      const heads = parseRemoteHeads(run(["ls-remote", "--symref", "--", remote, "HEAD", "refs/heads/*"]).stdout);
      expect(heads).not.toBeNull();
      const candidates = selectBaseCandidates(heads!);
      expect(candidates.map(({ ref }) => ref)).toEqual(["refs/heads/main", "refs/heads/integration/permissions"]);
      expect(findMissingCandidateTips(candidates, run).map(({ ref }) => ref)).toEqual(["refs/heads/main"]);
      const integrationTip = git(seed, ["rev-parse", "integration/permissions"]);
      expect(chooseNewBranchBase(localSha, candidates, run)).toEqual({
        ref: "refs/heads/integration/permissions", sha: integrationTip, count: 1,
      });

      // Fetch missing tip objects without moving tracking refs; choose the closest base.
      expect(run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remote, "refs/heads/main"]).status).toBe(0);
      expect(findMissingCandidateTips(candidates, run)).toEqual([]);
      expect(git(writer, ["rev-parse", "refs/remotes/origin/main"])).toBe(staleMain);
      expect(chooseNewBranchBase(localSha, candidates, run)).toEqual({
        ref: "refs/heads/integration/permissions", sha: integrationTip, count: 1,
      });

      git(writer, ["checkout", "-qb", "fix/main-topic", git(seed, ["rev-parse", "main"])]);
      commit(writer, "fix.txt", "fix\n");
      expect(chooseNewBranchBase(git(writer, ["rev-parse", "HEAD"]), candidates, run)).toMatchObject({
        ref: "refs/heads/main", count: 1,
      });
    } finally {
      // Async removal clears read-only loose-object attributes on Windows.
      await cleanupTmpDir(root);
    }
  });

  it("finds no base for unrelated history", () => {
    const run = (args: string[]) => args[0] === "merge-base" ? { status: 1, stdout: "" } : { status: 0, stdout: "" };
    expect(chooseNewBranchBase(A, [{ ref: "refs/heads/main", sha: B }], run)).toBeNull();
  });

  it("logs each base candidate a failed fetch leaves missing", () => {
    const hook = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    const start = hook.indexOf("function findNewBranchBase(");
    const end = hook.indexOf("function isFastForwardUpdate(", start);
    const logs: string[] = [];
    const listing = [
      "ref: refs/heads/main\tHEAD",
      `${A}\trefs/heads/main`,
      `${B}\trefs/heads/integration/permissions`,
      "",
    ].join("\n");
    const runner = (args: string[]) => {
      if (args[0] === "ls-remote") return { status: 0, stdout: listing, stderr: "" };
      if (args[0] === "fetch") return { status: 128, stdout: "", stderr: "fatal: unable to access remote\nfatal: could not read from remote" };
      if (args[0] === "cat-file") return { status: args[2]!.startsWith(A) ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "merge-base") return { status: 0, stdout: `${A}\n`, stderr: "" };
      return { status: 0, stdout: "2\n", stderr: "" };
    };
    const findNewBranchBase = runInNewContext(`${hook.slice(start, end)}; findNewBranchBase`, {
      isUsableRemoteLocation: () => true,
      gitRunner: () => runner,
      parseRemoteHeads, selectBaseCandidates, findMissingCandidateTips, chooseNewBranchBase,
      console: { log: (line: string) => logs.push(line) },
    });
    const result = findNewBranchBase("/fixture", { localRef: "refs/heads/feat/x", localSha: C }, "https://example.invalid/ave");
    expect(result).toEqual({ sha: A, tips: [A] });
    expect(logs).toContain(
      `[checks] skipping base candidate refs/heads/integration/permissions (${B.slice(0, 12)}): git fetch exited 128: fatal: could not read from remote`,
    );
  });
});
