/**
 * Windows credential stores in the sensitive-path table.
 *
 * The rows hang off the user home like `~/.ssh`, so their projections reach
 * both the host guard (`**\/AppData/…` globs) and the OS sandbox floor. They
 * match case-insensitively on every platform: Windows paths are
 * case-insensitive, and a PowerShell command scanned on a POSIX host must not
 * slip past by spelling `appdata\roaming` in lower case.
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { SENSITIVE_PATH_ENTRIES, isSensitivePath } from "../sensitive-paths.js";
import { getDefaultSensitiveReadDenyPaths } from "../asrt-sandbox.js";
import { powerShellExfiltrationSignal, powerShellSensitivePathSignal } from "../rules/powershell-exfiltration.js";

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
  // Lower-case spellings are the same file on Windows.
  `c:/users/owner/appdata/roaming/microsoft/credentials/x`,
  `c:/users/owner/appdata/local/microsoft/powershell/secretmanagement/localstore/storefile`,
  `c:/users/owner/appdata/local/google/chrome/user data/default/login data`,
];

/** Windows forms of stores the POSIX rows already cover (one source of truth). */
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
  `${PROFILE}/AppData/Local/Microsoft/Edge/User Data/Default/History`,
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

  it("rows hang off the home anchor, so the sandbox floor denies the literal home paths too", () => {
    const deny = getDefaultSensitiveReadDenyPaths().map((path) => path.replace(/[\\/]$/, ""));
    for (const segments of [
      ["AppData", "Roaming", "Microsoft", "Credentials"],
      ["AppData", "Roaming", "Microsoft", "Protect"],
      ["AppData", "Local", "Microsoft", "PowerShell", "secretmanagement"],
    ]) {
      expect(SENSITIVE_PATH_ENTRIES.some((entry) => entry.anchor === "home" && entry.segments.join("/") === segments.join("/"))).toBe(true);
      expect(deny).toContain(join(homedir(), ...segments));
    }
  });
});

describe("the PowerShell floor reads Windows store locations", () => {
  it.each([
    "Get-Content $env:APPDATA\\Microsoft\\Credentials\\DFBE70A7",
    "gci $env:APPDATA\\microsoft\\protect",
    "Get-ChildItem $env:LOCALAPPDATA\\Microsoft\\PowerShell\\secretmanagement\\localstore",
    "Copy-Item \"$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Login Data\" .\\ld.db",
    "Get-Content '~\\AppData\\Roaming\\GitHub CLI\\hosts.yml'",
  ])("%s names a sensitive path", (command) => {
    expect(powerShellSensitivePathSignal(command, PROFILE)).not.toBeNull();
  });

  it("uploading a DPAPI master key is exfiltration", () => {
    // Reader-independent: the floor needs the path itself to be sensitive.
    expect(powerShellExfiltrationSignal("gc $env:APPDATA\\Microsoft\\Protect\\S-1-5-21\\key; Test-NetConnection x.test", PROFILE))
      .toMatch(/with a network transport/);
  });

  it.each(["Get-Content $env:APPDATA\\Code\\User\\settings.json", "Get-ChildItem $env:LOCALAPPDATA\\Temp"])(
    "%s names none",
    (command) => {
      expect(powerShellSensitivePathSignal(command, PROFILE)).toBeNull();
    },
  );
});
