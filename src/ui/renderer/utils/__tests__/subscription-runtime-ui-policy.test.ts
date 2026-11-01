import { describe, expect, it } from "vitest";
import type { SubscriptionRuntimeCapabilities } from "../../../../shared/subscription-runtime.js";
import { selectSubscriptionRuntimeUiPolicy } from "../subscription-runtime-ui-policy.js";

const LIMITS = { maxCount: 5, maxBytesPerImage: 1024, maxTotalBytes: 2048 };
const READY: SubscriptionRuntimeCapabilities = {
  chat: true,
  images: true,
  imageAttachmentLimits: LIMITS,
  files: true,
  tools: true,
  projectAccess: true,
  plugins: true,
  mcp: true,
  generateText: true,
  compaction: true,
  routine: true,
  subagent: true,
};

function planPolicy(model: string | undefined) {
  return selectSubscriptionRuntimeUiPolicy({
    activeSubscriptionRuntime: { kind: "subscription", provider: "chatgpt-plan", ...(model ? { model } : {}) },
    settingsLoaded: true,
    capabilities: READY,
  });
}

describe("selectSubscriptionRuntimeUiPolicy for ChatGPT plan usage", () => {
  it("offers images for a plan model that accepts them, with the runtime's budget", () => {
    const policy = planPolicy("gpt-6.1-sol");
    expect(policy.imagesEnabled).toBe(true);
    expect(policy.imageAttachmentLimits).toEqual(LIMITS);
  });

  it("withholds images for a plan model that does not accept them, while files stay available", () => {
    const policy = planPolicy("gpt-oss-120b");
    expect(policy.imagesReady).toBe(false);
    expect(policy.imagesEnabled).toBe(false);
    expect(policy.imageAttachmentLimits).toBeNull();
    expect(policy.filesEnabled).toBe(true);
  });

  it("withholds images when no plan model is selected", () => {
    expect(planPolicy(undefined).imagesEnabled).toBe(false);
  });

  it("leaves a runtime whose images do not follow the model on its verified capability alone", () => {
    const policy = selectSubscriptionRuntimeUiPolicy({
      activeSubscriptionRuntime: { kind: "subscription", provider: "codex", model: "gpt-oss-120b" },
      settingsLoaded: true,
      capabilities: READY,
    });
    expect(policy.imagesEnabled).toBe(true);
  });
});

describe("selectSubscriptionRuntimeUiPolicy after a restart", () => {
  const UNPROVEN: SubscriptionRuntimeCapabilities = { ...READY, chat: false, images: false, files: false };
  const policy = (provableOnUse: boolean) => selectSubscriptionRuntimeUiPolicy({
    activeSubscriptionRuntime: { kind: "subscription", provider: "codex" },
    settingsLoaded: true,
    capabilities: UNPROVEN,
    provableOnUse,
  });

  it("lets a connected, ready runtime send so its first turn re-proves it, without unproven attachments", () => {
    const sendable = policy(true);
    expect(sendable.chatReady).toBe(true);
    expect(sendable.chatUnavailable).toBe(false);
    expect(sendable.imagesEnabled).toBe(false);
    expect(sendable.filesEnabled).toBe(false);
  });

  it("keeps chat unavailable when the runtime is not connected and ready", () => {
    expect(policy(false).chatUnavailable).toBe(true);
  });
});
