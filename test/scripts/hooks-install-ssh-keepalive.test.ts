// Keep idle push transports alive without overriding existing SSH configuration.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const INSTALLER = resolve(
  fileURLToPath(new URL("../../scripts/hooks/install.mjs", import.meta.url)),
);

function git(args: string[], cwd: string, home: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: gitFixtureEnv(home) });
  return (result.stdout || "").trim();
}

describe("hooks installer — push keepalive", () => {
  let repo: string;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-hooks-home-"));
    repo = mkdtempSync(join(tmpdir(), "ave-hooks-install-"));
    git(["init", "--quiet"], repo, home);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function runInstaller(cwd: string) {
    // The installer resolves the scratch repository through git rev-parse in its cwd.
    return spawnSync(process.execPath, [INSTALLER], {
      cwd,
      encoding: "utf-8",
      env: { ...gitFixtureEnv(home), GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd },
    });
  }

  it("sets a keepalive ssh command when the user has not chosen one", () => {
    expect(git(["config", "--get", "core.sshCommand"], repo, home)).toBe("");

    runInstaller(repo);

    const configured = git(["config", "--get", "core.sshCommand"], repo, home);
    expect(configured).toContain("ServerAliveInterval");
    expect(configured).toContain("ServerAliveCountMax");
  });

  it("does not overwrite an ssh command the user already set", () => {
    const chosen = "ssh -i ~/.ssh/company_key";
    git(["config", "core.sshCommand", chosen], repo, home);

    runInstaller(repo);

    expect(git(["config", "--get", "core.sshCommand"], repo, home)).toBe(chosen);
  });
});
