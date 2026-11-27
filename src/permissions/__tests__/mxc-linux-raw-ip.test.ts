import { describe, expect, it } from "vitest";
import { containerEgressProtocolCoverage } from "../../shared/sandbox-capability-info.js";
import { INVOCATION_PROXY_REFUSED_STATUS } from "../egress-invocation-listener.js";
import {
  classifyLinuxRawIpTarget, type LinuxRawIpMeasurement, linuxRawIpVerdict, openLinuxRawIpHostTargets, parseLinuxRawIpProbeOutput,
} from "../mxc-linux-raw-ip.js";

const REFUSED = "Operation not permitted";
const CONTROL = `C status=${INVOCATION_PROXY_REFUSED_STATUS} refused=loopback destination`;

function measured(lines: readonly string[], overrides: Partial<LinuxRawIpMeasurement> = {}): LinuxRawIpMeasurement {
  return {
    ran: true, output: parseLinuxRawIpProbeOutput(lines.join("\n")), expectedStatus: INVOCATION_PROXY_REFUSED_STATUS,
    nonceRecorded: true, tlRan: true, udpArrived: false, ...overrides,
  };
}

describe("Linux raw-IP verdict rules", () => {
  it("classifies bash's C-locale connect results by the Linux column of the rules", () => {
    expect(classifyLinuxRawIpTarget(REFUSED)).toEqual({ class: "refused-local" });
    expect(classifyLinuxRawIpTarget("Permission denied")).toEqual({ class: "refused-local" });
    expect(classifyLinuxRawIpTarget("0")).toEqual({ class: "allowed" });
    expect(classifyLinuxRawIpTarget("Connection refused")).toEqual({ class: "allowed" });
    expect(classifyLinuxRawIpTarget("Network is unreachable")).toEqual({ class: "inconclusive", kind: "no-route" });
    expect(classifyLinuxRawIpTarget("deadline")).toEqual({ class: "inconclusive", kind: "timeout" });
    expect(classifyLinuxRawIpTarget("Connection timed out")).toEqual({ class: "inconclusive", kind: "timeout" });
    expect(classifyLinuxRawIpTarget("Bad file descriptor")).toEqual({ class: "inconclusive", kind: "unclassified" });
    expect(classifyLinuxRawIpTarget(undefined)).toEqual({ class: "inconclusive", kind: "unclassified" });
  });

  it("parses the prober's lines and keeps the first of each", () => {
    expect(parseLinuxRawIpProbeOutput([CONTROL, "T4 deadline", "T4 0", "T6 Network is unreachable", "IF lo,tap0", "junk"].join("\n")))
      .toEqual({ control: { status: "403", refusal: "loopback destination" }, targets: { T4: "deadline", T6: "Network is unreachable" },
        interfaces: ["lo", "tap0"] });
  });

  it("is blocked only when both documentation targets were refused locally and the control passed", () => {
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, `T6 ${REFUSED}`, "TL deadline", `UA ${REFUSED}`, "IF lo,tap0"])))
      .toEqual({ verdict: "blocked", evidence: "measured" });
  });

  it("counts a loopback-only network namespace as structural IPv6 evidence, and nothing else", () => {
    const lines = (interfaces: string) => [CONTROL, `T4 ${REFUSED}`, "T6 Network is unreachable", `TL ${REFUSED}`, `IF ${interfaces}`];
    expect(linuxRawIpVerdict(measured(lines("lo")))).toEqual({ verdict: "blocked", evidence: "structural" });
    expect(linuxRawIpVerdict(measured(lines("lo,tap0")))).toEqual({ verdict: "unknown", reason: "ipv6-unmeasured" });
    expect(linuxRawIpVerdict(measured(lines("")))).toEqual({ verdict: "unknown", reason: "ipv6-unmeasured" });
  });

  it("is unknown for a firewall that drops instead of refusing, as the slirp4netns backend does", () => {
    expect(linuxRawIpVerdict(measured([CONTROL, "T4 deadline", "T6 Network is unreachable", "TL deadline", `UA ${REFUSED}`, "IF lo,tap0"])))
      .toEqual({ verdict: "unknown", reason: "timeout" });
  });

  it("is unknown when anything reached a peer, by TCP or by UDP arrival", () => {
    const refused = [CONTROL, `T4 ${REFUSED}`, `T6 ${REFUSED}`];
    expect(linuxRawIpVerdict(measured([...refused, "TL Connection refused", "IF lo"]))).toEqual({ verdict: "unknown", reason: "raw-ip-reachable" });
    expect(linuxRawIpVerdict(measured([...refused, "TL 0", "IF lo"]))).toEqual({ verdict: "unknown", reason: "raw-ip-reachable" });
    expect(linuxRawIpVerdict(measured([...refused, "TL deadline", "UA 0", "IF lo"], { udpArrived: true })))
      .toEqual({ verdict: "unknown", reason: "raw-ip-reachable" });
    // A datagram that left the container but never arrived leaves the TCP verdict standing.
    expect(linuxRawIpVerdict(measured([...refused, "TL deadline", "UA 0", "IF lo"]))).toEqual({ verdict: "blocked", evidence: "measured" });
  });

  it("never publishes blocked without both sides of the control", () => {
    const targets = [`T4 ${REFUSED}`, `T6 ${REFUSED}`, "TL deadline", "IF lo"];
    expect(linuxRawIpVerdict(measured([CONTROL, ...targets], { nonceRecorded: false }))).toEqual({ verdict: "unknown", reason: "control-failed" });
    expect(linuxRawIpVerdict(measured(["C status=502 refused=none", ...targets]))).toEqual({ verdict: "unknown", reason: "control-failed" });
    expect(linuxRawIpVerdict(measured(targets))).toEqual({ verdict: "unknown", reason: "control-failed" });
    expect(linuxRawIpVerdict(measured([]))).toEqual({ verdict: "unknown", reason: "no-evidence" });
    expect(linuxRawIpVerdict({ ...measured([CONTROL, ...targets]), ran: false })).toEqual({ verdict: "unknown", reason: "no-evidence" });
    expect(linuxRawIpVerdict(measured([CONTROL, ...targets], { tlRan: false }))).toEqual({ verdict: "unknown", reason: "no-evidence" });
  });

  it("names a missing route as no-route or ipv6-unmeasured", () => {
    expect(linuxRawIpVerdict(measured([CONTROL, "T4 Network is unreachable", `T6 ${REFUSED}`, "TL deadline", "IF lo"])))
      .toEqual({ verdict: "unknown", reason: "timeout" });
    expect(linuxRawIpVerdict(measured([CONTROL, "T4 Network is unreachable", `T6 ${REFUSED}`, "TL No route to host", "IF lo"])))
      .toEqual({ verdict: "unknown", reason: "no-route" });
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, "T6 Bad file descriptor", "TL Bad file descriptor", "IF lo"])))
      .toEqual({ verdict: "unknown", reason: "unclassified" });
  });

  it("publishes container coverage from the verdict only", () => {
    expect(containerEgressProtocolCoverage("bubblewrap")).toEqual({ dns: "blocked", rawIp: "unknown" });
    expect(containerEgressProtocolCoverage("bubblewrap", { verdict: "unknown", reason: "timeout" })).toEqual({ dns: "blocked", rawIp: "unknown" });
    expect(containerEgressProtocolCoverage("bubblewrap", { verdict: "blocked", evidence: "structural" })).toEqual({ dns: "blocked", rawIp: "blocked" });
  });

  it("runs no host targets, rather than failing the canary, when the host address cannot be bound", async () => {
    // A documentation address is never local, so binding it fails the way a vanished interface would.
    await expect(openLinuxRawIpHostTargets("192.0.2.55", "nonce")).resolves.toBeUndefined();
    await expect(openLinuxRawIpHostTargets(undefined, "nonce")).resolves.toBeUndefined();
    const targets = await openLinuxRawIpHostTargets("127.0.0.1", "nonce");
    expect(targets).toMatchObject({ address: "127.0.0.1", closedPort: expect.any(Number), udp: { port: expect.any(Number) } });
    await targets?.udp.close();
  });
});
