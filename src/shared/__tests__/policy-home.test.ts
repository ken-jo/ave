import { homedir, tmpdir, userInfo } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolicyHome } from "../policy-home.js";
import { expandLeadingTilde } from "../home-tilde.js";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: vi.fn(),
  userInfo: vi.fn(),
}));

describe("policy home resolution", () => {
  const home = join(tmpdir(), "ave-policy-home-fallback");

  beforeEach(() => {
    vi.mocked(homedir).mockReturnValue(home);
    vi.mocked(userInfo).mockImplementation(() => { throw new Error("No account entry"); });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["win32", "linux", "darwin"] as const)("keeps explicit HOME first on %s", (platform) => {
    const explicitHome = platform === "win32" ? home : "/tmp/ave-policy-home-fallback";
    expect(getPolicyHome({ HOME: explicitHome, USERPROFILE: join(home, "profile") }, platform)).toBe(explicitHome);
    expect(homedir).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("uses the profile when HOME is %s", (HOME) => {
    expect(getPolicyHome({ HOME, USERPROFILE: home }, "win32")).toBe(home);
    expect(homedir).not.toHaveBeenCalled();
  });

  it("uses the drive and path after an empty profile", () => {
    const windowsHome = win32.resolve(home);
    expect(getPolicyHome({ HOME: "", USERPROFILE: "", HOMEDRIVE: windowsHome.slice(0, 2), HOMEPATH: windowsHome.slice(2) }, "win32"))
      .toBe(windowsHome);
    expect(homedir).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux", "darwin"] as const)("falls back to the OS on %s", (platform) => {
    const osHome = platform === "win32" ? home : "/tmp/ave-policy-home-fallback";
    vi.mocked(homedir).mockReturnValue(osHome);
    expect(getPolicyHome({}, platform)).toBe(osHome);
  });

  it("ignores profile variables on POSIX", () => {
    const windowsHome = win32.resolve(home);
    vi.mocked(homedir).mockReturnValue("/tmp/ave-policy-home-fallback");
    expect(getPolicyHome({ USERPROFILE: join(home, "profile"), HOMEDRIVE: windowsHome.slice(0, 2), HOMEPATH: windowsHome.slice(2) }, "linux"))
      .toBe("/tmp/ave-policy-home-fallback");
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
});
