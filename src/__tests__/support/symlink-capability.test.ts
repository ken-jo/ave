import type { PathLike } from "node:fs";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";

let symlinkFailure: NodeJS.ErrnoException | undefined;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: (target: PathLike, path: PathLike, type?: Parameters<typeof actual.symlinkSync>[2]) => {
      if (symlinkFailure !== undefined) throw symlinkFailure;
      actual.symlinkSync(target, path, type);
    },
  };
});

const { existsSync, mkdtempSync, readdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { requireSymlinkCapability } = await import("./symlink-capability.js");

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: symlink`), { code });
}

function recordingSkip(): { skip: TestContext["skip"]; notes: string[] } {
  const notes: string[] = [];
  const skip = ((note?: string) => {
    notes.push(note ?? "");
    throw new Error(`skipped: ${note}`);
  }) as TestContext["skip"];
  return { skip, notes };
}

describe("requireSymlinkCapability", () => {
  const roots: string[] = [];
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "ave-symlink-capability-"));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    symlinkFailure = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(["file", "dir"] as const)("skips the test when a %s link is refused with EPERM", (type) => {
    const root = makeRoot();
    symlinkFailure = failure("EPERM");
    const { skip, notes } = recordingSkip();

    expect(() => requireSymlinkCapability(root, type, skip)).toThrow("skipped: Symlink creation requires an unavailable privilege");
    expect(notes).toEqual(["Symlink creation requires an unavailable privilege"]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("rethrows any other link failure", () => {
    const root = makeRoot();
    symlinkFailure = failure("EACCES");
    const { skip, notes } = recordingSkip();

    expect(() => requireSymlinkCapability(root, "file", skip)).toThrow("EACCES");
    expect(notes).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["file", "dir"] as const)("lets the test run when a %s link can be created", (type) => {
    const root = makeRoot();
    const { skip, notes } = recordingSkip();

    requireSymlinkCapability(root, type, skip);

    expect(notes).toEqual([]);
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
});
