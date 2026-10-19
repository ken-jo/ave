/**
 * Linux ASRT runtime-probe boot mapping.
 *
 * The adapter emits a typed failure only after the configured wrapper actually
 * fails. Boot must preserve the requested-at-boot signal, never publish a
 * verified capability, and choose the existing default-degrade vs explicit-
 * environment-abort policy without exposing wrapper diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import {
  createSandboxBootHarness,
  type SandboxBootHarness,
} from "../../__tests__/support/sandbox-boot-context.js";

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  checkDeps: vi.fn(),
  isProbeError: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/ave-sandbox-init-test") },
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => h.logger),
}));

vi.mock("../../permissions/asrt-sandbox.js", async () => {
  // The boot step sweeps both private roots and creates the HOME root, so they
  // live under a directory this file owns in the OS temp dir — never the real
  // AVE_HOME — whose parent can be created.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const roots = join(tmpdir(), "ave-sandbox-init-runtime-probe-sandbox");
  return {
    appOwnedSandboxTempRoot: () => join(roots, "tmp"),
    appOwnedSandboxHomeRoot: () => join(roots, "home"),
    sandboxTempPrincipalDirsInUse: () => new Set<string>(),
    ensureSandboxPrivateRoot: (root: string) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return root;
    },
    useAppOwnedSandboxTempRoot: () => "/tmp/ave-test-sandbox-tmp",
    initializeAsrtSandbox: h.initialize,
    subscribeAsrtViolations: async () => () => {},
    checkAsrtDependencies: h.checkDeps,
    isAsrtLinuxRuntimeProbeError: h.isProbeError,
  };
});

import { initSandboxGate } from "../steps/sandbox-init.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  detectSandboxCapability,
  getHostShellExecutionPlan,
  isPluginWorkerConfinementRequestedAtBoot,
  isShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;

let harness: SandboxBootHarness;

beforeEach(() => {
  harness = createSandboxBootHarness();
  setProcessPlatform("linux");
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  h.initialize.mockReset();
  h.checkDeps.mockReset();
  h.isProbeError.mockReset();
  h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
  vi.stubEnv("AVE_SANDBOX_ENABLED", "");
  vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("initSandboxGate — Linux ASRT runtime probe failures", () => {
  it("degrades the default/settings path without publishing a verified capability", async () => {
    const probeError = new Error("configured wrapper denied");
    h.initialize.mockRejectedValue(probeError);
    h.isProbeError.mockImplementation((error: unknown) => error === probeError);

    await expect(initSandboxGate(harness.context(true))).resolves.toBeUndefined();

    expect(harness.logSandboxGate).toHaveBeenCalledWith({
      platform: "linux",
      onSignal: "default-settings",
      outcome: "degrade",
      reason: "degrade-linux-runtime-probe-failed",
    });
    expect(detectSandboxCapability()).toMatchObject({ kind: "none", platform: "linux" });
    expect(isShellSandboxRequestedAtBoot()).toBe(true);
    expect(getHostShellExecutionPlan()).toMatchObject({
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "requested-sandbox-unavailable",
      requiresExplicitUserApproval: false,
      capability: { kind: "none" },
    });
  });

  it("audits and rethrows the typed probe failure for explicit Linux opt-in", async () => {
    const probeError = new Error("configured wrapper denied");
    h.initialize.mockRejectedValue(probeError);
    h.isProbeError.mockImplementation((error: unknown) => error === probeError);
    vi.stubEnv("AVE_SANDBOX_ENABLED", "1");

    await expect(initSandboxGate(harness.context(false))).rejects.toBe(probeError);

    expect(harness.logSandboxGate).toHaveBeenCalledWith({
      platform: "linux",
      onSignal: "explicit-env",
      outcome: "abort",
      reason: "abort-linux-runtime-probe-failed",
    });
    expect(harness.flush).toHaveBeenCalledOnce();
    expect(harness.logSandboxGate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.flush.mock.invocationCallOrder[0],
    );
    expect(detectSandboxCapability()).toMatchObject({ kind: "none", platform: "linux" });
    expect(isShellSandboxRequestedAtBoot()).toBe(true);
  });

  it("drains the dependency-abort audit before rejecting explicit opt-in", async () => {
    h.checkDeps.mockResolvedValue({ errors: ["missing bwrap"], warnings: [] });
    vi.stubEnv("AVE_SANDBOX_ENABLED", "1");

    await expect(initSandboxGate(harness.context(false))).rejects.toThrow(
      /dependencies are missing/,
    );

    expect(harness.logSandboxGate).toHaveBeenCalledWith({
      platform: "linux",
      onSignal: "explicit-env",
      outcome: "abort",
      reason: expect.stringContaining("abort"),
    });
    expect(harness.flush).toHaveBeenCalledOnce();
    expect(harness.logSandboxGate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.flush.mock.invocationCallOrder[0],
    );
  });
});

describe("initSandboxGate — shell sandbox and plugin-worker confinement scopes", () => {
  it("activates ASRT for worker confinement alone and keeps host shells unsandboxed", async () => {
    await initSandboxGate(harness.context(false, true));

    expect(h.initialize).toHaveBeenCalledOnce();
    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(true);
    expect(isShellSandboxRequestedAtBoot()).toBe(false);
    expect(detectSandboxCapability()).toMatchObject({ kind: "asrt" });
    expect(getHostShellExecutionPlan()).toMatchObject({
      requestedSandbox: false,
      mode: "plain",
      fallbackReason: "none",
      requiresExplicitUserApproval: false,
      capability: { kind: "none" },
    });
  });

  it("seals the shell sandbox alone without requesting worker confinement", async () => {
    await initSandboxGate(harness.context(true, false));

    expect(h.initialize).toHaveBeenCalledOnce();
    expect(isShellSandboxRequestedAtBoot()).toBe(true);
    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(false);
    expect(getHostShellExecutionPlan()).toMatchObject({ requestedSandbox: true, mode: "asrt" });
  });

  it("installs the upstream proxy route hook from the live setting, and clears its cache on a change", async () => {
    const context = harness.context(true, false);
    await initSandboxGate(context);

    const trusted = h.initialize.mock.calls[0]![0] as { upstreamRouter?: (d: { host: string; port: number; scheme: "http" | "https" }) => Promise<unknown> };
    expect(typeof trusted.upstreamRouter).toBe("function");
    const settings = context.settingsService as unknown as { onChanged: ReturnType<typeof vi.fn> };
    expect(settings.onChanged).toHaveBeenCalledWith("upstreamProxy", expect.any(Function));
  });

  it("skips ASRT when neither scope is requested", async () => {
    await initSandboxGate(harness.context(false, false));

    expect(h.initialize).not.toHaveBeenCalled();
    expect(isShellSandboxRequestedAtBoot()).toBe(false);
    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(false);
    expect(harness.logSandboxGate).toHaveBeenCalledWith(expect.objectContaining({ outcome: "skip" }));
  });

  it("AVE_SANDBOX_ENABLED=1 forces the shell scope only, and warns that extension processes are unconfined", async () => {
    vi.stubEnv("AVE_SANDBOX_ENABLED", "1");
    await initSandboxGate(harness.context(false, false));

    expect(isShellSandboxRequestedAtBoot()).toBe(true);
    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(
      /AVE_SANDBOX_ENABLED=1 now confines host shells only[\s\S]*AVE_PLUGIN_WORKER_CONFINEMENT=1/,
    ));
  });

  it("does not warn about the env split when worker confinement is also requested", async () => {
    vi.stubEnv("AVE_SANDBOX_ENABLED", "1");
    await initSandboxGate(harness.context(false, true));

    expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("now confines host shells only"));
  });

  it("AVE_PLUGIN_WORKER_CONFINEMENT=1 forces the worker scope only, and is fail-closed", async () => {
    vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "1");
    h.checkDeps.mockResolvedValue({ errors: ["missing bwrap"], warnings: [] });

    await expect(initSandboxGate(harness.context(false, false))).rejects.toThrow(
      /ON via AVE_PLUGIN_WORKER_CONFINEMENT=1 but its dependencies are missing/,
    );
    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(true);
    expect(isShellSandboxRequestedAtBoot()).toBe(false);
    expect(harness.logSandboxGate).toHaveBeenCalledWith(expect.objectContaining({
      onSignal: "explicit-env",
      outcome: "abort",
    }));
  });
});
