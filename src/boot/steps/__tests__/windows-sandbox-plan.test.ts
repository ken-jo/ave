import { describe, expect, it } from "vitest";

import { maxEgressGrantScope } from "../../../shared/sandbox-capability-info.js";
import {
  mxcShellCapability,
  planWindowsSandbox,
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
