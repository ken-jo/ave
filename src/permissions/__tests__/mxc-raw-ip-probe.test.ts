import { once } from "node:events";
import { get } from "node:http";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { openInvocationProxyListener } from "../egress-invocation-listener.js";
import {
  classifyMxcRawIpProbe,
  mxcRawIpBlockingRequirement,
  parseMxcRawIpProbeEvidence,
  probeMxcPowerShellStart,
  type DetectMxcSupportDeps,
} from "../mxc-windows.js";

const REFUSED = { control: true, t4: 10013, t6: 10013, tl: 10013 };
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
    expect(classifyMxcRawIpProbe({ ...REFUSED, t4 }, true)).toMatchObject({ reason, rawIp: reason === "blocked" ? "blocked" : "unknown" });
  });

  it.each([10051, 10065, 10049, 10047])("reports IPv6 result %s as unmeasured", (t6) => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, t6 }, true)).toMatchObject({ rawIp: "unknown", reason: "ipv6-unmeasured" });
  });

  it("uses the LAN result to downgrade a verdict when a peer answered", () => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, tl: 10061 }, true)).toEqual({ rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["tl"] });
    expect(classifyMxcRawIpProbe({ ...REFUSED, tl: "deadline" }, true).rawIp).toBe("blocked");
  });

  it("only downgrades a blocked verdict when a listener binds after the LAN lookup", () => {
    const beforeBind = { ...REFUSED, t6: 10013, tl: "deadline" } as const;
    expect(classifyMxcRawIpProbe(beforeBind, true)).toEqual({ rawIp: "blocked", reason: "blocked", reachableTargets: [] });
    const afterBind = { ...beforeBind, tl: "connected" } as const;
    expect(classifyMxcRawIpProbe(afterBind, true)).toEqual({
      rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["tl"],
    });
  });

  it("retains a reachable target when the control failed", () => {
    expect(classifyMxcRawIpProbe({ ...REFUSED, t6: "connected" }, false)).toEqual({
      rawIp: "unknown", reason: "control-failed", reachableTargets: ["t6"],
    });
    expect(classifyMxcRawIpProbe({ ...REFUSED, control: false }, true).reason).toBe("control-failed");
  });
});

describe("additional raw IP blocking requirements", () => {
  it.each([undefined, 10013, "other"] as const)("requires an IPv6 refusal with UDP result %s", (u4) => {
    expect(mxcRawIpBlockingRequirement({ t6: 10013, u4 })).toBeUndefined();
    expect(mxcRawIpBlockingRequirement({ t6: 10051, u4 })).toBe("ipv6-unmeasured");
    expect(mxcRawIpBlockingRequirement({ t6: 10060, u4 })).toBe("timeout");
    expect(mxcRawIpBlockingRequirement({ t6: "other", u4 })).toBe("unclassified");
  });
});

describe("raw IP evidence frame", () => {
  it("reads a single complete frame for the probe", () => {
    expect(parseMxcRawIpProbeEvidence(EVIDENCE_LINE, PROBE_ID)).toEqual(REFUSED);
  });

  it.each([
    "", "AVE_MXC_RAW_IP {", EVIDENCE_LINE.trimEnd(),
    evidenceFrame("b".repeat(32)), evidenceFrame("").replace("  ", " "),
    EVIDENCE_LINE.replace('"t4":10013', '"t4":"10013"'),
    EVIDENCE_LINE.replace('"t4":10013', '"t4":10013,"t4":10013'),
    EVIDENCE_LINE.repeat(2), `launcher\r\n${EVIDENCE_LINE}`, `${EVIDENCE_LINE}other\r\n`,
  ])("treats invalid or absent evidence as unknown (%j)", (stdout) => {
    expect(classifyMxcRawIpProbe(parseMxcRawIpProbeEvidence(stdout, PROBE_ID), true).reason).toBe("no-evidence");
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
  const script = Buffer.from(request.process.commandLine.split(" ").at(-1), "base64").toString("utf16le");
  const id = /'AVE_MXC_RAW_IP ([a-f0-9]{32}) '/.exec(script)?.[1];
  const controlHost = /Invoke-Tcp '127\.0\.0\.1' \d+ '(127\.[\d.]+)'/.exec(script)?.[1];
  if (controlHost === undefined) throw new Error("Missing proxy control destination");
  return { id: id ?? "", controlHost, proxyUrl: new URL(request.runtimeConfig.networkProxy) };
}

function requestProxyRefusal(proxy: URL, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    get(proxy, { path: `http://${host}/` }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
}

describe("raw IP startup observation", () => {
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
  ])("releases the listening port after $scenario", async ({ launcherFails, closeFails, state, closeCount }) => {
    const open = vi.fn<typeof openInvocationProxyListener>();
    const close = vi.fn<() => Promise<void>>();
    open.mockImplementation(async (options) => {
      const listener = await openInvocationProxyListener(options);
      if (closeFails) close.mockRejectedValueOnce(new Error("Transient close failure"));
      close.mockImplementation(listener.close);
      return { ...listener, close };
    });
    const run = async (_file: string, args: readonly string[]) => {
      if (launcherFails && args[0] === "--config-base64") throw new Error("Launcher failed");
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
