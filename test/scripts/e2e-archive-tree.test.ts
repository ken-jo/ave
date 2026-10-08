import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(root, "scripts/check-e2e-archive-tree.sh");

function git(repo: string, args: string[], input?: string) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    env: gitFixtureEnv(repo), encoding: "utf8", input,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), "e2e-archive-tree-"));
  git(repo, ["init", "--quiet"]);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "src/code.ts"), "export const value = 1;\n");
  git(repo, ["add", "--all"]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "regular"]);
  const regular = git(repo, ["rev-parse", "HEAD"]);
  symlinkSync("../src/code.ts", join(repo, "docs/link.md"));
  git(repo, ["add", "--all"]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "linked"]);
  return { repo, regular, linked: git(repo, ["rev-parse", "HEAD"]) };
}

function check(repo: string, commit: string, env = gitFixtureEnv(repo)) {
  const result = spawnSync("bash", [script, repo, commit], { cwd: root, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

describe("E2E archive tree gate", () => {
  it.skipIf(process.platform === "win32")("rejects a committed link with an empty or corrupt index", () => {
    const { repo, regular, linked } = createRepo();
    try {
      expect(check(repo, linked).status).toBe(1);
      expect(check(repo, linked).output).toContain("symbolic-link entry");

      writeFileSync(join(repo, ".git/index"), Buffer.alloc(0));
      expect(check(repo, linked).output).toContain("symbolic-link entry");
      expect(check(repo, regular).status).toBe(0);

      writeFileSync(join(repo, ".git/index"), "corrupt index");
      expect(check(repo, linked).output).toContain("symbolic-link entry");
      expect(check(repo, regular).status).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects an empty commit tree and Git query errors", () => {
    const { repo } = createRepo();
    try {
      const emptyTree = git(repo, ["mktree"], "");
      const emptyCommit = git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit-tree", emptyTree, "-m", "empty"]);
      expect(check(repo, emptyCommit).output).toContain("inventory is empty");
      expect(check(repo, "f".repeat(40)).output).toContain("could not be enumerated");
      expect(check(join(repo, "missing"), emptyCommit).output).toContain("could not be enumerated");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("uses the explicit repository despite inherited Git selectors", () => {
    const { repo, regular, linked } = createRepo();
    const foreign = mkdtempSync(join(tmpdir(), "e2e-archive-foreign-"));
    try {
      git(foreign, ["init", "--quiet"]);
      const env = { ...gitFixtureEnv(foreign), GIT_DIR: join(foreign, ".git"),
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" };
      expect(check(repo, regular, env).status).toBe(0);
      expect(check(repo, linked, env).output).toContain("symbolic-link entry");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("runs the policy from the trusted workflow commit", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/e2e.yml"), "utf8");
    expect(workflow).toContain("path: stage-policy");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain('bash stage-policy/scripts/check-e2e-archive-tree.sh "$repo" "$actual"');
    expect(workflow).not.toContain("ls-files -s");
  });
});
