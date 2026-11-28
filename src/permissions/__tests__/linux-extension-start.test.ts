import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_START_IDENTITY as ID } from "../../__tests__/support/approved-extension-start.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const route = vi.hoisted(() => ({ linux: true }));
vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "linux" ? route.linux : real.isContainerHolderRouteEnabled(platform) };
});

const { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
const { assertExtensionStartAllowed } = await import("../asrt-sandbox.js");
const { EXTENSION_START_CONSENT_REQUIRED_CODE } = await import("../extension-start-consent.js");
const { MxcExtensionReadinessRefusedError, MxcNativeEntryRequiredError, MxcProcessContractError, WorkerTransportUnsupportedError } = await import("../mxc-extension-errors.js");
const { setProvenLinuxHolderRoute } = await import("../linux-holder-route.js");
const { isMxcExtensionBackendSelected } = await import("../../sandbox/wrap-bundled-command.js");
const {
  __resetActiveSandboxCapabilityForTest, __resetContainerShellSubstrateForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan,
  setActiveSandboxCapability, setContainerShellSubstrate, setLinuxHolderSupport, setPluginWorkerConfinementRequestedAtBoot, setShellSandboxRequestedAtBoot,
} = await import("../sandbox-capability.js");

const HOST_PLATFORM = process.platform;
const PROVEN = {
  programs: { launcher: "/opt/ave/lxc-exec", helper: "/opt/ave/apply-seccomp", env: {}, validate: () => {} },
  helperSha256: "0".repeat(64), captureFolder: "/run/ave/bwrap-capture", bwrap: { path: "/usr/bin/bwrap", identity: "1:2:3:4:5" },
};

function legacyStart(): string {
  try {
    assertExtensionStartAllowed({ start: { key: "plugin-child:p", identity: ID, authority: undefined, spend: true } });
    return "started";
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
}

beforeEach(() => {
  setProcessPlatform("linux");
  route.linux = true;
  setPluginWorkerConfinementRequestedAtBoot(true);
  setAveHomePrivacyAtBoot({ enforcement: "posix-mode", home: "/home/alice/.ave" });
});
afterEach(() => {
  setProvenLinuxHolderRoute(undefined);
  setLinuxHolderSupport(undefined);
  __resetSandboxRequestedAtBootForTest();
  _resetAveHomePrivacyForTest();
  setProcessPlatform(HOST_PLATFORM);
});

describe("a Linux extension start once the holder route is on (design 6.3)", () => {
  it("waits while the holder canary runs", () => {
    setLinuxHolderSupport({ state: "checking" });
    expect(() => assertExtensionStartAllowed({ start: { key: "plugin-child:p", identity: ID, authority: undefined, spend: true } }))
      .toThrow(MxcExtensionReadinessRefusedError);
  });

  it("asks once per start when the route is unproven, never standing the existing sandbox in for the holder", () => {
    setLinuxHolderSupport({ state: "unavailable", reason: "namespaces-unavailable" });
    expect(legacyStart()).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    try {
      assertExtensionStartAllowed();
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: EXTENSION_START_CONSENT_REQUIRED_CODE, unconfinedCause: "no-backend" });
    }
    // A native entry is refused outright without the proof.
    expect(() => assertExtensionStartAllowed({ backend: "mxc" })).toThrow(MxcProcessContractError);
  });

  it("sends every start to the holder once the route is proven", () => {
    setLinuxHolderSupport({ state: "available" });
    setProvenLinuxHolderRoute(PROVEN);
    expect(() => assertExtensionStartAllowed({ start: { key: "plugin-child:p", identity: ID, authority: undefined, spend: true } }))
      .toThrow(MxcNativeEntryRequiredError);
    expect(() => assertExtensionStartAllowed({ holder: "worker" })).toThrow(WorkerTransportUnsupportedError);
    expect(() => assertExtensionStartAllowed({ backend: "mxc" })).not.toThrow();
  });

  it("does not route or ask when the user turned extension isolation off, proven or not", () => {
    setPluginWorkerConfinementRequestedAtBoot(false);
    setLinuxHolderSupport({ state: "unavailable", reason: "namespaces-unavailable" });
    expect(legacyStart()).toBe("started");
    setLinuxHolderSupport({ state: "available" });
    setProvenLinuxHolderRoute(PROVEN);
    expect(legacyStart()).toBe("started");
    expect(isMxcExtensionBackendSelected()).toBe(false);
    setPluginWorkerConfinementRequestedAtBoot(true);
    expect(isMxcExtensionBackendSelected()).toBe(true);
  });

  it("keeps a host-owned process on its own gate once the route is proven", () => {
    setLinuxHolderSupport({ state: "available" });
    setProvenLinuxHolderRoute(PROVEN);
    expect(() => assertExtensionStartAllowed({ hostOwned: true })).not.toThrow(MxcNativeEntryRequiredError);
  });

  it("does not ask while the route is off", () => {
    route.linux = false;
    expect(legacyStart()).toBe("started");
  });
});

describe("a Linux hook's plan once the holder route is on", () => {
  beforeEach(() => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({ platform: "linux", kind: "asrt", confidence: "verified", reason: "Active sandbox",
      confines: { filesystem: true, process: true, network: true } });
    setContainerShellSubstrate("linux", { state: "available" });
  });
  afterEach(() => {
    __resetContainerShellSubstrateForTest();
    __resetActiveSandboxCapabilityForTest();
  });

  it("reads the holder canary: no substrate while it is unproven, while shells stay in the container", () => {
    setLinuxHolderSupport({ state: "unavailable", reason: "holder-start-failed" });
    expect(getHostShellExecutionPlan().substrate).toBe("mxc");
    const hook = getHostShellExecutionPlan("default", "hook");
    expect(hook.substrate).not.toBe("mxc");
    expect(hook.sandboxed).toBe(false);
  });

  it("puts a hook in the container once the holder canary passed, with the holders' own raw-IP verdict", () => {
    const rawIpProbe = { rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent" } as const;
    setLinuxHolderSupport({ state: "available", rawIpProbe });
    const hook = getHostShellExecutionPlan("default", "hook");
    expect(hook.substrate).toBe("mxc");
    expect(getHostShellExecutionPlan().substrate).toBe("mxc");
  });

  it("keeps a hook off the container while the holder route is off", () => {
    route.linux = false;
    setLinuxHolderSupport({ state: "available" });
    expect(getHostShellExecutionPlan("default", "hook").substrate).not.toBe("mxc");
  });
});
