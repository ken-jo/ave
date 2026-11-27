import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as info from "../../shared/sandbox-capability-info.js";
import { acceptMeasuredContainerEgress, containerEgressProtocolCoverage, type MacRawIpVerdict } from "../../shared/sandbox-capability-info.js";
import {
  classifyRawIpTarget, parseRawIpProbeOutput, rawIpVerdict, type RawIpMeasurement,
} from "../mxc-macos-raw-ip.js";

describe("macOS raw-IP target classification", () => {
  it.each([
    ["1", "refused-local", undefined], ["13", "refused-local", undefined],
    ["0", "allowed", undefined], ["61", "allowed", undefined],
    ["51", "inconclusive", "no-route"], ["65", "inconclusive", "no-route"], ["49", "inconclusive", "no-route"], ["47", "inconclusive", "no-route"],
    ["60", "inconclusive", "timeout"], ["deadline", "inconclusive", "timeout"],
    ["nosocket", "inconclusive", "unclassified"], ["22", "inconclusive", "unclassified"],
    [undefined, "inconclusive", "unclassified"], ["EPERM", "inconclusive", "unclassified"], ["", "inconclusive", "unclassified"],
  ] as const)("classifies %s as %s", (code, klass, kind) => {
    expect(classifyRawIpTarget(code)).toEqual(kind === undefined ? { class: klass } : { class: klass, kind });
  });

  it("reads each target once and the control line, ignoring malformed lines", () => {
    expect(parseRawIpProbeOutput("C status=403 refused=loopback destination\nT4 1\nT4 0\nT6 1\nTL\nnoise\nUA 1\n")).toEqual({
      control: { status: "403", refusal: "loopback destination" }, targets: { T4: "1", T6: "1", UA: "1" },
    });
    expect(parseRawIpProbeOutput("")).toEqual({ targets: {} });
  });
});

const blockedRun = (targets: Record<string, string>, extra: Partial<RawIpMeasurement> = {}): RawIpMeasurement => ({
  ran: true, expectedStatus: 403, nonceRecorded: true, tlRan: true, udpArrival: "absent", structuralIpv6: true,
  output: { control: { status: "403", refusal: "loopback destination" }, targets: { T4: "1", T6: "1", TL: "1", UA: "1", ...targets } },
  ...extra,
});
const blocked = (evidenceKind: "measured" | "structural", udpArrival = "absent") =>
  ({ rawIp: "blocked", reason: "blocked", evidenceKind, reachableTargets: [], udpArrival });
const unknown = (reason: string, reachableTargets: string[] = [], udpArrival = "absent") =>
  ({ rawIp: "unknown", reason, reachableTargets, udpArrival });

describe("macOS raw-IP verdict", () => {
  it("is blocked only when the control passed and every target was refused locally", () => {
    expect(rawIpVerdict(blockedRun({}))).toEqual(blocked("measured"));
  });

  it.each([
    ["T4 reached a peer", { T4: "61" }, ["t4"]],
    ["T4 connected after EINPROGRESS", { T4: "0" }, ["t4"]],
    ["T6 reached a peer", { T6: "0" }, ["t6"]],
    ["TL reached the host's own address", { TL: "61" }, ["tl"]],
  ])("is unknown and reachable when %s, naming the target", (_name, targets, reached) => {
    expect(rawIpVerdict(blockedRun(targets))).toEqual(unknown("raw-ip-reachable", reached));
  });

  it("is unknown and reachable when the UDP nonce arrived, whatever TCP or the control did", () => {
    expect(rawIpVerdict(blockedRun({ UA: "0" }, { udpArrival: "arrived" })))
      .toEqual(unknown("raw-ip-reachable", ["udp"], "arrived"));
    expect(rawIpVerdict(blockedRun({ UA: "0", TL: "61" }, { udpArrival: "arrived", nonceRecorded: false })))
      .toEqual(unknown("raw-ip-reachable", ["tl", "udp"], "arrived"));
  });

  it("lets the TCP verdict stand when the UDP datagram was sent but never arrived", () => {
    expect(rawIpVerdict(blockedRun({ UA: "0" }))).toEqual(blocked("measured"));
  });

  it("is unknown when nothing measured the UDP datagram, as on Windows", () => {
    expect(rawIpVerdict(blockedRun({}, { udpArrival: "unmeasured" }))).toEqual(unknown("udp-unmeasured", [], "unmeasured"));
  });

  it("counts the profile's default deny as IPv6 evidence only for a no-route T6", () => {
    expect(rawIpVerdict(blockedRun({ T6: "65" }))).toEqual(blocked("structural"));
    expect(rawIpVerdict(blockedRun({ T6: "65" }, { structuralIpv6: false }))).toEqual(unknown("ipv6-unmeasured"));
    expect(rawIpVerdict(blockedRun({ T6: "deadline" }))).toEqual(unknown("timeout"));
    expect(rawIpVerdict(blockedRun({ T6: "22" }))).toEqual(unknown("unclassified"));
  });

  it("lets TL only downgrade: an inconclusive TL is not an allowed one", () => {
    expect(rawIpVerdict(blockedRun({ TL: "60" }))).toEqual(blocked("measured"));
    expect(rawIpVerdict(blockedRun({ TL: "65" }))).toEqual(blocked("measured"));
  });

  it("is unknown with the named reason for every other case", () => {
    expect(rawIpVerdict(blockedRun({}, { tlRan: false }))).toEqual(unknown("no-evidence"));
    expect(rawIpVerdict(blockedRun({}, { nonceRecorded: false }))).toEqual(unknown("control-failed"));
    expect(rawIpVerdict(blockedRun({}, { output: { control: { status: "none", refusal: "none" }, targets: { T4: "1", T6: "1", TL: "1" } } })))
      .toEqual(unknown("control-failed"));
    expect(rawIpVerdict(blockedRun({}, { output: { control: { status: "403", refusal: "none" }, targets: { T4: "1", T6: "1", TL: "1" } } })))
      .toEqual(unknown("control-failed"));
    expect(rawIpVerdict(blockedRun({}, { ran: false }))).toEqual(unknown("no-evidence"));
    expect(rawIpVerdict({ ...blockedRun({}), output: { targets: {} } })).toEqual(unknown("no-evidence"));
    const { output: _omitted, ...silent } = blockedRun({});
    expect(rawIpVerdict(silent)).toEqual(unknown("no-evidence"));
    expect(rawIpVerdict(blockedRun({ T4: "51" }))).toEqual(unknown("no-route"));
    expect(rawIpVerdict(blockedRun({ T4: "deadline" }))).toEqual(unknown("timeout"));
    expect(rawIpVerdict(blockedRun({ T4: "nosocket" }))).toEqual(unknown("unclassified"));
  });
});

describe("macOS published coverage", () => {
  it("has no constant blocked: DNS is unmeasured and only a measured raw-IP verdict publishes blocked", () => {
    expect(Object.keys(info)).not.toContain("SEATBELT_EGRESS_PROTOCOL_COVERAGE");
    expect(containerEgressProtocolCoverage("seatbelt")).toEqual({ dns: "unknown", rawIp: "unknown" });
    expect(acceptMeasuredContainerEgress("darwin", "seatbelt", { dns: "unknown", rawIp: "blocked" })).toEqual({ dns: "unknown", rawIp: "blocked" });
    for (const coverage of [{ dns: "blocked", rawIp: "blocked" }, { dns: "host-resolver", rawIp: "blocked" }, { dns: "unknown", rawIp: "unknown" },
      { dns: "unknown", rawIp: "blocked", extra: true }] as const) {
      expect(acceptMeasuredContainerEgress("darwin", "seatbelt", coverage)).toBeUndefined();
    }
    expect(acceptMeasuredContainerEgress("linux", "seatbelt", { dns: "unknown", rawIp: "blocked" })).toBeUndefined();
    expect(acceptMeasuredContainerEgress("darwin", "process-container", { dns: "unknown", rawIp: "blocked" })).toBeUndefined();
  });
});

describe.runIf(process.platform === "darwin")("macOS raw-IP verdict lifetime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lives in memory for one boot: a fresh load starts unmeasured and publishing writes nothing to the Ave home", async () => {
    const aveHome = mkdtempSync(join(tmpdir(), "ave-raw-ip-"));
    try {
      vi.stubEnv("AVE_HOME", aveHome);
      const boot = async () => {
        vi.resetModules();
        const capability = await import("../sandbox-capability.js");
        capability.setShellSandboxRequestedAtBoot(true);
        capability.setActiveSandboxCapability({
          platform: "darwin", kind: "asrt", confidence: "verified", reason: "Active sandbox",
          confines: { filesystem: true, process: true, network: true },
        });
        return capability;
      };
      const first = await boot();
      first.setContainerShellSubstrate({ state: "available", rawIpProbe: blocked("measured") as MacRawIpVerdict });
      expect(first.getHostShellExecutionPlan().egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "blocked" });
      expect(readdirSync(aveHome)).toEqual([]);
      const next = await boot();
      expect(next.getMacContainerShellInfo()).toBeUndefined();
      expect(next.getHostShellExecutionPlan().egressProtocolCoverage.rawIp).toBe("unknown");
    } finally {
      rmSync(aveHome, { recursive: true, force: true });
    }
  });
});
