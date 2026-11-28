import { createSocket } from "node:dgram";
import { once } from "node:events";
import { get } from "node:http";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { readMxcRawIpProbeScript } from "../../__tests__/support/mxc-raw-ip-probe.js";
import { openInvocationProxyListener } from "../egress-invocation-listener.js";
import {
  classifyMxcRawIpProbe,
  mxcRawIpBlockingRequirement,
  parseMxcRawIpProbeEvidence,
  probeMxcPowerShellStart,
  type DetectMxcSupportDeps,
} from "../mxc-windows.js";

const wrapUdpClose = vi.hoisted(() => vi.fn((close: () => Promise<void>) => close));

vi.mock("../mxc-raw-ip-udp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mxc-raw-ip-udp.js")>();
  return {
    ...actual,
    openMxcRawIpUdpListener: (async (address, probeId, deadline, adopt) => {
      const listener = await actual.openMxcRawIpUdpListener("127.0.0.1", probeId, deadline, adopt);
      if (listener === undefined) return undefined;
      return { ...listener, address, close: wrapUdpClose(listener.close) };
    }) satisfies typeof actual.openMxcRawIpUdpListener,
  };
});

const REFUSED: NonNullable<ReturnType<typeof parseMxcRawIpProbeEvidence>> = {
  control: true, t4: 10013, t6: 10013, tl: 10013, capabilitySids: null, udp: "refused-local",
};
const PROBE_ID = "a".repeat(32);
const EVIDENCE_LINE = evidenceFrame(PROBE_ID);
const HOST_LOOKUP_PROGRESS = [
  "#< CLIXML",
  '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN>'
    + '<MS><I64 N="SourceId">1</I64><PR N="Record"><AV>처음 사용하기 위해 모듈을 준비하는 중입니다.</AV>'
    + '<AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>'
    + '<Obj S="progress" RefId="1"><TNRef RefId="0" />'
    + '<MS><I64 N="SourceId">2</I64><PR N="Record"><AV>Get-NetRoute -AddressFamily IPv6</AV>'
    + '<AI>42</AI><Nil /><PI>-1</PI><PC>100</PC><T>Completed</T><SR>0</SR><SD>1/1 완료</SD></PR></MS></Obj></Objs>',
].join("\r\n");

function evidenceFrame(id: string, evidence = REFUSED): string {
  return `AVE_MXC_RAW_IP ${id} ${JSON.stringify(evidence)}\r\n`;
}

describe("Windows raw IP probe classification", () => {
  it.each([
    [10013, "blocked"], [10061, "raw-ip-reachable"], ["connected", "raw-ip-reachable"],
    [10051, "no-route"], [10065, "no-route"], [10049, "unclassified"], [10047, "unclassified"],
    [10060, "timeout"], ["deadline", "timeout"], ["other", "unclassified"], [10022, "unclassified"],
  ] as const)("classifies IPv4 result %s as %s", (t4, reason) => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, t4 }, true, "absent")).toMatchObject({ reason, rawIp: reason === "blocked" ? "blocked" : "unknown" });
  });

  it.each([10051, 10065, 10049, 10047])("reports IPv6 result %s as unmeasured", (t6) => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, t6, tl: "other" }, true, "absent")).toMatchObject({ rawIp: "unknown", reason: "ipv6-unmeasured" });
  });

  it("uses the LAN result to downgrade a verdict when a peer answered", () => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, tl: 10061 }, true, "absent")).toMatchObject({ rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["tl"] });
    expect(classifyMxcRawIpProbe({ ...REFUSED, tl: "deadline" }, true, "absent").rawIp).toBe("blocked");
  });

  it("only downgrades a blocked verdict when a listener binds after the LAN lookup", () => {
    const beforeBind = { ...REFUSED, t6: 10013, tl: "deadline" } as const;
    expect(classifyMxcRawIpProbe(beforeBind, true, "absent")).toEqual({
      rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent",
    });
    const afterBind = { ...beforeBind, tl: "connected" } as const;
    expect(classifyMxcRawIpProbe(afterBind, true, "absent")).toEqual({
      rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["tl"], udpArrival: "absent",
    });
  });

  it("retains a reachable target when the control failed", () => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, t6: "connected" }, false, "absent")).toEqual({
      rawIp: "unknown", reason: "control-failed", reachableTargets: ["t6"], udpArrival: "absent",
    });
    expect(classifyMxcRawIpProbe({ ...REFUSED, control: false }, true, "absent").reason).toBe("control-failed");
  });

  it("keeps coverage unknown when no UDP observation is available", () => {
    expect(classifyMxcRawIpProbe(REFUSED, true, "unmeasured")).toMatchObject({ rawIp: "unknown", reason: "udp-unmeasured" });
  });
});

describe("additional raw IP blocking requirements", () => {
  const proxyEvidence = { ...REFUSED, t6: 10051, capabilitySids: ["S-1-15-3-3"] };
  const proxyLaunch = { hostIpv6Route: "absent", launchMode: "proxy" } as const;

  it.each([10051, 10065])("accepts structural evidence from the proxy probe for no-route result %s", (t6) => {
    expect(classifyMxcRawIpProbe({ ...proxyEvidence, t6 }, true, "absent", proxyLaunch)).toEqual({
      rawIp: "blocked", reason: "blocked", evidenceKind: "structural", reachableTargets: [], udpArrival: "absent",
    });
  });

  it.each([
    [10051, "present"], [10065, "present"], [10051, "unknown"], [10065, "unknown"],
  ] as const)("keeps T6 %i unmeasured when the host route is %s", (t6, hostIpv6Route) => {
    expect(classifyMxcRawIpProbe({ ...proxyEvidence, t6 }, true, "absent", { ...proxyLaunch, hostIpv6Route })).toMatchObject({
      rawIp: "unknown", reason: "ipv6-unmeasured",
    });
  });

  it.each([
    [10051, "plain"], [10065, "plain"], [10051, "unproven"], [10065, "unproven"],
  ] as const)("keeps T6 %i unmeasured for a %s launch", (t6, launchMode) => {
    const hostEvidence = launchMode === "plain"
      ? { hostIpv6Route: "absent", launchMode } as const : { hostIpv6Route: "absent" } as const;
    expect(classifyMxcRawIpProbe({ ...proxyEvidence, t6 }, true, "absent", hostEvidence)).toMatchObject({
      rawIp: "unknown", reason: "ipv6-unmeasured",
    });
  });

  it.each([
    { scenario: "container control fails", evidence: { control: false }, controlRefused: true, udpArrival: "absent", reason: "control-failed", reachableTargets: [] },
    { scenario: "host control fails", evidence: {}, controlRefused: false, udpArrival: "absent", reason: "control-failed", reachableTargets: [] },
    { scenario: "LAN probe is inconclusive", evidence: { tl: "deadline" }, controlRefused: true, udpArrival: "absent", reason: "ipv6-unmeasured", reachableTargets: [] },
    { scenario: "LAN probe returns another code", evidence: { tl: 10051 }, controlRefused: true, udpArrival: "absent", reason: "ipv6-unmeasured", reachableTargets: [] },
    { scenario: "LAN target is missing", evidence: { tl: "other" }, controlRefused: true, udpArrival: "absent", reason: "ipv6-unmeasured", reachableTargets: [] },
    { scenario: "LAN peer refuses the connection", evidence: { tl: 10061 }, controlRefused: true, udpArrival: "absent", reason: "raw-ip-reachable", reachableTargets: ["tl"] },
    { scenario: "UDP arrival is unmeasured", evidence: { udp: "unmeasured" }, controlRefused: true, udpArrival: "unmeasured", reason: "udp-unmeasured", reachableTargets: [] },
    { scenario: "UDP datagram arrives", evidence: { udp: "sent" }, controlRefused: true, udpArrival: "arrived", reason: "raw-ip-reachable", reachableTargets: ["udp"] },
  ] as const)("keeps proxy coverage unknown when $scenario", ({ evidence, controlRefused, udpArrival, reason, reachableTargets }) => {
    expect(classifyMxcRawIpProbe({ ...proxyEvidence, ...evidence }, controlRefused, udpArrival, proxyLaunch)).toEqual({
      rawIp: "unknown", reason, reachableTargets, udpArrival,
    });
  });

  it.each([10049, 10047])("keeps IPv6 result %s unmeasured with proxy evidence", (t6) => {
    expect(classifyMxcRawIpProbe({ ...proxyEvidence, t6 }, true, "absent", proxyLaunch)).toMatchObject({
      rawIp: "unknown", reason: "ipv6-unmeasured",
    });
  });

  it.each(["absent", "present", "unknown"] as const)("reports a local IPv6 refusal as measured when the host route is %s", (hostIpv6Route) => {
    expect(classifyMxcRawIpProbe({ ...proxyEvidence, t6: 10013 }, true, "absent", { ...proxyLaunch, hostIpv6Route })).toMatchObject({
      rawIp: "blocked", evidenceKind: "measured",
    });
  });

  it.each([10051, 10065])("accepts a successful empty capability read for no-route result %s", (t6) => {
    const evidence = { ...REFUSED, t6, tl: "other", capabilitySids: [] } as const;
    expect(mxcRawIpBlockingRequirement(evidence)).toBe("refused-structural");
    expect(classifyMxcRawIpProbe(evidence, true, "absent")).toMatchObject({ rawIp: "blocked", evidenceKind: "structural" });
  });

  it.each(["S-1-15-3-1", "S-1-15-3-2", "S-1-15-3-3"])("keeps IPv6 unmeasured with capability %s", (sid) => {
    expect(mxcRawIpBlockingRequirement({ t6: 10051, capabilitySids: [sid] })).toBe("ipv6-unmeasured");
  });

  it("requires a successful capability read for structural evidence", () => {
    expect(mxcRawIpBlockingRequirement({ t6: 10051, capabilitySids: null })).toBe("ipv6-unmeasured");
    expect(mxcRawIpBlockingRequirement({ t6: 10049, capabilitySids: [] })).toBe("ipv6-unmeasured");
    expect(mxcRawIpBlockingRequirement({ t6: 10060, capabilitySids: [] })).toBe("timeout");
    expect(mxcRawIpBlockingRequirement({ t6: "other", capabilitySids: [] })).toBe("unclassified");
    expect(mxcRawIpBlockingRequirement({ t6: 10013, capabilitySids: null })).toBe("refused-local");
  });
});

describe("raw IP evidence frame", () => {
  it("reads a single complete frame for the probe", () => {
    expect(parseMxcRawIpProbeEvidence(EVIDENCE_LINE, PROBE_ID)).toEqual(REFUSED);
  });

  it("preserves the capability list in the matching frame", () => {
    const evidence = { ...REFUSED, t6: 10051, capabilitySids: ["S-1-15-3-7"] };
    const line = evidenceFrame(PROBE_ID, evidence);
    expect(parseMxcRawIpProbeEvidence(line, PROBE_ID)).toEqual(evidence);
    expect(parseMxcRawIpProbeEvidence(line, "b".repeat(32))).toBeUndefined();
  });

  it.each([["S-1-15-3-7"], [["invalid-sid"]], [["S-1-15-3-7", 7]]])("rejects malformed capability data %j despite TCP refusals", (capabilitySids) => {
    const line = EVIDENCE_LINE.replace('"capabilitySids":null', `"capabilitySids":${JSON.stringify(capabilitySids)}`);
    const parsed = parseMxcRawIpProbeEvidence(line, PROBE_ID);
    expect(classifyMxcRawIpProbe(parsed, true, "absent")).toMatchObject({ rawIp: "unknown", reason: "no-evidence" });
  });

  it.each([
    "", "AVE_MXC_RAW_IP {", EVIDENCE_LINE.trimEnd(),
    evidenceFrame("b".repeat(32)), evidenceFrame("").replace("  ", " "),
    EVIDENCE_LINE.replace('"t4":10013', '"t4":"10013"'),
    EVIDENCE_LINE.replace('"t4":10013', '"t4":10013,"t4":10013'),
    EVIDENCE_LINE.replace(',"capabilitySids":null', ''),
    EVIDENCE_LINE.replace('"udp":"refused-local"', '"udp":"arrived"'),
    EVIDENCE_LINE.repeat(2), `launcher\r\n${EVIDENCE_LINE}`, `${EVIDENCE_LINE}other\r\n`,
  ])("treats invalid or absent evidence as unknown (%j)", (stdout) => {
    expect(classifyMxcRawIpProbe(parseMxcRawIpProbeEvidence(stdout, PROBE_ID), true, "unmeasured").reason).toBe("no-evidence");
  });

  it("rejects extra output on stderr", () => {
    expect(parseMxcRawIpProbeEvidence(EVIDENCE_LINE, PROBE_ID, "launcher warning")).toBeUndefined();
  });
});

function makeDeps(run: DetectMxcSupportDeps["run"]): DetectMxcSupportDeps {
  return {
    platform: "win32", arch: "x64", resourcePath: "C:\\example\\resources", windowsBuild: null,
    probeDirectory: "C:\\example\\scratch", systemRoot: "C:\\Windows", exists: () => true, sha256: async () => "", run,
  };
}

function probeScriptInputs(args: readonly string[]) {
  const request = JSON.parse(Buffer.from(args[1] ?? "", "base64").toString("utf8"));
  const script = readMxcRawIpProbeScript(request.process.commandLine);
  const id = /'AVE_MXC_RAW_IP ([a-f0-9]{32}) '/.exec(script)?.[1];
  const controlHost = /Invoke-Tcp '127\.0\.0\.1' \d+ '(127\.[\d.]+)'/.exec(script)?.[1];
  if (controlHost === undefined) throw new Error("Missing proxy control destination");
  const udp = /Invoke-Udp '192\.0\.2\.2' (\d+) '([a-f0-9]{32})'/.exec(script);
  return { id: id ?? "", controlHost, proxyUrl: new URL(request.runtimeConfig.networkProxy), udp };
}

function requestProxyRefusal(proxy: URL, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    get(proxy, { path: `http://${host}/` }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
}

async function expectUdpPortReleased(port: number | undefined): Promise<void> {
  if (port === undefined) throw new Error("Missing UDP listener port");
  const replacement = createSocket("udp4");
  try {
    const listening = once(replacement, "listening");
    replacement.bind(port, "127.0.0.1");
    await listening;
  } finally {
    replacement.close();
  }
}

async function expectTcpPortReleased(port: number): Promise<void> {
  const replacement = createServer();
  try {
    const listening = once(replacement, "listening");
    replacement.listen(port, "127.0.0.1");
    await listening;
  } finally {
    replacement.close();
  }
}

describe("raw IP startup observation", () => {
  it.each([
    { scenario: "arrival", udp: "sent", datagram: "matching", udpArrival: "arrived", rawIp: "unknown", reason: "raw-ip-reachable" },
    { scenario: "no arrival", udp: "sent", datagram: undefined, udpArrival: "absent", rawIp: "blocked", reason: "blocked" },
    { scenario: "a local UDP refusal", udp: "refused-local", datagram: undefined, udpArrival: "absent", rawIp: "blocked", reason: "blocked" },
    { scenario: "a different nonce", udp: "sent", datagram: "wrong", udpArrival: "absent", rawIp: "blocked", reason: "blocked" },
  ] as const)("observes $scenario at the invocation UDP port", async ({ udp, datagram, udpArrival, rawIp, reason }) => {
    let udpPort: number | undefined;
    const result = await probeMxcPowerShellStart(makeDeps(async (_file, args) => {
      if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
      const { id, controlHost, proxyUrl, udp: target } = probeScriptInputs(args);
      if (target === null) return { code: 0, stdout: evidenceFrame(id), stderr: "" };
      const port = Number(target[1]);
      udpPort = port;
      expect(target[2]).toBe(id);
      expect(await requestProxyRefusal(proxyUrl, controlHost)).toBe(403);
      if (datagram !== undefined) {
        const sender = createSocket("udp4");
        const nonce = datagram === "matching" ? id : (id[0] === "a" ? "b" : "a") + id.slice(1);
        try {
          await new Promise<void>((resolve, reject) => {
            sender.send(nonce, port, "127.0.0.1", error => { if (error) reject(error); else resolve(); });
          });
        } finally {
          sender.close();
        }
      }
      const frame = { ...REFUSED, udp };
      return { code: 0, stdout: evidenceFrame(id, frame), stderr: "" };
    }), openInvocationProxyListener);
    expect(result).toMatchObject({ state: "available", rawIpProbe: { rawIp, reason, udpArrival } });
    await expectUdpPortReleased(udpPort);
  });

  describe.each([10051, 10065, 10013])("startup evidence with T6 %i", (t6) => {
    it.each([
      { scenario: "scoped global prefix", prefix: "2001:db8:1::%12/48" },
      { scenario: "missing frame" },
      { scenario: "plain text on stderr", prefix: "2001:db8:1::/48", stderr: "Route lookup failed" },
      { scenario: "progress-shaped stderr", prefix: "2001:db8:1::/48", stderr: HOST_LOOKUP_PROGRESS },
      { scenario: "serialized error on stderr", prefix: "2001:db8:1::/48", stderr: HOST_LOOKUP_PROGRESS.replace('S="progress" RefId="1"', 'S="Error" RefId="1"') },
      { scenario: "whitespace on stderr", prefix: "2001:db8:1::/48", stderr: " \r\n" },
      { scenario: "deeply nested XML on stderr", prefix: "2001:db8:1::/48", stderr: HOST_LOOKUP_PROGRESS.replace("<Nil />", `${"<L>".repeat(128)}<Nil />${"</L>".repeat(128)}`) },
      { scenario: "unrelated route", prefix: "2001:db8:1::/48", structural: true },
      { scenario: "default route", prefix: "::/0" },
      { scenario: "exact T6 route", prefix: "2001:db8::1/128" },
      { scenario: "out-of-range prefix length", prefix: "2001:db8:1::/129" },
      { scenario: "malformed prefix length", prefix: "2001:db8:1::/48/64" },
      { scenario: "IPv4 prefix", prefix: "192.0.2.0/24" },
    ])("classifies host route evidence with $scenario", async ({ prefix, stderr = "", structural }) => {
      const result = await probeMxcPowerShellStart(makeDeps(async (_file, args) => {
        if (args[0] !== "--config-base64") {
          const hostOutput = prefix === undefined ? "" : `AVE_MXC_IPV6_ROUTES ${JSON.stringify([prefix])}\r\n`;
          return { code: 0, stdout: `${hostOutput}192.0.2.2:49152`, stderr };
        }
        const { id, controlHost, proxyUrl } = probeScriptInputs(args);
        expect(await requestProxyRefusal(proxyUrl, controlHost)).toBe(403);
        return { code: 0, stdout: evidenceFrame(id, { ...REFUSED, t6, capabilitySids: ["S-1-15-3-3"] }), stderr: "" };
      }), openInvocationProxyListener);
      expect(result.state).toBe("available");
      const evidenceKind = t6 === 10013 ? "measured" : structural ? "structural" : undefined;
      expect(result.state === "available" && result.rawIpProbe).toEqual({
        ...(evidenceKind === undefined
          ? { rawIp: "unknown", reason: "ipv6-unmeasured" }
          : { rawIp: "blocked", reason: "blocked", evidenceKind }),
        reachableTargets: [], udpArrival: "absent",
      });
    });
  });

  it("requires the exact control destination and a fresh evidence ID for each launch", async () => {
    const ids = new Set<string>();
    const runProbe = async (matchesControl: boolean) => await probeMxcPowerShellStart(makeDeps(async (_file, args) => {
      if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
      const { id, controlHost, proxyUrl } = probeScriptInputs(args);
      ids.add(id);
      const host = matchesControl ? controlHost : controlHost === "127.0.0.1" ? "127.0.0.2" : "127.0.0.1";
      expect(await requestProxyRefusal(proxyUrl, host)).toBe(403);
      return { code: 0, stdout: evidenceFrame(id), stderr: "" };
    }), openInvocationProxyListener);
    await expect(runProbe(true)).resolves.toMatchObject({ state: "available", rawIpProbe: { rawIp: "blocked" } });
    await expect(runProbe(false)).resolves.toMatchObject({ state: "available", rawIpProbe: { reason: "control-failed" } });
    expect(ids.size).toBe(2);
  });

  it.each([
    ["wrong ID", () => evidenceFrame("wrong")],
    ["missing ID", () => `AVE_MXC_RAW_IP ${JSON.stringify(REFUSED)}\r\n`],
    ["missing frame", () => ""],
    ["duplicate frame", (id: string) => evidenceFrame(id).repeat(2)],
    ["unrelated output", (id: string) => `${evidenceFrame(id)}exit 0\r\n`],
  ] as const)("keeps coverage unknown with a %s after the host refused the control", async (_label, output) => {
    const run = async (_file: string, args: readonly string[]) => {
      if (args[0] !== "--config-base64") return { code: 0, stdout: "", stderr: "" };
      const { id, controlHost, proxyUrl } = probeScriptInputs(args);
      expect(await requestProxyRefusal(proxyUrl, controlHost)).toBe(403);
      return { code: 0, stdout: output(id), stderr: "" };
    };
    await expect(probeMxcPowerShellStart(makeDeps(run), openInvocationProxyListener)).resolves.toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
    });
  });

  it("checks availability with the original proxy placeholder when the listener cannot open", async () => {
    const run = vi.fn<DetectMxcSupportDeps["run"]>().mockResolvedValue({ code: 0, stdout: EVIDENCE_LINE, stderr: "" });
    await expect(probeMxcPowerShellStart(makeDeps(run), async () => { throw new Error("bind failed"); }))
      .resolves.toMatchObject({ state: "available", rawIpProbe: { rawIp: "unknown", reason: "listener-unavailable" } });
    expect(run).toHaveBeenCalledOnce();
    const request = JSON.parse(Buffer.from(run.mock.calls[0]?.[1][1] ?? "", "base64").toString("utf8"));
    expect(request.runtimeConfig.networkProxy).toBe("http://127.0.0.1:9");
  });

  it("caps the LAN lookup and preserves the measured start rejection without a second launch", async () => {
    const epoch = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
    const run = vi.fn<DetectMxcSupportDeps["run"]>()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("Measured launcher timed out"))
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    try {
      await expect(probeMxcPowerShellStart(makeDeps(run), async () => {
        clock.mockReturnValue(epoch + 57_000);
        return { port: 49153, url: "http://127.0.0.1:49153", close: async () => {} };
      })).resolves.toMatchObject({ state: "unavailable", reason: "powershell-start-failed" });
    } finally {
      clock.mockRestore();
    }
    expect(run.mock.calls.map(([, , timeout]) => timeout)).toEqual([2_000, 8_000]);
  });

  it("preserves a nonzero measured start without a second launch", async () => {
    const run = vi.fn<DetectMxcSupportDeps["run"]>()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0xc0000142, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    await expect(probeMxcPowerShellStart(makeDeps(run), openInvocationProxyListener))
      .resolves.toMatchObject({ state: "unavailable", reason: "unverified-session" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects a complete matching frame returned after the startup cutoff", async () => {
    const epoch = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
    try {
      const run = vi.fn<DetectMxcSupportDeps["run"]>(async (_file, args) => {
        if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
        const { id, controlHost, proxyUrl } = probeScriptInputs(args);
        expect(await requestProxyRefusal(proxyUrl, controlHost)).toBe(403);
        clock.mockReturnValue(epoch + 60_001);
        return { code: 0, stdout: evidenceFrame(id), stderr: "" };
      });
      await expect(probeMxcPowerShellStart(makeDeps(run), openInvocationProxyListener)).resolves.toMatchObject({
        state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
      });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("cancels an in-progress listener open at the startup cutoff", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => {});
      const run = vi.fn<DetectMxcSupportDeps["run"]>();
      const starting = probeMxcPowerShellStart(makeDeps(run), (options) => {
        options.admission?.adopt(close);
        return new Promise(() => {});
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(close).toHaveBeenCalledOnce();
      await expect(starting).resolves.toMatchObject({ state: "unavailable", reason: "powershell-start-failed" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for listener close at the startup cutoff", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn<() => Promise<void>>(() => new Promise(() => {}));
      const run = vi.fn<DetectMxcSupportDeps["run"]>().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const settled = vi.fn();
      const starting = probeMxcPowerShellStart(makeDeps(run), async () => ({ port: 49153, url: "http://127.0.0.1:49153", close }));
      void starting.then(settled);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(close).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ state: "available", rawIpProbe: expect.objectContaining({ reason: "cleanup-failed" }) }));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { scenario: "a launcher failure", launcherFails: true, closeFails: false, state: "unavailable", closeCount: 1 },
    { scenario: "a recoverable close failure", launcherFails: false, closeFails: true, state: "available", closeCount: 2 },
  ])("releases both listening ports after $scenario", async ({ launcherFails, closeFails, state, closeCount }) => {
    const open = vi.fn<typeof openInvocationProxyListener>();
    const close = vi.fn<() => Promise<void>>();
    open.mockImplementation(async (options) => {
      const listener = await openInvocationProxyListener(options);
      if (closeFails) close.mockRejectedValueOnce(new Error("Transient close failure"));
      close.mockImplementation(listener.close);
      return { ...listener, close };
    });
    let udpPort: number | undefined;
    const run = async (_file: string, args: readonly string[]) => {
      if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
      if (udpPort === undefined) {
        const port = probeScriptInputs(args).udp?.[1];
        if (port !== undefined) udpPort = Number(port);
      }
      if (launcherFails) throw new Error("Launcher failed");
      return { code: 0, stdout: "", stderr: "" };
    };
    try {
      await expect(probeMxcPowerShellStart(makeDeps(run), open)).resolves.toMatchObject({ state });
      const listener = await open.mock.results[0]?.value;
      if (!listener) throw new Error("Missing proxy listener");
      await expectTcpPortReleased(listener.port);
      expect(close).toHaveBeenCalledTimes(closeCount);
      await expectUdpPortReleased(udpPort);
    } finally {
      // Release the fixture even when a regression leaves the port bound.
      const listener = await open.mock.results[0]?.value;
      await listener?.close();
    }
  });

  it.each(["TCP", "UDP"] as const)("keeps owning the %s listener after both startup close attempts fail", async (protocol) => {
    const close = vi.fn<() => Promise<void>>();
    const releases: (() => Promise<void>)[] = [];
    const failTwice = (release: () => Promise<void>) => {
      releases.push(release);
      return close.mockRejectedValueOnce(new Error("Close failed"))
        .mockRejectedValueOnce(new Error("Close still failed"))
        .mockImplementation(release);
    };
    if (protocol === "UDP") wrapUdpClose.mockImplementationOnce(failTwice);
    let tcpPort = 0;
    let udpPort: number | undefined;
    try {
      const result = await probeMxcPowerShellStart(makeDeps(async (_file, args) => {
        if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
        const { id, controlHost, proxyUrl, udp } = probeScriptInputs(args);
        udpPort = Number(udp?.[1]);
        expect(await requestProxyRefusal(proxyUrl, controlHost)).toBe(403);
        return { code: 0, stdout: evidenceFrame(id), stderr: "" };
      }), async (options) => {
        const listener = await openInvocationProxyListener(options);
        tcpPort = listener.port;
        return protocol === "TCP" ? { ...listener, close: failTwice(listener.close) } : listener;
      });
      expect(result).toMatchObject({ state: "available", rawIpProbe: { rawIp: "unknown", reason: "cleanup-failed" } });
      expect(close).toHaveBeenCalledTimes(2);
      await vi.waitFor(async () => {
        expect(close).toHaveBeenCalledTimes(3);
        await expectTcpPortReleased(tcpPort);
        await expectUdpPortReleased(udpPort);
      }, { timeout: 3_000 });
    } finally {
      await Promise.all(releases.map(release => release()));
      wrapUdpClose.mockReset();
    }
  });

  it("keeps MXC available when PowerShell exits successfully with no evidence", async () => {
    const run = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(probeMxcPowerShellStart(makeDeps(run), openInvocationProxyListener)).resolves.toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
    });
  });
});
