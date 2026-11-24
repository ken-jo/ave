import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../../shared/host-program-path.js", () => ({
  findHostProgram: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { findHostProgram } from "../../shared/host-program-path.js";
import { resolveShell, ShellMismatchError, __resetShellResolverCache } from "../shell-resolver.js";

const onPath = (programs: Record<string, string>) => {
  vi.mocked(findHostProgram).mockImplementation((name) => programs[name] ?? null);
};

beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  onPath({ sh: "/usr/bin/sh" });
});

afterEach(() => {
  __resetShellResolverCache();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(findHostProgram).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("shell-resolver", () => {
  it("looks up sh and bash on PATH only, never through a command-line lookup or a bare name", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    onPath({});
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => resolveShell()).toThrow(ShellMismatchError);
    expect(findHostProgram).toHaveBeenCalledWith("sh");
    expect(findHostProgram).toHaveBeenCalledWith("bash");
    expect(vi.mocked(execFileSync).mock.calls.every(([cmd]) => /^[A-Za-z]:\\/u.test(String(cmd)) && !/where/iu.test(String(cmd)))).toBe(true);
  });
  it("returns the absolute sh found on PATH on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);
    onPath({ sh: "D:\\Runtime\\sh.exe" });
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd).includes("C:\\Program Files\\Git\\")) {
        throw new Error("not installed");
      }
      if (cmd === "D:\\Runtime\\sh.exe" && args[1] === "printf __ave_shell_ok__") {
        return "__ave_shell_ok__";
      }
      if (cmd === "D:\\Runtime\\sh.exe" && args[1] === "uname -s") {
        return "MSYS_NT";
      }
      throw new Error("unexpected command");
    });

    const shell = resolveShell();
    expect(shell.cmd).toBe("D:\\Runtime\\sh.exe");
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(shell.windowsFlavor).toBe("msys");
  });

  it("prefers Git for Windows sh over the WSL bash launcher", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "C:\\Program Files\\Git\\usr\\bin\\sh.exe" && args[1] === "printf __ave_shell_ok__") {
        return "__ave_shell_ok__";
      }
      if (cmd === "C:\\Program Files\\Git\\usr\\bin\\sh.exe" && args[1] === "uname -s") {
        return "MINGW64_NT";
      }
      throw new Error("unexpected command");
    });

    const shell = resolveShell();

    expect(shell.cmd).toBe("C:\\Program Files\\Git\\usr\\bin\\sh.exe");
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(shell.windowsFlavor).toBe("msys");
  });

  it("falls back to bash on Windows when sh is missing", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);
    onPath({ bash: "D:\\Runtime\\bash.exe" });
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd).includes("C:\\Program Files\\Git\\")) {
        throw new Error("not installed");
      }
      if (cmd === "D:\\Runtime\\bash.exe" && args[1] === "printf __ave_shell_ok__") {
        return "__ave_shell_ok__";
      }
      if (cmd === "D:\\Runtime\\bash.exe" && args[1] === "uname -s") {
        return "MINGW64_NT";
      }
      throw new Error("unexpected command");
    });

    const shell = resolveShell();
    expect(shell.cmd).toBe("D:\\Runtime\\bash.exe");
    expect(shell.shellArgs("echo hi")).toEqual(["-lc", "echo hi"]);
    expect(shell.windowsFlavor).toBe("msys");
  });

  it("ignores an env-redirected Program Files root; a drive root is user-writable by default", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    // A non-admin can set these process-env vars and create a folder at a drive root (Authenticated
    // Users may create subdirectories at C:\ by default), so an env-derived root would be attacker
    // controllable. The shell roots stay hardcoded and admin-owned by construction: no D:\evil candidate.
    for (const key of ["ProgramW6432", "ProgramFiles"]) vi.stubEnv(key, "D:\\evil");
    vi.stubEnv("ProgramFiles(x86)", "D:\\evil (x86)");
    vi.mocked(execFileSync).mockImplementation((cmd) => {
      if (cmd === "C:\\Program Files\\Git\\bin\\bash.exe") return "__ave_shell_ok__";
      throw new Error("not installed");
    });

    const shell = resolveShell("bash");

    expect(shell.cmd).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(vi.mocked(execFileSync).mock.calls.every(([cmd]) => !/^d:\\evil/i.test(String(cmd)))).toBe(true);
  });

  it("returns the absolute sh found on PATH on POSIX", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux" as NodeJS.Platform);

    const shell = resolveShell();

    expect(shell.cmd).toBe("/usr/bin/sh");
    expect(findHostProgram).toHaveBeenCalledWith("sh");
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("refuses POSIX sh missing from PATH instead of returning the bare name", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux" as NodeJS.Platform);
    onPath({});
    expect(() => resolveShell()).toThrow(ShellMismatchError);
  });

  it("resolves Bash separately from the generic POSIX dialect", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockReturnValue("__ave_shell_ok__");
    expect(resolveShell().cmd).toBe("/usr/bin/sh");
    const bash = resolveShell("bash");
    expect(bash.cmd).toBe("/bin/bash");
    expect(bash.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(resolveShell("bash")).toBe(bash);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(resolveShell().cmd).toBe("/usr/bin/sh");
  });

  it("reports missing Bash without falling back to sh or poisoning POSIX resolution", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("missing executable"); });
    expect(() => resolveShell("bash")).toThrow(/requires Bash/);
    expect(() => resolveShell("bash")).toThrow(ShellMismatchError);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(resolveShell().cmd).toBe("/usr/bin/sh");
  });

  it("rejects executables that do not prove the Bash dialect", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockReturnValue("");
    expect(() => resolveShell("bash")).toThrow(/requires Bash/);
  });

  it("selects a Windows Bash executable even when generic sh is available", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(execFileSync).mockReturnValue("__ave_shell_ok__");
    expect(resolveShell().cmd).toMatch(/sh\.exe$/);
    const bash = resolveShell("bash");
    expect(bash.cmd).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(bash.windowsFlavor).toBe("msys");
    expect(bash.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(execFileSync).toHaveBeenLastCalledWith(bash.cmd,
      ["-c", expect.stringContaining("<<<")], expect.any(Object));
  });

  it("pins and probes the absolute Bash path found on PATH", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const executable = "D:\\Shell Runtime\\bash.exe";
    onPath({ bash: executable });
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd !== executable) throw new Error("not installed");
      return Array.isArray(args) && args[1] === "uname -s" ? "MSYS_NT" : "__ave_shell_ok__";
    });

    const shell = resolveShell("bash");
    expect(shell.cmd).toBe(executable);
    expect(shell.windowsFlavor).toBe("msys");
    expect(execFileSync).toHaveBeenCalledWith(executable,
      ["-c", expect.stringContaining("<<<")], expect.any(Object));
    expect(execFileSync).toHaveBeenCalledWith(executable,
      ["-c", "uname -s"], expect.any(Object));
    expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === "bash")).toBe(false);
    expect(resolveShell("bash")).toBe(shell);
  });

  it("refuses Windows Bash missing from PATH without probing a bare command", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    onPath({});
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not installed"); });
    expect(() => resolveShell("bash")).toThrow(/bash was not found on PATH/);
    expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === "bash" || cmd === "sh")).toBe(false);
  });

  it.each([
    { platform: "linux", dialect: "bash", executable: "/bin/bash", lookup: "bash" },
    { platform: "win32", dialect: "bash", executable: "D:\\Runtime\\bash.exe", lookup: "bash" },
    { platform: "win32", dialect: "posix", executable: "D:\\Runtime\\sh.exe", lookup: "sh" },
  ] as const)("filters every $platform $dialect probe environment", ({ platform, dialect, executable, lookup }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubEnv("OPENAI_API_KEY", "sentinel-provider-secret");
    vi.stubEnv("AVE_INTERNAL_SECRET", "sentinel-host-secret");
    vi.stubEnv("BASH_ENV", "/sentinel-startup-script");
    vi.stubEnv("PATH", "sentinel-runtime-path");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("USERPROFILE", "sentinel-user-profile");
    vi.stubEnv("LANG", "sentinel-locale");
    onPath({ [lookup]: executable });
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd !== executable) throw new Error("not installed");
      return Array.isArray(args) && args[1] === "uname -s" ? "MSYS_NT" : "__ave_shell_ok__";
    });

    expect(resolveShell(dialect).cmd).toBe(executable);
    if (platform === "win32") {
      expect(findHostProgram).toHaveBeenCalledWith(lookup);
      expect(execFileSync).toHaveBeenCalledWith(executable, ["-c", "uname -s"], expect.any(Object));
    }
    for (const [, , options] of vi.mocked(execFileSync).mock.calls) {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(env?.OPENAI_API_KEY).toBeUndefined();
      expect(env?.AVE_INTERNAL_SECRET).toBeUndefined();
      expect(env?.BASH_ENV).toBeUndefined();
      expect(env?.PATH).toBe("sentinel-runtime-path");
      expect(env?.SystemRoot).toBe("C:\\Windows");
      expect(env?.USERPROFILE).toBe("sentinel-user-profile");
      expect(env?.LANG).toBe("sentinel-locale");
    }
  });

  it("ShellMismatchError exposes a stable code", () => {
    expect(new ShellMismatchError("x").code).toBe("SHELL_MISMATCH");
  });
});
