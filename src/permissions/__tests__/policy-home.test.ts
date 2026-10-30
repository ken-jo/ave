import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { expandLeadingTilde, expandShellTildePaths } from "../../shared/home-tilde.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { getPolicyHome, policyHomeAnchors } from "../../shared/policy-home.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import { findShellPathPolicyViolation } from "../../tools/shell-path-policy.js";
import { getBuiltinShellReadPolicy, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths, protectedReadDenyCovering } from "../asrt-sandbox.js";
import { canonicalizePathForMatch, SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import { sensitivePathInArgumentText, shellSensitivePathSignal } from "../rules/shell-exfiltration.js";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: vi.fn(original.homedir), userInfo: vi.fn(original.userInfo) };
});

beforeEach(() => {
  vi.mocked(userInfo).mockReturnValue({ homedir: join(tmpdir(), "account"), username: "test-account", uid: 1000, gid: 1000, shell: "/bin/sh" });
});

describe.skipIf(process.platform !== "win32")("home policy with an absent HOME", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-policy-home-"));
    vi.stubEnv("HOME", undefined);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("AVE_HOME", join(home, ".ave"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each(["rm -rf ~/", "rm -rf $HOME", 'rm -rf "${HOME}"/', "rm -rf ~other/"])("refuses %s without HOME", (command) => {
    const environment = { USERPROFILE: home };
    expect(new BashAstValidator().validate("bash", { command }, {
      cwd: home, facts: { dialect: "bash", environment },
    }).decision).toBe("deny");
  });

  it.each(["~/.ave/secrets/x", "~/.ssh/id_rsa"])("hard-blocks %s without HOME", (path) => {
    expect(assertReadableFilePath(path, home, [home])).toEqual({ ok: false, error: "sensitive-path" });
    expect(findShellPathPolicyViolation(`cat ${path}`, home, home, [home], false, {
      dialect: "bash", environment: { USERPROFILE: home },
    })).not.toBeNull();
  });

  it("refuses recursive removal of the resolved profile without HOME", () => {
    expect(new BashAstValidator().validate("bash", { command: `rm -rf '${home.replace(/\\/g, "/")}'` }, {
      cwd: home, facts: { dialect: "bash", environment: { USERPROFILE: home } },
    }).decision).toBe("deny");
  });

  it("preserves explicit HOME guard results", () => {
    vi.stubEnv("HOME", home);
    for (const command of ["rm -rf ~/", "rm -rf $HOME", 'rm -rf "${HOME}"/']) {
      expect(new BashAstValidator().validate("bash", { command }, {
        cwd: home, facts: { dialect: "bash", environment: { HOME: home, USERPROFILE: home } },
      }).decision).toBe("deny");
    }
    expect(assertReadableFilePath("~/.ave/secrets/x", home, [home])).toEqual({ ok: false, error: "sensitive-path" });
  });

  it("keeps policy tilde on the profile when HOME differs", () => {
    const explicitHome = join(home, "explicit");
    vi.stubEnv("HOME", explicitHome);
    expect(expandLeadingTilde("~")).toBe(home);
    const suffix = process.platform === "win32" ? sep : "";
    expect(getDefaultSensitiveReadDenyPaths()).toContain(join(explicitHome, ".ssh") + suffix);
  });

  it("retains both deny floors across distinct, absent and equivalent homes", () => {
    const explicitHome = join(home, "explicit");
    mkdirSync(explicitHome);
    vi.stubEnv("AVE_HOME", undefined);
    for (const shellHome of [explicitHome, undefined, home, home.toUpperCase(), join(home, ".")]) {
      vi.stubEnv("HOME", shellHome);
      const homes = shellHome === explicitHome ? [home, explicitHome] : [home];
      for (const denied of [getDefaultSensitiveReadDenyPaths(), getDefaultSensitiveWriteDenyPaths()]) {
        expect(new Set(denied.map((path) => path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase())).size).toBe(denied.length);
        for (const root of homes) {
          for (const entry of SENSITIVE_PATH_ENTRIES.filter((entry) => entry.anchor !== "root")) {
            const path = join(root, ...(entry.anchor === "ave-home" ? [".ave"] : []), ...entry.segments);
            expect(denied).toContain(path + (entry.kind === "dir" ? sep : ""));
          }
          expect(denied).toContain(join(root, "AppData", "Roaming", "Ave") + sep);
        }
        if (shellHome !== explicitHome) expect(denied.some((path) => path.startsWith(explicitHome + sep))).toBe(false);
      }
      const writes = getDefaultSensitiveWriteDenyPaths();
      for (const root of homes) {
        expect(writes).toContain(join(root, ".bashrc"));
        expect(writes).toContain(join(root, ".config") + sep);
        expect(writes).toContain(join(root, "Library", "LaunchAgents") + sep);
      }
      if (shellHome === explicitHome) {
        const policy = getBuiltinShellReadPolicy([], explicitHome);
        expect(policy.allowRead).toContain(canonicalizePathForMatch(join(home, ".ave", "sessions")));
        expect(policy.denyRead).toContain(join(explicitHome, ".ave", "sessions") + sep);
      }
    }
  });

  it.each(["profile", "shell"])("checks the %s tilde anchor through shell operands and scanners", (anchor) => {
    const explicitHome = join(home, "explicit");
    mkdirSync(explicitHome);
    vi.stubEnv("HOME", explicitHome);
    const sensitiveHome = anchor === "profile" ? home : explicitHome;
    const ordinaryHome = anchor === "profile" ? explicitHome : home;
    mkdirSync(join(sensitiveHome, ".ssh"));
    mkdirSync(join(ordinaryHome, "alias"));
    symlinkSync(join(sensitiveHome, ".ssh"), join(sensitiveHome, "alias"), "junction");
    // The alias makes checking only one expansion observably insufficient.
    if (anchor === "profile") {
      expect(findShellPathPolicyViolation("cat ~/alias/key", home, home, [explicitHome], false, {
        dialect: "bash", environment: { HOME: explicitHome, USERPROFILE: home },
      })).toBeNull();
    }
    expect(sensitivePathInArgumentText("~/alias/key", home)).not.toBeNull();
    expect(shellSensitivePathSignal("cat ~/alias/key", home)).not.toBeNull();
    for (const root of [home, explicitHome]) {
      expect(findShellPathPolicyViolation("cat ~/.ssh/key", home, home, [explicitHome], false, {
        dialect: "bash", environment: { HOME: root, USERPROFILE: home },
      })).toBeNull();
      expect(sensitivePathInArgumentText(join(root, ".ssh", "key"), home)).not.toBeNull();
    }
  });

  it("keeps child HOME absent", () => {
    expect(buildSafeChildEnv()).not.toHaveProperty("HOME");
  });

  // Confined shells read the host home; its sensitive entries stay denied from the USERPROFILE anchor when HOME is absent.
  it("keeps home-anchored sensitive reads denied without changing child HOME", () => {
    const policy = getBuiltinShellReadPolicy([], getPolicyHome());
    expect(policy.denyRead).not.toContain(home);
    expect(policy.denyRead.map((path) => canonicalizePathForMatch(path)))
      .toContain(canonicalizePathForMatch(join(home, ".ssh")));
    expect(buildSafeChildEnv()).not.toHaveProperty("HOME");
  });

  it("preserves missing directory kinds in deny projections", () => {
    for (const denied of [getDefaultSensitiveReadDenyPaths(), getDefaultSensitiveWriteDenyPaths()]) {
      for (const entry of SENSITIVE_PATH_ENTRIES) {
        const path = entry.anchor === "root" ? "/" + entry.segments.join("/")
          : join(entry.anchor === "ave-home" ? join(home, ".ave") : home, ...entry.segments);
        expect(denied).toContain(path + (entry.kind === "dir" ? sep : ""));
        expect(denied).not.toContain(path + (entry.kind === "dir" ? "" : sep));
      }
    }
  });
});

describe("independent home anchors", () => {
  const platform = process.platform;
  let scratch: string;
  let home: string;
  let shellHome: string;
  let passwd: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ave-home-anchors-"));
    // Keep the temporary drive explicit while exercising POSIX policy on a native host.
    home = platform === "win32" ? scratch.replace(/\\/g, "/") : scratch;
    shellHome = home + "/shell";
    passwd = home + "/account";
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.mocked(homedir).mockReturnValue(home);
    vi.mocked(userInfo).mockReturnValue({ homedir: passwd, username: "test-account", uid: 1000, gid: 1000, shell: "/bin/sh" });
    vi.stubEnv("HOME", shellHome);
    vi.stubEnv("USERPROFILE", undefined);
    vi.stubEnv("HOMEDRIVE", undefined);
    vi.stubEnv("HOMEPATH", undefined);
    vi.stubEnv("AVE_HOME", join(scratch, "app"));
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    vi.unstubAllEnvs();
    vi.mocked(homedir).mockReset().mockImplementation(() => platform === "win32" ? process.env.USERPROFILE! : process.env.HOME!);
    vi.mocked(userInfo).mockReset();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps cwd and conventional stores with an empty application home", () => {
    vi.stubEnv("AVE_HOME", "");
    for (const denied of [getDefaultSensitiveReadDenyPaths(), getDefaultSensitiveWriteDenyPaths()]) {
      for (const root of [process.cwd(), join(home, ".ave"), join(shellHome, ".ave"), join(passwd, ".ave")]) {
        for (const leaf of ["secrets", "sessions", "audit"]) expect(denied).toContain(join(root, leaf));
      }
    }
  });

  it("retains every sensitive table row and write floor at the passwd home", () => {
    for (const denied of [getDefaultSensitiveReadDenyPaths(), getDefaultSensitiveWriteDenyPaths()]) {
      for (const root of [home, shellHome, passwd]) {
        for (const entry of SENSITIVE_PATH_ENTRIES.filter((entry) => entry.anchor !== "root")) {
          expect(denied).toContain(join(root, ...(entry.anchor === "ave-home" ? [".ave"] : []), ...entry.segments));
        }
      }
    }
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(passwd, ".bashrc"));
    expect(policyHomeAnchors()).toEqual([home, shellHome, passwd]);
  });

  it.each(["rel", "/"])("ignores invalid HOME %s without adding deny rows", (HOME) => {
    vi.stubEnv("HOME", HOME);
    const denied = getDefaultSensitiveWriteDenyPaths();
    expect(denied).toContain(join(passwd, ".bashrc"));
    expect(denied).not.toContain(join(HOME, ".ssh"));
    expect(policyHomeAnchors()).toEqual([home, passwd]);
  });

  it("keeps deny projections usable with an empty OS home", () => {
    vi.stubEnv("HOME", "");
    vi.mocked(homedir).mockReturnValue("");
    expect(getDefaultSensitiveReadDenyPaths()).toContain(join(passwd, ".ssh"));
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(passwd, ".bashrc"));
    expect(getPolicyHome()).toBe(passwd);
  });

  it("refuses deny projections when no home resolves", () => {
    vi.stubEnv("HOME", "");
    vi.mocked(homedir).mockReturnValue("");
    vi.mocked(userInfo).mockImplementation(() => { throw Object.assign(new Error("No account entry"), { code: "ENOENT" }); });
    const userData = join(scratch, "app-data");
    expect(() => getDefaultSensitiveReadDenyPaths(userData)).toThrow("Cannot resolve home for path policy");
    expect(() => getDefaultSensitiveWriteDenyPaths(userData)).toThrow("Cannot resolve home for path policy");
  });

  it("allows ordinary removal and refuses home-shaped forced removal without an account", () => {
    vi.stubEnv("HOME", "");
    vi.mocked(homedir).mockReturnValue("");
    vi.mocked(userInfo).mockImplementation(() => { throw Object.assign(new Error("No account entry"), { code: "ENOENT" }); });
    expect(new BashAstValidator().validate("bash", { command: "rm foo" }, {
      cwd: scratch, facts: { dialect: "bash", environment: { HOME: "" } },
    }).decision).toBe("allow");
    for (const command of ["rm -rf ~/", "rm -rf $HOME", 'rm -rf "${HOME}"/']) {
      expect(new BashAstValidator().validate("bash", { command }, {
        cwd: scratch, facts: { dialect: "bash", environment: { HOME: "" } },
      }).decision).toBe("deny");
    }
  });

  it("scans HOME parameters with an empty OS home", () => {
    vi.stubEnv("HOME", "");
    vi.mocked(homedir).mockReturnValue("");
    expect(shellSensitivePathSignal("echo $HOME", scratch)).toBeNull();
    vi.mocked(userInfo).mockImplementation(() => { throw Object.assign(new Error("No account entry"), { code: "ENOENT" }); });
    expect(() => shellSensitivePathSignal("echo $HOME", scratch)).toThrow("Cannot resolve home for path policy");
  });

  it("refuses recursive removal of the passwd home when HOME differs", () => {
    expect(new BashAstValidator().validate("bash", { command: `rm -rf '${passwd}'` }, {
      cwd: scratch, facts: { dialect: "bash", environment: { HOME: shellHome } },
    }).decision).toBe("deny");
  });

  it("checks the passwd tilde anchor through operands and scanners", () => {
    mkdirSync(join(passwd, ".ssh"), { recursive: true });
    symlinkSync(join(passwd, ".ssh"), join(passwd, "alias"), platform === "win32" ? "junction" : "dir");
    expect(findShellPathPolicyViolation("cat ~/alias/key", scratch, home, [home, shellHome, passwd], false, {
      dialect: "bash", environment: { HOME: shellHome },
    })).toBeNull();
    expect(sensitivePathInArgumentText("~/alias/key", scratch)).not.toBeNull();
    expect(shellSensitivePathSignal("cat ~/alias/key", scratch)).not.toBeNull();
    expect(expandLeadingTilde("~")).toBe(home);
  });
});

describe("unresolved home policy", () => {
  beforeEach(() => {
    for (const key of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) vi.stubEnv(key, undefined);
    vi.stubEnv("AVE_HOME", join(tmpdir(), "ave-unresolved-policy"));
    vi.mocked(homedir).mockReturnValue("/");
    vi.mocked(userInfo).mockImplementation(() => { throw Object.assign(new Error("No account entry"), { code: "ENOENT" }); });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(homedir).mockReset().mockImplementation(() => process.platform === "win32" ? process.env.USERPROFILE! : process.env.HOME!);
    vi.mocked(userInfo).mockReset();
  });

  it.each(["", "/"])("refuses both sandbox deny floors without a home anchor for HOME=%s", (HOME) => {
    vi.stubEnv("HOME", HOME);
    const userData = join(tmpdir(), "ave-unresolved-user-data");
    expect(() => getDefaultSensitiveReadDenyPaths(userData)).toThrow("Cannot resolve home for path policy");
    expect(() => getDefaultSensitiveWriteDenyPaths(userData)).toThrow("Cannot resolve home for path policy");
  });

  it.each(["", "/"])("refuses forced recursive removal without a home anchor for HOME=%s", (HOME) => {
    vi.stubEnv("HOME", HOME);
    for (const command of ["rm -rf ~/.ssh", "rm -rf '$HOME/.ssh'", "rm -rf ./build"]) {
      expect(new BashAstValidator().validate("bash", { command }, {
        cwd: process.cwd(), facts: { dialect: "bash", environment: { HOME } },
      }).decision).toBe("deny");
    }
  });

  it.each(["", "/"])("refuses shell tilde expansion without a home anchor for HOME=%s", (HOME) => {
    vi.stubEnv("HOME", HOME);
    for (const path of ["~", "~/.ssh"]) {
      expect(() => expandShellTildePaths(path)).toThrow("Cannot resolve home for path policy");
    }
  });

  it("does not resolve home for ordinary commands and words", () => {
    vi.mocked(homedir).mockClear();
    vi.mocked(userInfo).mockClear();
    for (const command of ["echo hello", "rm foo"]) {
      expect(new BashAstValidator().validate("bash", { command }, {
        cwd: process.cwd(), facts: { dialect: "bash", environment: {} },
      }).decision).toBe("allow");
    }
    expect(expandShellTildePaths("./ordinary")).toEqual(["./ordinary"]);
    expect(homedir).not.toHaveBeenCalled();
    expect(userInfo).not.toHaveBeenCalled();
    for (const command of ["echo hello", "rm foo"]) expect(shellSensitivePathSignal(command, process.cwd())).toBeNull();
    expect(sensitivePathInArgumentText("./ordinary", process.cwd())).toBeNull();
  });
});

describe.skipIf(process.platform !== "win32")("independent profile anchors", () => {
  let home: string;
  let profile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-profile-anchors-"));
    profile = join(home, "profile");
    vi.mocked(userInfo).mockReturnValue({ homedir: profile, username: "test-account", uid: 1000, gid: 1000, shell: "/bin/sh" });
    // As on a real host, os.homedir is USERPROFILE.
    vi.mocked(homedir).mockReturnValue(profile);
    vi.stubEnv("HOME", join(home, "shell"));
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("HOMEDRIVE", undefined);
    vi.stubEnv("HOMEPATH", undefined);
    vi.stubEnv("AVE_HOME", join(home, "app"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(homedir).mockReset().mockImplementation(() => process.env.USERPROFILE!);
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps every default app-data copy a directory", () => {
    for (const denied of [getDefaultSensitiveReadDenyPaths(), getDefaultSensitiveWriteDenyPaths()]) {
      for (const root of [profile, process.env.HOME!]) {
        const path = join(root, "AppData", "Roaming", "Ave");
        expect(denied).toContain(path + sep);
        expect(denied).not.toContain(path);
      }
    }
  });

  it.each(["", "\\", "/"])("keeps trusted app-data a directory with suffix %s", (suffix) => {
    const userData = join(home, "app-data");
    for (const denied of [getDefaultSensitiveReadDenyPaths(userData + suffix), getDefaultSensitiveWriteDenyPaths(userData + suffix)]) {
      expect(denied).toContain(userData + sep);
      expect(denied).not.toContain(userData);
      expect(protectedReadDenyCovering(join(userData, "Partitions", "cookie"), denied)).toBe(userData + sep);
      expect(protectedReadDenyCovering(userData + "-sibling", denied)).toBeUndefined();
    }
  });

  it.each(["rel", "/", "\\shell", "C:\\", "C:/"])("ignores invalid profile HOME %s", (HOME) => {
    vi.stubEnv("HOME", HOME);
    expect(policyHomeAnchors()).toEqual([profile]);
    expect(getDefaultSensitiveWriteDenyPaths()).not.toContain(join(HOME, ".bashrc"));
  });

  it("anchors the drive and path when the OS home throws on an empty profile", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("HOMEDRIVE", profile.slice(0, 2));
    vi.stubEnv("HOMEPATH", profile.slice(2));
    vi.mocked(homedir).mockImplementation(() => { throw Object.assign(new Error("uv_os_homedir returned ENOENT"), { code: "ENOENT" }); });
    expect(policyHomeAnchors()).toEqual([profile]);
    expect(getPolicyHome()).toBe(profile);
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(profile, ".bashrc"));
  });

  it.each(["case", "separator"])("deduplicates profile HOME by %s", (form) => {
    vi.stubEnv("HOME", form === "case" ? profile.toUpperCase() : profile.replace(/\\/g, "/"));
    expect(policyHomeAnchors()).toEqual([profile]);
    const denied = getDefaultSensitiveWriteDenyPaths();
    expect(denied.filter((path) => /[/\\]AppData[/\\]Roaming[/\\]Ave[/\\]$/i.test(path))).toHaveLength(1);
  });

  it("refuses recursive removal of USERPROFILE when HOME differs", () => {
    expect(new BashAstValidator().validate("bash", { command: `rm -rf '${profile.replace(/\\/g, "/")}'` }, {
      cwd: home, facts: { dialect: "bash", environment: { HOME: process.env.HOME, USERPROFILE: profile } },
    }).decision).toBe("deny");
  });
});

describe("deny floor spellings", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-deny-spellings-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a linked runtime key spelling next to its target", () => {
    const keys = join(root, "keys");
    mkdirSync(keys);
    writeFileSync(join(keys, "key-material"), "synthetic-key-fixture");
    const alias = join(root, "keys-alias");
    symlinkSync(keys, alias, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("AVE_SECRET_KEY_FILE", join(alias, "key-material"));
    const target = realpathSync.native(join(keys, "key-material"));
    for (const denied of [getDefaultSensitiveReadDenyPaths(), getDefaultSensitiveWriteDenyPaths()]) {
      expect(denied).toEqual(expect.arrayContaining([join(alias, "key-material"), target]));
    }
  });
});
