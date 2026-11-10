import { homedir, userInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolicyHome, policyHomeAnchors } from "../policy-home.js";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: vi.fn(),
  userInfo: vi.fn(),
}));

const ISOLATED_HOME = "C:\\fixture\\isolated-home";
const ACCOUNT_HOME = "C:\\Users\\example";

describe("independent policy home anchors", () => {
  beforeEach(() => {
    vi.mocked(homedir).mockReturnValue(ISOLATED_HOME);
    vi.mocked(userInfo).mockReturnValue({
      homedir: ACCOUNT_HOME,
      username: "example",
      uid: -1,
      gid: -1,
      shell: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the account deny anchor when both home environment variables are isolated", () => {
    const environment = { HOME: ISOLATED_HOME, USERPROFILE: ISOLATED_HOME };

    expect(getPolicyHome(environment, "win32")).toBe(ISOLATED_HOME);
    expect(policyHomeAnchors(environment, "win32")).toEqual([ISOLATED_HOME, ACCOUNT_HOME]);
    expect(userInfo).toHaveBeenCalledOnce();
  });

  it("keeps the account deny anchor when OS home resolution fails", () => {
    vi.mocked(homedir).mockImplementation(() => { throw new Error("Home unavailable"); });

    expect(policyHomeAnchors({ HOME: ISOLATED_HOME, USERPROFILE: ISOLATED_HOME }, "win32"))
      .toEqual([ISOLATED_HOME, ACCOUNT_HOME]);
  });

  it("keeps distinct OS, shell and account anchors", () => {
    const osProfile = "C:\\fixture\\os-profile";
    vi.mocked(homedir).mockReturnValue(osProfile);

    expect(policyHomeAnchors({ HOME: ISOLATED_HOME, USERPROFILE: osProfile }, "win32"))
      .toEqual([osProfile, ISOLATED_HOME, ACCOUNT_HOME]);
  });

  it("deduplicates equivalent isolated and account anchors without dropping the account lookup", () => {
    vi.mocked(homedir).mockReturnValue(ACCOUNT_HOME);

    expect(policyHomeAnchors({ HOME: "c:/users/EXAMPLE/.", USERPROFILE: ACCOUNT_HOME }, "win32"))
      .toEqual([ACCOUNT_HOME]);
    expect(userInfo).toHaveBeenCalledOnce();
  });
});
