import { afterEach, describe, expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { planWindowsSandbox, mxcShellCapability, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest, getHostShellExecutionPlan, getWindowsSandboxSubstrate,
  getWindowsExtensionBackendPlan, getSandboxGeneration, setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate, setWindowsShellLocalNetworkAccess,
} from "../sandbox-capability.js";
import { decidePermission } from "../decision-pipeline.js";

const HOST_PLATFORM = process.platform;
afterEach(() => {
  __resetWindowsSandboxSubstrateForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetActiveSandboxCapabilityForTest();
  setProcessPlatform(HOST_PLATFORM);
});

function boot(localNetworkAccess?: boolean): void {
  setProcessPlatform("win32");
  setShellSandboxRequestedAtBoot(true);
  const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: true,
    shellLocalNetworkAccess: localNetworkAccess, mxc: { state: "available" },
    windowsBuild: "10.0.26300.9711", srtWinReady: false });
  setActiveSandboxCapability(windowsProxyOnlyCapability(substrate));
  setWindowsSandboxSubstrate(substrate, mxcShellCapability());
}

describe("Windows shell local-network consent", () => {
  it.each([undefined, false])("uses approved host execution when consent is %s", consent => {
    boot(consent);
    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({ mode: "plain", substrate: "none", sandboxed: false, requiresExplicitUserApproval: true });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "approved-host", shellLocalNetworkAccess: false,
      mxc: { state: "available" }, shellEgressIdentity: "shared" });
    for (const headless of [false, true]) {
      const decision = decidePermission({ tool: { name: "powershell", source: "builtin", kind: "shell" },
        mode: "strict", headless, shell: { sandboxed: plan.sandboxed, readOnlyProven: true, unproven: false, destructive: false } });
      expect(decision.outcome).toBe(headless ? "deny" : "ask");
    }
  });

  it("uses the existing MXC route only after explicit consent", () => {
    boot(true);
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", substrate: "mxc", sandboxed: true });
  });

  it("changes the next plan immediately and preserves independent extension identity", () => {
    boot(false);
    const extension = getWindowsExtensionBackendPlan();
    const original = getSandboxGeneration();
    setWindowsShellLocalNetworkAccess(true);
    expect(getHostShellExecutionPlan()).toMatchObject({ substrate: "mxc", sandboxed: true });
    expect(getSandboxGeneration()).not.toBe(original);
    setWindowsShellLocalNetworkAccess(false);
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", sandboxed: false, requiresExplicitUserApproval: true });
    expect(getWindowsExtensionBackendPlan()).toBe(extension);
    expect(getWindowsSandboxSubstrate()?.shellLocalNetworkAccess).toBe(false);
  });
});
