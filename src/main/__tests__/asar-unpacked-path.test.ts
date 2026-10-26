import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preferAsarUnpackedPath } from "../asar-unpacked-path.js";

const packaged = join(sep, "Applications", "Ave.app", "Contents", "Resources", "app.asar", "node_modules", "pkg", "bin", "tool");
const unpacked = packaged.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);

describe("preferAsarUnpackedPath", () => {
  it("returns a development path unchanged", () => {
    const dev = join(sep, "work", "ave", "node_modules", "pkg", "bin", "tool");
    expect(preferAsarUnpackedPath(dev, () => false)).toBe(dev);
  });

  it("maps a packaged path to its unpacked copy when that copy exists", () => {
    expect(preferAsarUnpackedPath(packaged, (path) => path === unpacked)).toBe(unpacked);
  });

  it("never hands back the virtual archive path when the unpacked copy is missing", () => {
    // Electron's fs reports the virtual path as existing, so it must not be the answer: the OS cannot execute anything inside the archive.
    expect(preferAsarUnpackedPath(packaged, (path) => path === packaged)).toBeNull();
  });
});

describe("pinned ripgrep resolution inside a package missing its unpacked copy", () => {
  afterEach(() => {
    vi.doUnmock("../asar-unpacked-path.js");
    vi.resetModules();
  });

  it("fails with the caller's unavailable error instead of a spawn error", async () => {
    vi.resetModules();
    vi.doMock("../asar-unpacked-path.js", () => ({ preferAsarUnpackedPath: () => null }));
    const { resolveBundledRipgrep } = await import("../../tools/grep-search.js");
    let thrown: unknown;
    try {
      resolveBundledRipgrep();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("RipgrepUnavailableError");
    expect((thrown as Error).message).toContain("@vscode/ripgrep");
  });
});
