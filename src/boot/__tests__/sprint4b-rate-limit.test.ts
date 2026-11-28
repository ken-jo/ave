import { collectPermissionEvents } from "../../__tests__/support/permission-events.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCallLlm, createCallLlmForPlugin } from "../conversation.js";

describe("createCallLlmForPlugin (Sprint 4-B §B-7)", () => {
  function makeFakeLoop(): { generateText: ReturnType<typeof vi.fn> } {
    return { generateText: vi.fn(async () => "ok") };
  }
  it("permits up to maxCalls within the window", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlmForPlugin(loop as never, {
      maxCalls: 3,
      windowMs: 10_000,
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(callLlm("p1", "hello")).resolves.toBe("ok");
    }
    expect(loop.generateText).toHaveBeenCalledTimes(3);
  });

  it("rejects the (maxCalls+1)-th call with an error and logs the quota refusal", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlmForPlugin(loop as never, {
      maxCalls: 2,
      windowMs: 10_000,
    });
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    await callLlm("p1", "a");
    await callLlm("p1", "b");
    await expect(callLlm("p1", "c")).rejects.toThrow(/rate-limit exceeded/);
    expect(capture.events).toContainEqual({ event: "plugin_llm_rate_limited", pluginId: "p1", sessionId: "plugin" });
  });

  it("buckets are per-plugin: one plugin's saturation does not block another", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlmForPlugin(loop as never, {
      maxCalls: 1,
      windowMs: 10_000,
    });
    await callLlm("p1", "a");
    await expect(callLlm("p1", "b")).rejects.toThrow();
    await expect(callLlm("p2", "c")).resolves.toBe("ok");
  });

  it("logs a successful call with the plugin identifier", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlmForPlugin(loop as never, {
      maxCalls: 5,
      windowMs: 10_000,
    });
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    await expect(callLlm("p1", "secret-prompt-canary")).resolves.toBe("ok");
    expect(capture.events).toEqual([{ event: "plugin_llm_called", pluginId: "p1", sessionId: "plugin" }]);
  });

  it("passes abort signal through to ConversationLoop.generateText", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlmForPlugin(loop as never, {
      maxCalls: 5,
      windowMs: 10_000,
    });
    const controller = new AbortController();

    await callLlm("p1", "hello", { signal: controller.signal });
    expect(loop.generateText).toHaveBeenCalledWith(
      "hello",
      undefined,
      controller.signal,
    );
  });

  it("maps plugin maxTokens only to the internal outputTokenLimit", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlmForPlugin(loop as never);
    const controller = new AbortController();

    await callLlm("p1", "hello", {
      maxTokens: 1400,
      systemPrompt: "plugin system",
      signal: controller.signal,
    });

    expect(loop.generateText).toHaveBeenCalledWith(
      "hello",
      "plugin system",
      controller.signal,
      { outputTokenLimit: 1400 },
    );
  });

  it("maps routine maxTokens to the same internal outputTokenLimit", async () => {
    const loop = makeFakeLoop();
    const callLlm = createCallLlm(loop as never);
    const controller = new AbortController();

    await callLlm("hello", {
      maxTokens: 750,
      systemPrompt: "routine system",
      signal: controller.signal,
    });

    expect(loop.generateText).toHaveBeenCalledWith(
      "hello",
      "routine system",
      controller.signal,
      { outputTokenLimit: 750 },
    );
  });
});
