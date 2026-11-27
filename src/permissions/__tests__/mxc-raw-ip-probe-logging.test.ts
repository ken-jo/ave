import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { closeFileLogSink, initFileLogSink } from "../../lib/logger.js";
import { pinnedWxcExecSha256, probeMxcPowerShellStart, type MxcContainerRequest } from "../mxc-windows.js";

vi.mock("../../boot/dev-flags.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../boot/dev-flags.js")>(),
  isPackagedElectronProcess: () => true,
}));

it("writes only the measurement key and reachability warning to the file sink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxc-probe-log-"));
  try {
    const sink = initFileLogSink({ dir });
    if (!sink) throw new Error("Missing file log sink");

    let network: MxcContainerRequest["network"] | undefined;
    const windowsBuild = "10.0.26300";
    const result = await probeMxcPowerShellStart({
      platform: "win32", arch: "x64", resourcePath: "C:\\example\\resources", windowsBuild,
      probeDirectory: "C:\\example\\scratch", systemRoot: "C:\\Windows",
      exists: () => true, sha256: async () => "",
      run: async (_file, args) => {
        if (args[0] !== "--config-base64") return { code: 0, stdout: "192.0.2.2:49152", stderr: "" };
        const request: MxcContainerRequest = JSON.parse(Buffer.from(args[1] ?? "", "base64").toString("utf8"));
        network = request.network;
        const script = Buffer.from(request.process.commandLine.split(" ").at(-1) ?? "", "base64").toString("utf16le");
        const prefix = /'(AVE_MXC_RAW_IP [a-f0-9]{32} )'/.exec(script)?.[1];
        if (!prefix) throw new Error("Missing evidence prefix");
        return { code: 0, stdout: prefix + '{"control":false,"t4":"connected","t6":10013,"tl":10013}\r\n', stderr: "" };
      },
    }, async () => ({ port: 49153, url: "http://127.0.0.1:49153", close: async () => {} }));
    expect(result).toMatchObject({ state: "available", rawIpProbe: { rawIp: "unknown", reachableTargets: ["t4"] } });

    await vi.waitFor(async () => {
      const records = (await readFile(sink.currentFile, "utf8")).trim().split("\n").map((line) => {
        const { level, time, pid, hostname, module, ...fields } = JSON.parse(line);
        return fields;
      });
      expect(records).toEqual([
        { msg: "MXC raw IP startup measurement", launcherSha256: pinnedWxcExecSha256("x64"), schema: "1.0.0", network, windowsBuild },
        { msg: "raw-ip-reachable" },
      ]);
    });
  } finally {
    closeFileLogSink();
    await cleanupTmpDir(dir);
  }
});
