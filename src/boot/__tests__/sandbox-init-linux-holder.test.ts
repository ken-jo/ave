/** Linux boot once the holder route is on (design 6.3): the holder canary runs after the shell canary, even when
 * shells are off, and its result is the route proof and the Settings line. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import type { SandboxContainerShellSupport } from "../../shared/sandbox-capability-info.js";
import type { LinuxHolderCanaryResult } from "../../permissions/mxc-linux.js";
import {
  createSandboxBootHarness,
  type SandboxBootHarness,
} from "../../__tests__/support/sandbox-boot-context.js";

// This file's private sandbox root, unique per process so concurrent vitest runs never remove each other's.
const SANDBOX_ROOT_NAME = vi.hoisted(() => `ave-sandbox-init-linux-holder-sandbox-${process.pid}-${Math.random().toString(16).slice(2)}`);
const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  closeAll: vi.fn(() => 2),
  checkDeps: vi.fn(),
  isProbeError: vi.fn(),
  isMacProbeError: vi.fn(),
  detectMacShell: vi.fn<() => Promise<SandboxContainerShellSupport>>(),
  detectLinuxShell: vi.fn<() => Promise<SandboxContainerShellSupport>>(),
  detectLinuxHolder: vi.fn<() => Promise<LinuxHolderCanaryResult>>(),
  holderRoute: true,
  logger: {
    debug: vi.fn(),
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

vi.mock("../../permissions/mxc-macos.js", () => ({
  detectHostMxcMacShellSupport: h.detectMacShell,
}));

vi.mock("../../permissions/mxc-linux.js", () => ({
  detectHostMxcLinuxShellSupport: h.detectLinuxShell,
  detectHostMxcLinuxHolderSupport: h.detectLinuxHolder,
}));

vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "linux" ? h.holderRoute : real.isContainerHolderRouteEnabled(platform) };
});

vi.mock("../../permissions/asrt-sandbox.js", async () => {
  // Boot sweeps private roots; use an owned temporary home.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const roots = join(tmpdir(), SANDBOX_ROOT_NAME);
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
    isAsrtMacRuntimeProbeError: h.isMacProbeError,
    closeAllEgressConnections: h.closeAll,
  };
});

import { initSandboxGate } from "../steps/sandbox-init.js";
import { provenLinuxHolderRoute, setProvenLinuxHolderRoute } from "../../permissions/linux-holder-route.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxBootOutcomeForTest,
  __resetSandboxRequestedAtBootForTest,
  getContainerHolderInfo,
  setLinuxHolderSupport,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;
const ROUTE = {
  programs: { launcher: "/opt/ave/lxc-exec", helper: "/opt/ave/apply-seccomp", env: {}, validate: () => {} },
  helperSha256: "0".repeat(64), captureFolder: "/run/ave/bwrap-capture", bwrap: { path: "/usr/bin/bwrap", identity: "1:2:3:4:5" },
};
let harness: SandboxBootHarness;

beforeEach(() => {
  harness = createSandboxBootHarness();
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  setProcessPlatform("linux");
  h.holderRoute = true;
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
  h.isMacProbeError.mockReturnValue(false);
  h.detectLinuxShell.mockResolvedValue({ state: "unavailable", reason: "tools-missing", detail: ["slirp4netns"] });
  vi.stubEnv("AVE_SANDBOX_ENABLED", "");
  vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "");
});

afterAll(() => rmSync(join(tmpdir(), SANDBOX_ROOT_NAME), { recursive: true, force: true }));

afterEach(() => {
  vi.unstubAllEnvs();
  setProvenLinuxHolderRoute(undefined);
  setLinuxHolderSupport(undefined);
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("Linux boot with the holder route on", () => {
  it("runs the holder canary for an extensions-only boot, after the shell canary, and takes its proof", async () => {
    const order: string[] = [];
    h.detectLinuxShell.mockImplementation(async () => { order.push("shell"); return { state: "unavailable", reason: "tools-missing", detail: ["slirp4netns"] }; });
    h.detectLinuxHolder.mockImplementation(async () => {
      order.push("holder");
      expect(getContainerHolderInfo()).toEqual({ state: "checking" });
      return { support: { state: "available" }, route: ROUTE };
    });
    await initSandboxGate(harness.context(false, true));
    expect(order).toEqual(["shell", "holder"]);
    expect(provenLinuxHolderRoute()).toMatchObject({ bwrap: { path: "/usr/bin/bwrap" } });
    expect(getContainerHolderInfo()).toEqual({ state: "available" });
  });

  it("leaves the route unproven and says why when the canary fails", async () => {
    h.detectLinuxHolder.mockResolvedValue({ support: { state: "unavailable", reason: "namespaces-unavailable" } });
    await initSandboxGate(harness.context(true, true));
    expect(provenLinuxHolderRoute()).toBeUndefined();
    expect(getContainerHolderInfo()).toEqual({ state: "unavailable", reason: "namespaces-unavailable" });
  });

  it("runs no holder canary while the route is off", async () => {
    h.holderRoute = false;
    await initSandboxGate(harness.context(true, true));
    expect(h.detectLinuxHolder).not.toHaveBeenCalled();
    expect(getContainerHolderInfo()).toBeUndefined();
  });
});
