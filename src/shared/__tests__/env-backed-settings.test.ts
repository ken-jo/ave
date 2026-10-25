import { describe, expect, it } from "vitest";
import {
  ENV_BACKED_SETTINGS,
  envForcedSettingsPaths,
  envForcedValueForSettingsPath,
  envVarForSettingsPath,
  parseEnvForcedSettingsPaths,
  resolveEnvBackedNumber,
} from "../env-backed-settings.js";

describe("env-backed settings registry", () => {
  it("reports only the variables set to the exact ON value", () => {
    expect(envForcedSettingsPaths({
      AVE_LOCAL_API: "1",
      // Report a setting as forced only when the environment actually overrides user choice.
      AVE_A2A: "0",
      AVE_A2A_REMOTE: "true",
      AVE_A2A_REMOTE_RECEIVER: "",
    })).toEqual(["system.localApiServer"]);

    expect(envForcedSettingsPaths({})).toEqual([]);
  });

  it("forces each confinement scope only by its own variable", () => {
    expect(envForcedSettingsPaths({ AVE_SANDBOX_ENABLED: "1" })).toEqual(["features.osToolSandbox"]);
    expect(envForcedSettingsPaths({ AVE_PLUGIN_WORKER_CONFINEMENT: "1" }))
      .toEqual(["features.pluginWorkerConfinement"]);
    expect(envVarForSettingsPath("features.pluginWorkerConfinement")).toBe("AVE_PLUGIN_WORKER_CONFINEMENT");
  });

  it("names the variable a surface should show for a forced setting", () => {
    expect(envVarForSettingsPath("features.a2aRemoteReceiver")).toBe("AVE_A2A_REMOTE_RECEIVER");
    expect(envVarForSettingsPath("features.notARealGate")).toBeNull();
  });

  it("drops a path this build does not know rather than rendering it", () => {
    expect(parseEnvForcedSettingsPaths(["system.localApiServer", "system.somethingElse", 7]))
      .toEqual(["system.localApiServer"]);
    expect(parseEnvForcedSettingsPaths("system.localApiServer")).toBeNull();
    expect(parseEnvForcedSettingsPaths(null)).toBeNull();
  });

  it("reports the update check forced only when the variable turns it OFF", () => {
    // An environment opt-in does not force a setting that the user may still disable.
    for (const on of ["1", "true", "yes", ""]) {
      expect(envForcedValueForSettingsPath("marketplace.updateCheckEnabled", {
        AVE_MARKETPLACE_UPDATE_CHECK: on,
      })).toBeUndefined();
    }
    for (const off of ["0", "false", "FALSE"]) {
      expect(envForcedValueForSettingsPath("marketplace.updateCheckEnabled", {
        AVE_MARKETPLACE_UPDATE_CHECK: off,
      })).toBe(false);
    }
    expect(envForcedValueForSettingsPath("marketplace.updateCheckEnabled", {})).toBeUndefined();
  });

  it("reports the offline copy forced in both directions once the variable is set", () => {
    expect(envForcedValueForSettingsPath("marketplace.offlineCacheEnabled", {
      AVE_MARKETPLACE_USE_CACHE: "1",
    })).toBe(true);
    expect(envForcedValueForSettingsPath("marketplace.offlineCacheEnabled", {
      AVE_MARKETPLACE_USE_CACHE: "no",
    })).toBe(false);
    expect(envForcedValueForSettingsPath("marketplace.offlineCacheEnabled", {})).toBeUndefined();
    expect(envForcedSettingsPaths({ AVE_MARKETPLACE_USE_CACHE: "off" }))
      .toEqual(["marketplace.offlineCacheEnabled"]);
  });

  it("reports the corporate CA switch forced only by the variable that skips it", () => {
    // The negative skip variable forces the setting off, not on.
    expect(envForcedValueForSettingsPath("system.corpCaEnabled", { AVE_SKIP_CORP_CA: "1" }))
      .toBe(false);
    expect(envForcedValueForSettingsPath("system.corpCaEnabled", { AVE_SKIP_CORP_CA: "0" }))
      .toBeUndefined();
    expect(envForcedValueForSettingsPath("system.corpCaEnabled", {})).toBeUndefined();
  });

  it("carries the certificate name itself, not a boolean", () => {
    // Text overrides use the registry’s resolved value so applicability checks cannot diverge.
    expect(envForcedValueForSettingsPath("system.corpCaCommonName", {
      AVE_CORP_CA_CN: "  Acme Root CA  ",
    })).toBe("Acme Root CA");
    expect(envForcedValueForSettingsPath("system.corpCaCommonName", { AVE_CORP_CA_CN: "   " }))
      .toBeUndefined();
    expect(envForcedSettingsPaths({ AVE_CORP_CA_CN: "Acme Root CA", AVE_CORP_CA_DEBUG: "1" }))
      .toEqual(["system.corpCaDebugLog", "system.corpCaCommonName"]);
  });

  it("carries the cleanup window as a number, parsed by the setting's own rule", () => {
    // Numeric overrides must satisfy the same bounds as the timer setting.
    expect(envForcedValueForSettingsPath("system.shutdownCleanupTimeoutMs", {
      AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000",
    })).toBe(45_000);
    expect(envForcedValueForSettingsPath("system.shutdownCleanupTimeoutMs", {
      AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS: "0",
    })).toBeUndefined();
    expect(envForcedSettingsPaths({ AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS: "abc" })).toEqual([]);
    expect(envForcedSettingsPaths({ AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000" }))
      .toEqual(["system.shutdownCleanupTimeoutMs"]);
  });

  it("resolves a numeric setting environment-first, then saved, then default", () => {
    expect(resolveEnvBackedNumber(
      "system.shutdownCleanupTimeoutMs", 30_000,
      { AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000" }, 15_000,
    )).toBe(45_000);
    expect(resolveEnvBackedNumber("system.shutdownCleanupTimeoutMs", 30_000, {}, 15_000))
      .toBe(30_000);
    expect(resolveEnvBackedNumber("system.shutdownCleanupTimeoutMs", undefined, {}, 15_000))
      .toBe(15_000);
    // A type-mismatched registry lookup must leave the setting in control.
    expect(resolveEnvBackedNumber(
      "system.localApiServer", 30_000, { AVE_LOCAL_API: "1" }, 15_000,
    )).toBe(30_000);
  });

  it("returns undefined for a path that is not in the registry", () => {
    expect(envForcedValueForSettingsPath("system.notARealGate", { AVE_LOCAL_API: "1" }))
      .toBeUndefined();
  });

  it("pairs each settings path with exactly one variable", () => {
    const paths = ENV_BACKED_SETTINGS.map((entry) => entry.settingsPath);
    const vars = ENV_BACKED_SETTINGS.map((entry) => entry.envVar);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(vars).size).toBe(vars.length);
    for (const path of paths) expect(path).toMatch(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/);
  });
});
