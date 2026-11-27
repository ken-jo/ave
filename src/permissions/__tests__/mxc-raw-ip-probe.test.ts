import { get } from "node:http";
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
const EVIDENCE_LINE = `AVE_MXC_RAW_IP ${JSON.stringify(REFUSED)}`;

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

describe("raw IP evidence marker", () => {
  it("reads one complete evidence line among launcher output", () => {
    expect(parseMxcRawIpProbeEvidence(`launcher\r\n${EVIDENCE_LINE}\r\nexit 0`)).toEqual(REFUSED);
  });

  it.each(["", "AVE_MXC_RAW_IP {", "AVE_MXC_RAW_IP null", "AVE_MXC_RAW_IP {\"control\":true}",
    EVIDENCE_LINE.replace('"t4":10013', '"t4":"10013"'), `${EVIDENCE_LINE}\n${EVIDENCE_LINE}`,
  ])("treats invalid or absent evidence as unknown (%j)", (stdout) => {
    expect(classifyMxcRawIpProbe(parseMxcRawIpProbeEvidence(stdout), true).reason).toBe("no-evidence");
  });
});

function makeDeps(run: DetectMxcSupportDeps["run"]): DetectMxcSupportDeps {
  return {
    platform: "win32", arch: "x64", resourcePath: "C:\\example\\resources", windowsBuild: null,
    probeDirectory: "C:\\example\\scratch", systemRoot: "C:\\Windows", exists: () => true, sha256: async () => "", run,
  };
}

describe("raw IP startup observation", () => {
  it("requires the exact nonce recorded by the invocation listener", async () => {
    const runProbe = async (matchesNonce: boolean) => await probeMxcPowerShellStart(makeDeps(async (_file, args) => {
      if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
      const request = JSON.parse(Buffer.from(args[1] ?? "", "base64").toString("utf8"));
      const script = Buffer.from(request.process.commandLine.split(" ").at(-1), "base64").toString("utf16le");
      const nonce = /Invoke-Tcp '127\.0\.0\.1' \d+ '(127\.[\d.]+)'/.exec(script)?.[1];
      if (nonce === undefined) throw new Error("Missing proxy control destination");
      const response = await new Promise<number | undefined>((resolve, reject) => {
        const proxy = new URL(request.runtimeConfig.networkProxy);
        const host = matchesNonce ? nonce : nonce === "127.0.0.1" ? "127.0.0.2" : "127.0.0.1";
        get(proxy, { path: `http://${host}/` }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
      });
      expect(response).toBe(403);
      return { code: 0, stdout: EVIDENCE_LINE, stderr: "" };
    }), openInvocationProxyListener);
    await expect(runProbe(true)).resolves.toMatchObject({ state: "available", rawIpProbe: { rawIp: "blocked" } });
    await expect(runProbe(false)).resolves.toMatchObject({ state: "available", rawIpProbe: { reason: "control-failed" } });
  });

  it("checks availability with the original proxy placeholder when the listener cannot open", async () => {
    const run = vi.fn<DetectMxcSupportDeps["run"]>().mockResolvedValue({ code: 0, stdout: EVIDENCE_LINE, stderr: "" });
    await expect(probeMxcPowerShellStart(makeDeps(run), async () => { throw new Error("bind failed"); }))
      .resolves.toMatchObject({ state: "available", rawIpProbe: { rawIp: "unknown", reason: "listener-unavailable" } });
    expect(run).toHaveBeenCalledOnce();
    const request = JSON.parse(Buffer.from(run.mock.calls[0]?.[1][1] ?? "", "base64").toString("utf8"));
    expect(request.runtimeConfig.networkProxy).toBe("http://127.0.0.1:9");
  });

  it("keeps MXC available when PowerShell exits successfully with no evidence", async () => {
    const run = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(probeMxcPowerShellStart(makeDeps(run), openInvocationProxyListener)).resolves.toMatchObject({
      state: "available", rawIpProbe: { rawIp: "unknown", reason: "no-evidence" },
    });
  });
});
