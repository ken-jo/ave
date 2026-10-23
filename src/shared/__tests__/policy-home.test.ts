import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolicyHome } from "../policy-home.js";
import { expandLeadingTilde } from "../home-tilde.js";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: vi.fn(),
}));

describe("policy home resolution", () => {
  const home = join(tmpdir(), "ave-policy-home-fallback");

  beforeEach(() => {
    vi.mocked(homedir).mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["win32", "linux", "darwin"] as const)("keeps explicit HOME first on %s", (platform) => {
    expect(getPolicyHome({ HOME: home, USERPROFILE: join(home, "profile") }, platform)).toBe(home);
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
    expect(getPolicyHome({}, platform)).toBe(home);
  });

  it("ignores profile variables on POSIX", () => {
    const windowsHome = win32.resolve(home);
    expect(getPolicyHome({ USERPROFILE: join(home, "profile"), HOMEDRIVE: windowsHome.slice(0, 2), HOMEPATH: windowsHome.slice(2) }, "linux")).toBe(home);
  });

  it("refuses unresolved tilde instead of resolving it under cwd", () => {
    for (const key of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) vi.stubEnv(key, undefined);
    vi.mocked(homedir).mockReturnValue("");
    expect(() => getPolicyHome()).toThrow("Cannot resolve home for path policy");
    expect(() => expandLeadingTilde("~/secret")).toThrow("Cannot resolve home for path policy");
  });

  it("propagates an OS resolution failure", () => {
    vi.mocked(homedir).mockImplementation(() => { throw new Error("No home available"); });
    expect(() => getPolicyHome({})).toThrow("No home available");
  });
});
