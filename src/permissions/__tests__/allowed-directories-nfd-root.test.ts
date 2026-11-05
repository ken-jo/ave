// A project root whose name the filesystem keeps in NFD (a Korean folder made on macOS, copied to ext4) must stay listable.
// ext4 keeps bytes as written, so the NFC spelling names nothing there; this suite simulates that on any host by refusing the
// NFC spelling at the fs seam, the way Linux CI meets it for real.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync as hostRealpath } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const NAME = "프로젝트";
// A folder whose realpath names a different target than its matching form, as when it is swapped between the two resolutions:
// the canonicalization resolves it first, and the runtime-root spelling resolves the same path a second time, which is the
// call that sees the other folder.
const { swapped } = vi.hoisted(() => ({ swapped: { from: "", to: "", calls: 0, vanish: false } }));
const NFD = NAME.normalize("NFD");
const NFC = NAME.normalize("NFC");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // An NFD-preserving filesystem: the composed spelling of the folder does not exist.
  const composed = (path: unknown) => typeof path === "string" && path.includes(NFC) && NFC !== NFD;
  const native = ((path: Parameters<typeof actual.realpathSync.native>[0], ...rest: unknown[]) => {
    if (swapped.from && path === swapped.from && ++swapped.calls === 2) {
      if (swapped.vanish) throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${String(path)}'`), { code: "ENOENT" });
      return swapped.to;
    }
    if (composed(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${String(path)}'`), { code: "ENOENT" });
    return (actual.realpathSync.native as (...args: unknown[]) => string)(path, ...rest);
  }) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(((path: Parameters<typeof actual.realpathSync>[0], ...rest: unknown[]) => {
    if (composed(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return (actual.realpathSync as (...args: unknown[]) => string)(path, ...rest);
  }) as typeof actual.realpathSync, { native });
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => !composed(path) && actual.existsSync(path),
    realpathSync,
  };
});

import { buildRuntimeAllowedDirectories, sanitizeAllowedDirectories, sanitizeRuntimeAllowedDirectories } from "../allowed-directories.js";

let parent: string;
let root: string;

beforeAll(() => {
  parent = hostRealpath(mkdtempSync(join(tmpdir(), "ave-nfd-root-")));
  root = join(parent, NFD);
  mkdirSync(root);
});

afterAll(async () => {
  await cleanupTmpDir(parent);
});

describe("runtime allowed directories on an NFD-preserving filesystem", () => {
  it("keep the folder's on-disk spelling, so paths realpath'd under it stay inside", () => {
    expect(sanitizeRuntimeAllowedDirectories([root])).toEqual([root]);
    expect(buildRuntimeAllowedDirectories([root], parent)).toContain(root);
  });

  it("keep the NFC matching form for a folder that does not exist", () => {
    const missing = join(parent, `${NFD}-missing`);
    expect(sanitizeRuntimeAllowedDirectories([missing])).toEqual([missing.normalize("NFC")]);
  });

  it("leave the case-folded matching list in its NFC form", () => {
    expect(sanitizeAllowedDirectories([root])[0]).toBe(sanitizeAllowedDirectories([root])[0]!.normalize("NFC"));
  });
});

describe("the on-disk spelling is pinned to the matching form's target", () => {
  it("leaves out only a root whose realpath names a different folder, and keeps the others", () => {
    const other = join(parent, "other");
    mkdirSync(other, { recursive: true });
    swapped.from = root;
    swapped.to = join(parent, "elsewhere");
    swapped.calls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const directories = buildRuntimeAllowedDirectories([root, other], parent);
      expect(directories).toContain(other);
      expect(directories).not.toContain(root);
      expect(directories).not.toContain(swapped.to);
      expect(directories.some((dir) => dir.normalize("NFC") === root.normalize("NFC"))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("left out"));
    } finally {
      swapped.from = "";
      warn.mockRestore();
    }
  });

  it("leaves out only a root whose folder disappears before its realpath, and keeps the others", () => {
    const other = join(parent, "other");
    mkdirSync(other, { recursive: true });
    swapped.from = root;
    swapped.vanish = true;
    swapped.calls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const directories = buildRuntimeAllowedDirectories([root, other], parent);
      expect(swapped.calls).toBe(2);
      expect(directories).toContain(other);
      expect(directories.some((dir) => dir.normalize("NFC") === root.normalize("NFC"))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("left out"));
    } finally {
      swapped.from = "";
      swapped.vanish = false;
      warn.mockRestore();
    }
  });
});
