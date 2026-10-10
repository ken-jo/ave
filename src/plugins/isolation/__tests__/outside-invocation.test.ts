import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

afterEach(() => vi.resetModules());

describe("the outside-invocation context is captured before tool dispatch", () => {
  it.each(["effect", "origin"] as const)("refuses lazy evaluation under an active %s context", async (kind) => {
    vi.resetModules();
    const load = () => import("../host-api-dispatcher.js");
    if (kind === "effect") {
      const { runWithEffectGateContext } = await import("../../../permissions/effect-enforcement.js");
      await expect(runWithEffectGateContext({ headless: true, toolName: "lazy_load" }, load))
        .rejects.toThrow(/evaluated inside a tool invocation/);
    } else {
      // A trusted app-only tool has an origin frame but bypasses the executor's gate frame.
      const { runWithInvocationOrigin } = await import("../../runtime/origin-chain.js");
      await expect(runWithInvocationOrigin("ui", undefined, load))
        .rejects.toThrow(/evaluated inside a tool invocation/);
    }
  });

  it("clears a later caller's store after evaluation outside an invocation", async () => {
    vi.resetModules();
    const { runOutsideInvocation } = await import("../host-api-dispatcher.js");
    const marker = new AsyncLocalStorage<string>();
    expect(marker.run("caller", () => runOutsideInvocation(() => marker.getStore()))).toBeUndefined();
    expect(marker.getStore()).toBeUndefined();
  });
});
