import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeHostApiVendor, createRefreshActiveLlmWildcard } from "../refresh-active-llm-wildcard.js";

function makeDeps(initial: { vendor?: string } = {}) {
  let vendor = initial.vendor ?? "openai";
  const setOverride = vi.fn();
  const clearOverride = vi.fn();
  const listPluginIds = vi.fn(() => ["plugin-a", "plugin-b"]);
  const restartPlugin = vi.fn(async (_id: string) => undefined);
  const cancelPendingRestarts = vi.fn();
  return {
    setVendor: (next: string | undefined) => { vendor = next as string; },
    deps: {
      getActiveVendor: () => vendor,
      setWildcardConfigOverride: setOverride,
      clearWildcardConfigOverride: clearOverride,
      listPluginIds,
      restartPlugin,
      cancelPendingRestarts,
    },
    setOverride,
    clearOverride,
    listPluginIds,
    restartPlugin,
    cancelPendingRestarts,
  };
}

describe("createRefreshActiveLlmWildcard (#893 / PR #894 Cycle 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first refresh seeds vendor and does not restart any plugin", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();

    expect(ctx.setOverride).toHaveBeenCalledWith({ hostApiVendor: "openai" });
    // Always remove stale secret slots from wildcard metadata.
    expect(ctx.clearOverride).toHaveBeenCalledWith(["hostApiKey", "hostApiVendor"]);
    vi.advanceTimersByTime(1_000);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
  });

  it("vendor change after the seed restarts every loaded plugin (debounced 200ms)", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();

    vi.advanceTimersByTime(199);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(ctx.restartPlugin).toHaveBeenCalledTimes(2);
    expect(ctx.restartPlugin).toHaveBeenCalledWith("plugin-a");
    expect(ctx.restartPlugin).toHaveBeenCalledWith("plugin-b");
  });

  it("coalesces a burst of vendor changes into a single restart sweep", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(50);
    ctx.setVendor("gemini");
    refresh();
    vi.advanceTimersByTime(50);
    ctx.setVendor("azure-foundry");
    refresh();

    vi.advanceTimersByTime(199);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(ctx.restartPlugin).toHaveBeenCalledTimes(2);
  });

  it("repeated calls with the same vendor are a no-op after the seed", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    refresh();
    refresh();

    vi.advanceTimersByTime(1_000);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
    // Write wildcard metadata on every call so replacement runtimes can be seeded.
    expect(ctx.setOverride).toHaveBeenCalledTimes(3);
  });

  it("clears API vendor metadata and restarts plugins when a subscription runtime becomes active", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor(undefined);
    refresh();

    expect(ctx.clearOverride).toHaveBeenLastCalledWith(["hostApiKey", "hostApiVendor"]);
    expect(ctx.setOverride).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(ctx.restartPlugin).toHaveBeenCalledWith("plugin-a");
    expect(ctx.restartPlugin).toHaveBeenCalledWith("plugin-b");
  });

  it("never injects hostApiKey via the wildcard slot (CRIT-1 contract)", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(200);

    // Wildcard overrides must contain vendor metadata only, never provider secrets.
    for (const call of ctx.setOverride.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(["hostApiVendor"]);
      expect(payload).not.toHaveProperty("hostApiKey");
      expect(payload).not.toHaveProperty("llmApiKey");
    }
  });

  it("restartPlugin rejection is swallowed so other plugins still restart", async () => {
    const ctx = makeDeps({ vendor: "openai" });
    ctx.deps.restartPlugin = vi.fn(async (id: string) => {
      if (id === "plugin-a") throw new Error("simulated restart failure");
      return undefined;
    });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(200);

    expect(ctx.deps.restartPlugin).toHaveBeenCalledWith("plugin-a");
    expect(ctx.deps.restartPlugin).toHaveBeenCalledWith("plugin-b");
    // Drain swallowed rejections before the test exits.
    await vi.runAllTimersAsync();
  });

  it("dispose() cancels a pending debounce timer", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh, dispose } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();

    dispose();
    vi.advanceTimersByTime(1_000);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();

    // Disposal is terminal; late settings events must not schedule restarts.
    ctx.setVendor("gemini");
    refresh();
    vi.advanceTimersByTime(1_000);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
  });

  it("cancels restarts already in flight when shutdown begins after the debounce fires", () => {
    const ctx = makeDeps({ vendor: "openai" });
    let resolveRestart: (() => void) | undefined;
    const pendingRestart = new Promise<undefined>((resolve) => {
      resolveRestart = () => resolve(undefined);
    });
    ctx.deps.restartPlugin = vi.fn((_id: string) => pendingRestart);
    const { refresh, dispose } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(200);

    // Once restart work starts, disposal must cancel at the runtime boundary to prevent publication.
    expect(ctx.deps.restartPlugin).toHaveBeenCalledTimes(2);
    dispose();
    dispose();

    expect(ctx.cancelPendingRestarts).toHaveBeenCalledOnce();
    resolveRestart?.();
  });
});

describe("activeHostApiVendor", () => {
  it("projects only the active API provider", () => {
    expect(activeHostApiVendor({ provider: "openai", activeChatRuntime: { kind: "api" } })).toBe("openai");
    expect(activeHostApiVendor({ provider: "openai", activeChatRuntime: { kind: "subscription", provider: "codex" } })).toBeUndefined();
  });

  it("does not expose the migrated provider while the retirement marker remains", () => {
    expect(activeHostApiVendor({ provider: "openai", activeChatRuntime: { kind: "api" }, retiredProvider: "copilot" })).toBeUndefined();
  });
});
