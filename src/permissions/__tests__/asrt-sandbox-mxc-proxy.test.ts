import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxManager, type ParentProxyRouter } from "@anthropic-ai/sandbox-runtime";
import {
  closeAllEgressConnections,
  closeEgressConnections,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  getWindowsProxyPortRange,
  initializeAsrtSandbox,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";
import { openInvocationProxyListener, type InvocationProxyListener } from "../egress-invocation-listener.js";
import { openHostEgressListener } from "../egress-host-listener.js";
import { EgressGrantStore } from "../egress-grants.js";

const TOKEN = "proxy-only-invocation-token-00001";
const DESTINATION = { host: "8.8.8.8", port: 443, network: "public" as const };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await resetAsrtSandbox();
});

/** A local route endpoint; destination traffic never leaves this process. */
async function startTunnelUpstream(): Promise<{ port: number; received: string[] }> {
  const sockets = new Set<net.Socket>();
  const received: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const onHead = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onHead);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", (data: Buffer) => {
        received.push(data.toString());
        socket.write(data);
      });
    };
    socket.on("data", onHead);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as net.AddressInfo).port, received };
}

async function startListener(upstreamRouter: ParentProxyRouter): Promise<InvocationProxyListener> {
  await initializeAsrtSandbox({
    allowedDomains: [],
    windows: { externalConfinement: true, proxyPortRange: [42000, 42009] },
    upstreamRouter,
  }, async () => true);
  const relay = await openHostEgressListener(TOKEN);
  cleanups.push(relay.close);
  const listener = await openInvocationProxyListener({ upstream: () => ({ host: "127.0.0.1", ...relay }) });
  relay.registerPort(listener.port);
  cleanups.push(listener.close);
  return listener;
}

async function openTunnel(listener: InvocationProxyListener): Promise<{ socket: net.Socket; output: () => string }> {
  let output = "";
  const socket = net.connect(listener.port, "127.0.0.1", () => {
    socket.write(`CONNECT ${DESTINATION.host}:${DESTINATION.port} HTTP/1.1\r\nHost: ${DESTINATION.host}:${DESTINATION.port}\r\n\r\n`);
  });
  socket.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  socket.on("error", () => {});
  cleanups.push(async () => { socket.destroy(); });
  await expect.poll(() => output).toContain("200 Connection Established");
  socket.write("before-close");
  await expect.poll(() => output).toContain("before-close");
  return { socket, output: () => output };
}

// The proxy-only boot path supplies confinement externally on this platform.
describe.skipIf(process.platform !== "win32")("proxy-only connection revocation", () => {
  it("drops an existing forwarded tunnel after its grant is revoked", async () => {
    const upstream = await startTunnelUpstream();
    const listener = await startListener(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstream.port }] }));
    expect(getWindowsProxyPortRange()).toEqual([42000, 42009]);
    expect(listener.port < 42000 || listener.port > 42009).toBe(true);
    const subject = { token: TOKEN, sessionId: "proxy-session", tabId: undefined, workspaceRoot: undefined, origin: "shell" as const };
    const grants = new EgressGrantStore(join(process.env.AVE_HOME!, "grants.json"));
    await grants.grant("conversation", ["conversation"], subject, DESTINATION);
    grants.noteUse("conversation", subject, DESTINATION);
    const tunnel = await openTunnel(listener);
    expect(upstream.received.join("")).toBe("before-close");

    const revoked = await grants.revoke({ scope: "conversation", sessionId: subject.sessionId, ...DESTINATION });
    expect(revoked.removed).toBe(true);
    expect(revoked.tokens).toEqual([TOKEN]);
    expect(closeEgressConnections(revoked.tokens, DESTINATION.host, DESTINATION.port)).toBeGreaterThan(0);
    await expect.poll(() => tunnel.socket.destroyed).toBe(true);
    expect(tunnel.socket.write("after-close")).toBe(false);
    expect(upstream.received.join("")).toBe("before-close");
  });

  it("drops old-route tunnels on an upstream change and sends new traffic to the new route", async () => {
    const first = await startTunnelUpstream();
    const second = await startTunnelUpstream();
    let port = first.port;
    let generation = 0;
    const router: ParentProxyRouter = Object.assign(
      async () => ({ routes: [{ kind: "http" as const, host: "127.0.0.1", port }] }),
      { generation: () => generation },
    );
    const listener = await startListener(router);
    const old = await openTunnel(listener);
    port = second.port;
    generation++;
    expect(closeAllEgressConnections()).toBeGreaterThan(0);
    await expect.poll(() => old.socket.destroyed).toBe(true);
    expect(old.socket.write("after-change")).toBe(false);
    const current = await openTunnel(listener);
    expect(current.socket.destroyed).toBe(false);
    expect(first.received.join("")).toBe("before-close");
    expect(second.received.join("")).toBe("before-close");
  });

  it("clears the synchronous release manager and configured range on reset", async () => {
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true, proxyPortRange: [42000, 42009] } });
    const closeAll = vi.spyOn(SandboxManager, "closeAllInvocationConnections").mockReturnValue(7);
    const closeSome = vi.spyOn(SandboxManager, "closeInvocationConnections").mockReturnValue(3);
    expect(closeAllEgressConnections()).toBe(7);
    expect(closeEgressConnections([TOKEN], DESTINATION.host, DESTINATION.port)).toBe(3);
    await resetAsrtSandbox();
    closeAll.mockClear();
    closeSome.mockClear();
    expect(closeAllEgressConnections()).toBe(0);
    expect(closeEgressConnections([TOKEN], DESTINATION.host, DESTINATION.port)).toBe(0);
    expect(closeAll).not.toHaveBeenCalled();
    expect(closeSome).not.toHaveBeenCalled();
    expect(getWindowsProxyPortRange()).toEqual(DEFAULT_WINDOWS_PROXY_PORT_RANGE);
  });

  it("does not publish a release manager after initialization fails", async () => {
    vi.spyOn(SandboxManager, "initialize").mockRejectedValueOnce(new Error("proxy startup failed"));
    const closeAll = vi.spyOn(SandboxManager, "closeAllInvocationConnections");
    await expect(initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } })).rejects.toThrow("proxy startup failed");
    expect(closeAllEgressConnections()).toBe(0);
    expect(closeAll).not.toHaveBeenCalled();
    expect(getWindowsProxyPortRange()).toEqual(DEFAULT_WINDOWS_PROXY_PORT_RANGE);
  });
});
