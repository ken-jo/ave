import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  upstream: vi.fn(),
  floor: vi.fn(() => [] as string[]),
  wxcExec: vi.fn(async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`),
}));

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  asrtInvocationProxyUpstream: h.upstream,
  getProtectedReadDenyFloor: h.floor,
}));
vi.mock("../../permissions/mxc-windows.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../permissions/mxc-windows.js")>()),
  resolveHostWxcExecPath: h.wxcExec,
}));

import { prepareMxcShellLaunch } from "../mxc-shell-launch.js";

const WS = String.raw`C:\work\repo`;
const INPUT = {
  egressToken: "tok",
  commandLine: "cmd.exe /d /c echo hi",
  cwd: WS,
  filesystem: { allowWrite: [WS], allowRead: [], denyRead: [], denyWrite: [] },
  env: { SYSTEMROOT: String.raw`C:\Windows`, LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local` },
  timeoutMs: 5_000,
  exists: () => true,
};

function decodeRequest(argv: readonly string[]): Record<string, any> {
  expect(argv[1]).toBe("--config-base64");
  return JSON.parse(Buffer.from(argv[2] ?? "", "base64").toString("utf8"));
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("prepareMxcShellLaunch", () => {
  it("opens the invocation's own listener and points the container's only network path at it", async () => {
    h.upstream.mockResolvedValue({ host: "127.0.0.1", port: 9, proxyAuthorization: "Basic eA==" });
    const launch = await prepareMxcShellLaunch(INPUT);
    try {
      expect(h.upstream).toHaveBeenCalledWith("tok");
      expect(launch.argv[0]).toBe(String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`);
      const request = decodeRequest(launch.argv);
      expect(request["runtimeConfig"]).toEqual({ networkProxy: `http://127.0.0.1:${launch.proxyPort}` });
      expect(request["network"]["egress"]).toEqual({ default: "deny" });
      expect(request["filesystem"]["readwritePaths"]).toEqual([WS]);
      // The MXC timeout trails the host's own lifetime watch.
      expect(request["process"]["timeout"]).toBe(35_000);
      expect(await portAccepts(launch.proxyPort)).toBe(true);
    } finally {
      await launch.release();
    }
    expect(await portAccepts(launch.proxyPort)).toBe(false);
  });

  it("refuses without the ASRT proxy, since the container would have no network path", async () => {
    h.upstream.mockResolvedValue(undefined);
    await expect(prepareMxcShellLaunch(INPUT)).rejects.toThrow(/sandbox proxy is not running/);
  });

  it("refuses when the launcher is missing from the installation", async () => {
    h.upstream.mockResolvedValue({ host: "127.0.0.1", port: 9, proxyAuthorization: "Basic eA==" });
    await expect(prepareMxcShellLaunch({ ...INPUT, exists: (p) => !p.endsWith("wxc-exec.exe") }))
      .rejects.toThrow(/launcher is missing/);
  });

  it("closes the listener it opened when the request cannot be built", async () => {
    h.upstream.mockResolvedValue({ host: "127.0.0.1", port: 9, proxyAuthorization: "Basic eA==" });
    const listen = vi.spyOn(net.Server.prototype, "listen");
    await expect(prepareMxcShellLaunch({ ...INPUT, cwd: String.raw`D:\elsewhere` })).rejects.toThrow();
    const server = listen.mock.contexts[0] as net.Server | undefined;
    listen.mockRestore();
    expect(server).toBeDefined();
    expect(server?.listening).toBe(false);
  });
});
