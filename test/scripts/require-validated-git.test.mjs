import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { firstPathGit, gitVersionError, validatedRelease } from "../../.github/scripts/require-validated-git.mjs";

describe("the CI git floor", () => {
  const floor = validatedRelease("export const HOOK_EVENTS_VALIDATED = [2, 56] as const;");

  it("passes the validated release and every newer one", () => {
    for (const reported of ["git version 2.56.0", "git version 2.56.3.windows.1", "git version 2.57.0", "git version 3.0.0"]) {
      assert.equal(gitVersionError(reported, floor), null, reported);
    }
  });

  it("fails an older release and an answer it cannot read", () => {
    for (const reported of ["git version 2.55.9", "git version 1.99.0", "", "git 2.56.0"]) {
      assert.notEqual(gitVersionError(reported, floor), null, reported);
    }
    assert.notEqual(gitVersionError("git version 2.56.0", validatedRelease("no release here")), null);
  });

  it("reads the git discovery tries first: the first absolute search-path entry that holds one", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-git-floor-"));
    try {
      const [empty, first, second] = ["empty", "first", "second"].map((name) => join(root, name));
      for (const dir of [empty, first, second]) mkdirSync(dir);
      for (const dir of [first, second]) writeFileSync(join(dir, process.platform === "win32" ? "git.exe" : "git"), "");
      const separator = process.platform === "win32" ? ";" : ":";
      const found = firstPathGit(["", ".", "relative", empty, first, second].join(separator));
      assert.equal(found, join(first, process.platform === "win32" ? "git.exe" : "git"));
      assert.equal(firstPathGit([".", empty].join(separator)), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
