import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openRelay: vi.fn(),
  floor: vi.fn(() => [] as string[]),
  wxcExec: vi.fn(async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`),
  registerPort: vi.fn(),
  recordRefusal: vi.fn(),
  closeRelay: vi.fn(async () => {}),
}));
vi.mock("../../permissions/egress-host-listener.js", () => ({
  openHostEgressListener: h.openRelay,
}));

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  getProtectedReadDenyFloor: h.floor,
  getWindowsProxyPortRange: () => [60080, 60089],
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("prepareMxcShellLaunch", () => {
  it("refuses a missing system root and closes preparation resources", async () => {
    const roots = ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"];
    const previous = roots.map(key => process.env[key]);
    try {
      for (const key of roots) vi.stubEnv(key, undefined);
      h.openRelay.mockResolvedValue({ port: 9, proxyAuthorization: "Basic eA==", registerPort: h.registerPort, recordRefusal: h.recordRefusal, close: h.closeRelay });
      const listen = vi.spyOn(net.Server.prototype, "listen");
      await expect(prepareMxcShellLaunch(INPUT)).rejects.toThrow(/system root/i);
      const server = listen.mock.contexts[0] as net.Server | undefined;
      expect(server).toBeDefined();
      expect(server?.listening).toBe(false);
      expect(h.closeRelay).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      // Environment keys alias each other on Windows; restore defined values after all removals.
      roots.forEach((key, index) => { if (previous[index] !== undefined) process.env[key] = previous[index]; });
    }
  });

  it("opens the invocation's own listener and points the container's only network path at it", async () => {
    h.openRelay.mockResolvedValue({ port: 9, proxyAuthorization: "Basic eA==", registerPort: h.registerPort, recordRefusal: h.recordRefusal, close: h.closeRelay });
    const launch = await prepareMxcShellLaunch(INPUT);
    try {
      expect(h.openRelay).toHaveBeenCalledWith("tok");
      expect(launch.argv[0]).toBe(String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`);
      const request = decodeRequest(launch.argv);
      expect(request["runtimeConfig"]).toEqual({ networkProxy: `http://127.0.0.1:${launch.proxyPort}` });
      expect(request["network"]["egress"]).toEqual({ default: "deny" });
      expect(request["filesystem"]["readwritePaths"]).toEqual([WS]);
      // The MXC timeout trails the host's own lifetime watch.
      expect(request["process"]["timeout"]).toBe(35_000);
      expect(await portAccepts(launch.proxyPort)).toBe(true);
      expect(h.registerPort).toHaveBeenCalledWith(launch.proxyPort);
    } finally {
      await launch.release();
    }
    expect(await portAccepts(launch.proxyPort)).toBe(false);
    expect(h.closeRelay).toHaveBeenCalledOnce();
  });

  it("refuses without the ASRT proxy, since the container would have no network path", async () => {
    h.openRelay.mockRejectedValueOnce(new Error("the sandbox proxy is not running"));
    await expect(prepareMxcShellLaunch(INPUT)).rejects.toThrow(/sandbox proxy is not running/);
  });

  it("refuses when the launcher is missing from the installation", async () => {
    h.openRelay.mockResolvedValue({ port: 9, proxyAuthorization: "Basic eA==", registerPort: h.registerPort, recordRefusal: h.recordRefusal, close: h.closeRelay });
    await expect(prepareMxcShellLaunch({ ...INPUT, exists: (p) => !p.endsWith("wxc-exec.exe") }))
      .rejects.toThrow(/launcher is missing/);
  });

  it("closes the listener it opened when the request cannot be built", async () => {
    h.openRelay.mockResolvedValue({ port: 9, proxyAuthorization: "Basic eA==", registerPort: h.registerPort, recordRefusal: h.recordRefusal, close: h.closeRelay });
    const listen = vi.spyOn(net.Server.prototype, "listen");
    await expect(prepareMxcShellLaunch({ ...INPUT, cwd: String.raw`D:\elsewhere` })).rejects.toThrow();
    const server = listen.mock.contexts[0] as net.Server | undefined;
    listen.mockRestore();
    expect(server).toBeDefined();
    expect(server?.listening).toBe(false);
    expect(h.closeRelay).toHaveBeenCalledOnce();
  });
});
