import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { disableHook } from "../hook-discovery.js";
import { hookDisableCausePath, readHookDisableCause, writeHookDisableCause } from "../hook-disable-state.js";
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
function disableGuard(): string {
  const fileName = "pre-guard.sh";
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

  describe.each(["file", "link"] as const)("a user record planted as a %s just before the write", (kind) => {
    function plant(ctx: TestContext, fail: boolean): void {
      injection.beforeWrite = (path) => {
        injection.beforeWrite = undefined;
        const sidecar = path.slice(0, path.indexOf(".disable-cause") + ".disable-cause".length);
        if (kind === "file") writeFileSync(sidecar, "user\n");
        else linkOrSkip(ctx, outside, sidecar);
        if (fail) throw new Error("injected cause write failure");
      };
    }

    it("is replaced by the system record", (ctx) => {
      plant(ctx, false);
      const dest = disableGuard();
      expect(readHookDisableCause(dest)).toBe("system-quarantine");
      expect(readFileSync(outside, "utf8")).toBe("user\n");
      expect(guards()).toHaveLength(1);
    });

    it("is cleared when the write then fails", (ctx) => {
      plant(ctx, true);
      const dest = disableGuard();
      expect(existsSync(hookDisableCausePath(dest))).toBe(false);
      expect(readHookDisableCause(dest)).toBe("legacy");
      expect(guards()).toHaveLength(1);
    });
  });
});
