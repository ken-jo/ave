import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleaseRepository } from "../../scripts/check-release-repository.mjs";
import {
  readRepositoryIdentity,
  repositoryIdentity,
} from "../../scripts/lib/repository-identity.mjs";

const SCRIPT = resolve(process.cwd(), "scripts/check-release-repository.mjs");
const identity = repositoryIdentity({
  build: { publish: [{ provider: "github", owner: "old-owner", repo: "ave" }] },
});

function runGate(repository: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  if (repository !== undefined) env.GITHUB_REPOSITORY = repository;
  return spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });
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

  it("exits zero from the workflow entry point in the published repository", () => {
    const { slug } = readRepositoryIdentity();
    const result = runGate(slug);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(slug);
  });
});
