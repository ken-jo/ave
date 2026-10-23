import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { getPolicyHome } from "../../shared/policy-home.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import { findShellPathPolicyViolation } from "../../tools/shell-path-policy.js";
import { getBuiltinShellReadPolicy, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { canonicalizePathForMatch, SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import { sensitivePathInArgumentText, shellSensitivePathSignal } from "../rules/shell-exfiltration.js";

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
          expect(denied).toContain(join(root, "AppData", "Roaming", "Ave"));
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
      })?.kind).toBe("sensitive-path");
    } else {
      expect(sensitivePathInArgumentText("~/alias/key", home)).not.toBeNull();
      expect(shellSensitivePathSignal("cat ~/alias/key", home)).not.toBeNull();
    }
    for (const root of [home, explicitHome]) {
      expect(findShellPathPolicyViolation("cat ~/.ssh/key", home, home, [explicitHome], false, {
        dialect: "bash", environment: { HOME: root, USERPROFILE: home },
      })?.kind).toBe("sensitive-path");
    }
  });

  it("keeps child HOME absent", () => {
    expect(buildSafeChildEnv()).not.toHaveProperty("HOME");
  });

  it("retains the host-home read jail without changing child HOME", () => {
    const policy = getBuiltinShellReadPolicy([], getPolicyHome());
    expect(policy.denyRead).toContain(home);
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
