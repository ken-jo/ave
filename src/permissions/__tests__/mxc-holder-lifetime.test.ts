import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";

beforeEach(() => vi.resetModules());

describe("container holder lifetime ownership", () => {
  it("retains a failed startup cleanup for the shutdown drain to retry", async () => {
    const { registerMxcHolderLifetime, drainMxcHolderLifetimes } = await import("../mxc-holder-lifetime.js");
    const cleanup = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("Native termination unverified")).mockResolvedValue(undefined);
    const holder = registerMxcHolderLifetime("worker-incarnation", cleanup);
    await expect(holder.release()).rejects.toThrow("Native termination unverified");
    await drainMxcHolderLifetimes();
    expect(cleanup).toHaveBeenCalledTimes(2);
    await holder.release(); await drainMxcHolderLifetimes();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("keeps failures after a drain and reports every affected holder", async () => {
    const { registerMxcHolderLifetime, drainMxcHolderLifetimes } = await import("../mxc-holder-lifetime.js");
    const a = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("A unverified"));
    const b = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("B unverified"));
    const successful = vi.fn(async () => {});
    registerMxcHolderLifetime("holder-a", a); registerMxcHolderLifetime("holder-b", b); registerMxcHolderLifetime("holder-c", successful);
    const failed = await drainMxcHolderLifetimes().catch((error: AggregateError) => error);
    expect(failed).toBeInstanceOf(AggregateError);
    expect((failed as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "Container holder cleanup is unverified: holder-a", "Container holder cleanup is unverified: holder-b",
    ]);
    a.mockResolvedValue(undefined); b.mockResolvedValue(undefined);
    await drainMxcHolderLifetimes();
    expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(2); expect(successful).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent release attempts and closes admission before shutdown drain", async () => {
    const { registerMxcHolderLifetime, sealMxcHolderLifetimeAdmission, drainMxcHolderLifetimes } = await import("../mxc-holder-lifetime.js");
    const stopping = deferred<void>();
    const cleanup = vi.fn(() => stopping.promise);
    const holder = registerMxcHolderLifetime("in-flight", cleanup);
    const first = holder.release();
    expect(holder.release()).toBe(first);
    sealMxcHolderLifetimeAdmission("shutdown");
    expect(() => registerMxcHolderLifetime("late", async () => {})).toThrow("admission is closed");
    const drain = drainMxcHolderLifetimes();
    expect(drainMxcHolderLifetimes()).toBe(drain);
    stopping.resolve();
    await drain;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
