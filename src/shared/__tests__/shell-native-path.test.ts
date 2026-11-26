import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAmbiguousNativeSpelling, isWindowsNetworkOrDevicePath, localDriveAlias, modelShellPath, withoutStreamSuffixes } from "../shell-native-path.js";
import { setWindowsDriveQueryForTest } from "../windows-drive-locality.js";

// The shared setup answers every drive as local; these cases need a host with no X: drive, as the query reports it.
vi.unmock("../windows-drive-locality.js");
beforeEach(() => setWindowsDriveQueryForTest(drive => drive === "X:" ? null : String.raw`\Device\HarddiskVolume1`));
afterEach(() => setWindowsDriveQueryForTest());

describe("local drive aliases", () => {
  it.each([
    [String.raw`\\.\D:\a\settings.json`, String.raw`D:\a\settings.json`],
    [String.raw`\\?\d:\a`, String.raw`D:\a`],
    [String.raw`\\localhost\D$\a`, String.raw`D:\a`],
    [String.raw`\\127.0.0.1\d$\a\b`, String.raw`D:\a\b`],
    [String.raw`\\127.4.5.6\D$\a`, String.raw`D:\a`],
    [String.raw`\\?\UNC\localhost\D$\a`, String.raw`D:\a`],
    [String.raw`\\.\unc\LOCALHOST\D$\a`, String.raw`D:\a`],
    ["//LocalHost/d$/a/b", String.raw`D:\a\b`],
    [String.raw`\\::1\D$\a`, String.raw`D:\a`],
    [String.raw`\\[::1]\D$\a`, String.raw`D:\a`],
    [String.raw`\\0--1.ipv6-literal.net\D$\a`, String.raw`D:\a`],
    [String.raw`\\localhost\D$`, "D:\\"],
    [String.raw`\\localhost\D$\a::$DATA`, String.raw`D:\a::$DATA`],
  ])("maps %s to its drive", (path, expected) => {
    expect(localDriveAlias(path, "win32")).toBe(expected);
  });

  it("maps the host's own name", () => {
    expect(localDriveAlias(`\\\\${hostname()}\\D$\\a`, "win32")).toBe(String.raw`D:\a`);
  });

  it.each([
    String.raw`\\?\GLOBALROOT\??\D:\a`, String.raw`\\?\Volume{00000000-0000-0000-0000-000000000000}\a`,
    String.raw`\\.\D:`, String.raw`\\.\D:x`, String.raw`\\.\D:\a.`, String.raw`\\.\D:\a \b`, String.raw`\\.\D:\a\..\b`, String.raw`\\.\D:\a\.\b`,
    String.raw`\\files.example\D$\a`, String.raw`\\localhost\share\a`, String.raw`\\localhost\DE$\a`, String.raw`\\localhost.\D$\a`,
    String.raw`\\127.0.0.256\D$\a`, String.raw`\\.\D$\a`, String.raw`D:\a`,
    // Letters that fold to ASCII only under Unicode case rules: the Kelvin sign and the long s.
    "\\\\.\\\u212A:\\a", "\\\\localho\u017Ft\\D$\\a",
  ])("leaves %s unproven", path => {
    expect(localDriveAlias(path, "win32")).toBeUndefined();
  });

  it("maps nothing on other platforms", () => {
    expect(localDriveAlias(String.raw`\\.\D:\a`, "linux")).toBeUndefined();
  });
});

// Spellings whose target the Win32 path rules can read more than one way: an NT prefix, a slash or an empty component
// after the extended prefix (which skips normalization), and components ending in a dot or space (which it strips).
describe("ambiguous native spellings", () => {
  it.each([
    String.raw`\??\D:\a`, "/??/D:/a", String.raw`\\?\D:\a/b`, String.raw`\\?\D:\a\\b`, String.raw`\\.\D:\a.`, String.raw`\\.\D:\a \b`,
    String.raw`\\localhost\D$\..\a`, String.raw`\\files.example\share\a.`,
  ])("treats %s as an unproven device path", path => {
    expect(isAmbiguousNativeSpelling(path, "win32")).toBe(true);
    expect(isWindowsNetworkOrDevicePath(path, "win32")).toBe(true);
    expect(localDriveAlias(path, "win32")).toBeUndefined();
  });

  it.each([
    String.raw`D:\a.`, "D:/a/b", String.raw`\\?\D:\a\b`, String.raw`\\.\D:\a`, String.raw`\\files.example\share\a`, String.raw`\\?\UNC\files.example\share\a`,
  ])("leaves %s unambiguous", path => {
    expect(isAmbiguousNativeSpelling(path, "win32")).toBe(false);
  });

  it("finds nothing ambiguous on other platforms", () => {
    expect(isAmbiguousNativeSpelling(String.raw`\??\D:\a`, "linux")).toBe(false);
    expect(isWindowsNetworkOrDevicePath(String.raw`\??\D:\a`, "linux")).toBe(false);
  });
});

describe("stream suffixes", () => {
  it.each([
    [String.raw`D:\a\b.txt::$DATA`, String.raw`D:\a\b.txt`],
    [String.raw`D:\a\b.txt:alt:$DATA`, String.raw`D:\a\b.txt`],
    [String.raw`D:\a:s\b`, String.raw`D:\a\b`],
    [String.raw`\\::1\D$\a::$DATA`, String.raw`\\::1\D$\a`],
    [String.raw`\\?\D:\a::$DATA`, String.raw`\\?\D:\a`],
    [String.raw`\\?\UNC\files.example\share\a:s`, String.raw`\\?\UNC\files.example\share\a`],
    [String.raw`D:\a`, String.raw`D:\a`],
  ])("names %s as %s", (path, expected) => {
    expect(withoutStreamSuffixes(path, "win32")).toBe(expected);
  });

  it("keeps colons on other platforms", () => {
    expect(withoutStreamSuffixes("/a/b:c", "linux")).toBe("/a/b:c");
  });
});

describe.runIf(process.platform === "win32")("native shell path model", () => {
  it.each([
    [String.raw`C:\..\etc\shadow`, String.raw`C:\etc\shadow`],
    [String.raw`\\host\etc\..\shadow`, String.raw`\\host\etc\shadow`],
    [String.raw`\\host\.ssh\..\config`, String.raw`\\host\.ssh\config`],
    [String.raw`\\?\C:\..\etc\shadow`, String.raw`\\?\C:\etc\shadow`],
    [String.raw`\\?\UNC\host\etc\..\shadow`, String.raw`\\?\UNC\host\etc\shadow`],
  ])("clamps parent components at the native volume root: %s", (path, expected) => {
    expect(modelShellPath(path, { dialect: "native" }).normalizedPath).toBe(expected);
  });

  it.each(["/x/file.txt", String.raw`\x\file.txt`])("anchors only an established execution location: %s", path => {
    expect(modelShellPath(path, { dialect: "powershell", location: "D:/project" }).normalizedPath).toBe(String.raw`D:\x\file.txt`);
    expect(modelShellPath(path, { dialect: "powershell" }).nativePath).toBeUndefined();
    expect(modelShellPath(path, { dialect: "powershell", location: "/project" }).nativePath).toBeUndefined();
  });

  it("does not borrow the cwd drive for a mounted root", () => {
    expect(modelShellPath("/x/file.txt", { dialect: "bash", location: "D:/project" }).nativePath).toBeUndefined();
    expect(modelShellPath("/c/x/file.txt", { dialect: "bash", location: "D:/project" }).normalizedPath).toBe(String.raw`c:\x\file.txt`);
  });

  it("retains a sensitive drive-relative floor without assigning a drive location", () => {
    const path = modelShellPath("C:.ssh/config", { dialect: "native" });
    expect(path.nativePath).toBeUndefined();
    expect(path.floorPaths).toContain("/.ssh/config");
  });

  it("uses the share as the extended network volume root", () => {
    expect(modelShellPath(String.raw`\\?\UNC\host\etc\..\shadow`, { dialect: "native" }).volumeRoot)
      .toBe(String.raw`\\?\UNC\host\etc` + "\\");
  });
});

it.runIf(process.platform !== "win32")("preserves host path semantics", () => {
  expect(modelShellPath("/x/../file.txt", { dialect: "bash", location: "/project" }).normalizedPath).toBe("/file.txt");
});

it.each([String.raw`HKCU:\Software\Foo`, String.raw`HKLM:\Software\Foo`, String.raw`Cert:\CurrentUser\My\fixture`,
  String.raw`WSMan:\localhost\Client`, String.raw`Registry::HKEY_CURRENT_USER\Software\Foo`, "Env:fixture",
  String.raw`Microsoft.PowerShell.Core\Registry::HKEY_CURRENT_USER\Software\Foo`, String.raw`Microsoft.PowerShell.Core\Environment::GITHUB_TOKEN`, "C:fixture", String.raw`C:\fixture\f.txt:stream`])("does not assign a filesystem identity to provider target %s", path => {
  expect(modelShellPath(path, { dialect: "powershell", location: process.cwd() }).nativePath).toBeUndefined();
});
it.runIf(process.platform === "win32").each([String.raw`C:\fixture`, "d:/fixture"])("retains absolute single-letter drive %s", path => {
  expect(modelShellPath(path, { dialect: "powershell", location: process.cwd() }).nativePath).toBe(path);
});
