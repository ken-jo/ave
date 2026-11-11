import { configureHostResources } from "../../main/host-resources.js";
import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { AVE_HOME_PROTECTED_DIRECTORIES, aveHomeRefusalReason, ensureAveHomePrivate, isAveHomeConfigurationRefused, win32SystemBinary, _resetAveHomePrivacyForTest } from "../ave-home.js";
import { _cleanupRootConfigurationForTest, migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { permissionSettingsPath, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { loadPolicy, savePolicy, userPolicyPath } from "../../permissions/policy-store.js";
import { isPathAllowed } from "../../permissions/allowed-directories.js";
import { buildMandatorySandboxWritePolicy } from "../../permissions/sandbox-write-policy.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath, SENSITIVE_PATH_ENTRIES, SENSITIVE_PATH_PATTERNS } from "../../permissions/sensitive-paths.js";
import { getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths } from "../../permissions/asrt-sandbox.js";
import { hostRuntimeReads } from "../../sandbox/wrap-bundled-command.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

const home = useTempPaths("ave-config-", ".ave");
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), openSync: vi.fn(actual.openSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
afterEach(async () => {
  vi.mocked(execFileSync).mockImplementation((await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFileSync);
  vi.mocked(unlinkSync).mockImplementation((await vi.importActual<typeof import("node:fs")>("node:fs")).unlinkSync);
  vi.mocked(openSync).mockImplementation((await vi.importActual<typeof import("node:fs")>("node:fs")).openSync);
  vi.mocked(fstatSync).mockImplementation((await vi.importActual<typeof import("node:fs")>("node:fs")).fstatSync);
  vi.unstubAllEnvs();
  _resetAveHomePrivacyForTest();
});

function fixture(): string {
  const dir = home();
  setFixtureOwner(dirname(dir));
  expect(ensureAveHomePrivate(dir).enforcement).not.toBe("none");
  return dir;
}

async function candidateMetadata(path: string, mode = 0o600, uid = process.getuid?.() ?? 0): Promise<void> {
  const identity = statSync(path);
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fstatSync).mockImplementation(((descriptor: number) => {
    const opened = actual.fstatSync(descriptor);
    if (opened.dev === identity.dev && opened.ino === identity.ino) {
      opened.mode = (opened.mode & ~0o7777) | mode;
      opened.uid = uid;
    }
    return opened;
  }) as typeof fstatSync);
}

/** The aside copy a commit made of a legacy root file, named in its diagnostic. */
function asideOf(diagnostics: readonly string[], dir: string, name: string): string {
  const prefix = "Legacy configuration preserved at ";
  const found = diagnostics.find((line) => line.startsWith(prefix) && line.slice(prefix.length).startsWith(join(dir, `${name}.post-migration-`)));
  expect(found, `${name} moved aside`).toBeDefined();
  return found!.slice(prefix.length);
}

const DEFAULT_SETTINGS = "{}\n";
const DEFAULT_POLICY = { version: 1, requireExplicitApproval: true, managed: false };
const DEFAULT_SECRETS = { version: 1, entries: {} };

function exposeConfiguration(dir: string): void {
  const config = join(dir, "config");
  if (process.platform === "win32") {
    execFileSync(win32SystemBinary("icacls"), [config, "/grant", "*S-1-1-0:(OI)(CI)R", "/q"], { windowsHide: true, stdio: "pipe" });
  } else chmodSync(config, 0o777);
}

describe("protected home configuration", () => {
  it.each(["settings.json", "policy.json", "ave-secrets.json"])("preserves %s in a new file and deletes the original", name => {
    const dir = fixture();
    const before = vi.mocked(execFileSync).mock.calls.length;
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    if (process.platform === "win32") {
      const requests = vi.mocked(execFileSync).mock.calls.slice(before).filter(([file]) => /powershell\.exe$/i.test(String(file)));
      expect(requests).toHaveLength(1);
      const script = requests[0]?.[2]?.input;
      expect(script).toContain('$result = @([HomeDirectoryDacl]::CommitConfiguration(');
      expect(script).toContain('$result += @([HomeDirectoryDacl]::CleanupConfiguration(');
    }
    const path = join(dir, name);
    writeFileSync(path, "outside edit");
    const original = statSync(path, { bigint: true });
    const aside = asideOf(migrateAveHomeConfiguration(dir), dir, name);
    expect(readFileSync(aside, "utf8")).toBe("outside edit");
    expect(statSync(aside, { bigint: true }).ino).not.toBe(original.ino);
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps a safe copy when deletion is interrupted and retries on the next boot", async () => {
    const dir = home();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.json");
    writeFileSync(path, "outside edit");
    const original = statSync(path, { bigint: true }).ino;
    const unlink = vi.mocked(unlinkSync).getMockImplementation();
    if (!unlink) throw new Error("Expected unlink implementation");
    vi.mocked(unlinkSync).mockImplementation(target => {
      if (String(target).endsWith("/settings.json")) throw new Error("Interrupted source deletion");
      unlink(target);
    });
    expect(_cleanupRootConfigurationForTest(dir).join("\n")).toContain("Interrupted source deletion");
    expect(existsSync(path)).toBe(true);
    const first = readdirSync(dir).find(name => name.startsWith("settings.json.post-migration-"));
    if (!first) throw new Error("Expected preserved copy");
    expect(statSync(join(dir, first), { bigint: true }).ino).not.toBe(original);
    await candidateMetadata(join(dir, first));
    expect(_cleanupRootConfigurationForTest(dir).join("\n")).toContain("Interrupted source deletion");
    expect(readdirSync(dir).filter(name => name.startsWith("settings.json.post-migration-"))).toEqual([first]);
    vi.mocked(unlinkSync).mockImplementation(unlink);
    expect(_cleanupRootConfigurationForTest(dir).join("\n")).toContain("Legacy configuration preserved at");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith("settings.json.post-migration-"))).toEqual([first]);
  });

  it.skipIf(process.platform === "win32").each(["source hardlink", "other hardlink", "symlink", "directory", "vanished", "wrong mode", "special mode", "foreign owner", "proper"])("validates POSIX preserved candidate: %s", async kind => {
    const dir = home();
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "settings.json");
    const previous = join(dir, "settings.json.post-migration-prior");
    const outside = join(dir, "retained");
    writeFileSync(source, "outside edit");
    const original = statSync(source);
    if (kind === "source hardlink") linkSync(source, previous);
    else if (kind === "symlink") symlinkSync(source, previous);
    else if (kind === "directory") mkdirSync(previous);
    else {
      writeFileSync(previous, "outside edit", { mode: 0o600 });
      if (kind === "other hardlink") linkSync(previous, outside);
    }
    if (kind !== "symlink" && kind !== "directory") {
      // Model owner/mode facts separately where the fixture filesystem cannot retain POSIX permissions.
      await candidateMetadata(previous, kind === "wrong mode" ? 0o644 : kind === "special mode" ? 0o4600 : 0o600,
        (process.getuid?.() ?? 0) + (kind === "foreign owner" ? 1 : 0));
    }
    if (kind === "vanished") {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(openSync).mockImplementation((path, flags, mode) => {
        if (String(path).endsWith("settings.json.post-migration-prior")) actual.unlinkSync(previous);
        return actual.openSync(path, flags, mode);
      });
    }
    const aside = asideOf(_cleanupRootConfigurationForTest(dir), dir, "settings.json");
    expect(aside === previous).toBe(kind === "proper");
    const preserved = statSync(aside);
    expect(preserved.ino === original.ino && preserved.dev === original.dev).toBe(false);
    expect(preserved.nlink).toBe(1);
    expect(readFileSync(aside, "utf8")).toBe("outside edit");
    expect(existsSync(source)).toBe(false);
    if (kind === "symlink") expect(lstatSync(previous).isSymbolicLink()).toBe(true);
    if (kind === "other hardlink") expect(readFileSync(outside, "utf8")).toBe("outside edit");
  });

  it.skipIf(process.platform === "win32")("does not reuse a POSIX aside with different bytes", () => {
    const dir = home();
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "settings.json");
    const previous = join(dir, "settings.json.post-migration-prior");
    writeFileSync(source, "outside edit");
    writeFileSync(previous, "different bytes");
    const aside = asideOf(_cleanupRootConfigurationForTest(dir), dir, "settings.json");
    expect(aside).not.toBe(previous);
    expect(readFileSync(aside, "utf8")).toBe("outside edit");
    expect(readFileSync(previous, "utf8")).toBe("different bytes");
    expect(existsSync(source)).toBe(false);
  });

  it.skipIf(process.platform === "win32").each(["settings.json", "policy.json", "ave-secrets.json"])("copies POSIX root %s into a new inode before unlinking", name => {
    const dir = home();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "outside edit");
    const original = statSync(path, { bigint: true }).ino;
    const aside = asideOf(_cleanupRootConfigurationForTest(dir), dir, name);
    expect(statSync(aside, { bigint: true }).ino).not.toBe(original);
    expect(readFileSync(aside, "utf8")).toBe("outside edit");
    expect(existsSync(path)).toBe(false);
  });

  it("commits explicit default documents for a new home", () => {
    const dir = fixture();
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(readFileSync(join(dir, "config", "settings.json"), "utf8")).toBe("{}\n");
    expect(JSON.parse(readFileSync(join(dir, "config", "policy.json"), "utf8"))).toEqual({ version: 1, requireExplicitApproval: true, managed: false });
    expect(JSON.parse(readFileSync(join(dir, "config", "ave-secrets.json"), "utf8"))).toEqual({ version: 1, entries: {} });
  });

  it("reuses an exact default document left by an interrupted new home migration", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", "settings.json"), "{}\n");
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
  });

  it("preserves configuration without a root source instead of replacing it with defaults", () => {
    const dir = fixture();
    const path = join(dir, "config", "settings.json");
    const bytes = '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}';
    writeFileSync(path, bytes);
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain("requires recovery");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
  });

  it("refuses a non-boot configuration under a root with foreign child deletion rights", () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    if (process.platform === "win32") {
      execFileSync(win32SystemBinary("icacls"), [dir, "/grant", "*S-1-1-0:(DC)", "/q"], { windowsHide: true, stdio: "pipe" });
    } else chmodSync(dir, 0o720);
    expect(() => userPolicyPath(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("rechecks root protection before writing user policy", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    writeFileSync(join(dir, "config", "policy.json"), '{"version":1,"requireExplicitApproval":false}');
    vi.stubEnv("AVE_HOME", dir);
    const admin = join(dirname(dir), "absent-admin.json");
    expect((await loadPolicy(undefined, admin)).requireExplicitApproval).toBe(false);
    if (process.platform === "win32") {
      execFileSync(win32SystemBinary("icacls"), [dir, "/grant", "*S-1-1-0:(DC)", "/q"], { windowsHide: true, stdio: "pipe" });
    } else chmodSync(dir, 0o720);
    await expect(savePolicy({ requireExplicitApproval: true }, undefined, admin)).rejects.toMatchObject({ name: "AveHomeConfigurationUntrustedError" });
  });

  it("rechecks configuration protection before writing user policy", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    writeFileSync(join(dir, "config", "policy.json"), '{"version":1,"requireExplicitApproval":true}');
    vi.stubEnv("AVE_HOME", dir);
    const admin = join(dirname(dir), "absent-admin.json");
    expect((await loadPolicy(undefined, admin)).requireExplicitApproval).toBe(true);
    exposeConfiguration(dir);
    await expect(savePolicy({ requireExplicitApproval: true }, undefined, admin)).rejects.toMatchObject({ name: "AveHomeConfigurationUntrustedError" });
  });

  it("rechecks protected boot paths before a subsequent policy write", async () => {
    const dir = fixture();
    migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir));
    vi.stubEnv("AVE_HOME", dir);
    const admin = join(dirname(dir), "absent-admin.json");
    expect((await loadPolicy(undefined, admin)).requireExplicitApproval).toBe(true);
    exposeConfiguration(dir);
    await expect(savePolicy({ requireExplicitApproval: true }, undefined, admin)).rejects.toMatchObject({ name: "AveHomeConfigurationUntrustedError" });
  });

  it("commits defaults for legacy roots without importing their authority, and moves the roots aside", () => {
    const dir = fixture();
    const contents: Record<string, string> = {
      "settings.json": '{"permissions":{"reviewer":{"mode":"llm"}}}',
      "policy.json": '{"version":1,"requireExplicitApproval":false}',
      "ave-secrets.json": '{"key":"plain:secret"}',
    };
    for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(dir, name), bytes);
    const diagnostics = migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir));
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    // R2: root bytes are unverified, so nothing widening is imported; the defaults are committed instead.
    expect(readFileSync(join(dir, "config", "settings.json"), "utf8")).toBe(DEFAULT_SETTINGS);
    expect(JSON.parse(readFileSync(join(dir, "config", "policy.json"), "utf8"))).toEqual(DEFAULT_POLICY);
    expect(JSON.parse(readFileSync(join(dir, "config", "ave-secrets.json"), "utf8"))).toEqual(DEFAULT_SECRETS);
    for (const [name, bytes] of Object.entries(contents)) {
      expect(existsSync(join(dir, name))).toBe(false);
      expect(readFileSync(asideOf(diagnostics, dir, name), "utf8")).toBe(bytes);
    }
    // A home with legacy content starts its trust manifest pending review.
    expect(JSON.parse(readFileSync(join(dir, "config", ".ave-trust-manifest.json"), "utf8"))).toEqual({ version: 1, state: "bootstrapped:false", entries: {} });
    _resetAveHomePrivacyForTest();
    expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir))).toEqual([]);
  });

  it("leaves linked stale root entries and their targets untouched after commit", () => {
    const dir = fixture();
    migrateAveHomeConfiguration(dir);
    const target = join(dirname(dir), "retained-target");
    mkdirSync(target);
    writeFileSync(join(target, "private"), "retained");
    const source = join(dir, "settings.json");
    symlinkSync(target, source, process.platform === "win32" ? "junction" : "dir");
    _resetAveHomePrivacyForTest();
    expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir)).join("\n")).toContain(source);
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "private"), "utf8")).toBe("retained");
  });

  it("resolves the current non boot marker on every lookup", () => {
    const dir = fixture();
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
    migrateAveHomeConfiguration(dir);
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
    unlinkSync(join(dir, "config", ".ave-config-migrated"));
    expect(() => userPolicyPath(dir)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("commits defaults past a settings root its reader rejects and keeps that root aside", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "[]");
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(readFileSync(join(dir, "config", "settings.json"), "utf8")).toBe(DEFAULT_SETTINGS);
    expect(readFileSync(asideOf(diagnostics, dir, "settings.json"), "utf8")).toBe("[]");
  });

  it("never imports legacy secrets, readable or not", () => {
    const dir = fixture();
    writeFileSync(join(dir, "ave-secrets.json"), '{"secret":42}');
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(JSON.parse(readFileSync(join(dir, "config", "ave-secrets.json"), "utf8"))).toEqual(DEFAULT_SECRETS);
    expect(readFileSync(asideOf(diagnostics, dir, "ave-secrets.json"), "utf8")).toBe('{"secret":42}');
  });

  it("carries a root read restriction into the committed defaults", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true, reviewer: { mode: "llm" } } }));
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false, managed: true }));
    migrateAveHomeConfiguration(dir);
    // Restrictions only: strict-OR into the defaults, never the root's widening fields.
    expect(JSON.parse(readFileSync(permissionSettingsPath(dir), "utf8"))).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    expect(JSON.parse(readFileSync(userPolicyPath(dir), "utf8"))).toEqual({ version: 1, requireExplicitApproval: true, managed: true });
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });

  it("requires recovery for a repaired config/ and commits nothing (S3-1)", () => {
    const dir = fixture();
    // A config/ without its marker that holds documents other than the exact defaults was written outside a commit.
    writeFileSync(join(dir, "config", "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false }));
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: true }));
    expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir)).join("\n")).toContain("requires recovery");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(existsSync(join(dir, "config", ".ave-trust-manifest.json"))).toBe(false);
    expect(readFileSync(join(dir, "config", "policy.json"), "utf8")).toBe(JSON.stringify({ version: 1, requireExplicitApproval: false }));
    expect(readFileSync(join(dir, "policy.json"), "utf8")).toBe(JSON.stringify({ version: 1, requireExplicitApproval: true }));
    expect(isAveHomeConfigurationRefused(dir)).toBe(true);
    expect(aveHomeRefusalReason(dir)).toBe("recovery");
  });

  it("commits defaults past a root source that is a reparse point and leaves the link", () => {
    const dir = fixture();
    const target = join(dirname(dir), "linked-settings");
    mkdirSync(target);
    symlinkSync(target, join(dir, "settings.json"), process.platform === "win32" ? "junction" : "dir");
    expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir)).join("\n")).toContain("settings.json");
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
  });

  it("commits defaults past a policy root its reader rejects", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 2, requireExplicitApproval: true }));
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(JSON.parse(readFileSync(userPolicyPath(dir), "utf8"))).toEqual(DEFAULT_POLICY);
    expect(readFileSync(asideOf(diagnostics, dir, "policy.json"), "utf8")).toBe(JSON.stringify({ version: 2, requireExplicitApproval: true }));
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
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(readFileSync(asideOf(diagnostics, dir, "settings.json"), "utf8")).toBe("{}");
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

  it("keeps both owners at the root before migration, and a published copy without a marker requires recovery", () => {
    const dir = fixture();
    writeFileSync(join(dir, "policy.json"), '{"version":1,"requireExplicitApproval":true}');
    writeFileSync(join(dir, "config", "policy.json"), '{"version":1,"requireExplicitApproval":false}');
    vi.stubEnv("AVE_HOME", dir);
    expect(permissionSettingsPath()).toBe(join(dir, "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "policy.json"));
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain("requires recovery");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(existsSync(join(dir, "policy.json"))).toBe(true);
  });

  it("treats zero-byte root placeholders as absent and leaves them in place", () => {
    const dir = fixture();
    const names = ["settings.json", "policy.json", "ave-secrets.json"];
    for (const name of names) writeFileSync(join(dir, name), "");
    expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir))).toEqual([]);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(readFileSync(join(dir, "config", "settings.json"), "utf8")).toBe(DEFAULT_SETTINGS);
    expect(JSON.parse(readFileSync(join(dir, "config", "policy.json"), "utf8"))).toEqual(DEFAULT_POLICY);
    // Placeholders are not legacy content, so the home starts fresh rather than pending review.
    expect(JSON.parse(readFileSync(join(dir, "config", ".ave-trust-manifest.json"), "utf8"))).toEqual({ version: 1, state: "fresh", entries: {} });
    for (const name of names) expect(statSync(join(dir, name)).size).toBe(0);
    expect(readdirSync(dir).filter((name) => name.includes(".post-migration-"))).toEqual([]);
  });

  it("leaves a zero-byte placeholder that appears after commit in place, on every boot", () => {
    const dir = fixture();
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    writeFileSync(join(dir, "policy.json"), "");
    for (let boot = 0; boot < 2; boot += 1) {
      _resetAveHomePrivacyForTest();
      expect(migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir))).toEqual([]);
    }
    expect(statSync(join(dir, "policy.json")).size).toBe(0);
    expect(readdirSync(dir).filter((name) => name.includes(".post-migration-"))).toEqual([]);
  });

  it("still treats a one-byte root file as legacy content and moves it aside", () => {
    const dir = fixture();
    writeFileSync(join(dir, "policy.json"), "\n");
    const diagnostics = migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir));
    expect(readFileSync(asideOf(diagnostics, dir, "policy.json"), "utf8")).toBe("\n");
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "config", ".ave-trust-manifest.json"), "utf8"))).toMatchObject({ state: "bootstrapped:false" });
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
    const denyPaths = buildMandatorySandboxWritePolicy([]).denyWrite.map(entry =>
      caseFoldForMatch((typeof entry === "string" ? entry : entry.path).replace(/\\/g, "/")));
    expect(denyPaths).toContain(caseFoldForMatch(join(dir, "config").replace(/\\/g, "/")));
    for (const name of ["settings.json", "policy.json", "future-control.json"]) {
      expect(isPathAllowed(caseFoldForMatch(join(dir, "config", name).replace(/\\/g, "/")), { directories: denyPaths })).toBe(true);
    }
    expect(getDefaultSensitiveWriteDenyPaths().map((path) => path.replace(/\\/g, "/").replace(/\/$/, "")))
      .toContain(join(dir, "config").replace(/\\/g, "/"));
    // `runtime` is a protected boundary whose venvs sandboxed extensions must still read, and its sensitive row arrives with slice 3's
    // rows. A row in the shared table projects into the read floor as well, which would stop every venv. A write-only projection
    // (as the write floor's `homeWritePersistence` list is) avoids that, but on Windows any deny on `runtime` is kept and stamped onto
    // the boundary's own DACL whenever a narrowed runtime grant intersects it, so it also needs a Windows deny-target exemption.
    expect(AVE_HOME_PROTECTED_DIRECTORIES).toContain("runtime");
    const runtime = join(dir, "runtime");
    expect(lstatSync(runtime).isDirectory()).toBe(true);
    const folded = (path: string) => caseFoldForMatch(path.replace(/\\/g, "/").replace(/\/$/, ""));
    const runtimeKey = folded(runtime);
    expect(getDefaultSensitiveReadDenyPaths().map(folded).filter((path) => path === runtimeKey || path.startsWith(`${runtimeKey}/`))).toEqual([]);
    expect(isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(join(runtime, "uv", "target", "sha", "uv"))), "read")).toBeNull();
    // A sandboxed runtime program is granted the child it needs, never the boundary.
    expect(hostRuntimeReads(join(runtime, "uv", "target", "sha", "uv"))).toEqual([join(runtime, "uv")]);
  });

  it("resolves marker presence after boot while other homes resolve independently", () => {
    const dir = fixture();
    const privacy = ensureAveHomePrivate(dir);
    migrateAveHomeConfiguration(dir, privacy);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    unlinkSync(join(dir, "config", ".ave-config-migrated"));
    vi.stubEnv("AVE_HOME", dir);
    expect(() => permissionSettingsPath()).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
    expect(() => userPolicyPath()).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
    const other = home();
    expect(permissionSettingsPath(other)).toBe(join(other, "settings.json"));
    expect(userPolicyPath(other)).toBe(join(other, "policy.json"));
  });

  it("does not import what the legacy owners saved before the first protected boot", async () => {
    const dir = fixture();
    vi.stubEnv("AVE_HOME", dir);
    await writePermissionSettings({ reviewer: { mode: "llm" } });
    await savePolicy({ requireExplicitApproval: true }, undefined, join(dirname(dir), "absent-admin.json"));
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    expect(existsSync(join(dir, "policy.json"))).toBe(true);
    expect(existsSync(join(dir, "config", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "config", "policy.json"))).toBe(false);
    migrateAveHomeConfiguration(dir);
    expect(readFileSync(permissionSettingsPath(), "utf8")).toBe(DEFAULT_SETTINGS);
    expect(JSON.parse(readFileSync(userPolicyPath(), "utf8"))).toEqual(DEFAULT_POLICY);
  });

  it("moves complete root files aside once and leaves nothing for the next boot", () => {
    const dir = fixture();
    const contents: Record<string, string> = { "settings.json": "{}", "policy.json": '{"version":1}', "ave-secrets.json": '{"key":"plain:secret"}' };
    for (const name of Object.keys(contents)) writeFileSync(join(dir, name), contents[name]);
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(diagnostics).toHaveLength(3);
    for (const name of Object.keys(contents)) {
      expect(existsSync(join(dir, name))).toBe(false);
      expect(readFileSync(asideOf(diagnostics, dir, name), "utf8")).toBe(contents[name]);
    }
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
  });

  it("requires recovery instead of replacing a published file that is not the default", () => {
    const dir = fixture();
    const oldPath = join(dir, "settings.json");
    const newPath = join(dir, "config", "settings.json");
    writeFileSync(oldPath, '{"current":true}');
    writeFileSync(newPath, '{"current":false}');
    expect(migrateAveHomeConfiguration(dir).join("\n")).toContain("requires recovery");
    expect(readFileSync(oldPath, "utf8")).toBe('{"current":true}');
    expect(readFileSync(newPath, "utf8")).toBe('{"current":false}');
  });

  it("recovers a crash after staging without treating a partial stage as live", () => {
    const dir = fixture();
    const destination = join(dir, "config");
    writeFileSync(join(dir, "policy.json"), '{"version":1}');
    writeFileSync(join(destination, ".policy.json.migration-interrupted"), "partial");
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(JSON.parse(readFileSync(join(destination, "policy.json"), "utf8"))).toEqual(DEFAULT_POLICY);
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
    expect(readFileSync(asideOf(diagnostics, dir, "policy.json"), "utf8")).toBe('{"version":1}');
  });

  it("finishes a commit interrupted after it published the defaults", () => {
    const dir = fixture();
    const oldPath = join(dir, "policy.json");
    const newPath = join(dir, "config", "policy.json");
    writeFileSync(oldPath, '{"version":1}');
    // The interrupted commit had already published the exact default, so the retry reuses it.
    writeFileSync(newPath, '{"version":1,"requireExplicitApproval":true,"managed":false}\n');
    const diagnostics = migrateAveHomeConfiguration(dir);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(asideOf(diagnostics, dir, "policy.json"), "utf8")).toBe('{"version":1}');
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
    expect(readFileSync(join(dir, "config", "settings.json"), "utf8")).toBe(DEFAULT_SETTINGS);
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
    expect(JSON.parse(readFileSync(join(dir, "config", "policy.json"), "utf8"))).toEqual(DEFAULT_POLICY);
    expect(readFileSync(target, "utf8")).toBe("outside-policy");
    expect(statSync(target).mode).toBe(mode);
  });
});
