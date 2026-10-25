import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { ensureAveHomePrivate, readWindowsDirectoryDacls, win32SystemBinary, setAveHomePrivacyAtBoot, assertAveHomePrivacyForConfinement, _resetAveHomePrivacyForTest } from "../ave-home.js";
import { createBootHostFixture, createDesktopHostFixture } from "../../__tests__/support/host-runtime.js";
import { NotificationService } from "../../main/notification-service.js";
import { notifyHomeBoundaryRepairs } from "../../boot/steps/home-privacy-notice.js";
import { windowsPowerShellEnv } from "../windows-powershell-env.js";

describe.runIf(process.platform === "win32")("protected home boundaries", () => {
  afterEach(() => { _resetAveHomePrivacyForTest(); });
  const home = useTempPaths("ave-boundaries-", ".ave");
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

  it("creates all four boundaries with the exact owner-only descriptor", () => {
    const dir = fixture();
    expectBoundary(dir);
    expectBoundary(join(dir, "secrets"));
    expectBoundary(join(dir, "subscription-runtimes"));
    expectBoundary(join(dir, "keys"));
    expectBoundary(join(dir, "certs"));
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
    expect(ensureAveHomePrivate(dir)).not.toHaveProperty("repairs");
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
  it("finishes a completed aside without overwriting the live content", () => {
    const dir = fixture();
    const boundary = join(dir, "secrets");
    const aside = `${boundary}.unprotected-complete`;
    mkdirSync(aside); setFixtureOwner(aside);
    writeFileSync(join(aside, "key"), "old"); setFixtureOwner(join(aside, "key"));
    writeFileSync(join(boundary, "key"), "current"); setFixtureOwner(join(boundary, "key"));
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl", repairs: [boundary] });
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
