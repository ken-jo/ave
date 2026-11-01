import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEgressInvocation } from "../egress-invocations.js";
import { openMxcEgressLease } from "../egress-host-listener.js";
import { egressIdentityStrength } from "../egress-identity.js";

const runtime = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js", () => ({ openHostInvocationProxy: runtime.open }));
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
  runtime.open.mockResolvedValue(relay);
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
    await lease.close();
    expect(relay.close).toHaveBeenCalledTimes(1);
    await expect(request(lease.port)).rejects.toThrow();
  });
  it("refuses preparation when admission ends during the runtime await", async () => {
    const { invocation, relay } = await fixture();
    runtime.open.mockImplementationOnce(async () => { invocation.release(); return relay; });
    await expect(openMxcEgressLease(invocation.token)).rejects.toThrow("ended during preparation");
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
