/** Settings confinement text must reflect measured platform capabilities without overclaiming. */
import { describe, it, expect } from "vitest";
import {
  describeShellSandboxStatus,
  sandboxConfinementForPlatform,
  type SandboxBootOutcome,
  type ShellSandboxStatusInput,
} from "../sandbox-capability-info.js";

describe("sandboxConfinementForPlatform", () => {
  it("macOS confines filesystem + process + network (Seatbelt via ASRT — egress contained by the loopback proxy + strict-union allow-list)", () => {
    expect(sandboxConfinementForPlatform("darwin", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
  });

  it("Linux confines filesystem + process + network (bwrap via ASRT)", () => {
    expect(sandboxConfinementForPlatform("linux", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
  });

  it("Windows confines nothing — fail-closed, no sandbox", () => {
    expect(sandboxConfinementForPlatform("win32", "none")).toEqual({
      filesystem: false,
      process: false,
      network: false,
    });
  });

  it("Windows ASRT confines filesystem + network, but not process", () => {
    expect(sandboxConfinementForPlatform("win32", "partial")).toEqual({
      filesystem: true,
      process: false,
      network: true,
    });
  });

  it("honors partial kind on platforms that are normally full", () => {
    expect(sandboxConfinementForPlatform("darwin", "partial")).toEqual({
      filesystem: true,
      process: false,
      network: true,
    });
  });

  it("reports no confinement when the runner kind is none regardless of platform", () => {
    expect(sandboxConfinementForPlatform("linux", "none")).toEqual({
      filesystem: false,
      process: false,
      network: false,
    });
    expect(sandboxConfinementForPlatform("darwin", "none")).toEqual({
      filesystem: false,
      process: false,
      network: false,
    });
  });

  it("claims REAL network containment on macOS when active (ASRT loopback-proxy floor)", () => {
    expect(sandboxConfinementForPlatform("darwin", "full").network).toBe(true);
  });
});

const ACTIVATED: SandboxBootOutcome = {
  action: "activate",
  reason: "deps-present",
  onSignal: "default-settings",
  dependencyErrors: [],
  causes: [],
};
const SKIPPED: SandboxBootOutcome = {
  action: "skip",
  reason: "gate-off",
  onSignal: "off",
  dependencyErrors: [],
  causes: [],
};

function input(overrides: Partial<ShellSandboxStatusInput>): ShellSandboxStatusInput {
  return {
    platformSupported: true,
    setting: false,
    envForced: false,
    requestedAtBoot: false,
    boot: SKIPPED,
    shellPlanMode: "plain",
    shellPlanFallback: "none",
    ...overrides,
  };
}

describe("describeShellSandboxStatus", () => {
  it("is on only when shells actually run under the sandbox plan", () => {
    expect(describeShellSandboxStatus(input({
      setting: true, requestedAtBoot: true, boot: ACTIVATED, shellPlanMode: "asrt",
    }))).toEqual({ state: "on", setting: true, envForced: false, causes: [] });
  });

  it("is off when nothing is requested and nothing waits for a restart", () => {
    expect(describeShellSandboxStatus(input({})).state).toBe("off");
  });

  it("names every boot failure cause when the requested sandbox did not start", () => {
    const degraded: SandboxBootOutcome = {
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "default-settings",
      dependencyErrors: ["bubblewrap (bwrap) not installed", "socat not installed"],
      causes: ["missing-bwrap", "missing-socat"],
    };
    expect(describeShellSandboxStatus(input({
      setting: true, requestedAtBoot: true, boot: degraded, shellPlanFallback: "requested-sandbox-unavailable",
    }))).toEqual({ state: "unavailable", setting: true, envForced: false, causes: ["missing-bwrap", "missing-socat"] });
  });

  it("reports Windows Plan B as unavailable for shells even though ASRT is active", () => {
    expect(describeShellSandboxStatus(input({
      setting: true, requestedAtBoot: true, boot: ACTIVATED, shellPlanFallback: "windows-partial-shell-acl-unsafe",
    }))).toMatchObject({ state: "unavailable", causes: ["windows-shell-not-contained"] });
  });

  it("is pending-on when the setting was turned on after boot, including a worker-only activation", () => {
    expect(describeShellSandboxStatus(input({ setting: true })).state).toBe("pending-on");
    expect(describeShellSandboxStatus(input({ setting: true, boot: ACTIVATED })).state).toBe("pending-on");
  });

  it("is pending-off while a booted sandbox keeps running after the setting went off", () => {
    expect(describeShellSandboxStatus(input({
      requestedAtBoot: true, boot: ACTIVATED, shellPlanMode: "asrt",
    })).state).toBe("pending-off");
  });

  it("is plainly off when the setting went off after a boot whose sandbox never contained shells", () => {
    const degraded: SandboxBootOutcome = {
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "default-settings",
      dependencyErrors: ["bubblewrap (bwrap) not installed"],
      causes: ["missing-bwrap"],
    };
    expect(describeShellSandboxStatus(input({
      requestedAtBoot: true, boot: degraded, shellPlanFallback: "requested-sandbox-unavailable",
    })).state).toBe("off");
    expect(describeShellSandboxStatus(input({
      requestedAtBoot: true, boot: ACTIVATED, shellPlanFallback: "windows-partial-shell-acl-unsafe",
    })).state).toBe("off");
  });

  it("counts the environment override as a request", () => {
    expect(describeShellSandboxStatus(input({
      envForced: true, requestedAtBoot: true, boot: ACTIVATED, shellPlanMode: "asrt",
    }))).toEqual({ state: "on", setting: false, envForced: true, causes: [] });
  });

  it("is unsupported on a platform with no OS sandbox, whatever is stored", () => {
    expect(describeShellSandboxStatus(input({ platformSupported: false, setting: true })))
      .toMatchObject({ state: "unsupported", causes: ["platform-unsupported"] });
  });

  it("claims nothing about effectiveness before the boot gate ran", () => {
    expect(describeShellSandboxStatus(input({ setting: true, boot: null })).state).toBe("unknown");
  });

  it("fails on a degraded boot that recorded no cause", () => {
    expect(() => describeShellSandboxStatus(input({
      setting: true,
      requestedAtBoot: true,
      boot: { ...SKIPPED, action: "degrade", reason: "degrade-default-cannot-activate" },
    }))).toThrow(/recorded no cause/);
  });

  it("fails when an activated boot left a requested shell plain", () => {
    expect(() => describeShellSandboxStatus(input({
      setting: true, requestedAtBoot: true, boot: ACTIVATED,
    }))).toThrow(/shell plan is plain\/none/);
  });
});
