import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSandboxBareRepositoryCleanup } from "../sandbox-bare-repository-cleanup.js";

const { warnings } = vi.hoisted(() => ({ warnings: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: warnings }) }));

describe("sandbox-created bare repository cleanup", () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-bare-cleanup-")));
    root = join(base, "work");
    mkdirSync(root);
    warnings.mockClear();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("removes newly appeared layout entries and logs each removal once", () => {
    const cleanup = prepareSandboxBareRepositoryCleanup([root]);
    writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, "config"), "[core]\n bare=true\n");
    for (const name of ["objects", "refs", "hooks"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "payload"), "created");
    }
    writeFileSync(join(root, "ordinary"), "kept");
    cleanup();
    cleanup();
    for (const name of ["HEAD", "objects", "refs", "config", "hooks"]) expect(existsSync(join(root, name))).toBe(false);
    expect(readFileSync(join(root, "ordinary"), "utf8")).toBe("kept");
    expect(readdirSync(root)).toEqual(["ordinary"]);
    expect(warnings).toHaveBeenCalledTimes(5);
  });

  it("preserves every pre-existing entry and hooks without a HEAD", () => {
    writeFileSync(join(root, "config"), "source configuration");
    mkdirSync(join(root, "objects"));
    writeFileSync(join(root, "objects", "original"), "kept");
    const cleanup = prepareSandboxBareRepositoryCleanup([root]);
    mkdirSync(join(root, "hooks"));
    cleanup();
    expect(readFileSync(join(root, "config"), "utf8")).toBe("source configuration");
    expect(readFileSync(join(root, "objects", "original"), "utf8")).toBe("kept");
    expect(existsSync(join(root, "hooks"))).toBe(true);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("removes an appeared link without following its target", () => {
    const target = join(base, "outside");
    mkdirSync(target);
    writeFileSync(join(target, "original"), "kept");
    const cleanup = prepareSandboxBareRepositoryCleanup([root]);
    symlinkSync(target, join(root, "objects"), "dir");
    cleanup();
    expect(existsSync(join(root, "objects"))).toBe(false);
    expect(readFileSync(join(target, "original"), "utf8")).toBe("kept");
  });

  it("preserves an unrelated replacement root", () => {
    const cleanup = prepareSandboxBareRepositoryCleanup([root]);
    renameSync(root, join(base, "previous"));
    mkdirSync(root);
    writeFileSync(join(root, "HEAD"), "unrelated");
    cleanup();
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("unrelated");
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("replaced root"));
  });

  it("leaves ordinary names inside an existing repository alone", () => {
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    mkdirSync(join(root, ".git", "refs"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const cleanup = prepareSandboxBareRepositoryCleanup([root]);
    writeFileSync(join(root, "HEAD"), "ordinary source file");
    cleanup();
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("ordinary source file");
    expect(warnings).not.toHaveBeenCalled();
  });
});
