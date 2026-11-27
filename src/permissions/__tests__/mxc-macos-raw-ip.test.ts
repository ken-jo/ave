import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as info from "../../shared/sandbox-capability-info.js";
import { acceptMeasuredContainerEgress, containerEgressProtocolCoverage } from "../../shared/sandbox-capability-info.js";
import {
  classifyRawIpTarget, parseRawIpProbeOutput, rawIpVerdict, seatbeltProfileAllowsOnlyProxyEgress, type RawIpMeasurement,
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

const PROXY = 4321;
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

describe("macOS structural network evidence", () => {
  const profile = (network: string) => ["(version 1)", "(deny default)", "(allow file-read* (subpath \"/x\"))", network,
    "(deny file-write* network-outbound (subpath \"/y\"))"].join("\n");

  it("holds only for a default deny whose single outbound allow is the proxy port", () => {
    expect(seatbeltProfileAllowsOnlyProxyEgress(profile(`(allow network-outbound (remote ip "localhost:${PROXY}"))`), PROXY)).toBe(true);
  });

  it.each([
    ["another port", `(allow network-outbound (remote ip "localhost:${PROXY + 1}"))`],
    ["all outbound", "(allow network-outbound)"],
    ["a second allow", `(allow network-outbound (remote ip "localhost:${PROXY}"))\n(allow network* (remote ip "*:*"))`],
    ["no allow at all", ""],
  ])("does not hold with %s", (_name, network) => {
    expect(seatbeltProfileAllowsOnlyProxyEgress(profile(network), PROXY)).toBe(false);
  });

  it("does not hold without a default deny", () => {
    const open = profile(`(allow network-outbound (remote ip "localhost:${PROXY}"))`).replace("(deny default)", "(allow default)");
    expect(seatbeltProfileAllowsOnlyProxyEgress(open, PROXY)).toBe(false);
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

describe("macOS raw-IP verdict lifetime", () => {
  it("lives in memory only: no store, settings or cache module handles the verdict", () => {
    const listed = spawnSync("git", ["grep", "-l", "-E", "MacRawIpVerdict|rawIpVerdict\\(", "--", "src", ":!*__tests__*"], { encoding: "utf8" });
    expect(listed.stdout.trim().split("\n").sort()).toEqual([
      "src/permissions/mxc-macos-raw-ip.ts",
      "src/permissions/mxc-macos.ts",
      "src/shared/sandbox-capability-info.ts",
      "src/ui/renderer/tabs/PermissionsTab.tsx",
    ]);
  });
});
