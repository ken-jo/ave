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

vi.mock("../mxc-raw-ip-udp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mxc-raw-ip-udp.js")>();
  return {
    ...actual,
    openMxcRawIpUdpListener: async (address: string, probeId: string, deadline: number) => {
      const listener = await actual.openMxcRawIpUdpListener("127.0.0.1", probeId, deadline);
      return listener === undefined ? undefined : { ...listener, address };
    },
  };
});

const REFUSED: NonNullable<ReturnType<typeof parseMxcRawIpProbeEvidence>> = {
  control: true, t4: 10013, t6: 10013, tl: 10013, capabilitySids: null, udp: "refused-local",
};
const PROBE_ID = "a".repeat(32);
const EVIDENCE_LINE = evidenceFrame(PROBE_ID);

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
    expect(classifyMxcRawIpProbe({ ...REFUSED, t6 }, true, "absent")).toMatchObject({ rawIp: "unknown", reason: "ipv6-unmeasured" });
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
  it.each([10051, 10065])("accepts a successful empty capability read for no-route result %s", (t6) => {
    const evidence = { ...REFUSED, t6, capabilitySids: [] };
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

  it("treats an unparseable capability read as IPv6 unmeasured", () => {
    const evidence = { ...REFUSED, t6: 10051, capabilitySids: ["invalid-sid"] };
    const parsed = parseMxcRawIpProbeEvidence(evidenceFrame(PROBE_ID, evidence), PROBE_ID);
    expect(classifyMxcRawIpProbe(parsed, true, "absent").reason).toBe("ipv6-unmeasured");
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

  it("caps the LAN lookup and retries a failed measurement with the full plain start budget", async () => {
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
      })).resolves.toMatchObject({ state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" } });
    } finally {
      clock.mockRestore();
    }
    expect(run.mock.calls.map(([, , timeout]) => timeout)).toEqual([2_000, 8_000, 65_000]);
    const request = JSON.parse(Buffer.from(run.mock.calls[2]?.[1][1] ?? "", "base64").toString("utf8"));
    expect(request.process.timeout).toBe(60_000);
    expect(request.runtimeConfig.networkProxy).toBe("http://127.0.0.1:9");
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
      const replacement = createServer();
      try {
        const listening = once(replacement, "listening");
        replacement.listen(listener.port, "127.0.0.1");
        await listening;
      } finally {
        replacement.close();
      }
      expect(close).toHaveBeenCalledTimes(closeCount);
      await expectUdpPortReleased(udpPort);
    } finally {
      // Release the fixture even when a regression leaves the port bound.
      const listener = await open.mock.results[0]?.value;
      await listener?.close();
    }
  });

  it("keeps MXC available when PowerShell exits successfully with no evidence", async () => {
    const run = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(probeMxcPowerShellStart(makeDeps(run), openInvocationProxyListener)).resolves.toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
    });
  });
});
