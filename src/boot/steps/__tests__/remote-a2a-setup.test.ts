import { describe, expect, it, vi } from "vitest";
import type { A2ARemoteRuntime } from "../../../main/a2a-remote-runtime.js";
import type { RemoteA2AActionController } from "../../../main/remote-a2a-action-controller.js";
import { remoteA2AStartFailureReason, setupRemoteA2A } from "../remote-a2a-setup.js";

function runtimeDouble(overrides: Partial<{ outboundRouting: boolean; ready: () => Promise<void> }> = {}) {
  const dispose = vi.fn();
  const runtime = {
    gates: { outboundRouting: overrides.outboundRouting ?? true, receiverProfile: false },
    ready: overrides.ready ?? (async () => undefined),
    dispose,
  } as unknown as A2ARemoteRuntime;
  return { runtime, dispose };
}

const controller = {} as RemoteA2AActionController;

function harness() {
  return { audit: vi.fn(), logError: vi.fn() };
}

describe("setupRemoteA2A", () => {
  it("returns nothing and audits nothing when both gates are down", async () => {
    const h = harness();
    const createController = vi.fn();

    await expect(setupRemoteA2A({ createRuntime: () => null, createController, ...h })).resolves.toEqual({});
    expect(createController).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("builds the controller only for the outbound gate", async () => {
    const outbound = runtimeDouble();
    await expect(setupRemoteA2A({
      createRuntime: () => outbound.runtime,
      createController: () => controller,
      ...harness(),
    })).resolves.toEqual({ runtime: outbound.runtime, controller });

    const receiverOnly = runtimeDouble({ outboundRouting: false });
    const createController = vi.fn();
    await expect(setupRemoteA2A({
      createRuntime: () => receiverOnly.runtime,
      createController,
      ...harness(),
    })).resolves.toEqual({ runtime: receiverOnly.runtime });
    expect(createController).not.toHaveBeenCalled();
  });

  it("keeps booting when a switched-on gate has no provisioned config, naming the reason", async () => {
    const h = harness();

    const result = await setupRemoteA2A({
      createRuntime: () => { throw new Error("a2a-remote-outbound-config-incomplete"); },
      createController: () => controller,
      ...h,
    });

    expect(result).toEqual({});
    expect(h.audit).toHaveBeenCalledWith("start-failed:a2a-remote-outbound-config-incomplete");
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]?.[1]).toContain("a2a-remote-outbound-config-incomplete");
  });

  it("disposes a runtime whose store failed to open, and drops it", async () => {
    const h = harness();
    const failing = runtimeDouble({ ready: async () => { throw new Error("a2a-remote-store-unreadable"); } });

    await expect(setupRemoteA2A({
      createRuntime: () => failing.runtime,
      createController: () => controller,
      ...h,
    })).resolves.toEqual({});
    expect(failing.dispose).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith("start-failed:a2a-remote-store-unreadable");
  });

  it("disposes the runtime when the controller rejects the target registry", async () => {
    const h = harness();
    const built = runtimeDouble();

    await expect(setupRemoteA2A({
      createRuntime: () => built.runtime,
      createController: () => { throw new Error("a2a-remote-target-registry-invalid"); },
      ...h,
    })).resolves.toEqual({});
    expect(built.dispose).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith("start-failed:a2a-remote-target-registry-invalid");
  });
});

describe("remoteA2AStartFailureReason", () => {
  it("keeps only the runtime's own reason codes and never echoes other text", () => {
    expect(remoteA2AStartFailureReason(new Error("a2a-remote-receiver-secret-missing")))
      .toBe("a2a-remote-receiver-secret-missing");
    expect(remoteA2AStartFailureReason(new Error("ENOENT: /Users/someone/.ave/secret")))
      .toBe("a2a-remote-start-failed");
    expect(remoteA2AStartFailureReason("a2a-remote-config-incomplete")).toBe("a2a-remote-start-failed");
  });
});
