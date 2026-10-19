import { describe, expect, it } from "vitest";

import { maxEgressGrantScope } from "../../../shared/sandbox-capability-info.js";
import {
  mxcShellCapability,
  planWindowsSandbox,
  windowsProxyOnlyCapability,
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
    expect(mxcShellCapability().confines).toEqual({ filesystem: true, process: true, network: true });
    expect(windowsProxyOnlyCapability()).toMatchObject({ kind: "asrt", confines: { filesystem: false, process: false, network: false } });
  });

  it("caps egress grants at the conversation for a shared identity only", () => {
    expect(maxEgressGrantScope("kernel-channel")).toBe("always");
    expect(maxEgressGrantScope("shared")).toBe("conversation");
  });
});
