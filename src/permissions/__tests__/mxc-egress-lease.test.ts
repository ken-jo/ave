import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { egressInvocationAbortSignal, openEgressInvocation } from "../egress-invocations.js";
import { openMxcEgressLease, openMxcEgressSocketLease } from "../egress-host-listener.js";
import { type InvocationProxyAdmission, UNIX_SOCKET_PATH_MAX } from "../egress-invocation-listener.js";
import { egressIdentityStrength } from "../egress-identity.js";

const runtime = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../egress-relay/relay.js", () => ({ openEgressRelay: runtime.open }));
vi.mock("../asrt-sandbox.js", () => ({ getWindowsProxyPortRange: () => [60080, 60089] }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); runtime.open.mockReset(); });

async function fixture() {
  const observed: string[] = [];
  const server = http.createServer((request, response) => {
    observed.push(String(request.headers["proxy-authorization"]));
    response.end("allowed");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as net.AddressInfo;
  const relay = { port: address.port, proxyAuthorization: "Basic aG9zdC1vd25lZA==", registerPort: vi.fn(), recordRefusal: vi.fn(), close: vi.fn(async () => {}) };
  runtime.open.mockImplementation(async (_token: string, admission: InvocationProxyAdmission) => {
    admission.adopt(relay.close);
    return relay;
  });
  const invocation = openEgressInvocation({ kind: "worker", role: "worker", pluginId: "fixture", instanceId: "a" });
  cleanups.push(invocation.release);
  return { relay, invocation, observed };
}
function request(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "http://allowed.example/", headers: { "Proxy-Authorization": "Basic Zm9yZ2Vk" } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    request.once("error", reject);
  });
}

describe("container egress lease", () => {
  it("requires a live host-issued invocation before opening any listener", async () => {
    await expect(openMxcEgressLease("foreign")).rejects.toThrow("live invocation");
    expect(runtime.open).not.toHaveBeenCalled();
  });
  it("exposes only the proxy endpoint and replaces forged labels with its owner", async () => {
    const { relay, invocation, observed } = await fixture();
    const lease = await openMxcEgressLease(invocation.token);
    cleanups.push(lease.close);
    expect(Object.keys(lease).sort()).toEqual(["close", "port", "url"]);
    expect(relay.registerPort.mock.calls).toEqual([[lease.port]]);
    expect(await request(lease.port)).toBe(200);
    expect(observed).toEqual([relay.proxyAuthorization]);
    await lease.close(); await lease.close();
    expect(relay.close).toHaveBeenCalledTimes(1);
    await expect(request(lease.port)).rejects.toThrow();
  });
  it("closes the holder endpoint on invocation release", async () => {
    const { invocation, relay } = await fixture();
    const lease = await openMxcEgressLease(invocation.token);
    cleanups.push(lease.close);
    invocation.release();
    expect(relay.close).toHaveBeenCalledTimes(1);
    await lease.close();
    await expect(request(lease.port)).rejects.toThrow();
  });
  it("keeps a held endpoint bound and refusing after release, until its owner closes it", async () => {
    const { invocation, relay } = await fixture();
    const lease = await openMxcEgressLease(invocation.token, undefined, { holdPortAfterRelease: true });
    cleanups.push(lease.close);
    expect(await request(lease.port)).toBe(200);
    invocation.release();
    // The release revokes the relay and the listener, but the port stays bound to them.
    expect(relay.close).not.toHaveBeenCalled();
    await expect(request(lease.port)).rejects.toThrow();
    const rebind = (): Promise<NodeJS.ErrnoException | undefined> => new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", (error: NodeJS.ErrnoException) => resolve(error));
      probe.listen(lease.port, "127.0.0.1", () => probe.close(() => resolve(undefined)));
    });
    expect((await rebind())?.code).toBe("EADDRINUSE");
    await lease.close();
    expect(relay.close).toHaveBeenCalledTimes(1);
    expect(await rebind()).toBeUndefined();
  });
  it("refuses preparation when admission ends during the runtime await", async () => {
    const { invocation, relay } = await fixture();
    const signal = egressInvocationAbortSignal(invocation.token);
    const open = runtime.open.getMockImplementation();
    if (!signal || !open) throw new Error("fixture missing abort signal or runtime open");
    runtime.open.mockImplementationOnce(async (...args) => {
      const opened = await open(...args);
      invocation.release();
      return opened;
    });
    const failure = await openMxcEgressLease(invocation.token).catch((error: unknown) => error);
    expect(signal.aborted).toBe(true);
    expect(failure).toBe(signal.reason);
    expect(relay.registerPort).not.toHaveBeenCalled();
    expect(relay.close).toHaveBeenCalledTimes(1);
  });
  it("retains endpoint-scoped identity for both holder kinds on the native platform", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
      for (const kind of ["shell", "extension"] as const) {
        expect(egressIdentityStrength(kind, { identity: "listener" })).toBe("kernel-channel");
        expect(egressIdentityStrength(kind, { identity: "username" })).toBe("shared");
      }
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });
});

describe("container egress lease on a socket file", () => {
  function socketRequest(socketPath: string): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const request = http.get({ socketPath, path: "http://allowed.example/", headers: { "Proxy-Authorization": "Basic Zm9yZ2Vk" } },
        (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      request.once("error", reject);
    });
  }
  function folder(): string {
    const path = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-proxy-socket-")));
    cleanups.push(() => rmSync(path, { recursive: true, force: true }));
    return path;
  }
  // A path of exactly `length` bytes inside the folder.
  function pathOf(base: string, length: number): string {
    const prefix = `${base}/`;
    return `${prefix}${"s".repeat(length - Buffer.byteLength(prefix))}`;
  }

  // 107 bytes on Linux, where holders run; 103 on macOS. The refusal by name binds nothing, so it runs everywhere.
  it(`refuses a socket path one byte over ${UNIX_SOCKET_PATH_MAX} by name before anything binds`, async () => {
    const { invocation } = await fixture();
    const base = folder();
    if (Buffer.byteLength(base) > 90) throw new Error(`temporary folder ${base} is too long for this case`);
    await expect(openMxcEgressSocketLease(invocation.token, undefined, { socketPath: pathOf(base, UNIX_SOCKET_PATH_MAX + 1) }))
      .rejects.toMatchObject({ code: "proxy-socket-path-too-long" });
    expect(existsSync(pathOf(base, UNIX_SOCKET_PATH_MAX + 1))).toBe(false);
  });

  // Socket files are the POSIX holders' proxy form: Windows cannot bind a listener at a file path here (EACCES), and
  // its containers reach the proxy on a loopback port instead.
  it.runIf(process.platform !== "win32")(`binds a socket path of ${UNIX_SOCKET_PATH_MAX} bytes owner-only`, async () => {
    const { invocation, relay, observed } = await fixture();
    const base = folder();
    if (Buffer.byteLength(base) > 90) throw new Error(`temporary folder ${base} is too long for this case`);
    const lease = await openMxcEgressSocketLease(invocation.token, undefined, { socketPath: pathOf(base, UNIX_SOCKET_PATH_MAX) });
    cleanups.push(lease.close);
    expect(Object.keys(lease).sort()).toEqual(["close", "socketPath"]);
    expect(statSync(lease.socketPath).mode & 0o777).toBe(0o600);
    // A socket file is never a TCP destination: nothing is registered with the relay.
    expect(relay.registerPort).not.toHaveBeenCalled();
    expect(await socketRequest(lease.socketPath)).toBe(200);
    expect(observed).toEqual([relay.proxyAuthorization]);
  });

  it.runIf(process.platform !== "win32")("refuses once the invocation ended, and removes the socket file", async () => {
    const { invocation } = await fixture();
    const lease = await openMxcEgressSocketLease(invocation.token, undefined, { socketPath: join(folder(), "proxy.sock") });
    expect(await socketRequest(lease.socketPath)).toBe(200);
    invocation.release();
    await vi.waitFor(() => expect(existsSync(lease.socketPath)).toBe(false));
    await expect(socketRequest(lease.socketPath)).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("stays bound and refusing after an unverified release, and is removed once the owner closes it", async () => {
    const { invocation } = await fixture();
    const lease = await openMxcEgressSocketLease(invocation.token, undefined, { socketPath: join(folder(), "proxy.sock"), holdPortAfterRelease: true });
    expect(await socketRequest(lease.socketPath)).toBe(200);
    invocation.release();
    expect(egressInvocationAbortSignal(invocation.token)).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(lease.socketPath)).toBe(true);
    // Bound, and every connection is dropped: nothing reaches the relay.
    await expect(socketRequest(lease.socketPath)).rejects.toThrow();
    await lease.close();
    expect(existsSync(lease.socketPath)).toBe(false);
  });
});
