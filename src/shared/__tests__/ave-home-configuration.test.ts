import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { ensureAveHomePrivate, _resetAveHomePrivacyForTest } from "../ave-home.js";
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

describe("protected home configuration", () => {
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
    writeFileSync(join(dir, "policy.json"), "root");
    writeFileSync(join(dir, "config", "policy.json"), "published");
    vi.stubEnv("AVE_HOME", dir);
    expect(permissionSettingsPath()).toBe(join(dir, "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "policy.json"));
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    migrateAveHomeConfiguration(dir);
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
    expect(readFileSync(userPolicyPath(dir), "utf8")).toBe("published");
    expect(readFileSync(join(dir, "policy.json"), "utf8")).toBe("root");
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
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
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
    for (const name of ["settings.json", "policy.json", "ave-secrets.json"]) writeFileSync(join(dir, name), `content:${name}`);
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    for (const name of ["settings.json", "policy.json", "ave-secrets.json"]) {
      expect(readFileSync(join(dir, "config", name), "utf8")).toBe(`content:${name}`);
      expect(existsSync(join(dir, name))).toBe(false);
    }
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
  });

  it("retains both files and diagnoses both paths when the new file exists", () => {
    const dir = fixture();
    const oldPath = join(dir, "settings.json");
    const newPath = join(dir, "config", "settings.json");
    mkdirSync(dirname(newPath), { recursive: true });
    writeFileSync(oldPath, "old");
    writeFileSync(newPath, "new");
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(oldPath);
    expect(diagnostics[0]).toContain(newPath);
    expect(readFileSync(oldPath, "utf8")).toBe("old");
    expect(readFileSync(newPath, "utf8")).toBe("new");
  });

  it("recovers a crash after staging without treating a partial stage as live", () => {
    const dir = fixture();
    const destination = join(dir, "config");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(dir, "policy.json"), "complete");
    writeFileSync(join(destination, ".policy.json.migration-interrupted"), "partial");
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(readFileSync(join(destination, "policy.json"), "utf8")).toBe("complete");
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
  });

  it("recovers a crash after publication and before deleting the root file", () => {
    const dir = fixture();
    const oldPath = join(dir, "policy.json");
    const newPath = join(dir, "config", "policy.json");
    mkdirSync(dirname(newPath), { recursive: true });
    writeFileSync(oldPath, "complete");
    copyFileSync(oldPath, `${newPath}.stage`);
    renameSync(`${newPath}.stage`, newPath);
    expect(migrateAveHomeConfiguration(dir)).toHaveLength(1);
    expect(readFileSync(oldPath, "utf8")).toBe("complete");
    expect(readFileSync(newPath, "utf8")).toBe("complete");
    expect(statSync(newPath).ino).not.toBe(statSync(oldPath).ino);
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
    writeFileSync(join(dir, "settings.json"), "private", { mode: 0o644 });
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
