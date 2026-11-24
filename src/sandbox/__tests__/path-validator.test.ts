import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { validateSandboxPath } from "../path-validator.js";

const dirLinkType = process.platform === "win32" ? "junction" : "dir";

describe("validateSandboxPath", () => {
  let sandboxCwd: string;
  let outsideDir: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    // Canonicalize macOS /var before comparing resolved paths.
    sandboxCwd = realpathSync(mkdtempSync(join(tmpdir(), "ave-sandbox-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "ave-outside-")));
    cleanup.push(sandboxCwd, outsideDir);
  });

  afterEach(async () => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      await cleanupTmpDir(dir);
    }
  });

  it.each(["ENOENT", "EACCES", "ELOOP"])("denies unresolved filesystem paths (%s)", (code) => {
    const spy = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error("filesystem resolution failed"), { code });
    });
    try {
      expect(validateSandboxPath(sandboxCwd, sandboxCwd)).toEqual({
        allowed: false,
        reason: `cannot resolve sandbox path (${code})`,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not hide an internal resolver exception", () => {
    const spy = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new TypeError("resolver contract violated"), { code: "ERR_INTERNAL_ASSERTION" });
    });
    try {
      expect(() => validateSandboxPath(sandboxCwd, sandboxCwd)).toThrow("resolver contract violated");
    } finally {
      spy.mockRestore();
    }
  });

  it.for(["file", "directory"])("denies a dangling %s symlink before creating outside the sandbox", (kind, context) => {
    if (kind === "file" && !canCreateSymlinks()) context.skip(); // File links require host permission.
    const link = join(sandboxCwd, "link");
    const target = join(outsideDir, "missing");
    symlinkSync(target, link, kind === "directory" ? dirLinkType : "file");
    const candidate = kind === "directory" ? join(link, "created.txt") : link;
    expect(validateSandboxPath(candidate, sandboxCwd).allowed).toBe(false);
  });

  it("allows a path inside the sandbox cwd", () => {
    const inside = join(sandboxCwd, "docs", "readme.md");
    mkdirSync(join(sandboxCwd, "docs"));
    writeFileSync(inside, "hello");

    const result = validateSandboxPath(inside, sandboxCwd);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("denies a path outside the sandbox cwd with a reason", () => {
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret");

    const result = validateSandboxPath(outsideFile, sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
    expect(result.reason).toContain(sandboxCwd);
  });

  it("expands ~/ to the user's home directory", () => {
    const home = realpathSync(homedir());
    const result = validateSandboxPath("~/", home);
    expect(result.allowed).toBe(true);
  });

  it("expands bare ~ to the user's home directory", () => {
    const home = realpathSync(homedir());
    const result = validateSandboxPath("~", home);
    expect(result.allowed).toBe(true);
  });

  it("allows a path inside an extraAllowed directory", () => {
    const allowedFile = join(outsideDir, "allowed.log");
    writeFileSync(allowedFile, "log");

    const result = validateSandboxPath(allowedFile, sandboxCwd, [outsideDir]);
    expect(result.allowed).toBe(true);
  });

  it("blocks symlink traversal when target is outside the sandbox", () => {
    // Use junctions to exercise Windows escapes without file-symlink privilege.
    const outsideTarget = join(outsideDir, "target");
    mkdirSync(outsideTarget);

    const symlinkInside = join(sandboxCwd, "escape");
    symlinkSync(outsideTarget, symlinkInside, dirLinkType);

    const result = validateSandboxPath(symlinkInside, sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("denies a relative path that traverses upward outside cwd", () => {
    const result = validateSandboxPath("../../../etc/passwd", sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("validates a non-existent path via nearest existing parent realpath", () => {
    const phantom = join(sandboxCwd, "does-not-exist-yet", "file.txt");
    const result = validateSandboxPath(phantom, sandboxCwd);
    expect(result.allowed).toBe(true);
  });

  it("allows a non-existent path when cwd is reached through a symlink alias", () => {
    const alias = join(outsideDir, "sandbox-alias");
    symlinkSync(sandboxCwd, alias, dirLinkType);

    const phantom = join(alias, "generated", "file.txt");
    const result = validateSandboxPath(phantom, alias);
    expect(result.allowed).toBe(true);
  });

  it("blocks a non-existent path under an escaping symlink directory", () => {
    const outsideTarget = join(outsideDir, "target-dir");
    mkdirSync(outsideTarget);
    const symlinkInside = join(sandboxCwd, "escape-dir");
    symlinkSync(outsideTarget, symlinkInside, dirLinkType);

    const phantom = join(symlinkInside, "future.txt");
    const result = validateSandboxPath(phantom, sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("denies a non-existent path that resolves outside cwd", () => {
    const phantom = join(outsideDir, "also-does-not-exist.txt");
    const result = validateSandboxPath(phantom, sandboxCwd);
    expect(result.allowed).toBe(false);
  });

  it("does not crash with an empty extraAllowed array", () => {
    const inside = join(sandboxCwd, "file.txt");
    writeFileSync(inside, "x");
    expect(() => validateSandboxPath(inside, sandboxCwd, [])).not.toThrow();
    const result = validateSandboxPath(inside, sandboxCwd, []);
    expect(result.allowed).toBe(true);
  });

  it("treats the cwd itself as allowed (equal path)", () => {
    const result = validateSandboxPath(sandboxCwd, sandboxCwd);
    expect(result.allowed).toBe(true);
  });

  it("does not allow a sibling path that shares a name prefix", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-prefix-")));
    cleanup.push(parent);
    const a = join(parent, "abc");
    const ab = join(parent, "abcd");
    mkdirSync(a);
    mkdirSync(ab);
    const fileInAb = join(ab, "f.txt");
    writeFileSync(fileInAb, "x");

    const result = validateSandboxPath(fileInAb, a);
    expect(result.allowed).toBe(false);
  });
});

describe("validateSandboxPath boundary direction", () => {
  let sandboxCwd: string;
  let outsideDir: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    sandboxCwd = realpathSync(mkdtempSync(join(tmpdir(), "ave-sandbox-dir-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "ave-outside-dir-")));
    cleanup.push(sandboxCwd, outsideDir);
  });

  afterEach(async () => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      await cleanupTmpDir(dir);
    }
  });

  it("does not read the boundary backwards", () => {
    // Pin parent/candidate argument direction because swapped strings still typecheck and invert containment.
    const child = join(sandboxCwd, "nested", "file.txt");
    mkdirSync(join(sandboxCwd, "nested"), { recursive: true });
    writeFileSync(child, "x");
    expect(validateSandboxPath(child, sandboxCwd).allowed).toBe(true);
    expect(validateSandboxPath(sandboxCwd, join(sandboxCwd, "nested")).allowed).toBe(false);
  });

  it("keeps a directory whose name begins with two dots inside the sandbox", () => {
    const dotted = join(sandboxCwd, "..cache");
    mkdirSync(dotted, { recursive: true });
    writeFileSync(join(dotted, "f.txt"), "x");
    expect(validateSandboxPath(join(dotted, "f.txt"), sandboxCwd).allowed).toBe(true);
  });

  it("still refuses a sibling whose name merely extends the sandbox root", () => {
    expect(validateSandboxPath(`${sandboxCwd}-evil`, sandboxCwd).allowed).toBe(false);
    expect(validateSandboxPath(join(outsideDir, "f.txt"), sandboxCwd).allowed).toBe(false);
  });
});
