import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readMxcRawIpProbeScript } from "../../__tests__/support/mxc-raw-ip-probe.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { closeFileLogSink, initFileLogSink } from "../../lib/logger.js";
import { openMxcRawIpUdpListener } from "../mxc-raw-ip-udp.js";
import { pinnedWxcExecSha256, probeMxcPowerShellStart, type MxcContainerRequest } from "../mxc-windows.js";

vi.mock("../../boot/dev-flags.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../boot/dev-flags.js")>(),
  isPackagedElectronProcess: () => true,
}));
vi.mock("../mxc-raw-ip-udp.js", () => ({ openMxcRawIpUdpListener: vi.fn() }));

it.each([
  { label: "structural refusal", rawIp: "blocked", t4: 10013, udpArrival: "absent", evidenceKind: "structural", warnings: [] },
  { label: "inconclusive TCP result", rawIp: "unknown", t4: "deadline", udpArrival: "absent", evidenceKind: undefined, warnings: [] },
  { label: "TCP reachability", rawIp: "unknown", t4: "connected", udpArrival: "absent", evidenceKind: undefined, warnings: [{ msg: "raw-ip-reachable" }] },
  { label: "UDP arrival", rawIp: "unknown", t4: 10013, udpArrival: "arrived", evidenceKind: undefined, warnings: [{ msg: "raw-ip-reachable (udp)" }] },
] as const)("writes only the measurement key and any warning for $label", async ({ rawIp, t4, udpArrival, evidenceKind, warnings }) => {
  const dir = await mkdtemp(join(tmpdir(), "mxc-probe-log-"));
  try {
    const sink = initFileLogSink({ dir });
    if (!sink) throw new Error("Missing file log sink");
    vi.mocked(openMxcRawIpUdpListener).mockResolvedValue({
      address: "192.0.2.2", port: 49154, observe: async () => udpArrival, close: async () => {},
    });

    let network: MxcContainerRequest["network"] | undefined;
    let onRefused: ((destination: string, reason: string) => void) | undefined;
    const windowsBuild = "10.0.26300";
    const result = await probeMxcPowerShellStart({
      platform: "win32", arch: "x64", resourcePath: "C:\\example\\resources", windowsBuild,
      probeDirectory: "C:\\example\\scratch", systemRoot: "C:\\Windows",
      exists: () => true, sha256: async () => "",
      run: async (_file, args) => {
        if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
        const request: MxcContainerRequest = JSON.parse(Buffer.from(args[1] ?? "", "base64").toString("utf8"));
        network = request.network;
        const script = readMxcRawIpProbeScript(request.process.commandLine);
        const prefix = /'(AVE_MXC_RAW_IP [a-f0-9]{32} )'/.exec(script)?.[1];
        const controlHost = /Invoke-Tcp '127\.0\.0\.1' \d+ '(127\.[\d.]+)'/.exec(script)?.[1];
        if (!prefix || !controlHost) throw new Error("Missing probe inputs");
        onRefused?.(controlHost, "loopback destination");
        const evidence = { control: true, t4, t6: 10051, tl: 10013, capabilitySids: ["S-1-15-3-7"], udp: "sent" };
        return { code: 0, stdout: `${prefix}${JSON.stringify(evidence)}\r\n`, stderr: "" };
      },
    }, async (options) => {
      onRefused = options.onRefused;
      return { port: 49153, url: "http://127.0.0.1:49153", close: async () => {} };
    });
    expect(result).toMatchObject({ state: "available", rawIpProbe: { rawIp, udpArrival } });
    if (evidenceKind !== undefined) expect(result).toHaveProperty("rawIpProbe.evidenceKind", evidenceKind);

    await vi.waitFor(async () => {
      const records = (await readFile(sink.currentFile, "utf8")).trim().split("\n").map((line) => {
        const { level, time, pid, hostname, module, ...fields } = JSON.parse(line);
        return fields;
      });
      expect(records).toEqual([
        { msg: "MXC raw IP startup measurement", launcherSha256: pinnedWxcExecSha256("x64"), schema: "1.0.0", network, windowsBuild },
        ...warnings,
      ]);
    });
  } finally {
    closeFileLogSink();
    await cleanupTmpDir(dir);
  }
});
