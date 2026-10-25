// The OS deny floor projected per platform, pinned as a snapshot. Every platform's list is locked so a table edit shows up as a reviewable diff, and the darwin list must lack exactly the rows whose location belongs to another OS.
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

  it.each(["darwin", "linux", "win32"] as const)("%s, default userData layout", (platform) => {
    expect(denyFloor(platform)).toMatchSnapshot();
  });

  it.each(["darwin", "linux", "win32"] as const)("%s, trusted userData dir", (platform) => {
    expect(denyFloor(platform, FIXTURE_USER_DATA)).toMatchSnapshot();
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
