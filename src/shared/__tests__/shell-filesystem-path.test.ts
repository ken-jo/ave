import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPhysicalFilesystemPath, resolvePhysicalFilesystemPath, resolveShellFilesystemPath } from "../shell-filesystem-path.js";

describe("physical filesystem path contracts", () => {
  let root: string;
  beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), "physical-path-"))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("preserves the shell resolver's unbounded missing suffix while bounding policy resolution", () => {
    const suffix = Array.from({ length: 72 }, (_, index) => `p${index}`).join(sep);
    expect(resolveShellFilesystemPath(suffix, root)).toBe(join(root, suffix));
    expect(() => resolvePhysicalFilesystemPath(suffix, root, 64)).toThrow("missing ancestor limit");
  });

  it("reports the first missing component without changing an ordinary future target", () => {
    const result = inspectPhysicalFilesystemPath(join("missing", "metadata"), root, 64);
    expect(result).toEqual({
      path: join(root, "missing", "metadata"),
      firstMissingPath: join(root, "missing"),
      unresolvedParentTraversal: false,
      routingSymlinkPaths: [],
    });
  });

  it("marks a parent component beyond a missing ancestor as unresolved", () => {
    const result = inspectPhysicalFilesystemPath(`missing${sep}..${sep}metadata`, root, 64);
    expect(result.unresolvedParentTraversal).toBe(true);
    expect(result.firstMissingPath).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("reports routing link names separately from their physical targets", () => {
    const physical = join(root, "physical");
    const route = join(root, "route");
    mkdirSync(join(physical, "deep"), { recursive: true });
    mkdirSync(join(physical, "metadata"));
    symlinkSync(join(physical, "deep"), route, "dir");
    const result = inspectPhysicalFilesystemPath(`${route}/../metadata`, root, 64);
    expect(result.path).toBe(join(physical, "metadata"));
    expect(result.firstMissingPath).toBeUndefined();
    expect(result.unresolvedParentTraversal).toBe(false);
    expect(result.routingSymlinkPaths).toEqual([route]);
  });

  it("bounds metadata routing inspection even when every component already exists", () => {
    const relative = Array.from({ length: 65 }, (_, index) => `p${index}`).join(sep);
    mkdirSync(join(root, relative), { recursive: true });
    expect(resolvePhysicalFilesystemPath(relative, root, 64)).toBe(join(root, relative));
    expect(() => inspectPhysicalFilesystemPath(relative, root, 64)).toThrow("component limit");
  });
});
