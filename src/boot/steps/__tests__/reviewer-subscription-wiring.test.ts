import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";

import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { RuleBasedRiskClassifier } from "../../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { UnavailableRationaleScopeReviewer } from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import { UnavailableApprovalSentenceSelector } from "../../../permissions/reviewer/approval-sentence-selector.js";
import type { WireReviewerResult } from "../reviewer-wiring.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

function reviewerResult(root: string): WireReviewerResult {
  const settings = { mode: "rule", fallbackOnError: "deny" } as const;
  return {
    classifier: new RuleBasedRiskClassifier(), rationaleScopeReviewer: new UnavailableRationaleScopeReviewer(),
    approvalSentenceSelector: new UnavailableApprovalSentenceSelector(),
    cache: new VerdictCache(join(root, "cache.jsonl")), recentlyDenied: makeRecentlyDeniedStore(join(root, "recent.json")),
    appliedSettings: settings, effectiveSettings: { ...settings, provider: "openai", model: "fixture-model" }, runtimeMode: "rule",
  };
}

describe("wireReviewerAndPermissions subscription runtime", () => {
  it("blocks API reviewer credentials while retirement is unresolved", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "reviewer-retired-"));
    vi.resetModules();
    const resources = await import("../../../main/host-resources.js");
    resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const wireReviewerAgent = vi.fn((_input: unknown) => reviewerResult(tempDir));
    vi.doMock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
    vi.doMock("../reviewer-wiring.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../reviewer-wiring.js")>(), wireReviewerAgent,
    }));
    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      let retired = true;
      const getSecret = vi.fn(() => "fixture-key");
      const context = {
        host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() },
        permissionManager: new PermissionManager(join(tempDir, "permissions.json")),
        approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
        settingsService: {
          onChanged: vi.fn(),
          get: (key: string) => key === "llm" ? {
            provider: "openai", activeChatRuntime: { kind: "api" },
            vendors: { openai: { model: "gpt-4o" } }, ...(retired ? { retiredProvider: "copilot" } : {}),
          } : {},
          getSecret,
        },
        llmFetch: vi.fn(), getMainWindow: () => null, bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory: vi.fn(),
      };
      wireReviewerAndPermissions(context as never);
      const options = wireReviewerAgent.mock.calls[0]?.[0] as unknown as {
        streamProviderFor: (provider: string) => LLMProvider | null;
      };
      expect(options.streamProviderFor("openai")).toBeNull();
      expect(getSecret).not.toHaveBeenCalled();
      retired = false;
      expect(options.streamProviderFor("openai")).not.toBeNull();
      expect(getSecret).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("electron");
      vi.doUnmock("../reviewer-wiring.js");
      vi.resetModules();
      await cleanupTmpDir(tempDir);
    }
  });
  it.each([undefined, "copilot"] as const)("uses the explicitly selected subscription without releasing the API retirement marker %s", async (retiredProvider) => {
    const tempDir = mkdtempSync(join(tmpdir(), "reviewer-subscription-"));
    vi.resetModules();
    const resources = await import("../../../main/host-resources.js");
    resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const wireReviewerAgent = vi.fn((_input: unknown) => reviewerResult(tempDir));
    vi.doMock("electron", () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock("../reviewer-wiring.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../reviewer-wiring.js")>(), wireReviewerAgent,
    }));
    vi.doMock("../../../ipc/domains/permissions.js", () => ({
      broadcastPermissionConfigChanged: vi.fn(),
    }));

    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      const selection = {
        kind: "subscription" as const,
        provider: "codex" as const,
        model: "gpt-5.5-codex",
      };
      const subscriptionProvider: LLMProvider = {
        vendor: "openai",
        subscriptionRuntime: selection,
        async *streamTurn() {},
      };
      const subscriptionProviderFactory = vi.fn(() => subscriptionProvider);
      const settingsService = {
        onChanged: vi.fn(),
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              // Deliberately different: reviewer must not consult this stale API-key setting while the subscription runtime is active.
              provider: "claude",
              retiredProvider,
              activeChatRuntime: selection,
              vendors: { claude: { model: "claude-sonnet-4-5" } },
            };
          }
          return {};
        }),
        getSecret: vi.fn(() => null),
      };
      const permissionManager = new PermissionManager(join(tempDir, "permissions.json"));
      const context = {
        host: createBootHostFixture(),
        toolRegistry: { setDenyRules: vi.fn() },
        permissionManager,
        approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
        settingsService,
        llmFetch: vi.fn(),
        getMainWindow: () => null,
        bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory,
      };

      wireReviewerAndPermissions(context as never);

      const options = wireReviewerAgent.mock.calls[0]?.[0] as unknown as {
        readActiveLlm: () => { provider: string; model: string };
        streamProviderFor: (provider: string) => LLMProvider | null;
      };
      expect(options.readActiveLlm()).toEqual({
        provider: "subscription:codex",
        model: "gpt-5.5-codex",
      });
      expect(options.streamProviderFor("subscription:codex")).toBe(subscriptionProvider);
      expect(subscriptionProviderFactory).toHaveBeenCalledWith(selection);
      // A forged/legacy API-key identity cannot fall through while a subscription runtime owns the active reviewer transport.
      expect(options.streamProviderFor("claude")).toBeNull();
      expect(subscriptionProviderFactory).toHaveBeenCalledOnce();
      expect(settingsService.getSecret).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("electron");
      vi.doUnmock("../reviewer-wiring.js");
      vi.doUnmock("../../../ipc/domains/permissions.js");
      vi.resetModules();
      await cleanupTmpDir(tempDir);
    }
  });
});
