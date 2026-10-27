vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { vi } from "vitest";

import "../../__tests__/support/trusted-powershell.js";
// Credential-store paths match case-insensitively even when scanned on a POSIX host; both host and sandbox projections must deny them.
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { SENSITIVE_PATH_ENTRIES, isSensitivePath } from "../sensitive-paths.js";
import { getDefaultSensitiveReadDenyPaths } from "../asrt-sandbox.js";
import { inspectPowerShellCommand, powerShellSensitivePathSignal } from "../rules/powershell-exfiltration.js";

const PROFILE = "C:/Users/owner";

const WINDOWS_SECRETS: string[] = [
  `${PROFILE}/AppData/Roaming/Microsoft/Credentials/DFBE70A7E5CC19A398EBF1B96859CE5D`,
  `${PROFILE}/AppData/Local/Microsoft/Credentials/DFBE70A7E5CC19A398EBF1B96859CE5D`,
  `${PROFILE}/AppData/Roaming/Microsoft/Protect/S-1-5-21-1-2-3-1001/Preferred`,
  `${PROFILE}/AppData/Roaming/Microsoft/Crypto/RSA/S-1-5-21-1-2-3-1001/key`,
  `${PROFILE}/AppData/Roaming/Microsoft/Vault/4BF4C442-9B8A-41A0-B380-DD4A704DDB28/Policy.vpol`,
  `${PROFILE}/AppData/Local/Microsoft/Vault/4BF4C442-9B8A-41A0-B380-DD4A704DDB28/Policy.vpol`,
  `${PROFILE}/AppData/Local/Microsoft/PowerShell/secretmanagement/localstore/storefile`,
  `${PROFILE}/AppData/Roaming/GitHub CLI/hosts.yml`,
  `${PROFILE}/AppData/Local/Google/Chrome/User Data/Default/Login Data`,
  `${PROFILE}/AppData/Local/Microsoft/Edge/User Data/Profile 1/Login Data`,
  // Whole browser profile roots: any file under them, a random profile name included.
  `${PROFILE}/AppData/Local/Microsoft/Edge/User Data/Default/History`,
  `${PROFILE}/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies`,
  `${PROFILE}/AppData/Local/Chromium/User Data/Local State`,
  `${PROFILE}/AppData/Local/Vivaldi/User Data/Default/Login Data`,
  `${PROFILE}/AppData/Roaming/Opera Software/Opera Stable/Login Data`,
  `${PROFILE}/AppData/Roaming/Mozilla/Firefox/Profiles/x1y2.default-release/key4.db`,
  `c:/users/owner/appdata/roaming/mozilla/firefox/profiles/x1y2.default-release/logins.json`,
  // Sibling browser channels and the mail client keep their own profile roots.
  `${PROFILE}/AppData/Local/Google/Chrome SxS/User Data/Default/Login Data`,
  `${PROFILE}/AppData/Local/Google/Chrome Beta/User Data/Profile 2/Network/Cookies`,
  `${PROFILE}/AppData/Local/Google/Chrome Dev/User Data/Local State`,
  `${PROFILE}/AppData/Local/Microsoft/Edge Beta/User Data/Default/Login Data`,
  `${PROFILE}/AppData/Local/Microsoft/Edge Dev/User Data/Default/History`,
  `${PROFILE}/AppData/Local/Microsoft/Edge SxS/User Data/Default/Login Data`,
  `${PROFILE}/AppData/Roaming/Thunderbird/Profiles/ab12.default-release/logins.json`,
  // Lower-case spellings are the same file on Windows.
  `c:/users/owner/appdata/roaming/microsoft/credentials/x`,
  `c:/users/owner/appdata/local/microsoft/powershell/secretmanagement/localstore/storefile`,
  `c:/users/owner/appdata/local/google/chrome/user data/default/login data`,
];

// Windows forms of stores the POSIX rows already cover (one source of truth).
const ALREADY_COVERED: string[] = [
  `${PROFILE}/.ssh/id_rsa`,
  `${PROFILE}/.aws/credentials`,
  `${PROFILE}/.azure/msal_token_cache.json`,
  `${PROFILE}/.kube/config`,
  `${PROFILE}/.docker/config.json`,
  `${PROFILE}/.git-credentials`,
];

const NOT_SECRET: string[] = [
  `${PROFILE}/AppData/Roaming/Code/User/settings.json`,
  `${PROFILE}/AppData/Local/Temp/build.log`,
  `${PROFILE}/AppData/Local/Microsoft/Edge/Application/msedge.exe`,
  `${PROFILE}/AppData/Local/Google/Chrome Beta/Application/chrome.exe`,
  `${PROFILE}/AppData/Local/Google/Update/Download/x.exe`,
  `${PROFILE}/AppData/Local/Microsoft/PowerShell/ModuleAnalysisCache`,
  `${PROFILE}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/x.lnk`,
  `${PROFILE}/Documents/Credentials.txt`,
];

describe("Windows credential stores are sensitive paths", () => {
  it.each(WINDOWS_SECRETS)("%s is sensitive", (path) => {
    expect(isSensitivePath(path, "read")).not.toBeNull();
  });

  it.each(ALREADY_COVERED)("%s is covered by the POSIX row", (path) => {
    expect(isSensitivePath(path, "read")).not.toBeNull();
  });

  it.each(NOT_SECRET)("%s is not sensitive", (path) => {
    expect(isSensitivePath(path, "read")).toBeNull();
  });

  it.each(["win32", "linux", "darwin"] as const)("rows hang off the home anchor, so the %s sandbox floor denies the literal home paths unless the host is macOS", (platform) => {
    const hostPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    let deny: string[];
    try {
      deny = getDefaultSensitiveReadDenyPaths().map((path) => path.replace(/[\\/]$/, ""));
    } finally {
      Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true });
    }
    for (const segments of [
      ["AppData", "Roaming", "Microsoft", "Credentials"],
      ["AppData", "Roaming", "Microsoft", "Protect"],
      ["AppData", "Local", "Microsoft", "PowerShell", "secretmanagement"],
    ]) {
      expect(SENSITIVE_PATH_ENTRIES.some((entry) => entry.anchor === "home" && entry.segments.join("/") === segments.join("/"))).toBe(true);
      // Nothing on macOS keeps a Windows store under the home, so its Seatbelt floor leaves the row to the host guard.
      if (platform === "darwin") expect(deny).not.toContain(join(homedir(), ...segments));
      else expect(deny).toContain(join(homedir(), ...segments));
    }
  });
});

describe("the PowerShell floor reads Windows store locations", () => {
  it.each([
    "Get-Content $env:APPDATA\\Microsoft\\Credentials\\DFBE70A7",
    "gci $env:APPDATA\\microsoft\\protect",
    "Get-Content '~\\AppData\\Roaming\\GitHub CLI\\hosts.yml'",
  ])("%s names a directly recognized sensitive path", (command) => {
    expect(powerShellSensitivePathSignal(command, PROFILE)).not.toBeNull();
  });

  it.each([
    "Get-ChildItem $env:LOCALAPPDATA\\Microsoft\\PowerShell\\secretmanagement\\localstore",
    "Copy-Item \"$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Login Data\" .\\ld.db",
    "Copy-Item \"$env:LOCALAPPDATA\\Google\\Chrome SxS\\User Data\\Default\\Login Data\" .\\ld.db",
    "Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Edge Dev\\User Data\\Default\"",
    "Get-Content $env:APPDATA\\Thunderbird\\Profiles\\ab12.default\\logins.json",
  ])("%s remains unproven without resolving environment state", (command) => {
    expect(inspectPowerShellCommand(command, PROFILE)).toMatchObject({ outcome: "unproven", sensitive: null });
  });

  it("keeps the direct DPAPI credential path visible without inventing an upload", () => {
    expect(inspectPowerShellCommand("gc $env:APPDATA\\Microsoft\\Protect\\S-1-5-21\\key; Test-NetConnection x.test", PROFILE))
      .toMatchObject({ outcome: "visible-floor", sensitive: expect.any(String), exfiltration: null });
  });

  it.each(["Get-Content $env:APPDATA\\Code\\User\\settings.json", "Get-ChildItem $env:LOCALAPPDATA\\Temp"])(
    "%s names none",
    (command) => {
      expect(powerShellSensitivePathSignal(command, PROFILE)).toBeNull();
    },
  );
});
