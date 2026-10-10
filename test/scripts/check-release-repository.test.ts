import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReleaseRepository,
  readRepositoryIdentity,
  repositoryIdentity,
} from "../../scripts/lib/repository-identity.mjs";

const SCRIPT = resolve(process.cwd(), "scripts/check-release-repository.mjs");
const identity = repositoryIdentity({
  build: { publish: [{ provider: "github", owner: "old-owner", repo: "ave" }] },
});
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runGate(repository: string | undefined, script = SCRIPT, cwd = process.cwd()) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  if (repository !== undefined) env.GITHUB_REPOSITORY = repository;
  return spawnSync(process.execPath, [script], { cwd, encoding: "utf8", env });
}

describe("release repository gate", () => {
  it("passes when the build runs in the repository package.json publishes to", () => {
    expect(assertReleaseRepository({ identity, repository: "old-owner/ave" })).toBe(
      "old-owner/ave",
    );
  });

  it.each([
    ["a moved repository", "new-owner/ave"],
    ["a renamed repository", "old-owner/ave-desktop"],
    ["a fork", "someone/ave"],
    ["a different letter case", "Old-Owner/ave"],
    ["an empty value", ""],
    ["an unset value", undefined],
  ])("fails closed for %s", (_label, repository) => {
    expect(() => assertReleaseRepository({ identity, repository })).toThrow(
      "[release-repository]",
    );
  });

  it("exits non-zero from the workflow entry point when the repositories differ", () => {
    const moved = runGate("new-owner/ave");
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("[release-repository]");
    expect(moved.stderr).toContain("new-owner/ave");

    const unset = runGate(undefined);
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain("GITHUB_REPOSITORY is not set");
  });

  it("still runs, and still fails, when invoked through a symlink or a relative path", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-repository-"));
    temporary.push(directory);
    const link = join(directory, "check-release-repository.mjs");
    symlinkSync(SCRIPT, link);

    const throughLink = runGate("new-owner/ave", link);
    expect(throughLink.status).toBe(1);
    expect(throughLink.stderr).toContain("[release-repository]");

    const throughRelative = runGate("new-owner/ave", "./check-release-repository.mjs", dirname(SCRIPT));
    expect(throughRelative.status).toBe(1);
    expect(throughRelative.stderr).toContain("[release-repository]");
  });

  it("exits zero from the workflow entry point in the published repository", () => {
    const { slug } = readRepositoryIdentity();
    const result = runGate(slug);
    expect(result.stderr).not.toContain("[release-repository]");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`[release-repository] package.json build.publish matches ${slug}\n`);
  });
});
