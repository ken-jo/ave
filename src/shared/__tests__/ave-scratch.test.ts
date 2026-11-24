import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAveScratchDir, aveScratchDir, removeAveScratchDirIfEmpty, verifyAveScratchDir } from "../ave-scratch.js";

const posix = process.platform !== "win32";
const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ave-scratch-unit-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("aveScratchDir", () => {
  it("names an application-owned directory under the platform temp root, keyed by account and application home", () => {
    const path = aveScratchDir();
    expect(dirname(path)).toBe(tmpdir());
    expect(basename(path)).toMatch(/^ave-scratch(-\d+)?-[0-9a-f]{8}$/);
    if (typeof process.getuid === "function") {
      expect(basename(path)).toMatch(new RegExp(`^ave-scratch-${process.getuid()}-`));
    }
  });

  it("gives an isolated AVE_HOME its own scratch directory instead of the live app's", () => {
    const live = aveScratchDir("/Users/example/.ave");
    const isolated = aveScratchDir("/tmp/ave-bench-controller-1/profile");
    expect(live).not.toBe(isolated);
    expect(dirname(live)).toBe(dirname(isolated));
    expect(aveScratchDir("/Users/example/.ave")).toBe(live);
  });
});

describe("ensureAveScratchDir", () => {
  it("creates a private directory and verifies it", () => {
    const path = join(freshRoot(), "scratch");
    const state = ensureAveScratchDir(path);
    expect(state).toEqual({ ok: true, path });
    expect(verifyAveScratchDir(path)).toEqual({ ok: true, path });
  });

  it.skipIf(!canCreateSymlinks())("reports rather than adopts a pre-existing symbolic link at the scratch path", () => {
    const root = freshRoot();
    const target = join(root, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const path = join(root, "scratch");
    symlinkSync(target, path);
    const state = ensureAveScratchDir(path);
    expect(state.ok).toBe(false);
    expect(state).toMatchObject({ path, reason: "is a symbolic link" });
  });

  it("reports a file squatting on the scratch path", () => {
    const path = join(freshRoot(), "scratch");
    writeFileSync(path, "");
    const state = ensureAveScratchDir(path);
    expect(state).toMatchObject({ ok: false, path });
    expect((state as { reason: string }).reason).toMatch(/not a directory|could not create/);
  });

  it.runIf(posix)("refuses a directory other accounts can read even though this account owns it", () => {
    const path = join(freshRoot(), "scratch");
    mkdirSync(path, { mode: 0o755 });
    chmodSync(path, 0o755);
    const state = ensureAveScratchDir(path);
    expect(state.ok).toBe(false);
    expect((state as { reason: string }).reason).toMatch(/readable by other accounts/);
  });
});

describe("verifyAveScratchDir", () => {
  it("reports an absent directory without creating it", () => {
    const path = join(freshRoot(), "never-created");
    const state = verifyAveScratchDir(path);
    expect(state.ok).toBe(false);
    expect((state as { reason: string }).reason).toMatch(/not present/);
  });
});

describe("removeAveScratchDirIfEmpty", () => {
  it("removes a scratch directory nothing was left in", () => {
    const path = join(freshRoot(), "scratch");
    expect(ensureAveScratchDir(path).ok).toBe(true);
    expect(removeAveScratchDirIfEmpty(path)).toEqual({ status: "removed" });
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a scratch directory holding a file, and the file with it", () => {
    const path = join(freshRoot(), "scratch");
    expect(ensureAveScratchDir(path).ok).toBe(true);
    const staged = join(path, "build", "out.txt");
    mkdirSync(dirname(staged));
    writeFileSync(staged, "kept");
    expect(removeAveScratchDirIfEmpty(path)).toEqual({ status: "kept" });
    expect(readFileSync(staged, "utf8")).toBe("kept");
  });

  it("leaves the directory first when it is the process's working directory", () => {
    const path = join(freshRoot(), "scratch");
    expect(ensureAveScratchDir(path).ok).toBe(true);
    const previous = process.cwd();
    process.chdir(path);
    try {
      // Windows compares the working directory without case.
      const spelled = process.platform === "win32" ? path.toUpperCase() : path;
      expect(removeAveScratchDirIfEmpty(spelled)).toEqual({ status: "removed" });
      expect(realpathSync(process.cwd())).toBe(realpathSync(tmpdir()));
      expect(existsSync(path)).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it("treats an already-absent directory as nothing to remove", () => {
    expect(removeAveScratchDirIfEmpty(join(freshRoot(), "never-created"))).toEqual({ status: "kept" });
  });

  it("reports any other failure instead of hiding it", () => {
    const path = join(freshRoot(), "scratch");
    writeFileSync(path, "");
    // Windows rmdir reports ENOENT for a file; both platforms report what is there.
    expect(removeAveScratchDirIfEmpty(path)).toEqual({ status: "failed", code: "ENOTDIR" });
    expect(existsSync(path)).toBe(true);
  });

  describe("after rmdir reports ENOENT", () => {
    afterEach(() => {
      vi.doUnmock("node:fs");
      vi.resetModules();
    });

    async function removeWith(lstatSync: () => unknown) {
      vi.resetModules();
      vi.doMock("node:fs", async (importOriginal) => ({
        ...await importOriginal<typeof import("node:fs")>(),
        rmdirSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
        lstatSync,
      }));
      const { removeAveScratchDirIfEmpty: remove } = await import("../ave-scratch.js");
      return remove(join(freshRoot(), "scratch"));
    }

    it("reports a file still on the path as not a directory", async () => {
      expect(await removeWith(() => ({ isDirectory: () => false }))).toEqual({ status: "failed", code: "ENOTDIR" });
    });

    it("reports a path it cannot inspect with that error's code", async () => {
      const denied = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
      expect(await removeWith(denied)).toEqual({ status: "failed", code: "EPERM" });
    });
  });
});
