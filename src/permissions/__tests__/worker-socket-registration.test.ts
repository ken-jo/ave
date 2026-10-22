import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import {
  initializeAsrtSandbox,
  registerWorkerUnixSocketDir,
  resetAsrtSandbox,
  unregisterWorkerUnixSocketDir,
} from "../asrt-sandbox.js";

useVerifiedAveHomePrivacy();

// Config ownership only: the probe gets a valid wrapper and a successful child
// lifecycle. Runtime confinement and probe failures have separate coverage.
const manager = vi.hoisted(() => ({
  config: undefined as { network: { allowUnixSockets?: string[] } } | undefined,
  update: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  setParentProxyRouter: () => undefined,
  initialize: async (config: typeof manager.config) => { manager.config = config; },
  updateConfig: (config: typeof manager.config) => { manager.update(config); manager.config = config; },
  reset: async () => { manager.config = undefined; },
  wrapWithSandboxArgv: async () => ({
    argv: ["/bin/bash", "-c", "/configured/bwrap --ro-bind / / -- /bin/bash -c true"],
    env: process.env,
  }),
  cleanupAfterCommand: () => undefined,
} }));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  },
}));

describe("worker socket directory ownership", () => {
  const originalPlatform = process.platform;
  const dir = "/run/plugin/sockets";
  const allowed = () => manager.config?.network.allowUnixSockets ?? [];
  beforeEach(async () => {
    setProcessPlatform("linux");
    manager.update.mockReset();
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
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

});
