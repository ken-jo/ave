// Owner decision (2026-11-03): a home that was ever refused never migrates or trusts root configuration files. The first trusted start
// after a refusal sets them aside under <home>/quarantine/<timestamp>/ and starts from the strict defaults; the Permissions panel names
// them, and only a user's click restores one, at the next start. A committed config/ that vanishes fails closed instead of falling back
// to the root. The refusal history lives in a trust record outside the home, which a writer to the home root cannot reach.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { _resetAveHomePrivacyForTest, aveHomeConfigurationDirectory, aveHomeConfigurationSeal, AveHomeConfigurationUntrustedError, ensureAveHomePrivate, type AveHomePrivacy } from "../ave-home.js";
import { readAveHomeConfigurationFile, setAveHomeConfigurationOwner } from "../ave-home-configuration-access.js";
import { _resetAveHomeConfigurationNoticeForTest, getAveHomeConfigurationNotice, migrateAveHomeConfiguration, resolveAveHomeConfigurationNotice, restoreRequestedConfiguration } from "../ave-home-configuration.js";
import { aveHomeTrustDirectory, readAveHomeTrustRecord, recordAveHomeWorkspaceCheck } from "../ave-home-trust-record.js";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";

const WEAK_POLICY = '{"version":1,"requireExplicitApproval":false,"managed":false}\n';
const DEFAULT_POLICY = '{"version":1,"requireExplicitApproval":true,"managed":false}\n';

describe.runIf(process.platform !== "win32")("root configuration of a home with a refusal history", () => {
  let parent: string;
  let home: string;
  let config: string;
  const refusal = (): AveHomePrivacy => ({ enforcement: "none", home, category: "extra-principals", reason: "fixture" });

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "ave-quarantine-"));
    home = join(parent, ".ave");
    config = join(home, "config");
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
  });
  afterEach(async () => {
    setAveHomeConfigurationOwner(undefined);
    _resetAveHomePrivacyForTest();
    _resetAveHomeConfigurationNoticeForTest();
    vi.unstubAllEnvs();
    await cleanupTmpDir(parent);
  });

  /** A new process: nothing from the previous start survives except the files and the trust record. */
  function restart(): void {
    _resetAveHomePrivacyForTest();
    _resetAveHomeConfigurationNoticeForTest();
  }

  function trustedStart(): string[] {
    restart();
    const privacy = ensureAveHomePrivate(home);
    expect(privacy.enforcement).toBe("posix-mode");
    return migrateAveHomeConfiguration(home, privacy);
  }

  function refusedStart(): string[] {
    restart();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return migrateAveHomeConfiguration(home, refusal());
  }

  function quarantineFolders(): string[] {
    const directory = join(home, "quarantine");
    return existsSync(directory) ? readdirSync(directory) : [];
  }

  it("keeps the record outside the home, where a writer to the home root cannot reach it", () => {
    expect(aveHomeTrustDirectory()).toBeDefined();
    expect(aveHomeTrustDirectory()!.startsWith(home)).toBe(false);
    refusedStart();
    expect(readAveHomeTrustRecord(home)).toEqual({ refused: true });
    expect((statSync(aveHomeTrustDirectory()!).mode & 0o077)).toBe(0);
  });

  it("migrates the root configuration of a never-refused home as before", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "settings.json"), '{"legacy":true}');
    expect(trustedStart()).toEqual([]);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"legacy":true}');
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(quarantineFolders()).toEqual([]);
    expect(readAveHomeTrustRecord(home)).toEqual({ committed: true });
    expect(getAveHomeConfigurationNotice(home)).toBeUndefined();
  });

  it("sets aside root files planted during a refusal at the next trusted start, and never migrates them", async () => {
    refusedStart();
    writeFileSync(join(home, "settings.json"), '{"planted":true}');
    writeFileSync(join(home, "policy.json"), WEAK_POLICY);

    const diagnostics = trustedStart();
    expect(diagnostics.some((line) => line.includes("Root configuration set aside"))).toBe(true);
    // Not migrated: config/ holds the defaults, and the root no longer holds the planted files.
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(config, "policy.json"), "utf8")).toBe(DEFAULT_POLICY);
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(existsSync(join(home, "policy.json"))).toBe(false);
    expect((await loadPolicy()).requireExplicitApproval).toBe(true);
    // Set aside in one timestamped, owner-only folder.
    const [folder, ...others] = quarantineFolders();
    expect(others).toEqual([]);
    expect(folder).toMatch(/^\d{8}T\d{9}Z$/);
    expect(statSync(join(home, "quarantine")).mode & 0o077).toBe(0);
    expect(statSync(join(home, "quarantine", folder!)).mode & 0o077).toBe(0);
    expect(readFileSync(join(home, "quarantine", folder!, "policy.json"), "utf8")).toBe(WEAK_POLICY);
    // The refusal is cleared only now that a fresh config/ is committed; the notice names the files.
    const record = readAveHomeTrustRecord(home);
    expect(record.refused).toBeUndefined();
    expect(record.committed).toBe(true);
    expect(getAveHomeConfigurationNotice(home)).toEqual({ quarantine: {
      directory: join(home, "quarantine"),
      files: [
        { folder, name: "settings.json", restorable: true, restoreRequested: false },
        { folder, name: "policy.json", restorable: true, restoreRequested: false },
      ],
    } });
    // The notice outlives the start that set the files aside.
    expect(trustedStart()).toEqual([]);
    expect(getAveHomeConfigurationNotice(home)?.quarantine?.files).toHaveLength(2);
  });

  it("sets aside root files of a committed home refused later, instead of keeping them beside the root", () => {
    expect(trustedStart()).toEqual([]);
    refusedStart();
    expect(readAveHomeTrustRecord(home)).toEqual({ refused: true, committed: true });
    writeFileSync(join(home, "policy.json"), WEAK_POLICY);
    trustedStart();
    expect(readdirSync(home).filter((name) => name.startsWith("policy.json"))).toEqual([]);
    expect(readFileSync(join(config, "policy.json"), "utf8")).toBe(DEFAULT_POLICY);
    expect(quarantineFolders()).toHaveLength(1);
  });

  it("restores a set-aside file only after the user's choice, and only at the next start", async () => {
    refusedStart();
    writeFileSync(join(home, "settings.json"), '{"mine":true}');
    trustedStart();
    const [folder] = quarantineFolders();
    // No choice yet: nothing is restored at a later start.
    trustedStart();
    expect(await restoreRequestedConfiguration(home)).toEqual([]);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{}\n");

    resolveAveHomeConfigurationNotice({ action: "restore", folder: folder!, name: "settings.json" }, home);
    expect(getAveHomeConfigurationNotice(home)?.quarantine?.files).toEqual([
      { folder, name: "settings.json", restorable: true, restoreRequested: true },
    ]);
    // The choice is recorded, not applied in this run.
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{}\n");

    trustedStart();
    const restored = await restoreRequestedConfiguration(home);
    expect(restored).toEqual([`Restored settings.json from ${join(home, "quarantine", folder!)}`]);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"mine":true}');
    expect(readAveHomeTrustRecord(home).quarantined).toBeUndefined();
    expect(getAveHomeConfigurationNotice(home)).toBeUndefined();
  });

  it("refuses to restore bytes that changed after they were set aside", async () => {
    refusedStart();
    writeFileSync(join(home, "settings.json"), '{"mine":true}');
    trustedStart();
    const [folder] = quarantineFolders();
    resolveAveHomeConfigurationNotice({ action: "restore", folder: folder!, name: "settings.json" }, home);
    writeFileSync(join(home, "quarantine", folder!, "settings.json"), '{"swapped":true}');
    trustedStart();
    expect(await restoreRequestedConfiguration(home)).toEqual(["Quarantined settings.json was not restored: its bytes changed after it was set aside"]);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{}\n");
    // The file stays listed, without the pending restore.
    expect(getAveHomeConfigurationNotice(home)?.quarantine?.files).toEqual([
      { folder, name: "settings.json", restorable: true, restoreRequested: false },
    ]);
  });

  it("forgets the notice on dismiss and leaves the files in the quarantine folder", () => {
    refusedStart();
    writeFileSync(join(home, "settings.json"), '{"mine":true}');
    trustedStart();
    const [folder] = quarantineFolders();
    resolveAveHomeConfigurationNotice({ action: "dismiss" }, home);
    expect(getAveHomeConfigurationNotice(home)).toBeUndefined();
    expect(readAveHomeTrustRecord(home)).toEqual({ committed: true });
    expect(existsSync(join(home, "quarantine", folder!, "settings.json"))).toBe(true);
  });

  describe("a committed config/ that vanishes", () => {
    it("is sealed on a refused start: reads find nothing, writes are refused, and the root is never used", async () => {
      expect(trustedStart()).toEqual([]);
      rmSync(config, { recursive: true });
      writeFileSync(join(home, "settings.json"), '{"planted":true}');
      writeFileSync(join(home, "policy.json"), WEAK_POLICY);

      const diagnostics = refusedStart();
      expect(diagnostics).toEqual([`Configuration is sealed (configuration-missing): ${config} was committed before and is now missing or uncommitted`]);
      expect(aveHomeConfigurationSeal(home)).toBe("configuration-missing");
      expect(aveHomeConfigurationDirectory(home)).toBe(config);
      expect(readAveHomeConfigurationFile(join(home, "settings.json"))).toBeUndefined();
      expect(await loadPolicy()).toMatchObject({ requireExplicitApproval: true, source: "defaults" });
      await expect(savePolicy({ requireExplicitApproval: false })).rejects.toBeInstanceOf(AveHomeConfigurationUntrustedError);
      expect(readFileSync(join(home, "policy.json"), "utf8")).toBe(WEAK_POLICY);
      expect(getAveHomeConfigurationNotice(home)).toEqual({ sealed: "configuration-missing" });
    });

    it("is sealed on a trusted start without recovering the marker or migrating the root", async () => {
      expect(trustedStart()).toEqual([]);
      unlinkSync(join(config, ".ave-config-migrated"));
      writeFileSync(join(home, "policy.json"), WEAK_POLICY);

      expect(trustedStart()).toEqual([`Configuration is sealed (configuration-missing): ${config} was committed before and is now missing or uncommitted`]);
      expect(existsSync(join(config, ".ave-config-migrated"))).toBe(false);
      expect(readFileSync(join(home, "policy.json"), "utf8")).toBe(WEAK_POLICY);
      expect(aveHomeConfigurationDirectory(home)).toBe(config);
      expect((await loadPolicy()).requireExplicitApproval).toBe(true);
    });

    it("is sealed when its marker was tampered with, instead of recovering it into a fresh migration", () => {
      expect(trustedStart()).toEqual([]);
      writeFileSync(join(config, ".ave-config-migrated"), "tampered");
      const diagnostics = trustedStart();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatch(/^Configuration is sealed \(configuration-unverified\): /);
      expect(readFileSync(join(config, ".ave-config-migrated"), "utf8")).toBe("tampered");
    });

    it("starts fresh at the next trusted start only after the user's choice, setting the root aside", () => {
      expect(trustedStart()).toEqual([]);
      rmSync(config, { recursive: true });
      writeFileSync(join(home, "policy.json"), WEAK_POLICY);
      trustedStart();
      expect(aveHomeConfigurationSeal(home)).toBe("configuration-missing");
      // Still sealed at a later start until the user chooses.
      trustedStart();
      expect(aveHomeConfigurationSeal(home)).toBe("configuration-missing");

      resolveAveHomeConfigurationNotice({ action: "start-fresh" }, home);
      trustedStart();
      expect(aveHomeConfigurationSeal(home)).toBeUndefined();
      expect(readFileSync(join(config, "policy.json"), "utf8")).toBe(DEFAULT_POLICY);
      expect(existsSync(join(home, "policy.json"))).toBe(false);
      expect(quarantineFolders()).toHaveLength(1);
      expect(readAveHomeTrustRecord(home)).toMatchObject({ committed: true });
      expect(readAveHomeTrustRecord(home).refused).toBeUndefined();
    });

    it("refuses start-fresh when committed configuration is not missing", () => {
      expect(trustedStart()).toEqual([]);
      expect(() => resolveAveHomeConfigurationNotice({ action: "start-fresh" }, home)).toThrow(/applies only when committed configuration is missing/);
      expect(readAveHomeTrustRecord(home)).toEqual({ committed: true });
    });
  });

  it("seals a refused home holding migration state without a commit, so the start reaches the refusal", async () => {
    // An interrupted migration: the source record was written, the commit marker was not, then the home was refused.
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".ave-config-sources.json"), "{}");
    writeFileSync(join(home, "settings.json"), '{"legacy":true}');

    expect(refusedStart()).toEqual([`Configuration is sealed (migration-interrupted): ${config} holds migration state without a commit`]);
    expect(readAveHomeConfigurationFile(join(home, "settings.json"))).toBeUndefined();
    expect(await loadPolicy()).toMatchObject({ requireExplicitApproval: true, source: "defaults" });
    expect(getAveHomeConfigurationNotice(home)).toEqual({ sealed: "migration-interrupted" });
  });

  it("finishes an interrupted migration of a refused home at the next trusted start, setting its uncommitted copies aside too", () => {
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".ave-config-sources.json"), "{}");
    writeFileSync(join(config, "settings.json"), '{"interrupted":true}');
    writeFileSync(join(home, "settings.json"), '{"legacy":true}');
    refusedStart();
    expect(aveHomeConfigurationSeal(home)).toBe("migration-interrupted");

    const diagnostics = trustedStart();
    expect(aveHomeConfigurationSeal(home)).toBeUndefined();
    expect(diagnostics.some((line) => line.includes("config/settings.json"))).toBe(true);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(config, ".ave-config-migrated"))).toBe(true);
    const [folder] = quarantineFolders();
    expect(readFileSync(join(home, "quarantine", folder!, "settings.json"), "utf8")).toBe('{"legacy":true}');
    expect(readFileSync(join(home, "quarantine", folder!, "config", "settings.json"), "utf8")).toBe('{"interrupted":true}');
    expect(existsSync(join(home, "quarantine", folder!, "config", ".ave-config-sources.json"))).toBe(true);
    expect(statSync(join(home, "quarantine", folder!, "config")).mode & 0o077).toBe(0);
    expect(getAveHomeConfigurationNotice(home)?.quarantine?.files).toEqual([
      { folder, name: "settings.json", restorable: true, restoreRequested: false },
      { folder: `${folder}/config`, name: "settings.json", restorable: true, restoreRequested: false },
    ]);
    expect(readAveHomeTrustRecord(home).refused).toBeUndefined();
  });

  it("starts fresh after the commit marker alone went missing, setting the uncommitted config/ files aside", () => {
    expect(trustedStart()).toEqual([]);
    writeFileSync(join(config, "settings.json"), '{"mine":true}');
    unlinkSync(join(config, ".ave-config-migrated"));
    trustedStart();
    expect(aveHomeConfigurationSeal(home)).toBe("configuration-missing");
    resolveAveHomeConfigurationNotice({ action: "start-fresh" }, home);
    trustedStart();
    expect(aveHomeConfigurationSeal(home)).toBeUndefined();
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{}\n");
    const [folder] = quarantineFolders();
    expect(readFileSync(join(home, "quarantine", folder!, "config", "settings.json"), "utf8")).toBe('{"mine":true}');
  });

  it("seals the configuration when the home's trust record cannot be verified", () => {
    refusedStart();
    const record = join(aveHomeTrustDirectory()!, `${createHash("sha256").update(resolve(home)).digest("hex")}.json`);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ version: 1, refused: true });
    writeFileSync(record, '{"version":1,"refused":"maybe"}');
    writeFileSync(join(home, "settings.json"), '{"planted":true}');
    const diagnostics = trustedStart();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^Configuration is sealed: Home trust record is unverified at /);
    expect(aveHomeConfigurationSeal(home)).toBe("trust-record-unverified");
    expect(existsSync(join(config, "settings.json"))).toBe(false);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe('{"planted":true}');
  });
});

describe.runIf(process.platform !== "win32")("consecutive workspace checks that could not open the workspace", () => {
  let parent: string;
  beforeEach(() => { parent = mkdtempSync(join(tmpdir(), "ave-workspace-count-")); });
  afterEach(async () => { await cleanupTmpDir(parent); });

  it("warns from the second start in a row and resets once a check succeeds", () => {
    const home = join(parent, ".ave");
    expect(recordAveHomeWorkspaceCheck(home, true)).toBeUndefined();
    expect(recordAveHomeWorkspaceCheck(home, true)).toBe(
      'Directory "workspace" could not be checked on 2 consecutive starts — its inherited entries and writers stay unverified until a start can open it');
    expect(recordAveHomeWorkspaceCheck(home, true)).toMatch(/on 3 consecutive starts/);
    expect(recordAveHomeWorkspaceCheck(home, false)).toBeUndefined();
    expect(readAveHomeTrustRecord(home)).toEqual({});
    expect(recordAveHomeWorkspaceCheck(home, true)).toBeUndefined();
  });
});
