import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { ensureAveHomePrivate, win32SystemBinary, _resetAveHomePrivacyForTest } from "../ave-home.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { permissionSettingsPath, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { savePolicy, userPolicyPath } from "../../permissions/policy-store.js";
import { buildMandatorySandboxWritePolicy } from "../../permissions/sandbox-write-policy.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath, SENSITIVE_PATH_ENTRIES, SENSITIVE_PATH_PATTERNS } from "../../permissions/sensitive-paths.js";
import { getDefaultSensitiveWriteDenyPaths } from "../../permissions/asrt-sandbox.js";

const home = useTempPaths("ave-config-", ".ave");
afterEach(() => { vi.unstubAllEnvs(); _resetAveHomePrivacyForTest(); });

function fixture(): string {
  const dir = home();
  setFixtureOwner(dirname(dir));
  expect(ensureAveHomePrivate(dir).enforcement).not.toBe("none");
  return dir;
}

function exposeConfiguration(dir: string): void {
  const config = join(dir, "config");
  if (process.platform === "win32") {
    execFileSync(win32SystemBinary("icacls"), [config, "/grant", "*S-1-1-0:(OI)(CI)R", "/q"], { windowsHide: true, stdio: "pipe" });
  } else chmodSync(config, 0o777);
}

describe("protected home configuration", () => {
  it("caches non-boot decisions until migration invalidates them", () => {
    const dir = fixture();
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    migrateAveHomeConfiguration(dir);
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
    unlinkSync(join(dir, "config", ".ave-config-migrated"));
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
  });

  it("does not commit a settings document rejected by its reader", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "[]");
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain("settings.json");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("[]");
  });

  it("does not commit legacy secrets rejected by their reader", () => {
    const dir = fixture();
    writeFileSync(join(dir, "ave-secrets.json"), '{"secret":42}');
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain("ave-secrets.json");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(readFileSync(join(dir, "ave-secrets.json"), "utf8")).toBe('{"secret":42}');
  });

  it("preserves the root read restriction over a stale published copy on retry", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", "settings.json"), JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: false } }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } }));
    migrateAveHomeConfiguration(dir);
    expect(JSON.parse(readFileSync(permissionSettingsPath(dir), "utf8")).permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });

  it("preserves explicit approval from root over a stale policy copy on retry", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false }));
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: true }));
    migrateAveHomeConfiguration(dir);
    expect(JSON.parse(readFileSync(userPolicyPath(dir), "utf8")).requireExplicitApproval).toBe(true);
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
  });

  it("keeps root authoritative when a source is a reparse point", () => {
    const dir = fixture();
    const target = join(dirname(dir), "linked-settings");
    mkdirSync(target);
    symlinkSync(target, join(dir, "settings.json"), process.platform === "win32" ? "junction" : "dir");
    expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir)).join("\n")).toContain("settings.json");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
  });

  it("keeps all roots when a policy source fails reader validation", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 2, requireExplicitApproval: true }));
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain("policy.json");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
  });

  it("rejects an empty marker outside boot with a named trust error", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "");
    expect(() => permissionSettingsPath(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("rejects a valid marker in an unprotected configuration directory", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    exposeConfiguration(dir);
    expect(() => userPolicyPath(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("recovers an empty marker inside a protected configuration directory", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "");
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });

  it("refuses to recover an empty marker in an unprotected directory", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "");
    exposeConfiguration(dir);
    expect(() => migrateAveHomeConfiguration(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("");
  });
  it("routes both path owners through the protected directory after migration", () => {
    const dir = fixture();
    migrateAveHomeConfiguration(dir);
    vi.stubEnv("AVE_HOME", dir);
    expect(permissionSettingsPath()).toBe(join(dir, "config", "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "config", "policy.json"));
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
  });

  it("keeps both owners at the root before migration even with published copies", () => {
    const dir = fixture();
    writeFileSync(join(dir, "policy.json"), '{"version":1,"requireExplicitApproval":true}');
    writeFileSync(join(dir, "config", "policy.json"), '{"version":1,"requireExplicitApproval":false}');
    vi.stubEnv("AVE_HOME", dir);
    expect(permissionSettingsPath()).toBe(join(dir, "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "policy.json"));
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    migrateAveHomeConfiguration(dir);
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
    expect(JSON.parse(readFileSync(userPolicyPath(dir), "utf8")).requireExplicitApproval).toBe(true);
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
  });

  it("writes a migration marker for a fresh home with no root files", () => {
    const dir = fixture();
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
  });

  it("does not follow a marker junction outside boot", () => {
    const dir = fixture();
    const target = join(dirname(dir), "marker-target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "config", ".ave-config-migrated"), process.platform === "win32" ? "junction" : "dir");
    expect(() => permissionSettingsPath(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
    expect(() => userPolicyPath(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("projects the protected directory into host and sandbox denies", () => {
    const dir = join(home(), "profile");
    mkdirSync(dirname(dir), { recursive: true });
    setFixtureOwner(dirname(dir));
    expect(ensureAveHomePrivate(dir).enforcement).not.toBe("none");
    migrateAveHomeConfiguration(dir);
    vi.stubEnv("AVE_HOME", dir);
    expect(SENSITIVE_PATH_ENTRIES).toContainEqual({ anchor: "ave-home", segments: ["config"], kind: "dir", why: "permission settings, user policy, and legacy secrets" });
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ave/config/**");
    expect(isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(join(dir, "config", "settings.json"))), "read")).toBe("ave-home:config");
    expect(isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(join(dir, "config", "policy.json"))), "write")).toBe("ave-home:config");
    expect(buildMandatorySandboxWritePolicy([]).denyWrite).toContain(join(dir, "config", "settings.json"));
    expect(buildMandatorySandboxWritePolicy([]).denyWrite).toContain(join(dir, "config", "policy.json"));
    expect(getDefaultSensitiveWriteDenyPaths().map((path) => path.replace(/\\/g, "/").replace(/\/$/, "")))
      .toContain(join(dir, "config").replace(/\\/g, "/"));
  });

  it("pins the boot decision while explicit other homes use their own marker", () => {
    const dir = fixture();
    const privacy = ensureAveHomePrivate(dir);
    migrateAveHomeConfiguration(dir, privacy);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    unlinkSync(join(dir, "config", ".ave-config-migrated"));
    vi.stubEnv("AVE_HOME", dir);
    expect(permissionSettingsPath()).toBe(join(dir, "config", "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "config", "policy.json"));
    const other = home();
    expect(permissionSettingsPath(other)).toBe(join(other, "settings.json"));
    expect(userPolicyPath(other)).toBe(join(other, "policy.json"));
  });

  it("saves through both legacy owners for the next protected boot", async () => {
    const dir = fixture();
    vi.stubEnv("AVE_HOME", dir);
    await writePermissionSettings({ reviewer: { mode: "strict" } });
    await savePolicy({ requireExplicitApproval: true }, undefined, join(dirname(dir), "absent-admin.json"));
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    expect(existsSync(join(dir, "policy.json"))).toBe(true);
    expect(existsSync(join(dir, "config", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "config", "policy.json"))).toBe(false);
    migrateAveHomeConfiguration(dir);
    expect(JSON.parse(readFileSync(permissionSettingsPath(), "utf8")).permissions.reviewer.mode).toBe("strict");
    expect(JSON.parse(readFileSync(userPolicyPath(), "utf8")).requireExplicitApproval).toBe(true);
  });

  it("copies complete files into the boundary and deletes their root names once", () => {
    const dir = fixture();
    const contents: Record<string, string> = { "settings.json": "{}", "policy.json": '{"version":1}', "ave-secrets.json": '{"key":"plain:secret"}' };
    for (const name of Object.keys(contents)) writeFileSync(join(dir, name), contents[name]);
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    for (const name of ["settings.json", "policy.json", "ave-secrets.json"]) {
      expect(readFileSync(join(dir, "config", name), "utf8")).toBe(contents[name]);
      expect(existsSync(join(dir, name))).toBe(false);
    }
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
  });

  it("replaces a published file with the authoritative root before commit", () => {
    const dir = fixture();
    const oldPath = join(dir, "settings.json");
    const newPath = join(dir, "config", "settings.json");
    mkdirSync(dirname(newPath), { recursive: true });
    writeFileSync(oldPath, '{"current":true}');
    writeFileSync(newPath, '{"current":false}');
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(diagnostics).toEqual([]);
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(newPath, "utf8")).toBe('{"current":true}');
  });

  it("recovers a crash after staging without treating a partial stage as live", () => {
    const dir = fixture();
    const destination = join(dir, "config");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(dir, "policy.json"), '{"version":1}');
    writeFileSync(join(destination, ".policy.json.migration-interrupted"), "partial");
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(readFileSync(join(destination, "policy.json"), "utf8")).toBe('{"version":1}');
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
  });

  it("recovers a crash after publication and before deleting the root file", () => {
    const dir = fixture();
    const oldPath = join(dir, "policy.json");
    const newPath = join(dir, "config", "policy.json");
    mkdirSync(dirname(newPath), { recursive: true });
    writeFileSync(oldPath, '{"version":1}');
    copyFileSync(oldPath, `${newPath}.stage`);
    renameSync(`${newPath}.stage`, newPath);
    const rootIdentity = statSync(oldPath).ino;
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(newPath, "utf8")).toBe('{"version":1}');
    expect(statSync(newPath).ino).not.toBe(rootIdentity);
  });

  it("skips a root link without reading or deleting its target", () => {
    const dir = fixture();
    const target = join(dirname(dir), "outside");
    mkdirSync(target);
    writeFileSync(join(target, "private"), "untouched");
    const oldPath = join(dir, "settings.json");
    symlinkSync(target, oldPath, process.platform === "win32" ? "junction" : "dir");
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain(oldPath);
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "config", "settings.json"))).toBe(false);
    expect(readFileSync(join(target, "private"), "utf8")).toBe("untouched");
  });

  it.runIf(process.platform !== "win32")("preserves private directory and file modes after migration", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), '{"private":true}', { mode: 0o644 });
    migrateAveHomeConfiguration(dir);
    expect(statSync(join(dir, "config")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "config", "settings.json")).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("skips a file symlink and preserves the target bytes and mode", () => {
    const dir = fixture();
    const target = join(dirname(dir), "outside-policy.json");
    writeFileSync(target, "outside-policy", { mode: 0o644 });
    const mode = statSync(target).mode;
    const source = join(dir, "policy.json");
    symlinkSync(target, source);
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain(source);
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "config", "policy.json"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("outside-policy");
    expect(statSync(target).mode).toBe(mode);
  });
});
