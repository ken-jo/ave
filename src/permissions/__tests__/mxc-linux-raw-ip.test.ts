import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { acceptMeasuredContainerEgress, containerEgressProtocolCoverage, posixContainerMeasuredEgress, type LinuxRawIpVerdict, type MxcRawIpUdpArrival } from "../../shared/sandbox-capability-info.js";
import { INVOCATION_PROXY_REFUSED_STATUS } from "../egress-invocation-listener.js";
import {
  classifyLinuxRawIpTarget, type LinuxRawIpMeasurement, linuxFirewallPayloadDrops, linuxRawIpProberArguments, linuxRawIpVerdict,
  openLinuxRawIpHostTargets, parseLinuxRawIpProbeOutput,
} from "../mxc-linux-raw-ip.js";

const REFUSED = "Operation not permitted";
const CONTROL = `C status=${INVOCATION_PROXY_REFUSED_STATUS} refused=loopback destination`;
// The payloads the pinned launcher wrote for a canary whose proxy listened on port 12345 (Ubuntu 24.04 aarch64).
const V4_PAYLOAD = `*filter
:MXC_EGRESS - [0:0]
:MXC_INGRESS - [0:0]
-A MXC_EGRESS -o lo -j ACCEPT
-A MXC_EGRESS -p tcp -d 10.0.2.2 --dport 12345 -j ACCEPT
-A MXC_EGRESS -j DROP
-A MXC_INGRESS -i lo -j ACCEPT
-A MXC_INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A MXC_INGRESS -m conntrack --ctstate NEW -j DROP
-A MXC_INGRESS -j DROP
-A OUTPUT -j MXC_EGRESS
-A INPUT -j MXC_INGRESS
COMMIT
`;
const V6_PAYLOAD = V4_PAYLOAD.replace("-A MXC_EGRESS -p tcp -d 10.0.2.2 --dport 12345 -j ACCEPT\n", "");
// What the slirp4netns backend measures: the direct connects time out, IPv6 has no route, the netns has lo and tap0.
const DROPPED = [CONTROL, "T4 deadline", "T6 Network is unreachable", "TL deadline", "TA deadline", `UA ${REFUSED}`, "IF lo,tap0"];
const ARRIVAL_HELD = { arrival: { controlPassed: true, arrived: false }, firewallDrops: true } as const;

function measured(lines: readonly string[], overrides: Partial<LinuxRawIpMeasurement> = {}): LinuxRawIpMeasurement {
  return {
    ran: true, output: parseLinuxRawIpProbeOutput(lines.join("\n")), expectedStatus: INVOCATION_PROXY_REFUSED_STATUS,
    nonceRecorded: true, tlRan: true, udpArrival: "absent", firewallDrops: false, ...overrides,
  };
}

function blocked(evidenceKind: "measured" | "structural" | "arrival"): LinuxRawIpVerdict {
  return { rawIp: "blocked", reason: "blocked", evidenceKind, reachableTargets: [], udpArrival: "absent" };
}

function unknown(
  reason: Extract<LinuxRawIpVerdict, { rawIp: "unknown" }>["reason"],
  reachableTargets: LinuxRawIpVerdict["reachableTargets"] = [], udpArrival: MxcRawIpUdpArrival = "absent",
): LinuxRawIpVerdict {
  return { rawIp: "unknown", reason, reachableTargets, udpArrival };
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
      .toEqual(blocked("measured"));
  });

  it("counts a loopback-only network namespace as structural IPv6 evidence, and nothing else", () => {
    const lines = (interfaces: string) => [CONTROL, `T4 ${REFUSED}`, "T6 Network is unreachable", `TL ${REFUSED}`, `IF ${interfaces}`];
    expect(linuxRawIpVerdict(measured(lines("lo")))).toEqual(blocked("structural"));
    expect(linuxRawIpVerdict(measured(lines("lo,tap0")))).toEqual(unknown("ipv6-unmeasured"));
    expect(linuxRawIpVerdict(measured(lines("")))).toEqual(unknown("ipv6-unmeasured"));
  });

  it("counts a dropping firewall as blocked only by arrival evidence: control taken, nothing arrived, structure read", () => {
    expect(linuxRawIpVerdict(measured(DROPPED, ARRIVAL_HELD))).toEqual(blocked("arrival"));
    // A timeout alone is never evidence.
    expect(linuxRawIpVerdict(measured(DROPPED))).toEqual(unknown("timeout"));
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, arrival: { controlPassed: false, arrived: false } })))
      .toEqual(unknown("timeout"));
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, firewallDrops: false }))).toEqual(unknown("timeout"));
    const { arrival: _arrival, ...withoutListener } = ARRIVAL_HELD;
    expect(linuxRawIpVerdict(measured(DROPPED, withoutListener))).toEqual(unknown("timeout"));
    for (const interfaces of ["IF lo", "IF lo,tap0,eth0", "IF tap0,lo", "IF lo,tap1"]) {
      expect(linuxRawIpVerdict(measured([...DROPPED.slice(0, -1), interfaces], ARRIVAL_HELD)).rawIp).toBe("unknown");
    }
    const withoutInterfaces = DROPPED.filter((line) => !line.startsWith("IF "));
    expect(linuxRawIpVerdict(measured(withoutInterfaces, ARRIVAL_HELD))).toEqual(unknown("timeout"));
    // An unclassified connect result is not a drop.
    expect(linuxRawIpVerdict(measured(DROPPED.map((line) => line === "T4 deadline" ? "T4 Bad file descriptor" : line), ARRIVAL_HELD))
      .rawIp).toBe("unknown");
    // Locally refused targets keep their own evidence kind; arrival names only what it decided.
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, "T6 deadline", "TL deadline", "TA deadline", "IF lo,tap0"], ARRIVAL_HELD)))
      .toEqual(blocked("arrival"));
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, `T6 ${REFUSED}`, "TL deadline", "TA deadline", "IF lo,tap0"], ARRIVAL_HELD)))
      .toEqual(blocked("measured"));
    // Arrival evidence never replaces the proxy control or TL.
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, nonceRecorded: false }))).toEqual(unknown("control-failed"));
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, tlRan: false }))).toEqual(unknown("no-evidence"));
  });

  it("is unknown when anything arrived at the host-side TCP listener, or the container connected to it", () => {
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, arrival: { controlPassed: true, arrived: true } })))
      .toEqual(unknown("raw-ip-reachable", ["ta"]));
    expect(linuxRawIpVerdict(measured(DROPPED.map((line) => line === "TA deadline" ? "TA 0" : line), ARRIVAL_HELD)))
      .toEqual(unknown("raw-ip-reachable", ["ta"]));
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, udpArrival: "arrived" })))
      .toEqual(unknown("raw-ip-reachable", ["udp"], "arrived"));
  });

  it("reads the launcher firewall only in the exact shape the pinned launcher writes", () => {
    expect(linuxFirewallPayloadDrops(V4_PAYLOAD, 4, 12345)).toBe(true);
    expect(linuxFirewallPayloadDrops(V6_PAYLOAD, 6, 12345)).toBe(true);
    // The proxy rule must name this canary's proxy, and IPv6 carries none.
    expect(linuxFirewallPayloadDrops(V4_PAYLOAD, 4, 12346)).toBe(false);
    expect(linuxFirewallPayloadDrops(V4_PAYLOAD, 6, 12345)).toBe(false);
    const variants = [
      V4_PAYLOAD.replace("-A MXC_EGRESS -j DROP\n", ""),
      V4_PAYLOAD.replace("-A MXC_EGRESS -j DROP\n", "-A MXC_EGRESS -j DROP\n-A MXC_EGRESS -j ACCEPT\n"),
      V4_PAYLOAD.replace("-A MXC_EGRESS -o lo -j ACCEPT\n", "-A MXC_EGRESS -d 0.0.0.0/0 -j ACCEPT\n"),
      V4_PAYLOAD.replace("-A OUTPUT -j MXC_EGRESS\n", ""),
      V4_PAYLOAD.replace("-A OUTPUT -j MXC_EGRESS\n", "-I OUTPUT -j ACCEPT\n-A OUTPUT -j MXC_EGRESS\n"),
      V4_PAYLOAD.replace(":MXC_INGRESS - [0:0]\n", ":MXC_INGRESS - [0:0]\n:OUTPUT ACCEPT [0:0]\n"),
      V4_PAYLOAD.replace("COMMIT\n", ""),
      V4_PAYLOAD.replace("*filter", "*nat"),
      `${V4_PAYLOAD}*nat\n-A OUTPUT -j DNAT --to-destination 10.0.2.2\nCOMMIT\n`,
      `${V4_PAYLOAD}*filter\n-A MXC_EGRESS -j ACCEPT\nCOMMIT\n`,
      "",
    ];
    for (const payload of variants) expect(linuxFirewallPayloadDrops(payload, 4, 12345), payload).toBe(false);
    // A later transaction appends after the closing DROP; it still reads as drop while it only repeats those rules.
    expect(linuxFirewallPayloadDrops(`${V4_PAYLOAD}\n${V4_PAYLOAD.replace("-A OUTPUT -j MXC_EGRESS\n", "")}`, 4, 12345)).toBe(true);
  });

  it("is unknown when anything reached a peer, by TCP or by UDP arrival", () => {
    const refused = [CONTROL, `T4 ${REFUSED}`, `T6 ${REFUSED}`];
    expect(linuxRawIpVerdict(measured([...refused, "TL Connection refused", "IF lo"]))).toEqual(unknown("raw-ip-reachable", ["tl"]));
    expect(linuxRawIpVerdict(measured([...refused, "TL 0", "IF lo"]))).toEqual(unknown("raw-ip-reachable", ["tl"]));
    expect(linuxRawIpVerdict(measured([...refused, "TL deadline", "UA 0", "IF lo"], { udpArrival: "arrived" })))
      .toEqual(unknown("raw-ip-reachable", ["udp"], "arrived"));
    // A datagram that left the container but never arrived leaves the TCP verdict standing.
    expect(linuxRawIpVerdict(measured([...refused, "TL deadline", "UA 0", "IF lo"]))).toEqual(blocked("measured"));
  });

  it("never publishes blocked without both sides of the control", () => {
    const targets = [`T4 ${REFUSED}`, `T6 ${REFUSED}`, "TL deadline", "IF lo"];
    expect(linuxRawIpVerdict(measured([CONTROL, ...targets], { nonceRecorded: false }))).toEqual(unknown("control-failed"));
    expect(linuxRawIpVerdict(measured(["C status=502 refused=none", ...targets]))).toEqual(unknown("control-failed"));
    expect(linuxRawIpVerdict(measured(targets))).toEqual(unknown("control-failed"));
    expect(linuxRawIpVerdict(measured([]))).toEqual(unknown("no-evidence"));
    expect(linuxRawIpVerdict({ ...measured([CONTROL, ...targets]), ran: false })).toEqual(unknown("no-evidence"));
    expect(linuxRawIpVerdict(measured([CONTROL, ...targets], { tlRan: false }))).toEqual(unknown("no-evidence"));
  });

  it("names a missing route as no-route or ipv6-unmeasured", () => {
    expect(linuxRawIpVerdict(measured([CONTROL, "T4 Network is unreachable", `T6 ${REFUSED}`, "TL deadline", "IF lo"])))
      .toEqual(unknown("timeout"));
    expect(linuxRawIpVerdict(measured([CONTROL, "T4 Network is unreachable", `T6 ${REFUSED}`, "TL No route to host", "IF lo"])))
      .toEqual(unknown("no-route"));
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, "T6 Bad file descriptor", "TL Bad file descriptor", "IF lo"])))
      .toEqual(unknown("unclassified"));
  });

  it("publishes container coverage from the verdict only", () => {
    expect(containerEgressProtocolCoverage("bubblewrap")).toEqual({ dns: "unknown", rawIp: "unknown" });
    const accepted = (rawIp: LinuxRawIpVerdict, platform: NodeJS.Platform = "linux") =>
      acceptMeasuredContainerEgress(platform, "bubblewrap", posixContainerMeasuredEgress(rawIp));
    expect(accepted(unknown("timeout"))).toBeUndefined();
    expect(accepted(blocked("structural"))).toEqual({ dns: "unknown", rawIp: "blocked" });
    expect(accepted(blocked("arrival"))).toEqual({ dns: "unknown", rawIp: "blocked" });
    expect(accepted(blocked("arrival"), "darwin")).toBeUndefined();
    expect(accepted(blocked("arrival"), "win32")).toBeUndefined();
  });

  it("runs no host targets, rather than failing the canary, when the host address cannot be bound", async () => {
    // A documentation address is never local, so binding it fails the way a vanished interface would.
    await expect(openLinuxRawIpHostTargets("192.0.2.55", "nonce")).resolves.toBeUndefined();
    await expect(openLinuxRawIpHostTargets(undefined, "nonce")).resolves.toBeUndefined();
    const targets = await openLinuxRawIpHostTargets("127.0.0.1", "nonce");
    expect(targets).toMatchObject({ address: "127.0.0.1", closedPort: expect.any(Number), udp: { port: expect.any(Number) },
      tcp: { port: expect.any(Number) } });
    await targets?.close();
  });

  it("proves the TCP arrival listener with an unconfined control and counts any other connection as an arrival", async () => {
    const targets = await openLinuxRawIpHostTargets("127.0.0.1", "nonce");
    if (targets === undefined) throw new Error("loopback host targets did not open");
    try {
      expect(targets.tcp.arrived).toBe(false);
      await expect(targets.tcp.control()).resolves.toBe(true);
      expect(targets.tcp.arrived).toBe(false);
      // A bare connect with no payload is an arrival.
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: targets.tcp.port }, () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
      await expect.poll(() => targets.tcp.arrived).toBe(true);
    } finally {
      await targets.close();
    }
  });

  it("hands the prober the arrival port after the UDP port", () => {
    expect(linuxRawIpProberArguments({ nonce: "n", host: "10.0.0.5", closedPort: 1, udpPort: 2, arrivalPort: 3 }))
      .toEqual(["3", "n", "10.0.0.5", "1", "2", "3"]);
    expect(linuxRawIpProberArguments({ nonce: "n", host: undefined, closedPort: undefined, udpPort: undefined, arrivalPort: undefined }))
      .toEqual(["3", "n", "-", "0", "0", "0"]);
  });
});
