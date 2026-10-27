import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileFactory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../permissions/sandbox-process-home.js", () => ({ createSandboxProcessHome: profileFactory.create }));

import { POWERSHELL_MODULE_PRELUDE, preparePowerShellLaunch, retainPowerShellLaunchUntilExit } from "../powershell-launch.js";
import type { SandboxProcessHome } from "../../permissions/sandbox-process-home.js";

const originalPlatform = process.platform;
const profiles: SandboxProcessHome[] = [];

function newProfile(): SandboxProcessHome {
  const path = mkdtempSync(join(tmpdir(), "shell-launch-profile-"));
  const profile = { path, env: { HOME: path, XDG_CONFIG_HOME: join(path, "old-config") }, cleanup: vi.fn(() => rmSync(path, { recursive: true, force: true })) };
  profiles.push(profile);
  return profile;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  profileFactory.create.mockReset();
  profileFactory.create.mockImplementation(newProfile);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  for (const profile of profiles.splice(0)) profile.cleanup();
});

describe("controlled shell startup", () => {
  it("retains live-child configuration after an operation error until close", () => {
    const plan = preparePowerShellLaunch("Get-Date", {});
    const child = new ChildProcess();
    Object.assign(child, { pid: 42, exitCode: null, signalCode: null });
    retainPowerShellLaunchUntilExit(plan, child);
    child.emit("error", new Error("signal operation refused"));
    expect(existsSync(plan.args[4]!)).toBe(true);
    expect(profiles[0]!.cleanup).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    expect(existsSync(plan.args[4]!)).toBe(false);
    expect(profiles[0]!.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans configuration when spawn has no child and tolerates repeated terminal events", () => {
    const plan = preparePowerShellLaunch("Get-Date", {});
    const child = new ChildProcess();
    expect(child.pid).toBeUndefined();
    retainPowerShellLaunchUntilExit(plan, child);
    child.emit("error", new Error("spawn failed"));
    child.emit("error", new Error("spawn failed again"));
    child.emit("close", -1, null);
    expect(existsSync(plan.args[4]!)).toBe(false);
    expect(profiles[0]!.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: "SIGTERM" },
  ] as const)("cleans on an error after definite termination: $exitCode/$signalCode", (termination) => {
    const plan = preparePowerShellLaunch("Get-Date", {});
    const child = new ChildProcess();
    Object.assign(child, { pid: 42, ...termination });
    retainPowerShellLaunchUntilExit(plan, child);
    child.emit("error", new Error("operation after termination"));
    expect(existsSync(plan.args[4]!)).toBe(false);
    child.emit("close", termination.exitCode, termination.signalCode);
    expect(profiles[0]!.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not confuse unavailable termination observations with an exit", () => {
    const plan = preparePowerShellLaunch("Get-Date", {});
    const child = new ChildProcess();
    Object.assign(child, { pid: 42, exitCode: undefined, signalCode: undefined });
    retainPowerShellLaunchUntilExit(plan, child);
    child.emit("error", new Error("operation failed before exit"));
    expect(profiles[0]!.cleanup).not.toHaveBeenCalled();
    child.emit("close", null, "SIGTERM");
    expect(profiles[0]!.cleanup).toHaveBeenCalledTimes(1);
  });

  it("isolates both configuration scopes while retaining the caller home", () => {
    const callerHome = join(tmpdir(), "caller-home");
    const baseEnv = { HOME: callerHome, XDG_CONFIG_HOME: join(callerHome, "untrusted"), PSModulePath: "untrusted-modules", psMODULEpath: "other-modules", PATH: "runtime-path" };
    const plan = preparePowerShellLaunch("Write-Output ready", baseEnv);
    expect(plan.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-SettingsFile"]);
    const settings = plan.args[4]!;
    expect(readFileSync(settings, "utf8")).toBe("{}\n");
    expect(plan.env.HOME).toBe(callerHome);
    expect(plan.env.PATH).toBe("runtime-path");
    expect(plan.env.XDG_CONFIG_HOME).toBe(dirname(settings));
    expect(plan.env.XDG_CONFIG_HOME).not.toBe(baseEnv.XDG_CONFIG_HOME);
    expect(plan.env.PSModulePath).toBe(join(dirname(settings), "modules"));
    expect(plan.env).not.toHaveProperty("psMODULEpath");
    expect(baseEnv.PSModulePath).toBe("untrusted-modules");
    if (originalPlatform !== "win32") {
      expect(statSync(dirname(settings)).mode & 0o777).toBe(0o700);
      expect(statSync(settings).mode & 0o777).toBe(0o600);
    }
    plan.cleanup();
    plan.cleanup();
    expect(profiles[0]!.cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(settings)).toBe(false);
  });

  it("preserves the complete command text after fail-closed initialization", () => {
    const command = "Write-Output '0x10'\r\nWrite-Output \"quoted\"; # trailing content";
    const plan = preparePowerShellLaunch(command, {});
    expect(plan.args.at(-2)).toBe("-Command");
    expect(plan.args.at(-1)).toBe(POWERSHELL_MODULE_PRELUDE + command);
    expect(POWERSHELL_MODULE_PRELUDE.indexOf("$PSModuleAutoLoadingPreference = 'None'")).toBeLessThan(POWERSHELL_MODULE_PRELUDE.indexOf("Import-Module"));
    expect(POWERSHELL_MODULE_PRELUDE).toContain("$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')");
    for (const module of ["Utility", "Management"]) {
      expect(POWERSHELL_MODULE_PRELUDE).toContain(`'Microsoft.PowerShell.${module}', 'Microsoft.PowerShell.${module}.psd1'`);
    }
    expect(POWERSHELL_MODULE_PRELUDE.match(/Microsoft\.PowerShell\.Core\\Import-Module/g)).toHaveLength(2);
    expect(POWERSHELL_MODULE_PRELUDE.match(/-Global -ErrorAction Stop/g)).toHaveLength(2);
    expect(POWERSHELL_MODULE_PRELUDE).toContain("catch { [System.Console]::Error.WriteLine('Shell module initialization failed'); exit 197 }");
  });

  it("uses a fresh configuration directory without taking ownership of a borrowed profile", () => {
    const profile = newProfile();
    const first = preparePowerShellLaunch("Get-Date", { HOME: profile.path }, profile);
    const second = preparePowerShellLaunch("Get-Date", { HOME: profile.path }, profile);
    expect(profileFactory.create).not.toHaveBeenCalled();
    expect(first.env.XDG_CONFIG_HOME).not.toBe(profile.env.XDG_CONFIG_HOME);
    expect(first.env.XDG_CONFIG_HOME).not.toBe(second.env.XDG_CONFIG_HOME);
    first.cleanup();
    second.cleanup();
    expect(profile.cleanup).not.toHaveBeenCalled();
    expect(existsSync(first.args[4]!)).toBe(true);
  });

  it("cleans up its own profile when configuration preparation fails", () => {
    const profile = newProfile();
    rmSync(profile.path, { recursive: true, force: true });
    profileFactory.create.mockReturnValue(profile);
    expect(() => preparePowerShellLaunch("Get-Date", {})).toThrow();
    expect(profile.cleanup).toHaveBeenCalledTimes(1);
  });

  it("leaves borrowed-profile cleanup with its caller on preparation failure", () => {
    const profile = newProfile();
    rmSync(profile.path, { recursive: true, force: true });
    expect(() => preparePowerShellLaunch("Get-Date", {}, profile)).toThrow();
    expect(profile.cleanup).not.toHaveBeenCalled();
  });

  it("does not claim a settings-file or user-configuration pin on an unsupported platform", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const plan = preparePowerShellLaunch("Get-Date", { HOME: "retained-home", PSModulePath: "untrusted", PSMODULEPATH: "other" });
    expect(plan.args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command"]);
    expect(plan.args).not.toContain("-SettingsFile");
    expect(plan.env).toEqual({ HOME: "retained-home", PSModulePath: "" });
    expect(profileFactory.create).not.toHaveBeenCalled();
    expect(plan.args.at(-1)).toBe(POWERSHELL_MODULE_PRELUDE + "Get-Date");
    plan.cleanup();
  });
});
