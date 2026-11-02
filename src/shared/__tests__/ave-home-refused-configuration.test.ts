// Native run 4: a home verified on its first boot and refused on a later one (a foreign entry added in between) crashed bootstrap
// with "Configuration migration state exists without the requested file". The refused boot looked for configuration at the root,
// which the first boot had already committed to `config/`, so the user never reached the privacy refusal and its fix command.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { _resetAveHomePrivacyForTest, aveHomeConfigurationDirectory, ensureAveHomePrivate, setAveHomeConfigurationRefusedAtBoot } from "../ave-home.js";
import { readAveHomeConfigurationFile, setAveHomeConfigurationOwner } from "../ave-home-configuration-access.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { loadPolicy } from "../../permissions/policy-store.js";

describe.runIf(process.platform !== "win32")("configuration of a home refused after an earlier verified boot", () => {
  let parent: string;
  let home: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "ave-refused-config-"));
    home = join(parent, ".ave");
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
  });
  afterEach(async () => {
    setAveHomeConfigurationOwner(undefined);
    _resetAveHomePrivacyForTest();
    vi.unstubAllEnvs();
    await cleanupTmpDir(parent);
  });

  /** The first, verified boot: protection, then the migration that commits `config/` (it writes the default policy there). */
  function verifiedFirstBoot(): void {
    const privacy = ensureAveHomePrivate(home);
    expect(privacy.enforcement).toBe("posix-mode");
    expect(migrateAveHomeConfiguration(home, privacy)).toEqual([]);
    expect(existsSync(join(home, "config", ".ave-config-migrated"))).toBe(true);
    _resetAveHomePrivacyForTest();
  }

  it("keeps reading the committed config/ on the refused relaunch, so bootstrap reaches the refusal", async () => {
    verifiedFirstBoot();
    // The relaunch: boot refuses the home and never migrates (boot.ts), then the approval gate loads the policy.
    expect(migrateAveHomeConfiguration(home, { enforcement: "none", home, category: "extra-principals", reason: "fixture" })).toEqual([]);
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(aveHomeConfigurationDirectory(home)).toBe(join(home, "config"));
    const policy = await loadPolicy();
    // The committed policy still applies (its default requires explicit approval), rather than nothing or the defaults of absence.
    expect(policy).toMatchObject({ requireExplicitApproval: true, source: "user" });
    expect(readAveHomeConfigurationFile(join(home, "policy.json"))?.toString("utf8")).toContain("requireExplicitApproval");
  });

  it("stays root-only for a refused home that never committed config/", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "settings.json"), '{"legacy":true}');
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(aveHomeConfigurationDirectory(home)).toBe(home);
    expect(readAveHomeConfigurationFile(join(home, "settings.json"))?.toString("utf8")).toBe('{"legacy":true}');
  });

  it("refuses a committed marker with the wrong content instead of guessing a location", () => {
    verifiedFirstBoot();
    writeFileSync(join(home, "config", ".ave-config-migrated"), "tampered");
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(() => aveHomeConfigurationDirectory(home)).toThrow(/Configuration marker content is invalid/);
  });
});
