import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_RUNTIME_MARKER, GIT_RUNTIME_TARGETS, GIT_RUNTIME_VERSION, gitRuntimeTargetKey } from "../../scripts/git-runtime-targets.mjs";

// @ts-expect-error — plain .mjs build script without declarations
import { gitRuntimeDir, gitRuntimeTreeDigest, stageGitRuntime, verifyStagedGitRuntime } from "../../scripts/fetch-git.mjs";

const KEY = "linux-arm64";
const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fetch-git-test-"));
  roots.push(root);
  return root;
}

/** A staged-looking tree whose marker records its own digest, as fetch-git writes it. */
async function stagedTree(root: string, archiveSha256 = GIT_RUNTIME_TARGETS[KEY]!.sha256): Promise<string> {
  const dir = gitRuntimeDir(KEY, root) as string;
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "git"), "binary");
  const treeSha256 = await gitRuntimeTreeDigest(dir);
  writeFileSync(path.join(dir, GIT_RUNTIME_MARKER), JSON.stringify({ schema: 1, version: GIT_RUNTIME_VERSION, target: KEY, archiveSha256, treeSha256 }));
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fetch-git refuses to stage an archive that is not the pinned one", () => {
  it("rejects an archive of the wrong size", async () => {
    const root = projectRoot();
    const archive = path.join(root, "git.tar.gz");
    writeFileSync(archive, "not the release archive");
    await expect(stageGitRuntime({ key: KEY, archive, projectRoot: root })).rejects.toThrow(/expected 23223345/);
  });

  it("rejects an archive of the pinned size whose sha256 differs", async () => {
    const root = projectRoot();
    const archive = path.join(root, "git.tar.gz");
    writeFileSync(archive, Buffer.alloc(GIT_RUNTIME_TARGETS[KEY]!.size));
    await expect(stageGitRuntime({ key: KEY, archive, projectRoot: root })).rejects.toThrow(/does not match the pinned/);
  });
});

describe("a staged copy is trusted only as extracted from the pinned archive", () => {
  it("accepts the recorded tree and keeps it without reading an archive", async () => {
    const root = projectRoot();
    const dir = await stagedTree(root);
    await expect(verifyStagedGitRuntime(KEY, dir)).resolves.toBeUndefined();
    await expect(stageGitRuntime({ key: KEY, archive: path.join(root, "absent.tar.gz"), projectRoot: root })).resolves.toEqual({ dir, staged: false });
  });

  it("rejects a tree whose files changed after staging", async () => {
    const root = projectRoot();
    const dir = await stagedTree(root);
    writeFileSync(path.join(dir, "bin", "git"), "replaced");
    await expect(verifyStagedGitRuntime(KEY, dir)).rejects.toThrow(/differs from the tree/);
  });

  it("rejects a marker recorded from another archive", async () => {
    const root = projectRoot();
    const dir = await stagedTree(root, "0".repeat(64));
    await expect(verifyStagedGitRuntime(KEY, dir)).rejects.toThrow(/different archive/);
  });
});

describe("git runtime targets", () => {
  it("pins Windows and Linux only; macOS uses the system git", () => {
    expect(Object.keys(GIT_RUNTIME_TARGETS).sort()).toEqual(["linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    expect(gitRuntimeTargetKey("darwin", "arm64")).toBeNull();
    expect(gitRuntimeTargetKey("win32", "x64")).toBe("win32-x64");
  });
});
