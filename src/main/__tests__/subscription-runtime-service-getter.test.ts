// Own file: the lazy service getter and the boot-configured release transport are module singletons.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import { configureClaudeCodeReleaseFetch } from "../claude-code-authenticity.js";
import * as subscriptionClient from "../claude-code-subscription-client.js";
import {
  getSubscriptionRuntimeService, stopSubscriptionRuntimes, SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry,
} from "../subscription-runtime-service.js";
import { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace as namespace } from "../../__tests__/support/subscription-runtime-namespace.js";

afterEach(async () => {
  await stopSubscriptionRuntimes();
  vi.restoreAllMocks();
});

describe("getSubscriptionRuntimeService before boot configures the release transport", () => {
  it("does not keep the failed creation, and builds the Claude Code client once the transport is configured", async () => {
    const realCreate = SubscriptionRuntimeService.create.bind(SubscriptionRuntimeService);
    const create = vi.spyOn(SubscriptionRuntimeService, "create").mockImplementation((open, options) => realCreate(open, {
      ...options, namespace: namespace(), claimRuntimeDirectories: claimFakeRuntimeDirectories,
      codexClient: { stop: vi.fn() } as unknown as CodexAppServerClient,
      acpRegistry: { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry,
    }));
    const constructed = vi.spyOn(subscriptionClient, "ClaudeCodeSubscriptionClient");
    const open = async () => undefined;
    claimFakeRuntimeDirectories.mockClear();

    await expect(getSubscriptionRuntimeService(open)).rejects.toThrow(/release verification transport is not configured/u);
    expect(constructed).not.toHaveBeenCalled();
    // The refusal comes before any runtime directory is claimed or client made.
    expect(claimFakeRuntimeDirectories).not.toHaveBeenCalled();

    const networkFetch = vi.fn(async () => new Response("key"));
    configureClaudeCodeReleaseFetch(networkFetch as unknown as typeof fetch);
    const service = await getSubscriptionRuntimeService(open);
    expect(service).toBeInstanceOf(SubscriptionRuntimeService);
    expect(create).toHaveBeenCalledTimes(2);
    expect(constructed).toHaveBeenCalledOnce();
    const { releaseFetch } = constructed.mock.calls[0]![0];
    await releaseFetch("https://downloads.claude.ai/keys/claude-code.asc");
    expect(networkFetch).toHaveBeenCalledWith("https://downloads.claude.ai/keys/claude-code.asc", expect.objectContaining({ redirect: "error", credentials: "omit" }));
  });
});
