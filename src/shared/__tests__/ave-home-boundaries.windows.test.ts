import { configureHostResources } from "../../main/host-resources.js";
import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { ensureAveHomePrivate, readWindowsDirectoryDacls, win32SystemBinary, setAveHomePrivacyAtBoot, assertAveHomePrivacyForConfinement, _resetAveHomePrivacyForTest } from "../ave-home.js";
import { createBootHostFixture, createDesktopHostFixture } from "../../__tests__/support/host-runtime.js";
import { NotificationService } from "../../main/notification-service.js";
import { notifyHomeBoundaryRepairs } from "../../boot/steps/home-privacy-notice.js";
import { windowsPowerShellEnv } from "../windows-powershell-env.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { permissionSettingsPath, readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { loadPolicy, userPolicyPath } from "../../permissions/policy-store.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "../windows-home-boundary.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

describe.runIf(process.platform === "win32")("protected home boundaries", () => {
  afterEach(() => { _resetAveHomePrivacyForTest(); vi.unstubAllEnvs(); });
  const home = useTempPaths("ave-boundaries-", ".ave");
  it("migrates a valid source above the descriptor content snapshot limit", () => {
    const dir = fixture();
    const bytes = JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) });
    writeFileSync(join(dir, "settings.json"), bytes);
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(readFileSync(join(dir, "config", "settings.json"), "utf8")).toBe(bytes);
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(true);
  });
  function fixture(): string {
    const dir = home();
    setFixtureOwner(dirname(dir));
    const privacy = ensureAveHomePrivate(dir);
    expect(privacy, JSON.stringify(privacy)).toMatchObject({ enforcement: "win32-dacl" });
    return dir;
  }
  function command(script: string, path: string): string {
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env, AVE_TEST_TARGET: path }) }).trim();
  }
  function grant(path: string, rights: string): void {
    execFileSync(win32SystemBinary("icacls"), [path, "/grant", `*S-1-1-0:${rights}`, "/q"], { windowsHide: true, stdio: "pipe" });
  }
  function expectBoundary(path: string): void {
    const [entry] = readWindowsDirectoryDacls([path]);
    expect(entry).toMatchObject({ ownerSid: entry.currentUserSid, protected: true, rules: [{
      sid: entry.currentUserSid, accessControlType: 0, fileSystemRights: 2032127,
      inheritanceFlags: 3, propagationFlags: 0, isInherited: false,
    }] });
  }
  function damage(path: string): void { grant(path, "(OI)(CI)R"); }
  function native(script: string, path: string, source = WINDOWS_HOME_BOUNDARY_SOURCE): string {
    const input = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'\n${source}\n'@\n$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ${script}`;
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64")],
      { input, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env, AVE_TEST_TARGET: path }) }).trim();
  }

  it("creates all five boundaries with the exact owner-only descriptor", () => {
    const dir = fixture();
    expectBoundary(dir);
    expectBoundary(join(dir, "secrets"));
    expectBoundary(join(dir, "subscription-runtimes"));
    expectBoundary(join(dir, "keys"));
    expectBoundary(join(dir, "certs"));
    expectBoundary(join(dir, "config"));
  });
  it("keeps root policy and deny rules active during a refused boot without migrating", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 1, managed: true, requireExplicitApproval: true }));
    writeFileSync(join(dir, "permissions.json"), JSON.stringify({ version: 1, mode: "allow", rules: [{ pattern: "web_fetch", action: "deny" }], updatedAt: new Date().toISOString() }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { reviewer: { mode: "strict" } } }));
    grant(dir, "W");
    const privacy = ensureAveHomePrivate(dir);
    expect(privacy.enforcement).toBe("none");
    vi.stubEnv("AVE_HOME", dir);
    setAveHomePrivacyAtBoot(privacy);
    expect(migrateAveHomeConfiguration(dir, privacy)).toEqual([]);
    expect(() => assertAveHomePrivacyForConfinement()).toThrow();
    expect(permissionSettingsPath()).toBe(join(dir, "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "policy.json"));
    expect(await loadPolicy(undefined, join(dirname(dir), "absent-admin.json"))).toMatchObject({ source: "user", managed: true, requireExplicitApproval: true });
    expect(readPermissionSettings().permissions.reviewer.mode).toBe("strict");
    const manager = new PermissionManager();
    await manager.loadRulesFromFile();
    expect(manager.checkDetailed("web_fetch", "builtin", "read")).toMatchObject({ decision: "deny", layer: 1 });
    expect(existsSync(join(dir, "config", "policy.json"))).toBe(false);
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(existsSync(join(dir, "policy.json"))).toBe(true);
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    expect(permissionSettingsPath()).toBe(join(dir, "settings.json"));
    expect(userPolicyPath()).toBe(join(dir, "policy.json"));
    expect(permissionSettingsPath(dir.toUpperCase())).toBe(join(dir.toUpperCase(), "settings.json"));
    expect(userPolicyPath(dir.toUpperCase())).toBe(join(dir.toUpperCase(), "policy.json"));
  });
  it("recovers an invalid marker only inside the protected configuration boundary", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "invalid");
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
  });
  it("discards a migration marker copied from an unprotected configuration boundary", () => {
    const dir = fixture();
    const config = join(dir, "config");
    writeFileSync(join(config, ".ave-config-migrated"), "ave-home-boundary-v1");
    damage(config);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [config] });
    expect(existsSync(join(config, ".ave-config-migrated"))).toBe(false);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
  });
  it("keeps every root file until the migration marker commits published copies", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "policy.json"), '{"version":1}');
    const source = WINDOWS_HOME_BOUNDARY_SOURCE.replace("Rename(copy, destination, name, true);",
      'Rename(copy, destination, name, true); if (name == "policy.json") throw new InvalidOperationException("migration interrupted");');
    const settingsHash = createHash("sha256").update("{}").digest("base64");
    const policyHash = createHash("sha256").update('{"version":1}').digest("base64");
    expect(native(`try { [HomeDirectoryDacl]::MigrateConfiguration($env:AVE_TEST_TARGET,'config',@('settings.json','policy.json'),$u,$false,@('${settingsHash}','${policyHash}')) } catch { 'interrupted' }`, dir, source)).toBe("interrupted");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(dir, "policy.json"), "utf8")).toBe('{"version":1}');
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "policy.json"));
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
    expect(userPolicyPath(dir)).toBe(join(dir, "config", "policy.json"));
    expect(readFileSync(join(dir, "config", ".ave-config-migrated"), "utf8")).toBe("ave-home-boundary-v1");
  });
  it("keeps the final marker absent when interrupted after flushing its stage", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    const hash = createHash("sha256").update("{}").digest("base64");
    const source = WINDOWS_HOME_BOUNDARY_SOURCE.replace("Rename(marker, directory, name);",
      'if (name == ConfigurationMarker) throw new InvalidOperationException("marker interrupted"); Rename(marker, directory, name);');
    expect(native(`try { [HomeDirectoryDacl]::MigrateConfiguration($env:AVE_TEST_TARGET,'config',@('settings.json'),$u,$false,@('${hash}')) } catch { 'interrupted' }`, dir, source)).toBe("interrupted");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{}");
    expect(readdirSync(join(dir, "config")).filter((name) => name.startsWith("..ave-config-migrated.migration-"))).toHaveLength(1);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
  });

  it("refuses an unreadable root source without committing or deleting it", () => {
    const dir = fixture();
    const source = join(dir, "settings.json");
    writeFileSync(source, "{}");
    execFileSync(win32SystemBinary("icacls"), [source, "/deny", "*S-1-1-0:R", "/q"], { windowsHide: true, stdio: "pipe" });
    try {
      expect(migrateAveHomeConfiguration(dir).join("\n")).toContain(source);
      expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
      expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
    } finally {
      execFileSync(win32SystemBinary("icacls"), [source, "/remove:d", "*S-1-1-0", "/q"], { windowsHide: true, stdio: "pipe" });
    }
    expect(readFileSync(source, "utf8")).toBe("{}");
  });
  it("rejects root bytes changed after reader validation before publishing a marker", () => {
    const dir = fixture();
    const hash = createHash("sha256").update("{}").digest("base64");
    const contents = '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}';
    writeFileSync(join(dir, "settings.json"), contents);
    const diagnostics = native(`[HomeDirectoryDacl]::MigrateConfiguration($env:AVE_TEST_TARGET,'config',@('settings.json'),$u,$false,@('${hash}'))`, dir);
    expect(diagnostics).toContain("changed after validation");
    expect(diagnostics).toContain("settings.json");
    expect(existsSync(join(dir, "config", ".ave-config-migrated"))).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(contents);
    expect(permissionSettingsPath(dir)).toBe(join(dir, "settings.json"));
  });
  it("migrates root configuration into fresh files without foreign read grants", () => {
    const dir = fixture();
    grant(dir, "(OI)(CI)RX");
    const source = join(dir, "settings.json");
    writeFileSync(source, '{"private":true}');
    grant(source, "R");
    const oldIdentity = statSync(source).ino;
    const before = command("(Get-Acl -LiteralPath $env:AVE_TEST_TARGET).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }", source);
    expect(before).toContain("S-1-1-0");
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    const target = join(dir, "config", "settings.json");
    expect(readFileSync(target, "utf8")).toBe('{"private":true}');
    expect(existsSync(source)).toBe(false);
    expect(statSync(target).ino).not.toBe(oldIdentity);
    const copy = JSON.parse(command("$a=Get-Acl -LiteralPath $env:AVE_TEST_TARGET; @($a.Access | ForEach-Object { @{ sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; inherited=$_.IsInherited; rights=[int]$_.FileSystemRights } }) | ConvertTo-Json -Compress", target));
    expect(copy).toMatchObject({ inherited: true, rights: 2032127 });
    expect(copy.sid).toBe(readWindowsDirectoryDacls([join(dir, "config")])[0].currentUserSid);
  });
  it("verifies a conforming directory without rewriting its descriptor or inspecting its files", () => {
    const dir = fixture();
    const secrets = join(dir, "secrets");
    const file = join(secrets, "token");
    writeFileSync(file, "private"); setFixtureOwner(file);
    grant(file, "R");
    const before = readWindowsDirectoryDacls([secrets]);
    const identity = statSync(secrets).ino;
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    expect(readWindowsDirectoryDacls([secrets])).toEqual(before);
    expect(statSync(secrets).ino).toBe(identity);
    expect(readdirSync(dir).some((name) => name.includes(".unprotected-"))).toBe(false);
  });
  it("repairs the configuration boundary before legacy files are migrated", () => {
    const dir = fixture();
    const boundary = join(dir, "config");
    damage(boundary);
    writeFileSync(join(dir, "policy.json"), '{"version":1,"requireExplicitApproval":true}');
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expect(migrateAveHomeConfiguration(dir)).toEqual([]);
    expectBoundary(boundary);
    expect(readFileSync(join(boundary, "policy.json"), "utf8")).toBe('{"version":1,"requireExplicitApproval":true}');
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
  });
  it("repairs a foreign boundary ACE through replacement and preserves protected copies", () => {
    const dir = fixture();
    const boundary = join(dir, "subscription-runtimes");
    const nested = join(boundary, "runtime");
    mkdirSync(nested); setFixtureOwner(nested);
    const file = join(nested, "credentials");
    writeFileSync(file, "retained"); setFixtureOwner(file);
    const oldFile = statSync(file).ino;
    damage(boundary);
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expect(readFileSync(file, "utf8")).toBe("retained");
    expect(statSync(file).ino).not.toBe(oldFile);
    expectBoundary(boundary);
    const copy = command("(Get-Acl -LiteralPath $env:AVE_TEST_TARGET).Access | ConvertTo-Json -Compress", file);
    expect(JSON.parse(copy)).toMatchObject({ IsInherited: true, FileSystemRights: 2032127 });
    expect(existsSync(`${boundary}.unprotected-recovery`)).toBe(false);
    expect(existsSync(`${boundary}.unprotected-complete`)).toBe(false);
  });
  it("repairs an unprotected DACL while retaining its content", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets");
    const file = join(boundary, "key");
    writeFileSync(file, "key-material"); setFixtureOwner(file);
    execFileSync(win32SystemBinary("icacls"), [boundary, "/inheritance:e", "/q"], { windowsHide: true, stdio: "pipe" });
    expect(readWindowsDirectoryDacls([boundary])[0].protected).toBe(false);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expectBoundary(boundary);
    expect(readFileSync(file, "utf8")).toBe("key-material");
  });
  it("copies read-only files and removes the damaged boundary aside", () => {
    const dir = fixture();
    const boundary = join(dir, "subscription-runtimes");
    const nested = join(boundary, "runtime");
    mkdirSync(nested); setFixtureOwner(nested);
    const file = join(boundary, "bundle");
    const nestedFile = join(nested, "object");
    writeFileSync(file, "bundle-bytes"); setFixtureOwner(file);
    writeFileSync(nestedFile, "object-bytes"); setFixtureOwner(nestedFile);
    command("[System.IO.File]::SetAttributes($env:AVE_TEST_TARGET, [System.IO.FileAttributes]::ReadOnly)", file);
    command("[System.IO.File]::SetAttributes($env:AVE_TEST_TARGET, [System.IO.FileAttributes]::ReadOnly)", nestedFile);
    expect(command("[int][System.IO.File]::GetAttributes($env:AVE_TEST_TARGET) -band 1", file)).toBe("1");
    expect(command("[int][System.IO.File]::GetAttributes($env:AVE_TEST_TARGET) -band 1", nestedFile)).toBe("1");
    damage(boundary);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expect(readFileSync(file, "utf8")).toBe("bundle-bytes");
    expect(readFileSync(nestedFile, "utf8")).toBe("object-bytes");
    expect(command("[int][System.IO.File]::GetAttributes($env:AVE_TEST_TARGET) -band 1", file)).toBe("0");
    expect(command("[int][System.IO.File]::GetAttributes($env:AVE_TEST_TARGET) -band 1", nestedFile)).toBe("0");
    expectBoundary(boundary);
    expect(existsSync(`${boundary}.unprotected-recovery`)).toBe(false);
    expect(existsSync(`${boundary}.unprotected-complete`)).toBe(false);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ repairs: [boundary] });
  });
  it("skips a junction during copying and deletes only the junction during aside cleanup", () => {
    const dir = fixture();
    const target = join(dirname(dir), "target");
    mkdirSync(target); setFixtureOwner(target);
    const targetFile = join(target, "outside");
    writeFileSync(targetFile, "untouched"); setFixtureOwner(targetFile);
    const before = readWindowsDirectoryDacls([target]);
    const boundary = join(dir, "secrets");
    symlinkSync(target, join(boundary, "junction"), "junction");
    setFixtureOwner(join(boundary, "junction"));
    damage(boundary);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary],
      diagnostics: [expect.stringContaining("skipped 1 link")] });
    expect(existsSync(join(boundary, "junction"))).toBe(false);
    expect(existsSync(`${boundary}.unprotected-complete`)).toBe(false);
    expect(readFileSync(targetFile, "utf8")).toBe("untouched");
    expect(readWindowsDirectoryDacls([target])).toEqual(before);
  });
  it("recovers an aside without a live directory before repairing again", () => {
    const dir = fixture();
    const boundary = join(dir, "subscription-runtimes");
    const file = join(boundary, "bundle");
    writeFileSync(file, "certificate"); setFixtureOwner(file);
    damage(boundary);
    renameSync(boundary, `${boundary}.unprotected-recovery`);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expectBoundary(boundary);
    expect(readFileSync(file, "utf8")).toBe("certificate");
    expect(existsSync(`${boundary}.unprotected-recovery`)).toBe(false);
  });
  it("resumes an interrupted copy instead of discarding the authoritative aside", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets");
    const aside = `${boundary}.unprotected-recovery`;
    mkdirSync(aside); setFixtureOwner(aside);
    const source = join(aside, "key");
    writeFileSync(source, "complete"); setFixtureOwner(source);
    writeFileSync(join(boundary, "key"), "partial"); setFixtureOwner(join(boundary, "key"));
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expect(readFileSync(join(boundary, "key"), "utf8")).toBe("complete");
    expect(existsSync(aside)).toBe(false);
  });
  it("never overwrites an outside hardlink in an unmarked interrupted copy", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets");
    const aside = `${boundary}.unprotected-recovery`;
    mkdirSync(aside); setFixtureOwner(aside);
    writeFileSync(join(aside, "key"), "authoritative"); setFixtureOwner(join(aside, "key"));
    const outside = join(dirname(dir), "outside-key");
    writeFileSync(outside, "outside"); setFixtureOwner(outside);
    linkSync(outside, join(boundary, "key"));
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(join(boundary, "key"), "utf8")).toBe("authoritative");
    expect(statSync(join(boundary, "key")).ino).not.toBe(statSync(outside).ino);
    expect(readdirSync(dir).some((name) => name.startsWith("secrets.unprotected-abandoned-"))).toBe(true);
  });
  it("creates the repair marker before copying and restarts a marked partial copy exclusively", () => {
    const dir = fixture(); const boundary = join(dir, "secrets");
    writeFileSync(join(boundary, "key"), "authoritative"); setFixtureOwner(join(boundary, "key"));
    damage(boundary);
    const source = WINDOWS_HOME_BOUNDARY_SOURCE.replace("input.CopyTo(output);",
      'if (input.CanRead) throw new InvalidOperationException("copy interrupted"); input.CopyTo(output);');
    expect(native("$h=[HomeDirectoryDacl]::OpenHome($env:AVE_TEST_TARGET,$u,$false); try { try { [HomeDirectoryDacl]::Repair($h,'secrets',$u,$false) } catch { 'interrupted' } } finally { $h.Dispose() }", dir,
      source)).toContain("interrupted");
    expect(readFileSync(join(boundary, ".ave-repair-created"), "utf8")).toBe("ave-home-boundary-v1");
    const outside = join(dirname(dir), "marked-outside");
    writeFileSync(outside, "untouched"); setFixtureOwner(outside);
    linkSync(outside, join(boundary, "planted"));
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(readFileSync(join(boundary, "key"), "utf8")).toBe("authoritative");
    expect(existsSync(join(boundary, "planted"))).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("secrets.unprotected-abandoned-"))).toBe(false);
  });
  it("preserves shared read-only attributes when extended deletion is unavailable", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets");
    const outside = join(dirname(dir), "outside-readonly");
    writeFileSync(outside, "outside"); setFixtureOwner(outside);
    linkSync(outside, join(boundary, "key"));
    command("[System.IO.File]::SetAttributes($env:AVE_TEST_TARGET, [System.IO.FileAttributes]::ReadOnly)", outside);
    damage(boundary);
    const source = WINDOWS_HOME_BOUNDARY_SOURCE.replace("int status = NtSetInformationFile(handle, out io, memory, 4, 64);",
      "io = new IoStatus(); int status = unchecked((int)0xC0000003); GC.KeepAlive(io);");
    const result = native("$h=[HomeDirectoryDacl]::OpenHome($env:AVE_TEST_TARGET,$u,$false); try { [HomeDirectoryDacl]::Repair($h,'secrets',$u,$false) } finally { $h.Dispose() }", dir, source);
    expect(result).toBe("0");
    expect(command("[int][System.IO.File]::GetAttributes($env:AVE_TEST_TARGET) -band 1", outside)).toBe("1");
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(join(boundary, "key"), "utf8")).toBe("outside");
    expect(existsSync(`${boundary}.unprotected-complete`)).toBe(true);
    const warning = native("$h=[HomeDirectoryDacl]::OpenHome($env:AVE_TEST_TARGET,$u,$false); try { [HomeDirectoryDacl]::Repair($h,'secrets',$u,$false,$env:AVE_TEST_TARGET) | Out-Null; [HomeDirectoryDacl]::CleanupWarnings.ToArray() } finally { $h.Dispose() }", dir, source);
    expect(warning).toContain(`${boundary}.unprotected-complete`);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
  });
  it("refuses an existing copy destination without writing through its hardlink", () => {
    const dir = fixture();
    const outside = join(dirname(dir), "copy-collision");
    writeFileSync(outside, "untouched"); setFixtureOwner(outside);
    const source = join(dir, "keys"); const destination = join(dir, "certs");
    writeFileSync(join(source, "key"), "new"); setFixtureOwner(join(source, "key"));
    linkSync(outside, join(destination, "key"));
    const result = native("$h=[HomeDirectoryDacl]::OpenHome($env:AVE_TEST_TARGET,$u,$false); $s=[HomeDirectoryDacl]::OpenRelative($h,'keys',$u,1,$true,$true,$true); $d=[HomeDirectoryDacl]::OpenRelative($h,'certs',$u,1,$true,$true,$true); try { try { [HomeDirectoryDacl].GetMethod('Copy',[System.Reflection.BindingFlags]'NonPublic,Static').Invoke($null,@($s,$d,$u)) | Out-Null; 'copied' } catch { 'refused' } } finally { $d.Dispose(); $s.Dispose(); $h.Dispose() }", dir);
    expect(result).toBe("refused");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });
  it("refuses a pre-existing staged migration hardlink without changing either source", () => {
    const dir = fixture();
    const outside = join(dirname(dir), "stage-collision");
    writeFileSync(outside, "untouched"); setFixtureOwner(outside);
    writeFileSync(join(dir, "settings.json"), "{}"); setFixtureOwner(join(dir, "settings.json"));
    const id = "11111111111111111111111111111111";
    linkSync(outside, join(dir, "config", `.settings.json.migration-${id}`));
    const source = WINDOWS_HOME_BOUNDARY_SOURCE.replace('Guid.NewGuid().ToString("N")', `"${id}"`);
    const hash = createHash("sha256").update("{}").digest("base64");
    expect(native(`try { [HomeDirectoryDacl]::MigrateConfiguration($env:AVE_TEST_TARGET,'config',@('settings.json'),$u,$false,@('${hash}')); 'copied' } catch { 'refused' }`, dir, source)).toBe("refused");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{}");
    expect(existsSync(join(dir, "config", "settings.json"))).toBe(false);
  });
  it("keeps a notice pending when desktop delivery fails or is not ready", () => {
    const dir = fixture(); const boundary = join(dir, "secrets"); damage(boundary);
    const privacy = ensureAveHomePrivate(dir);
    const pending = join(boundary, ".ave-repair-notice-pending");
    const host = createBootHostFixture({ desktop: createDesktopHostFixture() });
    const unavailable = new NotificationService({ getMainWindow: () => null, isReady: () => false, isTestEnv: () => false });
    notifyHomeBoundaryRepairs(privacy, { host, notificationService: unavailable });
    expect(existsSync(pending)).toBe(true);
    const broken = new NotificationService({ getMainWindow: () => null, isReady: () => true, isTestEnv: () => false,
      notificationFactory: () => { throw new Error("delivery unavailable"); } });
    notifyHomeBoundaryRepairs(privacy, { host, notificationService: broken });
    expect(existsSync(pending)).toBe(true);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ repairs: [boundary] });
  });
  it("replays a notice after cleanup and clears it only after desktop acceptance", () => {
    const dir = fixture(); const boundary = join(dir, "secrets"); damage(boundary);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ repairs: [boundary] });
    expect(existsSync(`${boundary}.unprotected-complete`)).toBe(false);
    const pending = join(boundary, ".ave-repair-notice-pending");
    expect(existsSync(pending)).toBe(true);
    const show = vi.fn();
    const notificationService = new NotificationService({ getMainWindow: () => null, isReady: () => true,
      isTestEnv: () => false, notificationFactory: () => ({ show, on: vi.fn() }) });
    const next = ensureAveHomePrivate(dir);
    expect(next).toMatchObject({ repairs: [boundary] });
    notifyHomeBoundaryRepairs(next, { host: createBootHostFixture(), notificationService });
    expect(existsSync(pending)).toBe(true);
    expect(show).not.toHaveBeenCalled();
    notifyHomeBoundaryRepairs(ensureAveHomePrivate(dir), {
      host: createBootHostFixture({ desktop: createDesktopHostFixture() }), notificationService,
    });
    expect(show).toHaveBeenCalledOnce();
    expect(existsSync(pending)).toBe(false);
    expect(ensureAveHomePrivate(dir)).not.toHaveProperty("repairs");
  });
  it("maps a native generic read root grant before admitting migration", () => {
    const dir = fixture();
    const result = native("$s=[System.Security.AccessControl.DirectorySecurity]::new(); $s.SetSecurityDescriptorSddlForm('O:'+$u.Value+'D:P(A;OICI;FA;;;'+$u.Value+')(A;;GR;;;WD)'); [HomeDirectoryDacl]::RootSafe($s,$u,$false,0x1200a9)", dir);
    expect(result).toBe("True");
  });
  it("refuses a native generic write root grant", () => {
    const dir = fixture();
    expect(native("$s=[System.Security.AccessControl.DirectorySecurity]::new(); $s.SetSecurityDescriptorSddlForm('O:'+$u.Value+'D:P(A;OICI;FA;;;'+$u.Value+')(A;;GW;;;WD)'); [HomeDirectoryDacl]::RootSafe($s,$u,$false,0x1200a9)", dir)).toBe("False");
  });
  it("refuses a native generic all root grant", () => {
    const dir = fixture();
    expect(native("$s=[System.Security.AccessControl.DirectorySecurity]::new(); $s.SetSecurityDescriptorSddlForm('O:'+$u.Value+'D:P(A;OICI;FA;;;'+$u.Value+')(A;;GA;;;WD)'); [HomeDirectoryDacl]::RootSafe($s,$u,$false,0x1200a9)", dir)).toBe("False");
  });
  it("finishes a completed aside without overwriting the live content", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets");
    const aside = `${boundary}.unprotected-complete`;
    mkdirSync(aside); setFixtureOwner(aside);
    writeFileSync(join(aside, "key"), "old"); setFixtureOwner(join(aside, "key"));
    writeFileSync(join(boundary, "key"), "current"); setFixtureOwner(join(boundary, "key"));
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    expect(readFileSync(join(boundary, "key"), "utf8")).toBe("current");
    expect(existsSync(aside)).toBe(false);
  });
  it("presents one repair notice and none on the next clean boot", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets"); damage(boundary);
    const show = vi.fn();
    const ctx = {
      host: createBootHostFixture({ desktop: createDesktopHostFixture() }),
      notificationService: new NotificationService({
        getMainWindow: () => null, isReady: () => true, isTestEnv: () => false,
        notificationFactory: () => ({ show, on: vi.fn() }),
      }),
    };
    const repaired = ensureAveHomePrivate(dir);
    expect(repaired).toMatchObject({ repairs: [boundary] });
    notifyHomeBoundaryRepairs(repaired, ctx);
    expect(show).toHaveBeenCalledOnce();
    const clean = ensureAveHomePrivate(dir);
    expect(clean).not.toHaveProperty("repairs");
    notifyHomeBoundaryRepairs(clean, ctx);
    expect(show).toHaveBeenCalledOnce();
  });
  it("warns for a foreign root READ grant while keeping confinement enabled", () => {
    const dir = fixture(); grant(dir, "(OI)(CI)RX");
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "win32-dacl",
      diagnostics: [expect.stringContaining("foreign read-only access")] });
    setAveHomePrivacyAtBoot(result);
    expect(() => assertAveHomePrivacyForConfinement()).not.toThrow();
    expectBoundary(join(dir, "secrets"));
  });
  it("refuses a foreign root WRITE grant before touching a damaged boundary", () => {
    const dir = fixture(); const boundary = join(dir, "secrets"); damage(boundary);
    const before = readWindowsDirectoryDacls([boundary]); grant(dir, "W");
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
    setAveHomePrivacyAtBoot(result);
    expect(() => assertAveHomePrivacyForConfinement()).toThrow(dir);
    expect(readWindowsDirectoryDacls([boundary])).toEqual(before);
    expect(existsSync(`${boundary}.unprotected-recovery`)).toBe(false);
  });
  it("copies hardlinked legacy content without changing the original object's permissions", () => {
    const dir = fixture(); const boundary = join(dir, "secrets");
    const original = join(dirname(dir), "legacy");
    writeFileSync(original, "legacy-value"); setFixtureOwner(original);
    linkSync(original, join(boundary, "adopted"));
    damage(boundary);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    expect(readFileSync(original, "utf8")).toBe("legacy-value");
    expect(statSync(join(boundary, "adopted")).ino).not.toBe(statSync(original).ino);
  });
  it("refuses a planted aside junction and names the boundary and failed step", () => {
    const dir = fixture(); const boundary = join(dir, "keys");
    const target = join(dirname(dir), "outside"); mkdirSync(target); setFixtureOwner(target);
    const aside = `${boundary}.unprotected-recovery`; symlinkSync(target, aside, "junction"); setFixtureOwner(aside);
    try {
      expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "none", failedPath: boundary,
        reason: expect.stringContaining("repair step open failed") });
      expect(existsSync(target)).toBe(true);
    } finally { rmdirSync(aside); }
  });
});
