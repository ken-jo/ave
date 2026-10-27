import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
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

  it.runIf(process.platform === "win32").each(["/", "\\"])("anchors rooted shell operands to the supplied cwd with %s separators", separator => {
    const operand = separator + [root.slice(parse(root).root.length), "future", "ordinary.txt"]
      .join(sep).replaceAll(sep, separator);
    expect(resolveShellFilesystemPath(operand, root)).toBe(join(root, "future", "ordinary.txt"));
  });

  it.runIf(process.platform === "win32").each(["/", "\\"])("anchors rooted physical operands and routing inspection to the supplied cwd with %s separators", separator => {
    const operand = separator + [root.slice(parse(root).root.length), "future", "ordinary.txt"]
      .join(sep).replaceAll(sep, separator);
    const expected = join(root, "future", "ordinary.txt");
    expect(resolvePhysicalFilesystemPath(operand, root, 64)).toBe(expected);
    expect(inspectPhysicalFilesystemPath(operand, root, 64)).toEqual({
      path: expected,
      firstMissingPath: join(root, "future"),
      unresolvedParentTraversal: false,
      routingSymlinkPaths: [],
    });
  });

  it.runIf(process.platform !== "win32")("marks a parent component beyond a missing ancestor as unresolved", () => {
    const result = inspectPhysicalFilesystemPath(`missing${sep}..${sep}metadata`, root, 64);
    expect(result.unresolvedParentTraversal).toBe(true);
    expect(result.firstMissingPath).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("resolves a parent component beyond a missing ancestor lexically, as Win32 opens it", () => {
    const result = inspectPhysicalFilesystemPath(`missing${sep}..${sep}metadata`, root, 64);
    expect(result).toEqual({
      path: join(root, "metadata"),
      firstMissingPath: join(root, "metadata"),
      unresolvedParentTraversal: false,
      routingSymlinkPaths: [],
    });
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

  it.each(["/", "\\"])("refuses rooted junction parents with %s separators", separator => {
    const root = fixture();
    const operand = separator + [root.slice(parse(root).root.length), "link", "..", "ordinary.txt"]
      .join(sep).replaceAll(sep, separator);
    expect(() => resolveShellFilesystemPath(operand, root))
      .toThrow(expect.objectContaining({ code: "EAMBIGUOUSLINKPARENT" }));
    expect(inspectPhysicalFilesystemPath(operand, root, 64).routingSymlinkPaths).toEqual([join(root, "link")]);
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
