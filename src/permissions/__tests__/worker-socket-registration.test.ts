import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { EventEmitter } from "node:events";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { registerLinuxWrapperProgramFixtures } from "../../__tests__/support/linux-wrapper-programs.js";
import { reserveTailnetListenerPort, TAILNET_LOOPBACK_DESTINATION } from "../../shared/tailnet-listener-port.js";
import {
  initializeAsrtSandbox,
  registerWorkerUnixSocketDir,
  resetAsrtSandbox,
  unregisterWorkerUnixSocketDir,
} from "../asrt-sandbox.js";

useVerifiedAveHomePrivacy();

// Config ownership only: the probe gets a valid wrapper and a successful child lifecycle. Runtime confinement and probe failures have separate coverage.
const manager = vi.hoisted(() => ({
  update: vi.fn(),
  openListener: vi.fn(),
  closeListener: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async () => {
  const { withSandboxManagerConfig } = await import("../../__tests__/support/linux-wrapper-programs.js");
  return { SandboxManager: withSandboxManagerConfig({
    setParentProxyRouter: () => undefined,
    updateConfig: manager.update,
    wrapWithSandboxArgv: async () => ({
      argv: ["/bin/bash", "-c", "/configured/bwrap --new-session --die-with-parent --unshare-pid --ro-bind / / -- /bin/bash -c true"],
      env: process.env,
    }),
    cleanupAfterCommand: () => undefined,
    openInvocationListener: manager.openListener,
    closeInvocationListener: manager.closeListener,
  }) };
});
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  },
}));


describe("worker socket directory ownership", () => {
  registerLinuxWrapperProgramFixtures();
  const originalPlatform = process.platform;
  const dir = "/run/plugin/sockets";
  const allowed = () => SandboxManager.getConfig()?.network.allowUnixSockets ?? [];
  beforeEach(async () => {
    setProcessPlatform("linux");
    manager.update.mockReset();
    manager.openListener.mockReset().mockResolvedValue({ socketPath: "/configured/proxy.sock" });
    manager.closeListener.mockReset();
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    expect(manager.openListener).toHaveBeenCalledOnce();
    expect(manager.openListener).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/u));
    expect(manager.closeListener).toHaveBeenCalledWith(manager.openListener.mock.calls[0]![0]);
  });
  afterEach(async () => {
    try {
      await resetAsrtSandbox();
    } finally {
      setProcessPlatform(originalPlatform);
    }
  });

  it("does not count the same holder twice", async () => {
    const holder = {};
    await Promise.all([registerWorkerUnixSocketDir(dir, holder), registerWorkerUnixSocketDir(dir, holder)]);
    await unregisterWorkerUnixSocketDir(dir, holder);
    expect(allowed()).not.toContain(dir);
  });

  it("a double release cannot take another holder's allowance", async () => {
    const first = {};
    const second = {};
    await registerWorkerUnixSocketDir(dir, first);
    await registerWorkerUnixSocketDir(dir, second);
    await unregisterWorkerUnixSocketDir(dir, first);
    await unregisterWorkerUnixSocketDir(dir, first);
    expect(allowed()).toContain(dir);
    await unregisterWorkerUnixSocketDir(dir, second);
    expect(allowed()).not.toContain(dir);
  });

  it("a release without an acquire cannot take another holder's allowance", async () => {
    const holder = {};
    await registerWorkerUnixSocketDir(dir, holder);
    await unregisterWorkerUnixSocketDir(dir, {});
    expect(allowed()).toContain(dir);
    await unregisterWorkerUnixSocketDir(dir, holder);
  });

  it("a release during the pending first push cancels that holder", async () => {
    const holder = {};
    const acquire = registerWorkerUnixSocketDir(dir, holder);
    const outcome = Promise.allSettled([acquire]);
    await unregisterWorkerUnixSocketDir(dir, holder);
    expect((await outcome)[0]?.status).toBe("rejected");
    expect(allowed()).not.toContain(dir);
  });

  it("all eight waiters reject a failed push and a fresh holder retries", async () => {
    manager.update.mockImplementationOnce(() => { throw new Error("push refused"); });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => registerWorkerUnixSocketDir(dir, {})));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(8).fill("rejected"));
    expect(allowed()).not.toContain(dir);
    const holder = {};
    await registerWorkerUnixSocketDir(dir, holder);
    expect(allowed()).toContain(dir);
    await unregisterWorkerUnixSocketDir(dir, holder);
    expect(allowed()).not.toContain(dir);
  });

  it("a second holder awaits the first config push", async () => {
    const first = registerWorkerUnixSocketDir(dir, {});
    let allowedAtResolution: string[] = [];
    const second = registerWorkerUnixSocketDir(dir, {}).then(() => { allowedAtResolution = allowed(); });
    expect(allowed()).not.toContain(dir);
    await Promise.all([first, second]);
    expect(allowedAtResolution).toContain(dir);
  });

  it("refreshes the Tailnet port deny without replacing the admitted sandbox config", async () => {
    const holder = {};
    await registerWorkerUnixSocketDir(dir, holder);
    const admitted = SandboxManager.getConfig();
    if (!admitted) throw new Error("Sandbox config is unavailable");
    const before = structuredClone(admitted);
    expect(before.network.allowUnixSockets).toContain(dir);

    const port = 43217;
    const deny = `*:${port}`;
    const release = reserveTailnetListenerPort(port);
    try {
      expect(manager.update).toHaveBeenLastCalledWith({
        ...before,
        network: {
          ...before.network,
          deniedDomains: [...before.network.deniedDomains, deny],
          deniedDomainReasons: { ...before.network.deniedDomainReasons, [deny]: TAILNET_LOOPBACK_DESTINATION },
        },
      });
    } finally {
      release();
    }
    expect(manager.update).toHaveBeenLastCalledWith(before);
    await unregisterWorkerUnixSocketDir(dir, holder);
  });

});
