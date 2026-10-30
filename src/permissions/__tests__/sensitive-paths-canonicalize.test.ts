// Both sides of every scope comparison must share canonical bytes across traversal, Unicode, case, slashes and symlinks; use realpath-derived temp paths.
import { afterEach, describe, it, expect, vi } from "vitest";
import * as filesystem from "node:fs";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalizePathForMatch, createPathCanonicalizer, foldCanonicalPathSeparators, MAX_WALK_UP } from "../sensitive-paths.js";
import { PermissionTestResources } from "./test-resources.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), lstatSync: vi.fn(actual.lstatSync) };
});

const resources = new PermissionTestResources();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(filesystem.existsSync).mockReset();
  vi.mocked(filesystem.lstatSync).mockReset();
  await resources.cleanup();
});

describe("canonicalizePathForMatch — security MAJOR-3 bypass vectors", () => {
  it("collapses `..` segments", () => {
    const root = resources.makeTmpDir("ave-canon-dot-");
    mkdirSync(join(root, "a/b/c"), { recursive: true });
    // /<root>/a/b/c/../../b → /<root>/a/b
    const traversed = join(root, "a/b/c/../../b");
    const canonical = canonicalizePathForMatch(traversed);
    expect(canonical).not.toMatch(/\.\./);
    expect(canonical.endsWith("/a/b")).toBe(true);
  });

  it("collapses duplicate slashes", () => {
    const root = resources.makeTmpDir("ave-canon-slash-");
    mkdirSync(join(root, "x"), { recursive: true });
    const dup = `${root}///x`;
    const canonical = canonicalizePathForMatch(dup);
    // No `//` anywhere except potentially the leading scheme-style — but POSIX paths never use //.
    expect(canonical.includes("//")).toBe(false);
  });

  it("trailing slash does not survive resolve", () => {
    const root = resources.makeTmpDir("ave-canon-trail-");
    mkdirSync(join(root, "leaf"), { recursive: true });
    const trailed = `${root}/leaf/`;
    const canonical = canonicalizePathForMatch(trailed);
    // path.resolve trims the trailing separator
    expect(canonical.endsWith("/")).toBe(false);
    expect(canonical.endsWith("/leaf")).toBe(true);
  });

  it("NFD-decomposed unicode normalizes to NFC", () => {
    // "café" — composed (NFC) e + ́ and decomposed (NFD).
    const nfc = "café"; // 4 code points (composed)
    const nfd = "café"; // 5 code points (decomposed)
    const root = resources.makeTmpDir("ave-canon-nfd-");
    const composed = canonicalizePathForMatch(`${root}/${nfc}`);
    const decomposed = canonicalizePathForMatch(`${root}/${nfd}`);
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
    // canonicalizePathForMatch already applies.normalize("NFC") so the raw outputs must also match.
    expect(composed).toBe(decomposed);
  });

  it("path produces an absolute resolved string", () => {
    const canonical = canonicalizePathForMatch("relative/path/file.txt");
    // Must be absolute (path.resolve at minimum prepends cwd). On Windows canonicalizePathForMatch normalizes separators to `/`, but the drive prefix remains absolute.
    expect(isAbsolute(canonical)).toBe(true);
    // No `.` or `..` segments leak through
    expect(canonical.includes("/../")).toBe(false);
    expect(canonical.includes("/./")).toBe(false);
  });

  it("repeated canonicalize is idempotent (frozen-canonical contract)", () => {
    const root = resources.makeTmpDir("ave-canon-idem-");
    mkdirSync(join(root, "deep/nest/path"), { recursive: true });
    const raw = `${root}//deep/./nest/../nest/path/`;
    const once = canonicalizePathForMatch(raw);
    const twice = canonicalizePathForMatch(once);
    expect(twice).toBe(once);
  });
});

// Windows shapes are pinned against the pure fold rather than `canonicalizePathForMatch`, because `resolve`/`realpath` follow the HOST's rules: on the macOS and Linux machines this suite runs on, a `\\server\share\...` string is just a filename containing backslashes, so the win32 branch would never execute.
describe("foldCanonicalPathSeparators — win32 shapes", () => {
  it("keeps the leading pair of a UNC path, which names the share", () => {
    // What `realpathSync.native` hands back for a mapped network drive (Z:\proj) as well as for a directly picked \\server\share\proj.
    expect(foldCanonicalPathSeparators("\\\\server\\share\\proj", "win32"))
      .toBe("//server/share/proj");
  });

  it("keeps the device-namespace prefix", () => {
    // The drive letter stays cased here because the lowercase rule is anchored at the start of the string and this shape puts `//?/` there. Matching is unaffected: `caseFoldForMatch` folds the whole path on win32.
    expect(foldCanonicalPathSeparators("\\\\?\\C:\\proj", "win32")).toBe("//?/C:/proj");
  });

  it("still collapses duplicate separators inside the path", () => {
    expect(foldCanonicalPathSeparators("\\\\server\\share\\\\a\\\\b", "win32"))
      .toBe("//server/share/a/b");
  });

  it("lowercases only the drive letter", () => {
    expect(foldCanonicalPathSeparators("C:\\Work\\Beta", "win32")).toBe("c:/Work/Beta");
  });

  it("does not invent a leading pair off win32", () => {
    expect(foldCanonicalPathSeparators("//server/share/proj", "linux")).toBe("/server/share/proj");
  });
});


describe("bounded missing-suffix observations", () => {
  const ancestorAtLimit = (path: string) => { for (let i = 0; i < MAX_WALK_UP; i++) path = dirname(path); return path; };

  it("proves a missing bounded ancestor once instead of probing every impossible descendant", () => {
    const root = resources.makeTmpDir("ave-missing-suffix-");
    const path = join(root, "missing", ...Array.from({ length: MAX_WALK_UP + 8 }, () => "x"), "leaf");
    const exists = vi.mocked(filesystem.existsSync).mockClear();
    const metadata = vi.mocked(filesystem.lstatSync).mockClear();
    expect(createPathCanonicalizer()(path)).toBe(foldCanonicalPathSeparators(path));
    expect(metadata).toHaveBeenCalledExactlyOnceWith(ancestorAtLimit(path));
    expect(exists).not.toHaveBeenCalled();
  });

  it("preserves original fallback bytes and sibling observations for a length-invalid prefix", () => {
    const root = resources.makeTmpDir("ave-length-suffix-");
    const path = join(root, ...Array.from({ length: MAX_WALK_UP + 8 }, () => "x"), "cafe\u0301");
    const sibling = join(dirname(path), "other");
    const expected = canonicalizePathForMatch(path);
    const expectedSibling = canonicalizePathForMatch(sibling);
    const metadata = vi.mocked(filesystem.lstatSync).mockClear().mockImplementation(() => { throw Object.assign(new Error("Path is too long"), { code: "ENAMETOOLONG" }); });
    const exists = vi.mocked(filesystem.existsSync).mockClear();
    const observe = createPathCanonicalizer();
    expect(observe(path)).toBe(expected);
    expect(observe(path)).toBe(expected);
    expect(observe(sibling)).toBe(expectedSibling);
    expect(metadata).toHaveBeenCalledExactlyOnceWith(ancestorAtLimit(path));
    expect(exists).not.toHaveBeenCalled();
  });

  it("retains child-first link resolution when the bounded ancestor exists", () => {
    const root = resources.makeTmpDir("ave-existing-suffix-");
    const prefix = join(root, ...Array.from({ length: MAX_WALK_UP + 4 }, () => "x"));
    const physical = join(root, "physical");
    mkdirSync(prefix, { recursive: true }); mkdirSync(physical);
    symlinkSync(physical, join(prefix, "link"), "junction");
    expect(createPathCanonicalizer()(join(prefix, "link", "leaf")))
      .toBe(foldCanonicalPathSeparators(join(filesystem.realpathSync.native(physical), "leaf")));
  });

  it.each(["EACCES", "EPERM", "ELOOP", "EIO", "UNKNOWN"])("keeps the original accessible-child result after ancestor metadata error %s", code => {
    const root = resources.makeTmpDir("ave-denied-suffix-");
    const path = join(root, ...Array.from({ length: MAX_WALK_UP + 8 }, () => "x"), "leaf");
    const target = join(root, "resolved-child");
    vi.spyOn(filesystem, "lstatSync").mockImplementation(() => { throw Object.assign(new Error("Metadata unavailable"), { code }); });
    const exists = vi.spyOn(filesystem, "existsSync").mockReturnValue(true);
    vi.spyOn(filesystem.realpathSync, "native").mockReturnValue(target);
    expect(createPathCanonicalizer()(path)).toBe(foldCanonicalPathSeparators(target));
    expect(exists).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("does not preflight beyond a previously observed intermediate prefix", () => {
    const root = resources.makeTmpDir("ave-known-suffix-");
    const prefix = join(root, ...Array.from({ length: 32 }, () => "x"));
    const observe = createPathCanonicalizer();
    observe(prefix);
    const metadata = vi.spyOn(filesystem, "lstatSync");
    const path = join(prefix, ...Array.from({ length: 40 }, () => "y"), "leaf");
    expect(observe(path)).toBe(foldCanonicalPathSeparators(path));
    expect(metadata).not.toHaveBeenCalled();
  });

  it.each(["\\\\server\\share\\" + "x\\".repeat(72) + "leaf", "/" + "x/".repeat(70) + "../leaf"])("keeps namespace or parent-ambiguous input on the original walk: %s", path => {
    vi.spyOn(filesystem, "existsSync").mockReturnValue(false);
    const metadata = vi.spyOn(filesystem, "lstatSync");
    createPathCanonicalizer()(path, true);
    expect(metadata).not.toHaveBeenCalled();
  });
});
