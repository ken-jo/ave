import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(() => ({
  relay: undefined as undefined | ((value: unknown) => void),
  proxyOpened: 0,
  registered: [] as number[],
}));
vi.mock("../../permissions/egress-host-listener.js", () => ({
  openHostEgressListener: vi.fn(() => new Promise((resolve) => {
    listeners.relay = resolve;
  })),
}));
vi.mock("../../permissions/egress-invocation-listener.js", () => ({
  openInvocationProxyListener: vi.fn(async () => {
    listeners.proxyOpened += 1;
    return { port: 4321, url: "http://127.0.0.1:4321", close: async () => {} };
  }),
}));

import { openEgressInvocation, releaseEgressInvocation } from "../../permissions/egress-invocations.js";
import { createContainedShellLifecycle } from "../contained-shell-lifecycle.js";
import { openShellEgressAdmission } from "../shell-egress-admission.js";

function relayHandle() {
  return { port: 5555, proxyAuthorization: "token", recordRefusal: () => {}, registerPort: (port: number) => listeners.registered.push(port) };
}

function shellInvocation() {
  return openEgressInvocation({
    kind: "shell", toolName: "bash", toolUseId: undefined, requiresListener: true,
    context: { approvalSurface: "unavailable", sessionId: undefined, workspaceRoot: process.cwd() },
  });
}

function resolveRelay(): void {
  const resolve = listeners.relay;
  if (resolve === undefined) throw new Error("relay listener was not requested");
  resolve(relayHandle());
}

async function relayRequested(): Promise<void> {
  await vi.waitFor(() => expect(listeners.relay).toBeTypeOf("function"));
}

describe("shared container shell egress admission", () => {
  it("opens the relay and the proxy, registers the proxy port and forwards only once activated", async () => {
    listeners.relay = undefined; listeners.registered = [];
    const invocation = shellInvocation();
    const lifecycle = createContainedShellLifecycle();
    const egress = openShellEgressAdmission({ token: invocation.token, lifecycle, isRouteCurrent: () => true });
    const opening = egress.openProxy();
    await relayRequested();
    resolveRelay();
    await expect(opening).resolves.toEqual({ port: 4321, url: "http://127.0.0.1:4321" });
    expect(listeners.registered).toEqual([4321]);
    expect(egress.active).toBe(false);
    egress.activate();
    expect(egress.active).toBe(true);
    invocation.release();
    await lifecycle.dispose();
  });

  it("refuses when the invocation is released while the relay listener is still opening", async () => {
    listeners.relay = undefined; listeners.proxyOpened = 0;
    const invocation = shellInvocation();
    const lifecycle = createContainedShellLifecycle();
    const egress = openShellEgressAdmission({ token: invocation.token, lifecycle, isRouteCurrent: () => true });
    const opening = egress.openProxy();
    await relayRequested();
    releaseEgressInvocation(invocation.token);
    expect(lifecycle.signal.aborted).toBe(true);
    resolveRelay();
    await expect(opening).rejects.toThrow();
    expect(listeners.proxyOpened).toBe(0);
    await lifecycle.dispose();
  });

  it("refuses when the container route changes while the relay listener is still opening", async () => {
    listeners.relay = undefined; listeners.proxyOpened = 0;
    const invocation = shellInvocation();
    const lifecycle = createContainedShellLifecycle();
    let current = true;
    const egress = openShellEgressAdmission({ token: invocation.token, lifecycle, isRouteCurrent: () => current });
    const opening = egress.openProxy();
    await relayRequested();
    current = false;
    resolveRelay();
    await expect(opening).rejects.toThrow("Container shell route is unavailable");
    expect(listeners.proxyOpened).toBe(0);
    invocation.release();
    await lifecycle.dispose();
  });

  it("releases the invocation on revoke only when asked to, and refuses a non-shell owner", async () => {
    const invocation = shellInvocation();
    const lifecycle = createContainedShellLifecycle();
    openShellEgressAdmission({ token: invocation.token, lifecycle, isRouteCurrent: () => true, releaseOnRevoke: true });
    lifecycle.revoke();
    expect(() => openShellEgressAdmission({ token: invocation.token, lifecycle: createContainedShellLifecycle(), isRouteCurrent: () => true }))
      .toThrow("Container egress requires a live shell invocation");
    await lifecycle.dispose();
  });

  it("is the only egress admission both container shell launches use", () => {
    for (const file of ["src/tools/mxc-shell-launch.ts", "src/tools/mxc-posix-shell-launch.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain('import { openShellEgressAdmission } from "./shell-egress-admission.js";');
      expect(source, file).not.toMatch(/openHostEgressListener|openInvocationProxyListener|onEgressInvocationReleased|egressInvocationAbortSignal/u);
    }
  });
});
