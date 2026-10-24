import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolicyHome, policyHomeAnchors } from "../policy-home.js";
import { expandLeadingTilde } from "../home-tilde.js";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: vi.fn(),
  userInfo: vi.fn(),
}));

describe("policy home resolution", () => {
  const home = join(tmpdir(), "ave-carol");
  const windowsHome = "C:\\Users\\carol";

  beforeEach(() => {
    vi.mocked(homedir).mockReturnValue(home);
    vi.mocked(userInfo).mockImplementation(() => { throw new Error("No account entry"); });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["win32", "linux", "darwin"] as const)("keeps explicit HOME first on %s", (platform) => {
    const explicitHome = platform === "win32" ? windowsHome : "/tmp/ave-carol";
    expect(getPolicyHome({ HOME: explicitHome, USERPROFILE: windowsHome + "\\profile" }, platform)).toBe(explicitHome);
    expect(homedir).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("uses the profile when HOME is %s", (HOME) => {
    expect(getPolicyHome({ HOME, USERPROFILE: windowsHome }, "win32")).toBe(windowsHome);
    expect(homedir).not.toHaveBeenCalled();
  });

  it("uses the drive and path after an empty profile", () => {
    expect(getPolicyHome({ HOME: "", USERPROFILE: "", HOMEDRIVE: windowsHome.slice(0, 2), HOMEPATH: windowsHome.slice(2) }, "win32"))
      .toBe(windowsHome);
    expect(homedir).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux", "darwin"] as const)("falls back to the OS on %s", (platform) => {
    const osHome = platform === "win32" ? windowsHome : "/tmp/ave-carol";
    vi.mocked(homedir).mockReturnValue(osHome);
    expect(getPolicyHome({}, platform)).toBe(osHome);
  });

  it("ignores profile variables on POSIX", () => {
    vi.mocked(homedir).mockReturnValue("/tmp/ave-carol");
    expect(getPolicyHome({ USERPROFILE: windowsHome + "\\profile", HOMEDRIVE: windowsHome.slice(0, 2), HOMEPATH: windowsHome.slice(2) }, "linux"))
      .toBe("/tmp/ave-carol");
  });

  it("refuses unresolved tilde instead of resolving it under cwd", () => {
    for (const key of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) vi.stubEnv(key, undefined);
    vi.mocked(homedir).mockReturnValue("");
    expect(() => getPolicyHome()).toThrow("Cannot resolve home for path policy");
    expect(() => expandLeadingTilde("~/secret")).toThrow("Cannot resolve home for path policy");
  });

  it("refuses when the OS resolution fails and no other anchor exists", () => {
    vi.mocked(homedir).mockImplementation(() => { throw new Error("No home available"); });
    expect(() => getPolicyHome({})).toThrow("Cannot resolve home for path policy");
  });

  it.each(["", "rel", "/"])("falls back to the account home for invalid POSIX home %s", (HOME) => {
    vi.mocked(homedir).mockReturnValue(HOME);
    vi.mocked(userInfo).mockReturnValue({ homedir: "/tmp/ave-account-home", username: "test-account", uid: 1000, gid: 1000, shell: "/bin/sh" });
    expect(getPolicyHome({ HOME }, "linux")).toBe("/tmp/ave-account-home");
  });

  it("retains the account profile when the profile environment is spoofed", () => {
    vi.mocked(homedir).mockReturnValue("C:\\Users\\bob");
    vi.mocked(userInfo).mockReturnValue({ homedir: "C:\\Users\\alice", username: "test-account", uid: -1, gid: -1, shell: null });
    expect(policyHomeAnchors({ USERPROFILE: "C:\\Users\\bob" }, "win32"))
      .toEqual(["C:\\Users\\bob", "C:\\Users\\alice"]);
  });

  it.each(["C:\\USERS\\ALICE", "C:/Users/alice/."])("deduplicates the account profile %s", (profile) => {
    vi.mocked(homedir).mockReturnValue("C:\\Users\\alice");
    vi.mocked(userInfo).mockReturnValue({ homedir: profile, username: "test-account", uid: -1, gid: -1, shell: null });
    expect(policyHomeAnchors({}, "win32")).toEqual(["C:\\Users\\alice"]);
    expect(userInfo).toHaveBeenCalled();
  });

  it("keeps valid profile anchors when the account lookup throws", () => {
    vi.mocked(homedir).mockReturnValue("C:\\Users\\bob");
    expect(policyHomeAnchors({}, "win32")).toEqual(["C:\\Users\\bob"]);
    expect(userInfo).toHaveBeenCalled();
  });
});
