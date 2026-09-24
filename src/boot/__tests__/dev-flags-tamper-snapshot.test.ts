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
  devNoSandboxAllowed,
  isE2eTestRuntime,
  isPackagedElectronProcess,
  isPackagedForbiddenEnvVar,
  readDevelopmentEnvVar,
  setIsPackaged,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";
import { PACKAGED_DEVELOPMENT_ENV_VARS } from "../../shared/development-env-policy.js";

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
      "AVE_DEV_CONSOLE",
      "AVE_E2E",
      "AVE_DEBUG_STREAM",
      "VITE_DEBUG_STREAM",
      "AVE_WIN_NO_SANDBOX",
      "AVE_PLUGINS_DIR",
    ]);
    const names = tamperedVarsAtBoot();
    expect(names).toContain("AVE_DEV");
    expect(names).toContain("AVE_DEV_RELOAD");
    expect(names).toContain("AVE_DEV_CONSOLE");
    expect(names).toContain("AVE_E2E");
    expect(names).toContain("AVE_DEBUG_STREAM");
    expect(names).toContain("VITE_DEBUG_STREAM");
    expect(names).toContain("AVE_WIN_NO_SANDBOX");
    expect(names).toContain("AVE_PLUGINS_DIR");
    expect(names).toHaveLength(8);
  });

  it("defines the packaged dev/test env scrub predicate", () => {
    for (const name of PACKAGED_DEVELOPMENT_ENV_VARS) {
      expect(isPackagedForbiddenEnvVar(name), name).toBe(true);
    }
    expect(isPackagedForbiddenEnvVar("AVE_DEV")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_DEV_CONSOLE")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_DEV_SOMETHING_NEW")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_E2E")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_DEBUG_STREAM")).toBe(true);
    expect(isPackagedForbiddenEnvVar("VITE_DEBUG_STREAM")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_WIN_NO_SANDBOX")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_PLUGINS_DIR")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_WHITELIST_OFFLINE")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_ADMISSION_OFFLINE")).toBe(true);
    expect(isPackagedForbiddenEnvVar("AVE_REVOCATION_OFFLINE")).toBe(true);

    expect(isPackagedForbiddenEnvVar("AVE_HOME")).toBe(false);
    expect(isPackagedForbiddenEnvVar("NODE_ENV")).toBe(false);
  });

  it("reads a development flag only for unpackaged execution", () => {
    const env: NodeJS.ProcessEnv = { AVE_TRACE: "1" };

    expect(readDevelopmentEnvVar("AVE_TRACE", env, false)).toBe("1");
    expect(readDevelopmentEnvVar("AVE_TRACE", env, true)).toBeUndefined();
  });

  it("keeps AVE_WIN_NO_SANDBOX Windows-only and packaged-gated", () => {
    const saved = process.env.AVE_WIN_NO_SANDBOX;
    try {
      process.env.AVE_WIN_NO_SANDBOX = "1";
      setIsPackaged(true);
      expect(devNoSandboxAllowed(true, "win32")).toBe(false);
      setIsPackaged(false);
      expect(devNoSandboxAllowed(false, "win32")).toBe(true);
      expect(devNoSandboxAllowed(false, "darwin")).toBe(false);
      expect(devNoSandboxAllowed(false, "linux")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AVE_WIN_NO_SANDBOX;
      else process.env.AVE_WIN_NO_SANDBOX = saved;
    }
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

describe("isPackagedElectronProcess — the pre-boot answer the logger uses", () => {
  it("is packaged when Electron runs without defaultApp, whatever AVE_DEV says", () => {
    // logger.ts and services.ts used to treat AVE_DEV=1 as "not packaged";
    // dev-flags ignores the flag in a packaged build, and now so do they.
    expect(isPackagedElectronProcess({ versions: { electron: "32.0.0" } })).toBe(true);
    expect(isPackagedElectronProcess({ versions: { electron: "32.0.0" }, defaultApp: true })).toBe(false);
    expect(isPackagedElectronProcess({ versions: {} })).toBe(false);
    expect(isPackagedElectronProcess({})).toBe(false);
  });
});

describe("isE2eTestRuntime", () => {
  it("requires AVE_E2E=1 AND NODE_ENV=test — AVE_E2E alone is not the harness", () => {
    // The plugin bundle-snapshot IPC and the preload env flag accepted
    // AVE_E2E=1 on its own; the whitelist and managed-bootstrap gates did not.
    expect(isE2eTestRuntime({ AVE_E2E: "1", NODE_ENV: "test" })).toBe(true);
    expect(isE2eTestRuntime({ AVE_E2E: "1" })).toBe(false);
    expect(isE2eTestRuntime({ AVE_E2E: "1", NODE_ENV: "development" })).toBe(false);
    expect(isE2eTestRuntime({ NODE_ENV: "test" })).toBe(false);
  });
});
