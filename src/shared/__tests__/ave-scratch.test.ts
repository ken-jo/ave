import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("treats an already-absent directory as nothing to remove", () => {
    expect(removeAveScratchDirIfEmpty(join(freshRoot(), "never-created"))).toEqual({ status: "kept" });
  });

  it("reports any other failure instead of hiding it", () => {
    const path = join(freshRoot(), "scratch");
    writeFileSync(path, "");
    expect(removeAveScratchDirIfEmpty(path)).toEqual({ status: "failed", code: expect.stringMatching(/^E[A-Z]+$/) });
    expect(existsSync(path)).toBe(true);
  });
});
