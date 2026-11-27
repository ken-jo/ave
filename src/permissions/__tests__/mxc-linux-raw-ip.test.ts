import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptMeasuredContainerEgress, containerEgressProtocolCoverage, posixContainerMeasuredEgress, type LinuxRawIpVerdict, type MxcRawIpUdpArrival } from "../../shared/sandbox-capability-info.js";
import { INVOCATION_PROXY_REFUSED_STATUS } from "../egress-invocation-listener.js";
import {
  classifyLinuxRawIpTarget, type LinuxRawIpMeasurement, linuxFirewallPayloadDrops, linuxRawIpHostInBackendNetwork, linuxRawIpProberArguments, linuxRawIpTcpArrived,
  linuxRawIpUdpArrival, linuxRawIpUdpSend, linuxRawIpVerdict, readLinuxFirewallFamilyPayload,
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
    ran: true, backend: "slirp", output: parseLinuxRawIpProbeOutput(lines.join("\n")), expectedStatus: INVOCATION_PROXY_REFUSED_STATUS,
    nonceRecorded: true, tlRan: true, udpArrival: "absent", firewallDrops: false, hostInBackendNetwork: false, ...overrides,
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
    // No canary has observed a TCP policy refusal on the slirp shell route: there a drop is judged by arrival.
    expect(classifyLinuxRawIpTarget(REFUSED, "slirp")).toEqual({ class: "inconclusive", kind: "unclassified" });
    expect(classifyLinuxRawIpTarget("Permission denied", "slirp")).toEqual({ class: "inconclusive", kind: "unclassified" });
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

  it("never publishes blocked on the slirp shape from TCP policy refusals alone", () => {
    for (const interfaces of ["IF lo,tap0", "IF lo"]) {
      for (const extra of [{}, ARRIVAL_HELD]) {
        const verdict = linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, `T6 ${REFUSED}`, "TL deadline", "TA deadline", `UA ${REFUSED}`, interfaces], extra));
        expect(verdict.rawIp, `${interfaces} ${JSON.stringify(extra)}`).toBe("unknown");
      }
    }
    // Structure alone is no evidence either.
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, "T6 Network is unreachable", `TL ${REFUSED}`, "IF lo"])).rawIp).toBe("unknown");
  });

  it("publishes no arrival evidence when the host's address lies in the backend's own network", () => {
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, hostInBackendNetwork: true }))).toEqual(unknown("arrival-unprovable"));
    expect(linuxRawIpHostInBackendNetwork("10.0.2.15")).toBe(true);
    expect(linuxRawIpHostInBackendNetwork("10.0.2.0")).toBe(true);
    expect(linuxRawIpHostInBackendNetwork("10.0.3.15")).toBe(false);
    expect(linuxRawIpHostInBackendNetwork("192.168.1.10")).toBe(false);
    expect(linuxRawIpHostInBackendNetwork(undefined)).toBe(false);
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
    // A TCP policy refusal is no drop on this shape, so it leaves the verdict unknown even with arrival evidence.
    expect(linuxRawIpVerdict(measured([CONTROL, `T4 ${REFUSED}`, "T6 deadline", "TL deadline", "TA deadline", "IF lo,tap0"], ARRIVAL_HELD)).rawIp)
      .toBe("unknown");
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

  it("reads the launcher firewall only in the exact shape the pinned launcher writes, across appended transactions", () => {
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
    // Only one transaction per family has been observed. Accepting more is safe because the launcher applies each
    // payload with `iptables-restore -n` (no flush), so a later one can only append, and an append is read here too.
    expect(linuxFirewallPayloadDrops(`${V4_PAYLOAD}\n${V4_PAYLOAD.replace("-A OUTPUT -j MXC_EGRESS\n", "")}`, 4, 12345)).toBe(true);
  });

  describe("the launcher's firewall payload on disk", () => {
    let dir: string;
    const make = () => {
      dir = mkdtempSync(join(tmpdir(), "mxc-bwrap-proxy-"));
      chmodSync(dir, 0o700);
      return dir;
    };

    it("reads the payload files through one checked descriptor each", async () => {
      make();
      try {
        writeFileSync(join(dir, "rules.v4.000"), V4_PAYLOAD, { mode: 0o600 });
        await expect(readLinuxFirewallFamilyPayload(dir, 4)).resolves.toBe(V4_PAYLOAD);
        await expect(readLinuxFirewallFamilyPayload(dir, 6)).resolves.toBeUndefined();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("does not follow a link in place of a payload file", async () => {
      make();
      try {
        writeFileSync(join(dir, "elsewhere"), V4_PAYLOAD, { mode: 0o600 });
        symlinkSync(join(dir, "elsewhere"), join(dir, "rules.v4.000"));
        await expect(readLinuxFirewallFamilyPayload(dir, 4)).resolves.toBeUndefined();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("takes no evidence from a payload or a folder that group or others can write", async () => {
      make();
      try {
        writeFileSync(join(dir, "rules.v4.000"), V4_PAYLOAD, { mode: 0o600 });
        chmodSync(join(dir, "rules.v4.000"), 0o620);
        await expect(readLinuxFirewallFamilyPayload(dir, 4)).resolves.toBeUndefined();
        chmodSync(join(dir, "rules.v4.000"), 0o600);
        chmodSync(dir, 0o702);
        await expect(readLinuxFirewallFamilyPayload(dir, 4)).resolves.toBeUndefined();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });

  it("is unknown when anything reached a peer, by TCP or by UDP arrival", () => {
    const refused = [CONTROL, `T4 ${REFUSED}`, `T6 ${REFUSED}`];
    expect(linuxRawIpVerdict(measured([...refused, "TL Connection refused", "IF lo"]))).toEqual(unknown("raw-ip-reachable", ["tl"]));
    expect(linuxRawIpVerdict(measured([...refused, "TL 0", "IF lo"]))).toEqual(unknown("raw-ip-reachable", ["tl"]));
    expect(linuxRawIpVerdict(measured([...refused, "TL deadline", "UA 0", "IF lo"], { udpArrival: "arrived" })))
      .toEqual(unknown("raw-ip-reachable", ["udp"], "arrived"));
    // A datagram that left the container but never arrived leaves the TCP verdict standing.
    expect(linuxRawIpVerdict(measured(DROPPED.map((line) => line.startsWith("UA ") ? "UA 0" : line), ARRIVAL_HELD))).toEqual(blocked("arrival"));
  });

  it("never publishes blocked while the UDP datagram is unmeasured, as on macOS", () => {
    const unmeasured = { udpArrival: "unmeasured" } as const;
    expect(linuxRawIpVerdict(measured(DROPPED, { ...ARRIVAL_HELD, ...unmeasured })))
      .toEqual(unknown("udp-unmeasured", [], "unmeasured"));
    // Without the TCP evidence the TCP reason still names what failed first.
    expect(linuxRawIpVerdict(measured(DROPPED, unmeasured))).toEqual(unknown("timeout", [], "unmeasured"));
  });

  it("measures UDP arrival only from an open listener and a datagram sent or refused locally", () => {
    expect(linuxRawIpUdpSend("0")).toBe("sent");
    expect(linuxRawIpUdpSend(REFUSED)).toBe("refused-local");
    expect(linuxRawIpUdpSend("Permission denied")).toBe("refused-local");
    for (const printed of [undefined, "deadline", "Network is unreachable", "Bad file descriptor"]) {
      expect(linuxRawIpUdpSend(printed), String(printed)).toBe("unmeasured");
    }
    expect(linuxRawIpUdpArrival("sent", true, false)).toBe("absent");
    expect(linuxRawIpUdpArrival("refused-local", true, false)).toBe("absent");
    expect(linuxRawIpUdpArrival("unmeasured", true, false)).toBe("unmeasured");
    expect(linuxRawIpUdpArrival("sent", false, false)).toBe("unmeasured");
    // An arrival counts whatever the prober printed.
    expect(linuxRawIpUdpArrival("unmeasured", true, true)).toBe("arrived");
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

  it("counts accepts: only the control's single connection is clean, a second from its source port is an arrival", () => {
    const control = { address: "10.0.0.5", port: 40000 };
    expect(linuxRawIpTcpArrived([], undefined)).toBe(false);
    expect(linuxRawIpTcpArrived([control], control)).toBe(false);
    expect(linuxRawIpTcpArrived([control, control], control)).toBe(true);
    expect(linuxRawIpTcpArrived([{ address: "10.0.0.6", port: 1 }], control)).toBe(true);
    expect(linuxRawIpTcpArrived([control], undefined)).toBe(true);
  });

  it("hands the prober the arrival port after the UDP port", () => {
    expect(linuxRawIpProberArguments({ nonce: "n", host: "10.0.0.5", closedPort: 1, udpPort: 2, arrivalPort: 3 }))
      .toEqual(["3", "n", "10.0.0.5", "1", "2", "3"]);
    expect(linuxRawIpProberArguments({ nonce: "n", host: undefined, closedPort: undefined, udpPort: undefined, arrivalPort: undefined }))
      .toEqual(["3", "n", "-", "0", "0", "0"]);
  });
});
