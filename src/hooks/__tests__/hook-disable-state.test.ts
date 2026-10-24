import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { disableHook } from "../hook-discovery.js";
import { disabledHookOriginalName, hookDisableCausePath, readHookDisableCause, writeHookDisableCause } from "../hook-disable-state.js";
import { collectHookMatcherDiagnostics } from "../hook-matcher-diagnostics.js";

/** Runs when a cause record is about to be written: plant something at the sidecar, or fail. */
const injection = vi.hoisted(() => ({ beforeWrite: undefined as ((path: string) => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const intercept = <A extends unknown[], R>(write: (...args: A) => R) => (...args: A): R => {
    if (injection.beforeWrite && String(args[0]).includes(".disable-cause")) injection.beforeWrite(String(args[0]));
    return write(...args);
  };
  return { ...actual, openSync: intercept(actual.openSync), writeFileSync: intercept(actual.writeFileSync) };
});

let dir: string;
let hooksDir: string;
let disabledDir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-disable-state-"));
  hooksDir = join(dir, "hooks");
  disabledDir = join(hooksDir, ".disabled");
  mkdirSync(disabledDir, { recursive: true });
  outside = join(dir, "outside.txt");
  writeFileSync(outside, "user\n");
});

afterEach(async () => {
  injection.beforeWrite = undefined;
  await cleanupTmpDir(dir);
});

function linkOrSkip(ctx: TestContext, target: string, path: string): void {
  try {
    symlinkSync(target, path);
  } catch {
    ctx.skip();
  }
}

/** Disables an invalid guard script into `.disabled/` and returns where it went. */
function disableGuard(fileName = "pre-guard.sh"): string {
  const active = join(hooksDir, fileName);
  writeFileSync(active, "#!/bin/sh\n# ave-hook-matcher: *danger*\nexit 0\n");
  return disableHook({ fileName, path: active } as Parameters<typeof disableHook>[0], disabledDir, "system-quarantine");
}

const guards = () => collectHookMatcherDiagnostics(hooksDir, disabledDir).guards;

describe("disable cause records", () => {
  it("replaces a link at the sidecar path instead of writing through it", (ctx) => {
    const stored = join(disabledDir, "pre-guard.sh");
    writeFileSync(stored, "#!/bin/sh\nexit 0\n");
    linkOrSkip(ctx, outside, hookDisableCausePath(stored));
    writeHookDisableCause(stored, "system-quarantine");
    expect(readFileSync(outside, "utf8")).toBe("user\n");
    expect(lstatSync(hookDisableCausePath(stored)).isSymbolicLink()).toBe(false);
    expect(readHookDisableCause(stored)).toBe("system-quarantine");
  });

  it("writes a private record and leaves no staging file behind", () => {
    const stored = join(disabledDir, "pre-guard.sh");
    writeFileSync(stored, "#!/bin/sh\nexit 0\n");
    writeHookDisableCause(stored, "user");
    writeHookDisableCause(stored, "system-quarantine");
    expect(readHookDisableCause(stored)).toBe("system-quarantine");
    if (process.platform !== "win32") expect(lstatSync(hookDisableCausePath(stored)).mode & 0o777).toBe(0o600);
    expect(readdirSync(disabledDir).sort()).toEqual(["pre-guard.sh", "pre-guard.sh.disable-cause"]);
  });

  it("does not follow a link when reading a record", (ctx) => {
    const stored = join(disabledDir, "pre-guard.sh");
    writeFileSync(stored, "#!/bin/sh\nexit 0\n");
    linkOrSkip(ctx, outside, hookDisableCausePath(stored));
    expect(readHookDisableCause(stored)).toBe("legacy");
  });

  it("drops a stale user record when the write fails, so the copy keeps its guard", () => {
    // Left behind when an earlier user-disabled copy was moved out by hand.
    writeFileSync(hookDisableCausePath(join(disabledDir, "pre-guard.sh")), "user\n");
    injection.beforeWrite = () => { throw new Error("injected cause write failure"); };
    const dest = disableGuard();
    injection.beforeWrite = undefined;
    expect(existsSync(hookDisableCausePath(dest))).toBe(false);
    expect(readHookDisableCause(dest)).toBe("legacy");
    expect(guards()).toHaveLength(1);
  });

  it("clears a stale user record before the move, so the copy is guarded until its record lands", () => {
    const sidecar = hookDisableCausePath(join(disabledDir, "pre-guard.sh"));
    writeFileSync(sidecar, "user\n");
    let duringWrite: string | undefined;
    injection.beforeWrite = () => {
      injection.beforeWrite = undefined;
      duringWrite = readHookDisableCause(join(disabledDir, "pre-guard.sh"));
    };
    const dest = disableGuard();
    expect(duringWrite).toBe("legacy");
    expect(readHookDisableCause(dest)).toBe("system-quarantine");
  });

  it("keeps guarding a system copy whose hook name contains the sidecar suffix", () => {
    const dest = disableGuard("pre-a.disable-cause.sh");
    expect(disabledHookOriginalName("pre-a.disable-cause.sh")).toBe("pre-a.disable-cause.sh");
    expect(readHookDisableCause(dest)).toBe("system-quarantine");
    expect(guards()).toHaveLength(1);
  });

  it("never treats a sidecar or a leftover sidecar temp file as a stored copy", () => {
    expect(disabledHookOriginalName("pre-guard.sh.disable-cause")).toBeUndefined();
    expect(disabledHookOriginalName("pre-guard.sh.disable-cause.0123456789ab.tmp")).toBeUndefined();
    expect(disabledHookOriginalName(".pre-guard.sh.disable-cause.123.0f8e2c1a-5b7d-4e3f-9a6b-1c2d3e4f5a6b.tmp")).toBeUndefined();
    writeFileSync(join(disabledDir, "pre-guard.sh.disable-cause.0123456789ab.tmp"), "#!/bin/sh\n# ave-hook-matcher: *danger*\nexit 0\n");
    expect(guards()).toHaveLength(0);
  });

  describe.each(["file", "link"] as const)("a user record planted as a %s just before the write", (kind) => {
    /** Plants at the destination sidecar, never at a path derived from the staging name. */
    function plant(ctx: TestContext, fail: boolean): { at?: string } {
      const planted: { at?: string } = {};
      injection.beforeWrite = () => {
        injection.beforeWrite = undefined;
        const sidecar = hookDisableCausePath(join(disabledDir, "pre-guard.sh"));
        if (kind === "file") writeFileSync(sidecar, "user\n");
        else linkOrSkip(ctx, outside, sidecar);
        planted.at = sidecar;
        if (fail) throw new Error("injected cause write failure");
      };
      return planted;
    }

    it("is replaced by the system record", (ctx) => {
      const planted = plant(ctx, false);
      const dest = disableGuard();
      expect(planted.at).toBe(hookDisableCausePath(dest));
      expect(readHookDisableCause(dest)).toBe("system-quarantine");
      expect(readFileSync(outside, "utf8")).toBe("user\n");
      expect(guards()).toHaveLength(1);
    });

    it("is cleared when the write then fails", (ctx) => {
      const planted = plant(ctx, true);
      const dest = disableGuard();
      expect(planted.at).toBe(hookDisableCausePath(dest));
      expect(existsSync(hookDisableCausePath(dest))).toBe(false);
      expect(readHookDisableCause(dest)).toBe("legacy");
      expect(guards()).toHaveLength(1);
    });
  });
});
