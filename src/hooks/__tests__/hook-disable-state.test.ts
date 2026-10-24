import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { disableHook } from "../hook-discovery.js";
import { hookDisableCausePath, readHookDisableCause, writeHookDisableCause } from "../hook-disable-state.js";
import { collectHookMatcherDiagnostics } from "../hook-matcher-diagnostics.js";

const failCauseWrites = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (failCauseWrites.on && String(args[0]).endsWith(".disable-cause")) throw new Error("injected cause write failure");
      return actual.openSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (failCauseWrites.on && String(args[0]).endsWith(".disable-cause")) throw new Error("injected cause write failure");
      return actual.writeFileSync(...args);
    },
  };
});

let dir: string;
let hooksDir: string;
let disabledDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-disable-state-"));
  hooksDir = join(dir, "hooks");
  disabledDir = join(hooksDir, ".disabled");
  mkdirSync(disabledDir, { recursive: true });
});

afterEach(async () => {
  failCauseWrites.on = false;
  await cleanupTmpDir(dir);
});

describe("disable cause records", () => {
  it("replaces a link at the sidecar path instead of writing through it", (ctx) => {
    const stored = join(disabledDir, "pre-guard.sh");
    writeFileSync(stored, "#!/bin/sh\nexit 0\n");
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "untouched\n");
    try {
      symlinkSync(outside, hookDisableCausePath(stored));
    } catch {
      ctx.skip();
    }
    writeHookDisableCause(stored, "user");
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(lstatSync(hookDisableCausePath(stored)).isSymbolicLink()).toBe(false);
    expect(readHookDisableCause(stored)).toBe("user");
  });

  it("drops a stale user record before a failed write, so the copy keeps its guard", () => {
    const fileName = "pre-guard.sh";
    const active = join(hooksDir, fileName);
    writeFileSync(active, "#!/bin/sh\n# ave-hook-matcher: *danger*\nexit 0\n");
    // Left behind when an earlier user-disabled copy was moved out by hand.
    writeFileSync(hookDisableCausePath(join(disabledDir, fileName)), "user\n");
    const dest = join(disabledDir, fileName);
    failCauseWrites.on = true;
    let thrown: unknown;
    try {
      expect(disableHook({ fileName, path: active } as Parameters<typeof disableHook>[0], disabledDir, "system-quarantine")).toBe(dest);
    } catch (err) {
      thrown = err;
    }
    failCauseWrites.on = false;
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(hookDisableCausePath(dest))).toBe(false);
    expect(readHookDisableCause(dest)).toBe("legacy");
    expect(collectHookMatcherDiagnostics(hooksDir, disabledDir).guards).toHaveLength(1);
    expect(thrown).toBeUndefined();
  });
});
