import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import type { HookDispatchResult } from "../../hooks/script-hook-manager.js";
import type { HookDispatchPayload } from "../../hooks/script-hook-types.js";
import type { RunOneHookOptions } from "../../hooks/script-hook-runner.js";
import { runScriptHook } from "../invocation-services.js";

describe("invocation hook cancellation boundary", () => {
  it("settles a signal-ignoring hook while retaining the inherited policy and cancelling the supplied runner signal", async () => {
    const caller = new AbortController();
    const held = deferred<HookDispatchResult>();
    const floor = { code: "other-principal" as const, reason: "Human approval required" };
    let runnerSignal: AbortSignal | undefined;
    const manager = { runPermissionRequest: vi.fn((_payload: HookDispatchPayload, options?: RunOneHookOptions) => {
      runnerSignal = options?.abortSignal;
      expect(turnExtensionPolicyContext.getStore()?.floor).toBe(floor);
      expect(turnExtensionPolicyContext.getStore()?.ownerUnattended).toBe(true);
      return held.promise;
    }) };
    const running = turnExtensionPolicyContext.run({ allowExternalHooks: true, ownerUnattended: true, floor, abortSignal: caller.signal }, () =>
      runScriptHook(manager as never, "perm", "network_probe", "builtin", "network", {}, "hook-session", { trustOrigin: "user-keyboard", ownerUnattended: true }));
    caller.abort(new Error("owner stopped"));
    expect(await running).toEqual({ decision: "deny", reason: "Hook execution cancelled", results: [] });
    expect(runnerSignal?.aborted).toBe(true);
    held.resolve({ decision: "allow", reason: "Late result", results: [] });
    await Promise.resolve();
    expect(manager.runPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it("preserves an ordinary hook failure when the caller has not aborted", async () => {
    const error = new Error("Invalid hook contract");
    const manager = { runPermissionRequest: vi.fn(async () => { throw error; }) };
    await expect(runScriptHook(manager as never, "perm", "network_probe", "builtin", "network", {}, "hook-session", { trustOrigin: "user-keyboard" })).rejects.toBe(error);
  });
});
