import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const HOOK = resolve("scripts/hooks/run-local-checks.mjs");
const NULL_SHA = "0".repeat(40);
const NOTES = "docs/notes/checkout.md";

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "pre-push-checkout-"));
  const env: NodeJS.ProcessEnv = { ...gitFixtureEnv(repo), AVE_HOME: join(repo, "runtime") };
  delete env.AVE_PREPUSH_FULL;
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["checkout", "-qb", "topic"]);
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "test/scripts"), { recursive: true });
  mkdirSync(join(repo, "docs/notes"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"ave"}\n');
  writeFileSync(join(repo, NOTES), "Initial notes.\n");
  writeFileSync(join(repo, "test/scripts/check-asrt-version-claims.test.mjs"),
    'import { test } from "node:test"; test("fixture check", () => {});\n');
  writeFileSync(join(repo, "scripts/check-asrt-version-claims.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync("checks-ran", "yes");\n');
  git(["add", "."]);
  git(["commit", "-qm", "initial fixture"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, NOTES), "Updated notes.\n");
  git(["commit", "-qam", "update notes"]);
  const head = git(["rev-parse", "HEAD"]);
  const pushInput = (input: string) =>
    spawnSync("node", [HOOK, "--repo", repo, "--stage", "pre-push"], {
      env, encoding: "utf8", input, timeout: 15_000,
    });
  const push = (localRef = "refs/heads/topic", localSha = head, remoteRef = "refs/heads/topic") =>
    pushInput(`${localRef} ${localSha} ${remoteRef} ${base}\n`);
  return { repo, git, head, base, push, pushInput, checked: () => existsSync(join(repo, "checks-ran")),
    cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

describe("pre-push checkout binding", () => {
  it("refuses another branch before running checks and names the commit to check out", () => {
    const f = fixture();
    try {
      f.git(["checkout", "-qb", "other"]);
      writeFileSync(join(f.repo, NOTES), "Other notes.\n");
      f.git(["commit", "-qam", "other notes"]);
      const other = f.git(["rev-parse", "HEAD"]);
      f.git(["checkout", "-q", "topic"]);
      const result = f.push("refs/heads/other", other, "refs/heads/other");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PRE_PUSH_CHECKOUT_MISMATCH");
      expect(result.stderr).toContain(`git checkout --detach ${other}`);
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });

  it("refuses a non-HEAD sha refspec before running checks", () => {
    const f = fixture();
    try {
      const result = f.push(f.base, f.base, "refs/heads/copy");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PRE_PUSH_CHECKOUT_MISMATCH");
      expect(result.stderr).toContain(`git checkout --detach ${f.base}`);
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });

  it("refuses a mismatched commit even when another update names HEAD", () => {
    const f = fixture();
    try {
      const result = f.pushInput(`refs/heads/topic ${f.head} refs/heads/topic ${f.base}\n${f.base} ${f.base} refs/heads/copy ${f.base}\n`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`git checkout --detach ${f.base}`);
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });

  it("explains that an annotated tag object cannot be checked out as HEAD", () => {
    const f = fixture();
    try {
      f.git(["tag", "-am", "fixture release", "fixture-release"]);
      const tag = f.git(["rev-parse", "refs/tags/fixture-release"]);
      const result = f.push("refs/tags/fixture-release", tag, "refs/tags/fixture-release");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("annotated tag object");
      expect(result.stderr).toContain(`git checkout --detach ${tag}^{commit}`);
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["assume-unchanged", "skip-worktree"])("refuses hidden tracked changes under %s", (flag) => {
    const f = fixture();
    try {
      f.git(["update-index", `--${flag}`, NOTES]);
      writeFileSync(join(f.repo, NOTES), "Hidden tracked bytes.\n");
      expect(f.git(["status", "--porcelain", "--untracked-files=no"])).toBe("");
      const result = f.push();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PRE_PUSH_HIDDEN_TRACKED_FILES");
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["worktree", "index", "package"] as const)("refuses dirty tracked %s before running checks", (kind) => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, kind === "package" ? "package.json" : NOTES), "Dirty tracked bytes.\n");
      if (kind === "index") f.git(["add", NOTES]);
      const result = f.push();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PRE_PUSH_DIRTY_TREE");
      expect(result.stderr).toContain(`git checkout --detach ${f.head}`);
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });

  it("passes a clean matching HEAD and runs the selected checks", () => {
    const f = fixture();
    try {
      const result = f.push();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("tier=docs-only");
      expect(f.checked()).toBe(true);
      expect(readFileSync(join(f.repo, NOTES), "utf8")).toBe("Updated notes.\n");
    } finally { f.cleanup(); }
  });

  it("accepts another branch name when its commit matches HEAD", () => {
    const f = fixture();
    try {
      f.git(["branch", "same-commit", f.head]);
      const result = f.push("refs/heads/same-commit", f.head, "refs/heads/same-commit");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.checked()).toBe(true);
    } finally { f.cleanup(); }
  });

  it("refuses a tracked mutation made during checks", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "scripts/check-asrt-version-claims.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync("checks-ran", "yes"); writeFileSync("${NOTES}", "changed during checks");\n`);
      f.git(["commit", "-qam", "fixture checker mutation"]);
      const base = f.git(["rev-parse", "HEAD"]);
      writeFileSync(join(f.repo, NOTES), "Documentation push.\n");
      f.git(["commit", "-qam", "fixture documentation change"]);
      const head = f.git(["rev-parse", "HEAD"]);
      const result = f.pushInput(`refs/heads/topic ${head} refs/heads/topic ${base}\n`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PRE_PUSH_DIRTY_TREE");
      expect(f.checked()).toBe(true);
    } finally { f.cleanup(); }
  });

  it("passes deletion-only updates without checking an unrelated dirty checkout", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, NOTES), "Unrelated dirty bytes.\n");
      const result = f.push("(delete)", NULL_SHA, "refs/heads/obsolete");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("deletion-only");
      expect(f.checked()).toBe(false);
    } finally { f.cleanup(); }
  });
});
