import { describe, expect, it } from "vitest";

import { assertSandboxWindowsExtensionPlan, maxEgressGrantScope } from "../../../shared/sandbox-capability-info.js";
import { __resetWindowsSandboxSubstrateForTest, setWindowsSandboxSubstrate } from "../../../permissions/sandbox-capability.js";
import {
  canRetryWindowsAsProxyOnly,
  mxcShellCapability,
  planWindowsSandbox,
  windowsExtensionBootWarning,
  windowsProxyOnlyCapability,
  windowsSubstrateFor,
  windowsSubstrateWithoutAsrt,
} from "../windows-sandbox-plan.js";

const AVAILABLE = { state: "available" } as const;
const UNAVAILABLE = { state: "unavailable", reason: "tier-unsupported" } as const;
const BUILD = "10.0.26300.9711";

describe("planWindowsSandbox — the four MXC × srt-win rows", () => {
  it("MXC + srt-win: shells in MXC (kernel-channel identity), extensions under srt-win", () => {
    const plan = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: true });
    expect(plan.start).toBe("srt-win");
    expect(plan.substrate).toMatchObject({
      shells: "mxc",
      extensions: "srt-win",
      shellEgressIdentity: "kernel-channel",
      extensionEgressIdentity: "shared",
      mxc: { state: "available" },
      windowsBuild: BUILD,
      srtWinReady: true,
    });
  });

  it("MXC without srt-win: ASRT starts as the proxy only, extensions are not confined", () => {
    const plan = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: false });
    expect(plan.start).toBe("proxy-only");
    expect(plan.substrate).toMatchObject({ shells: "mxc", extensions: "none", shellEgressIdentity: "kernel-channel" });
  });

  it("srt-win without MXC: shells take the approved-host route and the identity is shared", () => {
    const plan = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: UNAVAILABLE, windowsBuild: BUILD, srtWinReady: true });
    expect(plan.start).toBe("srt-win");
    expect(plan.substrate).toMatchObject({
      shells: "approved-host",
      extensions: "srt-win",
      shellEgressIdentity: "shared",
      mxc: { state: "unavailable", reason: "tier-unsupported" },
    });
  });

  it("neither: ASRT does not start and nothing is claimed", () => {
    const plan = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: UNAVAILABLE, windowsBuild: null, srtWinReady: false });
    expect(plan.start).toBe("none");
    expect(plan.substrate).toMatchObject({ shells: "none", extensions: "none", shellEgressIdentity: "shared" });
  });

  it("an available MXC carries no shells when the shell sandbox was not requested", () => {
    const workerOnly = planWindowsSandbox({ shellRequested: false, workerRequested: true, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: false });
    expect(workerOnly.start).toBe("none");
    expect(workerOnly.substrate.shells).toBe("none");
    const shellOnly = planWindowsSandbox({ shellRequested: true, workerRequested: false, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: true });
    expect(shellOnly.substrate.extensions).toBe("none");
  });
});

describe("planWindowsSandbox — MXC still checking", () => {
  const CHECKING = { state: "checking" } as const;

  it("starts ASRT as if MXC were there but keeps shells off MXC until the probe passes", () => {
    const plan = planWindowsSandbox({ shellRequested: true, workerRequested: false, mxc: CHECKING, windowsBuild: BUILD, srtWinReady: false });
    expect(plan.start).toBe("proxy-only");
    expect(plan.substrate).toMatchObject({ mxc: { state: "checking" }, shells: "approved-host", shellEgressIdentity: "shared" });
  });

  it("settles against the mode ASRT actually started in", () => {
    const input = { shellRequested: true, workerRequested: true, windowsBuild: BUILD, srtWinReady: false } as const;
    expect(windowsSubstrateFor({ ...input, mxc: AVAILABLE }, "proxy-only")).toMatchObject({ shells: "mxc", extensions: "none", shellEgressIdentity: "kernel-channel" });
    // A failed probe on a proxy-only boot: the proxy keeps running and shells ask.
    expect(windowsSubstrateFor({ ...input, mxc: { state: "unavailable", reason: "unverified-session" } }, "proxy-only")).toMatchObject({ shells: "approved-host", extensions: "none" });
    expect(windowsSubstrateFor({ ...input, mxc: AVAILABLE }, "none")).toMatchObject({ shells: "none", extensions: "none" });
  });
});

describe("Windows substrate helpers", () => {
  it("withdraws every claim when ASRT did not start after all", () => {
    const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: true });
    expect(windowsSubstrateWithoutAsrt(substrate)).toMatchObject({
      shells: "none",
      extensions: "none",
      shellEgressIdentity: "shared",
      mxc: { state: "available" },
    });
  });

  it("claims full confinement for an MXC shell and none for the proxy-only runtime", () => {
    const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: false });
    expect(mxcShellCapability().confines).toEqual({ filesystem: true, process: true, network: true });
    expect(windowsProxyOnlyCapability(substrate)).toMatchObject({
      kind: "asrt",
      reason: expect.stringContaining("agent shell commands run in containers"),
      confines: { filesystem: false, process: false, network: false },
    });
  });

  it("reports the approved host route when the proxy-only container probe fails", () => {
    const input = { shellRequested: true, workerRequested: true, windowsBuild: BUILD, srtWinReady: false } as const;
    const substrate = windowsSubstrateFor({ ...input, mxc: UNAVAILABLE }, "proxy-only");
    expect(substrate).toMatchObject({ shells: "approved-host", extensions: "none" });
    expect(windowsProxyOnlyCapability(substrate)).toMatchObject({
      kind: "asrt",
      reason: expect.stringContaining("containers unavailable; agent shell commands require host approval"),
      confines: { filesystem: false, process: false, network: false },
    });
  });

  it("caps egress grants at the conversation for a shared identity only", () => {
    expect(maxEgressGrantScope("kernel-channel")).toBe("always");
    expect(maxEgressGrantScope("shared")).toBe("session");
  });
});

describe("independent holder backend selection", () => {
  it.each([
    [false, true, "available", "none", "mxc", "ready"],
    [true, false, "available", "mxc", "none", "off"],
  ] as const)("keeps shell=%s extension=%s selection independent of extension %s", (shellRequested, workerRequested, state, shells, extensions, readiness) => {
    const plan = planWindowsSandbox({ shellRequested, workerRequested, mxc: AVAILABLE,
      extensionMxc: { state }, windowsBuild: BUILD, srtWinReady: false });
    expect(plan.start).toBe("proxy-only");
    expect(plan.substrate).toMatchObject({ shells, extensions, extensionPlan: { readiness, uiPolicy: "ui-enabled" } });
    expect(windowsProxyOnlyCapability(plan.substrate).confines).toEqual({ filesystem: false, process: false, network: false });
  });

  it("does not derive extension readiness from a successful shell probe", () => {
    const plan = planWindowsSandbox({ shellRequested: true, workerRequested: true, mxc: AVAILABLE, windowsBuild: BUILD, srtWinReady: true });
    expect(plan.substrate.extensionPlan).toMatchObject({ selectedBackend: "srt-win", readiness: "fallback", reason: "native-validation-required", fallbackVersion: "0.0.80" });
  });

  it("never publishes a boot extension plan in checking, which no boot settler could resolve", () => {
    // Boot inputs exclude checking by type; an internal caller forcing it is refused at publication, not left in limbo.
    const plan = planWindowsSandbox({ shellRequested: false, workerRequested: true, mxc: UNAVAILABLE,
      extensionMxc: { state: "checking" } as never, windowsBuild: BUILD, srtWinReady: true });
    expect(plan.substrate.extensionPlan).toMatchObject({ selectedBackend: "none", readiness: "checking" });
    try {
      expect(() => setWindowsSandboxSubstrate(plan.substrate)).toThrow(/no settle path/);
    } finally { __resetWindowsSandboxSubstrateForTest(); }
  });

  it("refuses an unpinned fallback and any fallback below an admitted ancestor", () => {
    const input = { shellRequested: false, workerRequested: true, mxc: UNAVAILABLE,
      extensionMxc: { state: "unavailable", reason: "readiness-deadline" }, windowsBuild: BUILD, srtWinReady: true } as const;
    expect(planWindowsSandbox({ ...input, fallbackVersion: "0.0.81" })).toMatchObject({ start: "none", substrate: { extensions: "none" } });
    expect(planWindowsSandbox({ ...input, admittedAncestorBackend: "srt-win" }).substrate.extensionPlan).toMatchObject({ selectedBackend: "none", readiness: "rejected", reason: "ancestor-already-admitted" });
    expect(canRetryWindowsAsProxyOnly({ ...input, extensionMxc: AVAILABLE, admittedAncestorBackend: "mxc" }, "srt-win")).toBe(false);
    expect(canRetryWindowsAsProxyOnly({ ...input, extensionMxc: AVAILABLE }, "srt-win")).toBe(true);
  });
});

it("preserves deadline rejection and off when no runtime can start", () => {
  const input = { shellRequested: false, workerRequested: true, mxc: UNAVAILABLE,
    windowsBuild: BUILD, srtWinReady: false } as const;
  const deadline = planWindowsSandbox({ ...input, extensionMxc: { state: "unavailable", reason: "readiness-deadline" } }).substrate;
  expect(deadline.extensionPlan).toMatchObject({ selectedBackend: "none", readiness: "rejected", reason: "readiness-deadline" });
  expect(windowsSubstrateWithoutAsrt(deadline).extensionPlan).toEqual(deadline.extensionPlan);
  const off = windowsSubstrateFor({ ...input, workerRequested: false }, "none");
  expect(windowsSubstrateWithoutAsrt(off).extensionPlan).toMatchObject({ selectedBackend: "none", readiness: "off" });
});

it("withdraws a selected fallback without retaining its selected-only version", () => {
  const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
    mxc: UNAVAILABLE, srtWinReady: true, windowsBuild: BUILD });
  expect(substrate.extensionPlan).toMatchObject({ selectedBackend: "srt-win", fallbackVersion: "0.0.80" });
  const withdrawn = windowsSubstrateWithoutAsrt(substrate);
  expect(withdrawn.extensionPlan).toMatchObject({ selectedBackend: "none", fallbackVersion: null, readiness: "unavailable" });
  expect(() => assertSandboxWindowsExtensionPlan(withdrawn.extensionPlan)).not.toThrow();
});

describe("boot warning for requested extension confinement", () => {
  const input = { shellRequested: false, workerRequested: true, mxc: UNAVAILABLE, windowsBuild: BUILD, srtWinReady: false } as const;

  it("says starts are refused, not unconfined, for a rejected plan", () => {
    const substrate = windowsSubstrateFor({ ...input, extensionMxc: { state: "unavailable", reason: "readiness-deadline" } }, "none");
    const warning = windowsExtensionBootWarning(substrate);
    expect(warning).toContain("REFUSED");
    expect(warning).toContain("readiness-deadline");
    expect(warning).not.toContain("NO OS isolation");
  });

  it("says NO OS isolation only for a settled no-backend plan", () => {
    const warning = windowsExtensionBootWarning(windowsSubstrateFor(input, "none"));
    expect(warning).toContain("NO OS isolation");
    expect(warning).not.toContain("REFUSED");
  });

  it("mentions container shells only when this substrate has them or is still checking them", () => {
    const shellInput = { ...input, shellRequested: true } as const;
    expect(windowsExtensionBootWarning(windowsSubstrateFor(input, "none"))).not.toContain("agent shells");
    expect(windowsExtensionBootWarning(windowsSubstrateFor(shellInput, "proxy-only"))).not.toContain("Execution Containers");
    expect(windowsExtensionBootWarning(windowsSubstrateFor({ ...shellInput, mxc: { state: "checking" } }, "proxy-only")))
      .toContain("once the container start check passes");
    const live = windowsExtensionBootWarning(windowsSubstrateFor({ ...shellInput, mxc: AVAILABLE }, "proxy-only"));
    expect(live).toContain("agent shells run in Microsoft Execution Containers");
    expect(live).not.toContain("once the container start check passes");
  });

  it("stays silent when an extension substrate was selected", () => {
    expect(windowsExtensionBootWarning(planWindowsSandbox({ ...input, srtWinReady: true }).substrate)).toBeUndefined();
  });
});
