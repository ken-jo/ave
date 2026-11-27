import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readMxcRawIpProbeScript } from "../../__tests__/support/mxc-raw-ip-probe.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { closeFileLogSink, initFileLogSink } from "../../lib/logger.js";
import { pinnedWxcExecSha256, probeMxcPowerShellStart, type MxcContainerRequest } from "../mxc-windows.js";

vi.mock("../../boot/dev-flags.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../boot/dev-flags.js")>(),
  isPackagedElectronProcess: () => true,
}));

it.each([
  { rawIp: "blocked", t4: 10013, evidenceKind: "structural", warnings: [] },
  { rawIp: "unknown", t4: "connected", evidenceKind: undefined, warnings: [{ msg: "raw-ip-reachable" }] },
] as const)("writes only the measurement key and any warning for $rawIp coverage", async ({ rawIp, t4, evidenceKind, warnings }) => {
  const dir = await mkdtemp(join(tmpdir(), "mxc-probe-log-"));
  try {
    const sink = initFileLogSink({ dir });
    if (!sink) throw new Error("Missing file log sink");

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
        const evidence = { control: true, t4, t6: 10051, tl: 10013, capabilitySids: ["S-1-15-3-7"] };
        return { code: 0, stdout: `${prefix}${JSON.stringify(evidence)}\r\n`, stderr: "" };
      },
    }, async (options) => {
      onRefused = options.onRefused;
      return { port: 49153, url: "http://127.0.0.1:49153", close: async () => {} };
    });
    expect(result).toMatchObject({ state: "available", rawIpProbe: { rawIp } });

    await vi.waitFor(async () => {
      const records = (await readFile(sink.currentFile, "utf8")).trim().split("\n").map((line) => {
        const { level, time, pid, hostname, module, ...fields } = JSON.parse(line);
        return fields;
      });
      expect(records).toEqual([
        { msg: "MXC raw IP startup measurement", launcherSha256: pinnedWxcExecSha256("x64"), schema: "1.0.0", network, windowsBuild,
          ...(evidenceKind === undefined ? {} : { evidenceKind }) },
        ...warnings,
      ]);
    });
  } finally {
    closeFileLogSink();
    await cleanupTmpDir(dir);
  }
});
