import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShellFilesystemPath } from "../shell-filesystem-path.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "win32")("junction path readings", () => {
  function fixture() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-path-"))); roots.push(root);
    mkdirSync(join(root, "a", "b"), { recursive: true });
    symlinkSync(join(root, "a", "b"), join(root, "link"), "junction");
    return root;
  }

  it.each(["link/../../ordinary.txt", "link/../ordinary.txt"])("codes ambiguous junction parents: %s", operand => {
    const root = fixture();
    expect(() => resolveShellFilesystemPath(operand, root)).toThrow(expect.objectContaining({ code: "EAMBIGUOUSLINKPARENT" }));
  });

  it("refuses an outward junction parent with a coded error", () => {
    const root = fixture();
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-path-outside-"))); roots.push(outside);
    mkdirSync(join(outside, "O"));
    symlinkSync(join(outside, "O"), join(root, "outward"), "junction");
    expect(() => resolveShellFilesystemPath("outward/../ordinary.txt", root))
      .toThrow(expect.objectContaining({ code: "EAMBIGUOUSLINKPARENT" }));
  });

  it("allows an inside junction without parent components", () => {
    const root = fixture();
    expect(resolveShellFilesystemPath("link/ordinary.txt", root)).toBe(join(root, "a", "b", "ordinary.txt"));
  });

  it("refuses an unresolved junction prefix", () => {
    const root = fixture();
    symlinkSync(join(root, "missing"), join(root, "dangling"), "junction");
    expect(() => resolveShellFilesystemPath("dangling/../ordinary.txt", root)).toThrow();
  });
});
