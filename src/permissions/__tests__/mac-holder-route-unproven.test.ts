// macOS with the holder route on and the holder capability unproven (design v1 §5.2, the commit-16 sweep): the wrap is
// initialised and working, yet no extension start, user hook or offline host child reaches it. An extension start
// asks for the no-backend consent; a user hook's plan has no substrate; local inference is refused and never asked.
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const wrap = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "darwin" || real.isContainerHolderRouteEnabled(platform) };
});
vi.mock("../asrt-sandbox.js", async (actual) => {
  const real = await actual<typeof import("../asrt-sandbox.js")>();
  return { ...real, wrapWorkerCommand: (...args: Parameters<typeof real.wrapWorkerCommand>) => { wrap.calls++; return real.wrapWorkerCommand(...args); } };
});

import { configureHostResources } from "../../main/host-resources.js";
import { assertLocalEmbeddingRuntime } from "../../main/memory-map/local-runtime.js";
import { initializeAsrtSandbox, isOfflineHolderConfinementActive, isOfflineProcessConfinementActive, isPluginWorkerConfinementActive, resetAsrtSandbox } from "../asrt-sandbox.js";
import { spawnConfinedChild } from "../confined-child.js";
import { ExtensionStartConsentRequiredError } from "../extension-start-consent.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetMacExtensionPlanForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan,
  setActiveSandboxCapability, setContainerShellSubstrate, setMacExtensionPlan, setMacHolderCapability, setPluginWorkerConfinementRequestedAtBoot, setShellSandboxRequestedAtBoot,
} from "../sandbox-capability.js";
import { spawnWorker } from "../worker-spawn.js";

describe.runIf(process.platform === "darwin")("macOS holder route on, holder capability unproven", () => {
  beforeAll(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    setShellSandboxRequestedAtBoot(true);
    setPluginWorkerConfinementRequestedAtBoot(true);
    await initializeAsrtSandbox({ allowedDomains: [] }, async () => false);
    setActiveSandboxCapability({ platform: "darwin", kind: "asrt", confidence: "verified", reason: "Active sandbox",
      confines: { filesystem: true, process: true, network: true } });
    setContainerShellSubstrate("darwin", { state: "available" });
    setMacHolderCapability({ state: "unavailable", reason: "holder-start-failed" });
    setMacExtensionPlan({ platform: "darwin", requestedBackend: "mxc", selectedBackend: "none", readiness: "unavailable", reason: "holder-start-failed", egressIdentity: "shared" } as never);
  });
  afterAll(async () => {
    await resetAsrtSandbox();
    __resetMacExtensionPlanForTest();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  it("does not count the working wrap as extension or offline confinement", () => {
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);
    expect(isOfflineHolderConfinementActive()).toBe(false);
  });

  it("asks the no-backend consent for a worker start, and never wraps it", async () => {
    await expect(spawnWorker({ pluginId: "route-probe", workerId: "w", command: "/bin/echo", control: "output-only-v1" }))
      .rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    expect(wrap.calls).toBe(0);
  });

  it("refuses an offline host child on the wrap and local inference with the named reason", async () => {
    await expect(spawnConfinedChild({
      command: "/bin/echo", args: [], label: "offline-probe", grantMode: "deny-only", stdio: ["pipe", "pipe", "pipe"], baseEnv: {},
      egressOwner: { kind: "worker", role: "worker", pluginId: undefined, instanceId: "offline-probe", network: "offline" },
    })).rejects.toThrow("an offline process needs the OS sandbox, which is not active");
    expect(() => assertLocalEmbeddingRuntime()).toThrow(expect.objectContaining({ code: "local-runtime-unavailable" }));
    expect(wrap.calls).toBe(0);
  });

  it("gives a user hook no substrate while shell commands stay in the container", () => {
    expect(getHostShellExecutionPlan().identity).toBe("host-shell-execution-plan/v4:darwin:mxc");
    const hook = getHostShellExecutionPlan("default", "hook");
    expect(hook.identity).not.toContain(":asrt");
    expect(hook.substrate).not.toBe("mxc");
    expect(hook.sandboxed).toBe(false);
  });

  it("puts a user hook in the container once the holder capability is proven", () => {
    setMacHolderCapability({ state: "ready" });
    try {
      expect(getHostShellExecutionPlan("default", "hook")).toMatchObject({ identity: "host-shell-execution-plan/v4:darwin:mxc", substrate: "mxc" });
      // The real offline gate, unmocked: local inference is admitted on the holder and nothing else changed.
      expect(isOfflineHolderConfinementActive()).toBe(true);
      expect(() => assertLocalEmbeddingRuntime()).not.toThrow();
      expect(isOfflineProcessConfinementActive()).toBe(false);
    } finally {
      setMacHolderCapability({ state: "unavailable", reason: "holder-start-failed" });
    }
  });
});
