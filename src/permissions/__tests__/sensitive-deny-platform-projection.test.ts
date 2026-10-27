// The OS deny floor projected per platform, pinned inline. Every platform's list is locked so a table edit is a reviewed change to this file, and the darwin list must be main's floor minus exactly the rows whose location belongs to another OS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/policy-home.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/policy-home.js")>()),
  policyHomeAnchors: () => ["/fixture-home/user"],
}));

import { getDefaultSensitiveWriteDenyPaths, getVendoredSrtWinExePath } from "../asrt-sandbox.js";
import { SENSITIVE_PATH_ENTRIES, sensitiveEntryOnSandboxFloor } from "../sensitive-paths.js";

const FIXTURE_HOME = "/fixture-home/user";
const FIXTURE_AVE_HOME = `${FIXTURE_HOME}/.ave`;
const FIXTURE_USER_DATA = "/fixture-home/user-data/Ave";
const realPlatform = process.platform;

// Stands for the Electron userData dir, the one entry whose spelling differs per platform.
const USER_DATA = "<user-data>";

// main's deny floor before the macOS pruning, captured with the fixture home. Spelled as win32 emits it: a directory entry carries a trailing separator, which POSIX floors omit. Linux and Windows must still produce exactly this list.
const MAIN_FLOOR: readonly string[] = [
  `${FIXTURE_HOME}/.ssh/`,
  `${FIXTURE_HOME}/.aws/`,
  `${FIXTURE_HOME}/.azure/`,
  `${FIXTURE_HOME}/.config/gcloud/`,
  `${FIXTURE_HOME}/.config/gh/`,
  `${FIXTURE_HOME}/.config/git/`,
  `${FIXTURE_HOME}/.gitconfig`,
  `${FIXTURE_HOME}/.git-credentials`,
  `${FIXTURE_HOME}/.kube/config`,
  `${FIXTURE_HOME}/.gnupg/`,
  `${FIXTURE_HOME}/.docker/config.json`,
  `${FIXTURE_HOME}/.npmrc`,
  `${FIXTURE_HOME}/.netrc`,
  `${FIXTURE_HOME}/.curlrc`,
  `${FIXTURE_HOME}/_curlrc`,
  `${FIXTURE_HOME}/curlrc`,
  `${FIXTURE_HOME}/.config/curlrc`,
  `${FIXTURE_HOME}/.wgetrc`,
  `${FIXTURE_HOME}/wget.ini`,
  "/etc/wgetrc",
  "/usr/local/etc/wgetrc",
  `${FIXTURE_HOME}/.pgpass`,
  `${FIXTURE_HOME}/Library/Keychains/`,
  `${FIXTURE_HOME}/.local/share/keyrings/`,
  `${FIXTURE_HOME}/.password-store/`,
  `${FIXTURE_HOME}/.config/op/`,
  `${FIXTURE_HOME}/Library/Group Containers/2BUA8C4S2C.com.1password/`,
  `${FIXTURE_HOME}/Library/Group Containers/2BUA8C4S2C.com.agilebits/`,
  `${FIXTURE_HOME}/.local/share/kwalletd/`,
  `${FIXTURE_HOME}/Library/Cookies/`,
  `${FIXTURE_HOME}/Library/Containers/com.apple.Safari/`,
  `${FIXTURE_HOME}/Library/Application Support/Google/`,
  `${FIXTURE_HOME}/Library/Application Support/Microsoft Edge/`,
  `${FIXTURE_HOME}/Library/Application Support/Microsoft Edge Beta/`,
  `${FIXTURE_HOME}/Library/Application Support/Microsoft Edge Dev/`,
  `${FIXTURE_HOME}/Library/Application Support/Microsoft Edge Canary/`,
  `${FIXTURE_HOME}/Library/Application Support/BraveSoftware/`,
  `${FIXTURE_HOME}/Library/Application Support/Chromium/`,
  `${FIXTURE_HOME}/Library/Application Support/Arc/`,
  `${FIXTURE_HOME}/Library/Application Support/Vivaldi/`,
  `${FIXTURE_HOME}/Library/Application Support/com.operasoftware.Opera/`,
  `${FIXTURE_HOME}/Library/Application Support/com.operasoftware.OperaGX/`,
  `${FIXTURE_HOME}/Library/Application Support/Firefox/`,
  `${FIXTURE_HOME}/.mozilla/`,
  `${FIXTURE_HOME}/.config/google-chrome/`,
  `${FIXTURE_HOME}/.config/chromium/`,
  `${FIXTURE_HOME}/.config/BraveSoftware/`,
  `${FIXTURE_HOME}/.config/microsoft-edge/`,
  `${FIXTURE_HOME}/.config/vivaldi/`,
  `${FIXTURE_HOME}/.config/opera/`,
  `${FIXTURE_HOME}/.config/google-chrome-beta/`,
  `${FIXTURE_HOME}/.config/google-chrome-unstable/`,
  `${FIXTURE_HOME}/.config/microsoft-edge-beta/`,
  `${FIXTURE_HOME}/.config/microsoft-edge-dev/`,
  `${FIXTURE_HOME}/snap/firefox/`,
  `${FIXTURE_HOME}/snap/chromium/`,
  `${FIXTURE_HOME}/snap/brave/`,
  `${FIXTURE_HOME}/snap/thunderbird/`,
  `${FIXTURE_HOME}/.var/app/org.mozilla.firefox/`,
  `${FIXTURE_HOME}/.var/app/org.chromium.Chromium/`,
  `${FIXTURE_HOME}/.var/app/com.google.Chrome/`,
  `${FIXTURE_HOME}/.var/app/com.brave.Browser/`,
  `${FIXTURE_HOME}/.var/app/com.microsoft.Edge/`,
  `${FIXTURE_HOME}/.var/app/org.mozilla.Thunderbird/`,
  `${FIXTURE_HOME}/.thunderbird/`,
  `${FIXTURE_HOME}/Library/Thunderbird/`,
  `${FIXTURE_HOME}/.bash_history`,
  `${FIXTURE_HOME}/.zsh_history`,
  `${FIXTURE_HOME}/.python_history`,
  `${FIXTURE_HOME}/.psql_history`,
  `${FIXTURE_HOME}/.viminfo`,
  `${FIXTURE_HOME}/AppData/Roaming/Microsoft/Credentials/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/Credentials/`,
  `${FIXTURE_HOME}/AppData/Roaming/Microsoft/Protect/`,
  `${FIXTURE_HOME}/AppData/Roaming/Microsoft/Crypto/`,
  `${FIXTURE_HOME}/AppData/Roaming/Microsoft/Vault/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/Vault/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/PowerShell/secretmanagement/`,
  `${FIXTURE_HOME}/AppData/Roaming/GitHub CLI/`,
  `${FIXTURE_HOME}/AppData/Local/Google/Chrome/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/Edge/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/BraveSoftware/Brave-Browser/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Chromium/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Vivaldi/User Data/`,
  `${FIXTURE_HOME}/AppData/Roaming/Opera Software/`,
  `${FIXTURE_HOME}/AppData/Local/Google/Chrome SxS/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Google/Chrome Beta/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Google/Chrome Dev/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/Edge Beta/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/Edge Dev/User Data/`,
  `${FIXTURE_HOME}/AppData/Local/Microsoft/Edge SxS/User Data/`,
  `${FIXTURE_HOME}/AppData/Roaming/Thunderbird/`,
  `${FIXTURE_HOME}/AppData/Roaming/Mozilla/Firefox/Profiles/`,
  `${FIXTURE_HOME}/.config/ave/hooks/`,
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/passwd-",
  `${FIXTURE_HOME}/.ave/certs/`,
  `${FIXTURE_HOME}/.ave/secrets/`,
  `${FIXTURE_HOME}/.ave/subscription-runtimes/`,
  `${FIXTURE_HOME}/.ave/keys/`,
  `${FIXTURE_HOME}/.ave/ave-secrets.json`,
  `${FIXTURE_HOME}/.ave/settings.json`,
  `${FIXTURE_HOME}/.ave/permissions.json`,
  `${FIXTURE_HOME}/.ave/policy.json`,
  `${FIXTURE_HOME}/.ave/permissions/`,
  `${FIXTURE_HOME}/.ave/audit/`,
  `${FIXTURE_HOME}/.ave/audit.log`,
  `${FIXTURE_HOME}/.ave/sessions/`,
  `${FIXTURE_HOME}/.ave/host-runtime/`,
  `${FIXTURE_HOME}/.ave/routine/`,
  `${FIXTURE_HOME}/.ave/plugins/auth-partitions.json`,
  USER_DATA,
  `${FIXTURE_HOME}/.zshenv`,
  `${FIXTURE_HOME}/.zprofile`,
  `${FIXTURE_HOME}/.zshrc`,
  `${FIXTURE_HOME}/.zlogin`,
  `${FIXTURE_HOME}/.zlogout`,
  `${FIXTURE_HOME}/.bash_profile`,
  `${FIXTURE_HOME}/.bash_login`,
  `${FIXTURE_HOME}/.bashrc`,
  `${FIXTURE_HOME}/.bash_logout`,
  `${FIXTURE_HOME}/.profile`,
  `${FIXTURE_HOME}/.config/`,
  `${FIXTURE_HOME}/Library/LaunchAgents/`,
  "/usr/lib/cron/tabs",
  "/var/spool/cron/crontabs",
  "/var/spool/cron",
  "/etc/cron.d",
  "<srt-win>",
];

// The rows the macOS floor leaves out, named here so a newly tagged row is a reviewed change. Each is a location only Windows (`%APPDATA%`, `%LOCALAPPDATA%` below the profile) or Linux packaging (snap, Flatpak) creates; nothing on macOS keeps a secret at these home-anchored paths, and the host guard still denies them anywhere.
const DARWIN_DROPPED = [
  "snap/firefox",
  "snap/chromium",
  "snap/brave",
  "snap/thunderbird",
  ".var/app/org.mozilla.firefox",
  ".var/app/org.chromium.Chromium",
  ".var/app/com.google.Chrome",
  ".var/app/com.brave.Browser",
  ".var/app/com.microsoft.Edge",
  ".var/app/org.mozilla.Thunderbird",
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Roaming/Microsoft/Protect",
  "AppData/Roaming/Microsoft/Crypto",
  "AppData/Roaming/Microsoft/Vault",
  "AppData/Local/Microsoft/Vault",
  "AppData/Local/Microsoft/PowerShell/secretmanagement",
  "AppData/Roaming/GitHub CLI",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
  "AppData/Local/BraveSoftware/Brave-Browser/User Data",
  "AppData/Local/Chromium/User Data",
  "AppData/Local/Vivaldi/User Data",
  "AppData/Roaming/Opera Software",
  "AppData/Local/Google/Chrome SxS/User Data",
  "AppData/Local/Google/Chrome Beta/User Data",
  "AppData/Local/Google/Chrome Dev/User Data",
  "AppData/Local/Microsoft/Edge Beta/User Data",
  "AppData/Local/Microsoft/Edge Dev/User Data",
  "AppData/Local/Microsoft/Edge SxS/User Data",
  "AppData/Roaming/Thunderbird",
  "AppData/Roaming/Mozilla/Firefox/Profiles",
];

function denyFloor(platform: NodeJS.Platform, userDataDir?: string): string[] {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    const vendored = getVendoredSrtWinExePath().replace(/[\\/][^\\/]+[\\/][^\\/]+$/, "");
    return getDefaultSensitiveWriteDenyPaths(userDataDir).map((path) => path.split(vendored).join("<srt-win>"));
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

// main's floor as a POSIX platform spells it, with that platform's userData dir.
function posixFloor(userData: string): string[] {
  return MAIN_FLOOR.map((path) => path === USER_DATA ? userData : path.replace(/\/$/, ""));
}

// The pinned lists use POSIX `path.join` spellings, which a Windows host would write with backslashes.
describe.runIf(realPlatform !== "win32")("the OS deny floor per platform", () => {
  let previousAveHome: string | undefined;
  let previousXdgConfigHome: string | undefined;
  beforeEach(() => {
    previousAveHome = process.env.AVE_HOME;
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.AVE_HOME = FIXTURE_AVE_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (previousAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousAveHome;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  });

  it.each([undefined, FIXTURE_USER_DATA])("win32 keeps main's floor (userData %s)", (userData) => {
    expect(denyFloor("win32", userData))
      .toEqual(MAIN_FLOOR.map((path) => path === USER_DATA ? `${userData ?? `${FIXTURE_HOME}/AppData/Roaming/Ave`}/` : path));
  });

  it.each([undefined, FIXTURE_USER_DATA])("linux keeps main's floor (userData %s)", (userData) => {
    expect(denyFloor("linux", userData)).toEqual(posixFloor(userData ?? `${FIXTURE_HOME}/.config/Ave`));
  });

  it.each([undefined, FIXTURE_USER_DATA])("darwin is main's floor minus the other-OS rows (userData %s)", (userData) => {
    const dropped = new Set(DARWIN_DROPPED.map((segments) => `${FIXTURE_HOME}/${segments}`));
    const expected = posixFloor(userData ?? `${FIXTURE_HOME}/Library/Application Support/Ave`).filter((path) => !dropped.has(path));
    expect(expected.length).toBe(MAIN_FLOOR.length - DARWIN_DROPPED.length);
    expect(denyFloor("darwin", userData)).toEqual(expected);
  });

  it("leaves out of the macOS floor exactly the rows tagged for another OS", () => {
    const tagged = SENSITIVE_PATH_ENTRIES.filter((entry) => !sensitiveEntryOnSandboxFloor(entry, "darwin"));
    expect(tagged.map((entry) => entry.segments.join("/"))).toEqual(DARWIN_DROPPED);
    expect(tagged.every((entry) => entry.anchor === "home" && entry.platform !== undefined)).toBe(true);
    const darwin = denyFloor("darwin");
    for (const segments of DARWIN_DROPPED) expect(darwin).not.toContain(`${FIXTURE_HOME}/${segments}`);
    for (const platform of ["linux", "win32"] as const) {
      expect(SENSITIVE_PATH_ENTRIES.every((entry) => sensitiveEntryOnSandboxFloor(entry, platform))).toBe(true);
      const floor = denyFloor(platform).map((path) => path.replace(/[\\/]$/, ""));
      for (const segments of DARWIN_DROPPED) expect(floor).toContain(`${FIXTURE_HOME}/${segments}`);
    }
  });
});
