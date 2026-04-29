/**
 * Round-4 — verifies the tamper-detect snapshot defeats the
 * `main.ts` env scrub.
 *
 * Threat model: a packaged binary launched with `AVE_DEV=1` in the user
 * environment must emit a single audit-log line listing the tampered vars,
 * so operators can detect supply-chain or local-launcher tampering. The
 * `main.ts:67-73` scrub deletes those vars from `process.env` before
 * `plugin-runtime.ts` calls `shouldWarnPackagedFlagsIgnored()`. If the
 * helper read live `process.env`, the scrub would silently disable the
 * audit log.
 *
 * The fix snapshots presence at module-load time (which runs before the
 * scrub due to ESM import order). These tests verify both the snapshot
 * read and the test-only override that lets us exercise warn-true /
 * warn-false branches.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTest,
  _setTamperedSnapshotForTest,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";

describe("dev-flags tamper snapshot", () => {
  beforeEach(() => {
    _resetForTest();
  });

  afterEach(() => {
    _resetForTest();
  });

  it("returns false for unpackaged builds even if vars were tampered", () => {
    _setTamperedSnapshotForTest(["AVE_DEV", "AVE_DEV_RELOAD"]);
    expect(shouldWarnPackagedFlagsIgnored(false)).toBe(false);
  });

  it("returns false for packaged builds when no vars were present at boot", () => {
    _setTamperedSnapshotForTest([]);
    expect(shouldWarnPackagedFlagsIgnored(true)).toBe(false);
    expect(tamperedVarsAtBoot()).toEqual([]);
  });

  it("returns true for packaged builds when AVE_DEV was present at boot", () => {
    _setTamperedSnapshotForTest(["AVE_DEV"]);
    expect(shouldWarnPackagedFlagsIgnored(true)).toBe(true);
    expect(tamperedVarsAtBoot()).toEqual(["AVE_DEV"]);
  });

  it("survives a simulated process.env scrub (the round-4 regression)", () => {
    // Simulate the boot snapshot capturing AVE_DEV at import time.
    _setTamperedSnapshotForTest(["AVE_DEV", "AVE_PLUGINS_DIR"]);

    // Simulate `main.ts`'s scrub running afterwards.
    delete process.env.AVE_DEV;
    delete process.env.AVE_PLUGINS_DIR;

    // Helper still reports tampered because it reads the snapshot.
    expect(shouldWarnPackagedFlagsIgnored(true)).toBe(true);
    expect(tamperedVarsAtBoot()).toEqual(["AVE_DEV", "AVE_PLUGINS_DIR"]);
  });

  it("lists all tampered vars for the audit log message body", () => {
    _setTamperedSnapshotForTest([
      "AVE_DEV",
      "AVE_DEV_RELOAD",
      "AVE_WIN_NO_SANDBOX",
    ]);
    const names = tamperedVarsAtBoot();
    expect(names).toContain("AVE_DEV");
    expect(names).toContain("AVE_DEV_RELOAD");
    expect(names).toContain("AVE_WIN_NO_SANDBOX");
    expect(names).toHaveLength(3);
  });

  it("clearing the override restores the real snapshot", () => {
    // First call without override → captures whatever the real snapshot is.
    _setTamperedSnapshotForTest(null);
    const realSnapshot = tamperedVarsAtBoot();

    // Apply override → returns override.
    _setTamperedSnapshotForTest(["FAKE_OVERRIDE_VAR"]);
    expect(tamperedVarsAtBoot()).toEqual(["FAKE_OVERRIDE_VAR"]);

    // Clear override → returns real snapshot again.
    _setTamperedSnapshotForTest(null);
    expect(tamperedVarsAtBoot()).toEqual(realSnapshot);
  });
});
