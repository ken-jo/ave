/**
 * A push that updates no ref was refused as a parse error.
 *
 * `readPrePushInput` returned a bare string, so "git sent an empty list" and
 * "we could not read git's list" were the same value. The parser then treated
 * an empty list as incomplete, and the caller refuses an incomplete parse —
 * correctly, since nothing is known about the push.
 *
 * Both readings cannot be right. Refusing an unreadable input is the fail-
 * closed behaviour to keep; refusing a genuine no-op push is not, and it
 * surfaces as a failed push even though the branch is already on the remote at
 * the right commit — a confusing way to learn there was nothing to do.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  chooseNewBranchBase,
  findMissingCandidateTips,
  isIntegrationBranchRef,
  parsePrePushUpdates,
  parseRemoteHeads,
  selectBaseCandidates,
} from "../../scripts/hooks/pre-push-ref-updates.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const ZERO = "0".repeat(40);
const SHA = "5e544ff8f30aa915be9e0d9e66db564cf1e192f4";
const UPDATE = `refs/heads/topic ${SHA} refs/heads/topic ${ZERO}`;

describe("pre-push ref updates", () => {
  it("accepts a push that updates no ref", () => {
    // git had nothing to send. A push that changes no ref cannot violate a
    // branch policy, so there is nothing for the caller to refuse.
    const result = parsePrePushUpdates({ readable: true, text: "" });
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([]);
  });

  it("refuses an input it could not read", () => {
    // Same empty text, opposite verdict — this is the distinction the single
    // string could not carry.
    expect(parsePrePushUpdates({ readable: false, text: "" }).complete).toBe(false);
  });

  it("parses a real update", () => {
    const result = parsePrePushUpdates({ readable: true, text: UPDATE });
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([
      { localRef: "refs/heads/topic", localSha: SHA, remoteRef: "refs/heads/topic", remoteSha: ZERO },
    ]);
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
    // One unreadable line makes the whole set unusable: the caller cannot
    // enforce a branch policy against a list it only partly understands.
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

/**
 * Every sub-branch push used to take the full checks: a new branch was diffed
 * only against the default branch, and only when the local tracking ref
 * equalled the live tip. Writer clones carry a stale origin/main, and
 * sub-branches are cut from origin/integration/<category>, so the base was
 * either missing or dragged every integration commit into the diff.
 */
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

  it("measures a sub-branch from its integration branch while the default tracking ref is stale", () => {
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
      // An integration branch collects merged work, and main moves on.
      git(seed, ["checkout", "-qb", "integration/permissions"]);
      for (let index = 0; index < 3; index += 1) commit(seed, `integration-${index}.txt`, `${index}\n`);
      git(seed, ["push", "-q", remote, "integration/permissions"]);
      git(seed, ["checkout", "-q", "main"]);
      commit(seed, "main-only.txt", "main\n");
      git(seed, ["push", "-q", remote, "main"]);
      // The writer fetches only its category: origin/main stays stale.
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
      // The live main tip is not in the writer's object store.
      expect(findMissingCandidateTips(candidates, run).map(({ ref }) => ref)).toEqual(["refs/heads/main"]);
      const integrationTip = git(seed, ["rev-parse", "integration/permissions"]);
      expect(chooseNewBranchBase(localSha, candidates, run)).toEqual({
        ref: "refs/heads/integration/permissions", sha: integrationTip, count: 1,
      });

      // The hook's one fetch brings the missing tips' objects without moving
      // a tracking ref; the integration branch is still the closest base.
      expect(run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remote, "refs/heads/main"]).status).toBe(0);
      expect(findMissingCandidateTips(candidates, run)).toEqual([]);
      expect(git(writer, ["rev-parse", "refs/remotes/origin/main"])).toBe(staleMain);
      expect(chooseNewBranchBase(localSha, candidates, run)).toEqual({
        ref: "refs/heads/integration/permissions", sha: integrationTip, count: 1,
      });

      // A branch cut from main measures from main instead.
      git(writer, ["checkout", "-qb", "fix/main-topic", git(seed, ["rev-parse", "main"])]);
      commit(writer, "fix.txt", "fix\n");
      expect(chooseNewBranchBase(git(writer, ["rev-parse", "HEAD"]), candidates, run)).toMatchObject({
        ref: "refs/heads/main", count: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds no base for unrelated history", () => {
    const run = (args: string[]) => args[0] === "merge-base" ? { status: 1, stdout: "" } : { status: 0, stdout: "" };
    expect(chooseNewBranchBase(A, [{ ref: "refs/heads/main", sha: B }], run)).toBeNull();
  });
});
