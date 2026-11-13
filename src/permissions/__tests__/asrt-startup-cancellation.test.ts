import { afterEach, describe, expect, it, vi } from "vitest";
import { useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, releaseAsrtSandboxForExit } from "../asrt-sandbox.js";

const manager = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  reset: vi.fn(async () => {}),
  setParentProxyRouter: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: manager }));
installVerifiedAveHomePrivacy();
const ORIGINAL_PLATFORM = process.platform;

afterEach(async () => {
  await releaseAsrtSandboxForExit();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("sandbox startup ownership during cancellation", () => {
  it("refuses a cancelled startup before creating runtime resources", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(initializeAsrtSandbox({}, undefined, false, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("releases partial resources and cannot reactivate when initialization finishes after shutdown", async () => {
    setProcessPlatform("linux");
    const pending = deferred<void>();
    const resources = new Set<string>();
    const controller = new AbortController();
    manager.initialize.mockImplementationOnce(async () => {
      resources.add("proxy");
      await pending.promise;
      resources.add("late-bridge");
    });
    manager.reset.mockImplementation(async () => { resources.clear(); });
    const startup = initializeAsrtSandbox({}, undefined, false, controller.signal);
    const stopped = startup.catch(error => error);
    try {
      await vi.waitFor(() => expect(resources).toEqual(new Set(["proxy"])));
      expect(isAsrtSandboxActive()).toBe(false);
      controller.abort();
      let settled = false;
      void stopped.then(() => { settled = true; });
      await releaseAsrtSandboxForExit();
      expect(settled).toBe(false);
      expect(manager.reset).toHaveBeenCalledOnce();
      expect(resources.size).toBe(0);
      await expect(initializeAsrtSandbox({})).rejects.toThrow(/already active or initializing/);
      pending.resolve();
      expect(await stopped).toBe(controller.signal.reason);
      await vi.waitFor(() => expect(manager.reset).toHaveBeenCalledTimes(2));
      expect(resources.size).toBe(0);
      expect(isAsrtSandboxActive()).toBe(false);
    } finally {
      pending.resolve();
      await stopped;
    }
  });

  it("releases an initializing owner's resources even when its startup promise never settles", async () => {
    setProcessPlatform("linux");
    const resources = new Set<string>();
    const controller = new AbortController();
    manager.initialize.mockImplementationOnce(() => {
      resources.add("proxy");
      return new Promise<void>(() => {});
    });
    manager.reset.mockImplementation(async () => { resources.clear(); });
    let settled = false;
    void initializeAsrtSandbox({}, undefined, false, controller.signal).finally(() => { settled = true; });
    await vi.waitFor(() => expect(resources.size).toBe(1));
    controller.abort();
    await releaseAsrtSandboxForExit();
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(resources.size).toBe(0);
    expect(isAsrtSandboxActive()).toBe(false);
    expect(settled).toBe(false);
  });
});
