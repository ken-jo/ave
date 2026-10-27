vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";
import { setAveHomePrivacyAtBoot, areExtensionsWithoutIsolationApproved, _resetAveHomePrivacyForTest } from "../../../shared/ave-home.js";
import { readdirSync } from "node:fs";
import * as srtIntegrity from "../../../permissions/srt-win-integrity.js";
import * as asrtSandbox from "../../../permissions/asrt-sandbox.js";
import {
  foreignFrameEvent,
  hostFrameEvent,
  makeRegisteredHandlerInvoker,
  useTempDirs,
} from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

const asrtState = vi.hoisted(() => ({
  userStatus: {} as {
    provisioned?: boolean;
    sid?: string;
    groupExists?: boolean;
    inBuiltinUsers?: boolean;
    inSandboxGroup?: boolean;
    hiddenFromLogon?: boolean;
    credPresent?: boolean;
  },
  wfpState: "absent" as "absent" | "installed" | "cannot-read",
  installResult: null as
    | { cancelled: true }
    | {
        user: {
          provisioned?: boolean;
          sid?: string;
          groupExists?: boolean;
          inBuiltinUsers?: boolean;
          inSandboxGroup?: boolean;
          hiddenFromLogon?: boolean;
          credPresent?: boolean;
        };
        wfp: { state: string };
      }
    | null,
  installCalls: [] as Array<{ proxyPortRange?: readonly [number, number] }>,
  verifyCalls: [] as Array<{ proxyPortRange?: readonly [number, number] }>,
  verifyRejects: false,
  instructions: "INSTRUCTIONS_TEXT",
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// Use the exported status/install surface and real error class so descriptor changes fail the test.
class MockWindowsSandboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  WindowsSandboxError: MockWindowsSandboxError,
  resolveSrtWin: vi.fn((cfg?: { path: string }) => ({
    exe: cfg?.path ?? "srt-win.exe",
    prependArgs: ["--srt-win"],
  })),
  checkWindowsSandboxStatusAsync: vi.fn(async () => ({
    user: asrtState.userStatus,
    wfp: { state: asrtState.wfpState, filters: 2 },
  })),
  windowsInstallInstructions: vi.fn((_sublayer?: string) => asrtState.instructions),
  verifyWindowsWfpEgress: vi.fn(
    (opts?: { proxyPortRange?: readonly [number, number] }) => {
      asrtState.verifyCalls.push(opts ?? {});
      if (asrtState.verifyRejects) {
        throw new Error("WFP egress verification failed");
      }
      return Promise.resolve({ target: "127.0.0.1:49152", stderr: "BLOCKED" });
    },
  ),
  installWindowsSandboxAsync: vi.fn(
    async (opts?: { proxyPortRange?: readonly [number, number] }) => {
      asrtState.installCalls.push(opts ?? {});
      return asrtState.installResult;
    },
  ),
  DEFAULT_WINDOWS_PROXY_PORT_RANGE: [60080, 60089] as readonly [number, number],
}));

vi.mock("../../../permissions/asrt-windows-support.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../permissions/asrt-windows-support.js")
  >();
  return {
    ...actual,
    installAsrtWindowsSandbox: () =>
      actual.installAsrtWindowsSandbox({
        grantBackendAcl: async () => undefined,
      }),
  };
});

const invoke = makeRegisteredHandlerInvoker(handlers);

type FeatureFixture = { osToolSandbox?: boolean; pluginWorkerConfinement?: boolean };

function makeDeps(features: FeatureFixture) {
  return {
    conversationLoop: { permissionManager: { getMode: () => "default", setDeferredEntryAsk: vi.fn() } },
    approvalGate: {},
    auditLogger: { log: vi.fn() },
    toolRegistry: { setDenyRules: vi.fn() },
    settingsService: { get: vi.fn(() => features) },
    getAppWindows: vi.fn(() => []),
  };
}

async function setup(features: FeatureFixture = { osToolSandbox: false }) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers(makeDeps(features) as never);
}

const ORIGINAL_PLATFORM = process.platform;

beforeEach(() => {
  asrtState.userStatus = {};
  asrtState.wfpState = "absent";
  asrtState.installResult = null;
  asrtState.installCalls = [];
  asrtState.verifyCalls = [];
  asrtState.verifyRejects = false;
});

afterEach(() => {
  _resetAveHomePrivacyForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
});

function readyUserStatus(): typeof asrtState.userStatus {
  return {
    provisioned: true,
    sid: "S-1-5-21-1",
    groupExists: true,
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
  };
}

describe("extension isolation session approval", () => {
  const home = useTempDirs("ave-home-session-approval-");
  function failPrivacy() {
    setProcessPlatform("win32");
    const path = home();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: path, category: "extra-principals", reason: "fixture",
      extraPrincipals: [{ sid: "S-1-5-18" }] });
    return path;
  }
  it.each([undefined, foreignFrameEvent("https://evil.example"), foreignFrameEvent("file:///app/plugin-ui-shell.html")])("rejects an untrusted sender %j", async (event) => {
    failPrivacy(); await setup();
    expect(await invoke(PERMISSIONS.approveExtensionsWithoutIsolation, event, { intent: USER_INTENT })).toEqual(UNAUTHORIZED_FRAME);
    expect(areExtensionsWithoutIsolationApproved()).toBe(false);
  });
  it("rejects headless and synthetic calls without a user gesture", async () => {
    failPrivacy(); await setup();
    expect(await invoke(PERMISSIONS.approveExtensionsWithoutIsolation, hostFrameEvent(), {}))
      .toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(areExtensionsWithoutIsolationApproved()).toBe(false);
  });
  it("approves only in main memory, audits once, survives renderer reload and asks again next boot", async () => {
    const path = failPrivacy();
    const { registerPermissionsHandlers } = await import("../permissions.js");
    const deps = { ...makeDeps({ pluginWorkerConfinement: true }), settingsService: { get: vi.fn(() => ({ pluginWorkerConfinement: true })), set: vi.fn() } };
    registerPermissionsHandlers(deps as never);
    const files = readdirSync(path).sort();
    const approve = () => invoke(PERMISSIONS.approveExtensionsWithoutIsolation, hostFrameEvent(), { intent: USER_INTENT });
    expect(await approve()).toEqual({ ok: true });
    expect(areExtensionsWithoutIsolationApproved()).toBe(true);
    expect(await approve()).toEqual({ ok: true });
    expect(deps.auditLogger.log).toHaveBeenCalledTimes(1);
    expect(deps.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "approval", timestamp: expect.any(String),
      output: expect.stringContaining('"who":"user-ui"') }));
    const entry = JSON.parse(deps.auditLogger.log.mock.calls[0][0].output);
    expect(entry).toMatchObject({ category: "extra-principals", path });
    expect(deps.settingsService.set).not.toHaveBeenCalled();
    expect(readdirSync(path).sort()).toEqual(files);
    await setup({ pluginWorkerConfinement: true });
    expect(await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())).toMatchObject({ ready: false,
      homePrivacyError: { path, category: "extra-principals", approvedForSession: true } });
    expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ homePrivacyError: { approvedForSession: true } });
    _resetAveHomePrivacyForTest(); failPrivacy();
    expect(areExtensionsWithoutIsolationApproved()).toBe(false);
  });
  it("cannot approve when the home is protected", async () => {
    setProcessPlatform("win32"); await setup();
    expect(await invoke(PERMISSIONS.approveExtensionsWithoutIsolation, hostFrameEvent(), { intent: USER_INTENT }))
      .toMatchObject({ ok: false, error: "not-applicable" });
  });
});

describe("sandboxWindowsStatus", () => {
  it("includes readable and unverified profile rows in both status surfaces", async () => {
    setProcessPlatform("win32");
    const warnings = [{ path: String.raw`D:\Users\tester\.ssh`, principals: ["Users", "INTERACTIVE"] as const },
      { path: String.raw`D:\Users\tester\.aws` }];
    const readWarnings = vi.spyOn(asrtSandbox, "getWindowsProfileReadDenyWarnings").mockReturnValue(warnings);
    try {
      await setup();
      expect(await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())).toMatchObject({ profileReadDenyWarnings: warnings });
      expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ profileReadDenyWarnings: warnings });
    } finally {
      readWarnings.mockRestore();
    }
  });

  it("surfaces an integrity failure without reporting ready or missing", async () => {
    setProcessPlatform("win32");
    await setup();
    const prepare = vi.spyOn(srtIntegrity, "prepareSrtWinExecutable").mockImplementationOnce(() => {
      throw new srtIntegrity.SrtWinIntegrityError("srt-win-integrity-mismatch");
    });
    try {
      expect(await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())).toMatchObject({
        applicable: true, ready: false, helperError: "srt-win-integrity-mismatch",
      });
    } finally { prepare.mockRestore(); }
  });
  it("returns a not-applicable shape off win32 (no ASRT call)", async () => {
    setProcessPlatform("darwin");
    await setup();
    const result = await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent());
    expect(result).toEqual({
      applicable: false,
      userState: null,
      wfpState: null,
      ready: false,
      instructions: "",
    });
  });

  it("incomplete user + WFP absent → ready:false with verbatim instructions", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = { provisioned: true, sid: "S-1-5-21-1" };
    asrtState.wfpState = "absent";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())) as Record<string, unknown>;
    expect(result.applicable).toBe(true);
    expect(result.userState).toBe("incomplete");
    expect(result.wfpState).toBe("absent");
    expect(result.ready).toBe(false);
    expect(result.instructions).toBe("INSTRUCTIONS_TEXT");
  });

  it("user ready + WFP installed → ready:true", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "installed";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())) as Record<string, unknown>;
    expect(result.ready).toBe(true);
    expect(result.userState).toBe("ready");
    expect(result.wfpState).toBe("installed");
  });

  it("user ready but WFP absent → ready:false (both conditions required)", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "absent";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())) as Record<string, unknown>;
    expect(result.ready).toBe(false);
  });

  it("WFP cannot-read is surfaced and treated as ready when verifier proves egress is blocked", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "cannot-read";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())) as Record<string, unknown>;
    expect(result.wfpState).toBe("cannot-read");
    expect(result.ready).toBe(true);
    expect(asrtState.verifyCalls).toHaveLength(1);
    expect(asrtState.verifyCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("WFP cannot-read fails closed when behavioral verification fails", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "cannot-read";
    asrtState.verifyRejects = true;
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, hostFrameEvent())) as Record<string, unknown>;
    expect(result.wfpState).toBe("cannot-read");
    expect(result.ready).toBe(false);
    expect(asrtState.verifyCalls).toHaveLength(1);
  });
});

describe("sandboxWindowsInstall", () => {
  it("rejects a foreign frame with UNAUTHORIZED_FRAME (sender guard)", async () => {
    setProcessPlatform("win32");
    await setup();
    const foreignEvent = foreignFrameEvent("https://evil.example");
    const result = await invoke(PERMISSIONS.sandboxWindowsInstall, foreignEvent, { intent: USER_INTENT });
    expect(result).toEqual(UNAUTHORIZED_FRAME);
  });

  it("rejects a submission without user-keyboard intent", async () => {
    setProcessPlatform("win32");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), {})) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("user-keyboard-required");
  });

  it("returns {cancelled:true} when the user dismisses UAC (not an error)", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = { cancelled: true };
    await setup();
    const result = await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), { intent: USER_INTENT });
    expect(result).toEqual({ outcome: "cancelled", cancelled: true });
    expect(asrtState.installCalls).toHaveLength(1);
    expect(asrtState.installCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("returns post-install user + WFP state on success", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = {
      user: { provisioned: true, sid: "S-1-5-21-1" },
      wfp: { state: "installed" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.outcome).toBe("installed-unverified");
    expect(result.userState).toBe("incomplete");
    expect(result.wfpState).toBe("installed");
    expect(result.ready).toBe(false);
  });

  it("answers already-ready without a UAC prompt when the sandbox is already provisioned (#1608)", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "installed";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.outcome).toBe("already-ready");
    expect(result.ready).toBe(true);
    expect(asrtState.installCalls).toHaveLength(0);
  });

  it("reports ready:true when install lands user ready + WFP installed", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = {
      user: readyUserStatus(),
      wfp: { state: "installed" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.outcome).toBe("ready");
    expect(result.ready).toBe(true);
  });

  it("reports ready:true when install returns WFP cannot-read but verifier proves egress is blocked", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = {
      user: readyUserStatus(),
      wfp: { state: "cannot-read" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.wfpState).toBe("cannot-read");
    expect(result.ready).toBe(true);
    expect(asrtState.verifyCalls).toHaveLength(1);
    expect(asrtState.verifyCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("refuses off win32 (not-applicable)", async () => {
    setProcessPlatform("linux");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, hostFrameEvent(), { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-applicable");
  });
});

describe("sandboxCapability win32 reconcile", () => {
  it("reports win32 as available with fs+network partial confines (matches boot SOT)", async () => {
    setProcessPlatform("win32");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as {
      platform: string;
      available: boolean;
      kind: string;
      potentialReason: string;
      runtime: { available: boolean; kind: string; reason: string };
      confines: { filesystem: boolean; process: boolean; network: boolean };
    };
    expect(result.platform).toBe("win32");
    expect(result.available).toBe(true);
    expect(result.kind).toBe("partial");
    expect(result.potentialReason).toContain("srt-win");
    // The shared sandbox account isolates from the host, not between plugins.
    expect(result.potentialReason).toContain("plugins are not isolated from each other");
    expect(result.runtime.available).toBe(false);
    expect(result.runtime.kind).toBe("none");
    expect(result.runtime.reason).toContain("shell sandbox not requested at boot");
    expect(result.confines).toEqual({ filesystem: true, process: false, network: true });
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])("reports each scope's runtime from its own boot seal (shell=%s, workers=%s)", async (shell, workers) => {
    setProcessPlatform("linux");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT runtime registered at boot",
      confines: { filesystem: true, process: true, network: true },
    });
    capability.setShellSandboxRequestedAtBoot(shell);
    capability.setPluginWorkerConfinementRequestedAtBoot(workers);
    try {
      await setup({ osToolSandbox: shell, pluginWorkerConfinement: workers });
      const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as {
        enabled: boolean;
        runtime: { kind: string };
        workerRuntime: { kind: string };
      };
      expect(result.enabled).toBe(shell);
      expect(result.runtime.kind).toBe(shell ? "full" : "none");
      expect(result.workerRuntime.kind).toBe(workers ? "full" : "none");
    } finally {
      capability.__resetActiveSandboxCapabilityForTest();
      capability.__resetSandboxRequestedAtBootForTest();
    }
  });

  it("still reports darwin as full-confine available", async () => {
    setProcessPlatform("darwin");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as {
      available: boolean;
      kind: string;
      potentialReason: string;
      confines: { filesystem: boolean; process: boolean; network: boolean };
    };
    expect(result.available).toBe(true);
    expect(result.kind).toBe("full");
    expect(result.potentialReason).toContain("Seatbelt");
    expect(result.confines).toEqual({ filesystem: true, process: true, network: true });
  });

  it("reports active runtime separately from platform potential when ASRT is registered", async () => {
    setProcessPlatform("linux");
    const {
      setActiveSandboxCapability,
      setShellSandboxRequestedAtBoot,
      __resetActiveSandboxCapabilityForTest,
      __resetSandboxRequestedAtBootForTest,
    } = await import("../../../permissions/sandbox-capability.js");
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT runtime registered at boot",
      confines: { filesystem: true, process: true, network: true },
    });
    try {
      await setup();
      const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as {
        available: boolean;
        kind: string;
        runtime: { available: boolean; kind: string; reason: string };
      };
      expect(result.available).toBe(true);
      expect(result.kind).toBe("full");
      expect(result.runtime).toEqual({
        available: true,
        kind: "full",
        reason: "ASRT runtime registered at boot",
      });
    } finally {
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
    }
  });
});

describe("sandboxCapability shell status (the permission card's checkbox)", () => {
  it("reports worker restart pending from the sealed boot intent and clears it on reversal", async () => {
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setSandboxBootOutcome({ action: "skip", reason: "gate-off", onSignal: "off", dependencyErrors: [], causes: [] });
    capability.setPluginWorkerConfinementRequestedAtBoot(false);
    await setup({ pluginWorkerConfinement: true });
    expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ workerRestartPending: true });
    await setup({ pluginWorkerConfinement: false });
    expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ workerRestartPending: false });
    capability.setPluginWorkerConfinementRequestedAtBoot(true);
    expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ workerRestartPending: true });
    await setup({ pluginWorkerConfinement: true });
    expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ workerRestartPending: false });
  });

  it("does not mark an environment-forced worker scope pending when its stored value changes", async () => {
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setSandboxBootOutcome({ action: "activate", reason: "deps-present", onSignal: "explicit-env", dependencyErrors: [], causes: [] });
    capability.setPluginWorkerConfinementRequestedAtBoot(true);
    vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "1");
    await setup({ pluginWorkerConfinement: false });
    expect(await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())).toMatchObject({ workerRestartPending: false });
  });
  async function readShell(features: FeatureFixture) {
    await setup(features);
    const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as {
      shell: { state: string; setting: boolean; envForced: boolean; causes: string[] };
    };
    return result.shell;
  }

  afterEach(async () => {
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.__resetActiveSandboxCapabilityForTest();
    capability.__resetSandboxRequestedAtBootForTest();
    capability.__resetSandboxBootOutcomeForTest();
    vi.unstubAllEnvs();
  });

  it("names the missing Linux dependencies the boot gate recorded", async () => {
    setProcessPlatform("linux");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setShellSandboxRequestedAtBoot(true);
    capability.setSandboxBootOutcome({
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "default-settings",
      dependencyErrors: ["bubblewrap (bwrap) not installed", "socat not installed"],
      causes: ["missing-bwrap", "missing-socat"],
    });
    expect(await readShell({ osToolSandbox: true, pluginWorkerConfinement: true })).toEqual({
      state: "unavailable",
      setting: true,
      envForced: false,
      causes: ["missing-bwrap", "missing-socat"],
    });
  });

  it("says a start failure apart from a missing dependency", async () => {
    setProcessPlatform("linux");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setShellSandboxRequestedAtBoot(true);
    capability.setSandboxBootOutcome({
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "default-settings",
      dependencyErrors: ["proxy failed to bind"],
      causes: ["init-failed"],
    });
    expect((await readShell({ osToolSandbox: true })).causes).toEqual(["init-failed"]);
  });

  it("shows a setting turned on after boot as pending a restart, not as on", async () => {
    setProcessPlatform("darwin");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setShellSandboxRequestedAtBoot(false);
    capability.setSandboxBootOutcome({
      action: "skip", reason: "gate-off", onSignal: "off", dependencyErrors: [], causes: [],
    });
    expect((await readShell({ osToolSandbox: true })).state).toBe("pending-on");
  });

  it("is on when the shell plan runs shells under ASRT", async () => {
    setProcessPlatform("darwin");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setShellSandboxRequestedAtBoot(true);
    capability.setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active",
      confines: { filesystem: true, process: true, network: true },
    });
    capability.setSandboxBootOutcome({
      action: "activate", reason: "deps-present", onSignal: "default-settings", dependencyErrors: [], causes: [],
    });
    expect(await readShell({ osToolSandbox: true })).toEqual({
      state: "on", setting: true, envForced: false, causes: [],
    });
  });

  it("marks the environment override so the card does not offer a toggle it cannot honour", async () => {
    setProcessPlatform("darwin");
    vi.stubEnv("AVE_SANDBOX_ENABLED", "1");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setShellSandboxRequestedAtBoot(true);
    capability.setSandboxBootOutcome({
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "explicit-env",
      dependencyErrors: ["x"],
      causes: ["init-failed"],
    });
    expect(await readShell({ osToolSandbox: false })).toMatchObject({ setting: false, envForced: true });
  });

  it("keeps raw dependency messages main-side and sends only the classified causes", async () => {
    setProcessPlatform("linux");
    const capability = await import("../../../permissions/sandbox-capability.js");
    capability.setShellSandboxRequestedAtBoot(true);
    capability.setSandboxBootOutcome({
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "default-settings",
      dependencyErrors: ["socat not executable at /home/example/bin/socat"],
      causes: ["missing-socat"],
    });
    await setup({ osToolSandbox: true });
    const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as { boot: Record<string, unknown> };
    expect(result.boot).toEqual({
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      onSignal: "default-settings",
      causes: ["missing-socat"],
    });
    expect(JSON.stringify(result)).not.toContain("/home/example");
  });

  it("reports a boot/plan contradiction as an error on the shell row, logged and audited, not a failed snapshot", async () => {
    setProcessPlatform("darwin");
    const capability = await import("../../../permissions/sandbox-capability.js");
    // Requested shell isolation with no published capability must not produce a plain execution plan.
    capability.setShellSandboxRequestedAtBoot(true);
    capability.setSandboxBootOutcome({
      action: "activate", reason: "deps-present", onSignal: "default-settings", dependencyErrors: [], causes: [],
    });
    handlers.clear();
    const deps = makeDeps({ osToolSandbox: true });
    const { registerPermissionsHandlers } = await import("../permissions.js");
    registerPermissionsHandlers(deps as never);

    const result = (await invoke(PERMISSIONS.sandboxCapability, hostFrameEvent())) as {
      platform: string;
      available: boolean;
      shell: { state: string; setting: boolean; envForced: boolean; causes: string[] };
    };

    expect(result.shell).toEqual({ state: "error", setting: true, envForced: false, causes: [] });
    expect(result.platform).toBe("darwin");
    expect(result.available).toBe(true);
    expect(deps.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      type: "error",
      output: expect.stringContaining("[sandbox-status:contract-violation]"),
    }));
  });
});
