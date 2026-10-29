import { reviewerSettings } from "../../../__tests__/support/reviewer-settings.js";
/** Reviewer boot integration (docs/architecture/permission-policy-design.md). */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import {
  wireReviewerAgent,
  LlmReviewerProviderAdapter,
} from "../reviewer-wiring.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import {
  RuleBasedRiskClassifier,
  DisabledRiskClassifier,
  LlmRiskClassifier,
  type RiskVerdict,
} from "../../../permissions/reviewer/risk-classifier.js";
import {
  LlmRationaleScopeReviewer,
  UnavailableRationaleScopeReviewer,
} from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import {
  VerdictCache,
  type VerdictCacheLookupKey,
  type VerdictCacheContext,
} from "../../../permissions/reviewer/verdict-cache.js";
import type { LLMProvider, StreamEvent } from "../../../engine/llm/types.js";
import { marketplaceProviderPresetSecretKey } from "../../../shared/marketplace-package-assets.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";

let tmpDir: string;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  tmpDir = mkdtempSync(join(tmpdir(), "permission-policy-p4-rw-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmpDir) await cleanupTmpDir(tmpDir);
});

function stubProvider(events: StreamEvent[]): LLMProvider {
  return {
    vendor: "openai",
    streamTurn: async function* () {
      for (const e of events) yield e;
    },
  };
}


const CHAT_LLM = () => ({ provider: "openai" as const, model: "gpt-4o-mini" });

function llmDenySettings() {
  return {
    mode: "llm",
    fallbackOnError: "deny",
  } as const;
}

describe("Permission policy P4 reviewer-wiring", () => {
  // An unconfigured chat model leaves the following reviewer unconfigured.
  it("reports an empty active chat model as unconfigured without building a provider", () => {
    const file = join(tmpDir, "permissions.json");
    const streamProviderFor = vi.fn(() => stubProvider([]));
    const result = wireReviewerAgent({
      networkFetch: unusedNetworkFetch,
      permissionManager: new PermissionManager(file),
      readSettings: () => readPermissionSettings(join(tmpDir, "settings.json")).permissions.reviewer,
      readActiveLlm: () => ({ provider: "openai", model: "" }),
      streamProviderFor,
      verdictCachePath: join(tmpDir, "cache.jsonl"),
    });
    expect(result.effectiveSettings.model).toBe("");
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(streamProviderFor).not.toHaveBeenCalled();
  });
  it("settings mode=rule wires RuleBasedRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const result = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        fallbackOnError: "rule",
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.rationaleScopeReviewer).toBeInstanceOf(UnavailableRationaleScopeReviewer);
    expect(setReviewerSpy).toHaveBeenCalledOnce();
    expect(pm.hasReviewer()).toBe(true);
  });

  it("settings mode=disabled wires DisabledRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "disabled",
        fallbackOnError: "rule",
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(DisabledRiskClassifier);
    expect(result.rationaleScopeReviewer).toBeInstanceOf(UnavailableRationaleScopeReviewer);
    expect(pm.hasReviewer()).toBe(true);
  });

  it("settings mode=llm + provider available wires LlmRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "openai" ? provider : null,
    );
    const result = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        fallbackOnError: "rule",
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(result.rationaleScopeReviewer).toBeInstanceOf(LlmRationaleScopeReviewer);
    const classifierRuntime = result.classifier as unknown as {
      provider: unknown;
      model: string;
    };
    const rationaleRuntime = result.rationaleScopeReviewer as unknown as {
      provider: unknown;
      model: string;
    };
    expect(rationaleRuntime.provider).toBe(classifierRuntime.provider);
    expect(classifierRuntime.model).toBe("gpt-4o-mini");
    expect(rationaleRuntime.model).toBe("gpt-4o-mini");
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledWith("openai");
    expect(pm.hasReviewer()).toBe(true);
  });

  it("mode=llm follows active chat LLM provider and model", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "openai-compatible" ? provider : null,
    );
    const result = wireReviewerAgent({
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        fallbackOnError: "deny",
      }),
      readActiveLlm: () => ({
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        model: "future/free",
        baseUrl: "https://future.example/v1",
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache-active-llm.jsonl"),
    });

    expect(result.effectiveSettings.provider).toBe("openai-compatible");
    expect(result.effectiveSettings.marketplaceProviderPresetId).toBe("future-router");
    expect(result.effectiveSettings.model).toBe("future/free");
    expect(
      (result.rationaleScopeReviewer as unknown as { model: string }).model,
    ).toBe("future/free");
    expect(factorySpy).toHaveBeenCalledWith("openai-compatible");
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.provider).toBe("openai-compatible");
    expect(cacheScope?.marketplaceProviderPresetId).toBe("future-router");
    expect(cacheScope?.model).toBe("future/free");
    expect(cacheScope?.providerBaseUrl).toBe("https://future.example/v1");
  });

  it("mode=llm active cacheScope includes Vertex transport identity", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "vertex-ai" ? provider : null,
    );

    const result = wireReviewerAgent({
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        fallbackOnError: "deny",
      }),
      readActiveLlm: () => ({
        provider: "vertex-ai",
        model: "gemini-2.5-pro",
        vertexProject: "prod-project",
        vertexLocation: "us-central1",
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache-active-vertex.jsonl"),
    });

    expect(result.effectiveSettings.provider).toBe("vertex-ai");
    expect(result.effectiveSettings.vertexProject).toBe("prod-project");
    expect(result.effectiveSettings.vertexLocation).toBe("us-central1");
    expect(factorySpy).toHaveBeenCalledWith("vertex-ai");
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.provider).toBe("vertex-ai");
    expect(cacheScope?.vertexProject).toBe("prod-project");
    expect(cacheScope?.vertexLocation).toBe("us-central1");
  });

  it("mode=llm but streamProviderFor dependency missing → throws (boot contract violation, no silent degrade)", () => {
    // Missing streamProviderFor is an internal wiring error and must abort boot; only an unconfigured external provider may degrade.
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    expect(() =>
      wireReviewerAgent({
        readActiveLlm: CHAT_LLM,
        networkFetch: unusedNetworkFetch,
        permissionManager: pm,
        readSettings: () => ({
          mode: "llm",
          fallbackOnError: "deny",
        }),
        verdictCachePath: join(tmpDir, "cache-degrade.jsonl"),
      }),
    ).toThrow(/no streamProviderFor supplied/);
  });

  it("mode=llm + factory null → degrades to rule (provider unconfigured)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: llmDenySettings,
      streamProviderFor: () => null,
      verdictCachePath: join(tmpDir, "cache-degrade-null.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.rationaleScopeReviewer).toBeInstanceOf(UnavailableRationaleScopeReviewer);
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("degraded wiring keeps the reviewer available", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: llmDenySettings,
      streamProviderFor: () => null,
      verdictCachePath: join(tmpDir, "cache-degrade-fa.jsonl"),
    });
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.hasReviewer()).toBe(true);
  });

  it("logs a boot warn on llm→rule degrade", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        readActiveLlm: CHAT_LLM,
        networkFetch: unusedNetworkFetch,
        permissionManager: pm,
        readSettings: () => ({
          mode: "llm",
          fallbackOnError: "deny",
        }),
        streamProviderFor: () => null,
        verdictCachePath: join(tmpDir, "cache-degrade-warn.jsonl"),
      });
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("degrading to rule classifier")),
      );
      expect(fired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-wiring after provider becomes available heals llm-degraded-to-rule → llm", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const degraded = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: llmDenySettings,
      streamProviderFor: () => null,
      verdictCachePath: join(tmpDir, "cache-heal-1.jsonl"),
    });
    expect(degraded.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);

    const provider = stubProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const healed = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: llmDenySettings,
      streamProviderFor: () => provider,
      verdictCachePath: join(tmpDir, "cache-heal-2.jsonl"),
    });
    expect(healed.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(healed.runtimeMode).toBe("llm");
    expect(pm.isReviewerDegradedToRule()).toBe(false);
  });

  // Use one physical cache file to prove runtime-mode changes invalidate stale reviewer verdicts.
  const LOOKUP_KEY: VerdictCacheLookupKey = {
    toolName: "fs_write",
    source: "plugin",
    category: "write",
    trustOrigin: "llm-tool-arg",
    finalInput: { path: "/Users/example/work/note.md" },
  };
  function ctxWithReviewerScope(
    reviewerScope: Record<string, unknown>,
  ): VerdictCacheContext {
    return {
      allowedDirectories: ["/Users/example/work"],
      scope: { reviewer: reviewerScope },
    };
  }


  it("degraded→heal: stale rule verdict in shared cache is NOT served after llm heal (miss-stale)", async () => {
    const cachePath = join(tmpDir, "cache-mode-flip.jsonl");

    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");

    const degraded = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: reviewerSettings,
      streamProviderFor: () => null,
      verdictCachePath: cachePath,
    });
    expect(degraded.runtimeMode).toBe("llm-degraded-to-rule");
    const degradedScope = setReviewerSpy.mock.calls[0][0].cacheScope!;
    expect(degradedScope.mode).toBe("llm-degraded-to-rule");

    const cache = new VerdictCache(cachePath);
    const ruleVerdict: RiskVerdict = { level: "low", reason: "degraded rule verdict" };
    await cache.store(LOOKUP_KEY, ctxWithReviewerScope(degradedScope), ruleVerdict);
    cache.resetForTests();
    expect(cache.lookup(LOOKUP_KEY, ctxWithReviewerScope(degradedScope)).reason).toBe("hit");

    const provider = stubProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const healed = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: reviewerSettings,
      streamProviderFor: () => provider,
      verdictCachePath: cachePath,
    });
    expect(healed.runtimeMode).toBe("llm");
    const healedScope = setReviewerSpy.mock.calls[1][0].cacheScope!;
    expect(healedScope.mode).toBe("llm");

    // Healed model review must not reuse rule-derived cache entries.
    cache.resetForTests();
    const afterHeal = cache.lookup(LOOKUP_KEY, ctxWithReviewerScope(healedScope));
    expect(afterHeal.hit).toBe(false);
    expect(afterHeal.reason).toBe("miss-stale");
  });

  it("heal→degrade: healthy llm verdict in shared cache is NOT served after degrade (miss-stale)", async () => {
    const cachePath = join(tmpDir, "cache-mode-flip-rev.jsonl");

    const provider = stubProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");

    const healthy = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: reviewerSettings,
      streamProviderFor: () => provider,
      verdictCachePath: cachePath,
    });
    expect(healthy.runtimeMode).toBe("llm");
    const llmScope = setReviewerSpy.mock.calls[0][0].cacheScope!;
    expect(llmScope.mode).toBe("llm");

    const cache = new VerdictCache(cachePath);
    const llmVerdict: RiskVerdict = { level: "medium", reason: "llm verdict" };
    await cache.store(LOOKUP_KEY, ctxWithReviewerScope(llmScope), llmVerdict);
    cache.resetForTests();
    expect(cache.lookup(LOOKUP_KEY, ctxWithReviewerScope(llmScope)).reason).toBe("hit");

    const degraded = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: reviewerSettings,
      streamProviderFor: () => null,
      verdictCachePath: cachePath,
    });
    expect(degraded.runtimeMode).toBe("llm-degraded-to-rule");
    const degradedScope = setReviewerSpy.mock.calls[1][0].cacheScope!;
    expect(degradedScope.mode).toBe("llm-degraded-to-rule");

    // Degraded rules must not reuse model-derived cache entries.
    cache.resetForTests();
    const afterDegrade = cache.lookup(LOOKUP_KEY, ctxWithReviewerScope(degradedScope));
    expect(afterDegrade.hit).toBe(false);
    expect(afterDegrade.reason).toBe("miss-stale");
  });

  it("preserves caller-supplied settings on appliedSettings", () => {
    const settingsPath = join(tmpDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: {
          additionalDirectories: [],
          reviewer: {
            mode: "rule",
            fallbackOnError: "deny",
          },
        },
      }),
    );
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        fallbackOnError: "deny",
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
    });
    expect(result.appliedSettings.mode).toBe("rule");
    expect(result.appliedSettings.fallbackOnError).toBe("deny");
  });

  it("wires the selected classifier into the live permission manager", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        fallbackOnError: "deny",
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
    });
    expect(pm.hasReviewer()).toBe(true);
  });

  it("does not warn for automatic execution mode", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    pm.setMode("auto");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        readActiveLlm: CHAT_LLM,
        networkFetch: unusedNetworkFetch,
        permissionManager: pm,
        readSettings: () => ({
          mode: "rule",
          fallbackOnError: "deny",
        }),
        verdictCachePath: join(tmpDir, "cache-warn-auto-off.jsonl"),
      });
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("legacy exec mode=auto")),
      );
      expect(fired).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for strict execution mode", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    pm.setMode("strict");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        readActiveLlm: CHAT_LLM,
        networkFetch: unusedNetworkFetch,
        permissionManager: pm,
        readSettings: () => ({
          mode: "rule",
          fallbackOnError: "deny",
        }),
        verdictCachePath: join(tmpDir, "cache-warn-strict.jsonl"),
      });
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("exec mode=strict")),
      );
      expect(fired).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rewiring preserves recently denied history", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        fallbackOnError: "deny",
      }),
      verdictCachePath: join(tmpDir, "cache-1.jsonl"),
    });
    const history = pm.getRecentlyDenied();
    expect(history).not.toBeNull();
    wireReviewerAgent({
      readActiveLlm: CHAT_LLM,
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        fallbackOnError: "deny",
      }),
      verdictCachePath: join(tmpDir, "cache-2.jsonl"),
    });
    expect(pm.getRecentlyDenied()).toBe(history);
  });
});

describe("wireReviewerAndPermissions marketplace preset endpoint binding", () => {
  it("uses the installed preset endpoint when building the reviewer provider", async () => {
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const networkGuard = await import("../../../core/network-guard.js");
    const fetchPublicHttpResponse = vi
      .spyOn(networkGuard, "fetchPublicHttpResponse")
      .mockResolvedValue(new Response("ok"));
    const provider = stubProvider([]);
    const createProvider = vi.fn(() => provider);
    const initialRationaleScopeReviewer = { reevaluate: vi.fn() };
    const rewiredRationaleScopeReviewer = { reevaluate: vi.fn() };
    const wireReviewerAgentMock = vi
      .fn()
      .mockReturnValueOnce({ classifier: new RuleBasedRiskClassifier(), rationaleScopeReviewer: initialRationaleScopeReviewer, recentlyDenied: { setReplayResolver: vi.fn() } })
      .mockReturnValue({ classifier: new RuleBasedRiskClassifier(), rationaleScopeReviewer: rewiredRationaleScopeReviewer, recentlyDenied: { setReplayResolver: vi.fn() } });
    vi.doMock("electron", () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock("../../../engine/llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    vi.doMock("../reviewer-wiring.js", () => ({
      wireReviewerAgent: wireReviewerAgentMock,
    }));
    vi.doMock("../../../ipc/domains/permissions.js", () => ({
      broadcastPermissionConfigChanged: vi.fn(),
    }));

    const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
    const settingsService = {
      onChanged: vi.fn(),
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": {
                // Follow the preset's own route, not the generic custom-provider model.
                presetModels: { "future-router": "future/free" },
                baseUrl: "https://stale.example/v1",
              },
            },
            fallbackChain: [],
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            }],
          };
        }
        if (key === "permissions") {
          return {
            reviewer: {
              mode: "llm",
              fallbackOnError: "rule",
            },
          };
        }
        return {};
      }),
      getSecret: vi.fn((key: string) =>
        key === marketplaceProviderPresetSecretKey("future-router")
          ? "fr-secret"
          : null
      ),
    };
    const permissionManager = new PermissionManager(join(tmpDir, "boot-permissions.json"));

    const bootContext = {
      approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
      host: createBootHostFixture(),
      toolRegistry: { setDenyRules: vi.fn() },
      permissionManager,
      settingsService,
      llmFetch: vi.fn(),
      singleHopNetworkFetch: unusedNetworkFetch,
      getMainWindow: () => null,
      bootAuditLogger: { log: vi.fn() },
    };
    wireReviewerAndPermissions(bootContext as never);
    expect(
      (bootContext as unknown as { rationaleScopeReviewer: unknown })
        .rationaleScopeReviewer,
    ).toBe(initialRationaleScopeReviewer);
    (bootContext as unknown as { rewireReviewerAgent: () => void })
      .rewireReviewerAgent();
    expect(
      (bootContext as unknown as { rationaleScopeReviewer: unknown })
        .rationaleScopeReviewer,
    ).toBe(rewiredRationaleScopeReviewer);

    const options = wireReviewerAgentMock.mock.calls[0]?.[0] as {
      readActiveLlm: () => { baseUrl?: string };
      streamProviderFor: (vendor: string) => LLMProvider | null;
    };
    expect(options.readActiveLlm()).toMatchObject({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "future-router",
      baseUrl: "https://future.example/v1",
    });
    expect(options.streamProviderFor("openai-compatible")).toBe(provider);
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      vendor: "openai-compatible",
      apiKey: "fr-secret",
      model: "future/free",
      baseUrl: "https://future.example/v1",
      fetch: expect.any(Function),
      providerMetadata: expect.objectContaining({
        providerId: "future-router",
        baseUrl: "https://future.example/v1",
      }),
    }));
    const providerConfig = createProvider.mock.calls[0]?.[0];
    await providerConfig?.fetch?.("https://future.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    expect(fetchPublicHttpResponse).toHaveBeenCalledWith(
      "https://future.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        allowPrivateNetworks: false,
        allowLoopback: false,
        maxRedirects: 0,
        fetchImpl: expect.any(Function),
      }),
    );

    vi.doUnmock("electron");
    vi.doUnmock("../../../engine/llm/provider-factory.js");
    vi.doUnmock("../reviewer-wiring.js");
    vi.doUnmock("../../../ipc/domains/permissions.js");
    vi.resetModules();
  });
});

describe("wireReviewerAndPermissions self-hosted direct endpoint binding", () => {
  it("builds the reviewer provider with a guarded model-provider fetch for a saved self-hosted endpoint", async () => {
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const networkGuard = await import("../../../core/network-guard.js");
    const fetchPublicHttpResponse = vi
      .spyOn(networkGuard, "fetchPublicHttpResponse")
      .mockResolvedValue(new Response("ok"));
    const provider = stubProvider([]);
    const createProvider = vi.fn(() => provider);
    const initialRationaleScopeReviewer = { reevaluate: vi.fn() };
    const rewiredRationaleScopeReviewer = { reevaluate: vi.fn() };
    const wireReviewerAgentMock = vi
      .fn()
      .mockReturnValueOnce({ classifier: new RuleBasedRiskClassifier(), rationaleScopeReviewer: initialRationaleScopeReviewer, recentlyDenied: { setReplayResolver: vi.fn() } })
      .mockReturnValue({ classifier: new RuleBasedRiskClassifier(), rationaleScopeReviewer: rewiredRationaleScopeReviewer, recentlyDenied: { setReplayResolver: vi.fn() } });
    vi.doMock("electron", () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock("../../../engine/llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    vi.doMock("../reviewer-wiring.js", () => ({
      wireReviewerAgent: wireReviewerAgentMock,
    }));
    vi.doMock("../../../ipc/domains/permissions.js", () => ({
      broadcastPermissionConfigChanged: vi.fn(),
    }));

    const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
    const settingsService = {
      onChanged: vi.fn(),
      get: vi.fn((key: string) => {
        if (key === "llm") {
          // A saved self-hosted openai-compatible endpoint with NO marketplace preset; the isSelfHostedDirectEndpoint branch of the fetch ladder.
          return {
            provider: "openai-compatible",
            vendors: {
              "openai-compatible": {
                model: "Qwen3.6-35B",
                baseUrl: "http://10.0.0.9:8000/v1",
              },
            },
            fallbackChain: [],
          };
        }
        if (key === "marketplace") {
          return { installedProviderPresets: [] };
        }
        if (key === "permissions") {
          return {
            reviewer: {
              mode: "llm",
              fallbackOnError: "rule",
            },
          };
        }
        return {};
      }),
      getSecret: vi.fn((key: string) =>
        key === "llm.apiKey.openai-compatible" ? "internal-key" : null,
      ),
    };
    const permissionManager = new PermissionManager(
      join(tmpDir, "boot-permissions-selfhosted.json"),
    );

    const bootContext = {
      approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
      host: createBootHostFixture(),
      toolRegistry: { setDenyRules: vi.fn() },
      permissionManager,
      settingsService,
      llmFetch: vi.fn(),
      singleHopNetworkFetch: unusedNetworkFetch,
      getMainWindow: () => null,
      bootAuditLogger: { log: vi.fn() },
    };
    wireReviewerAndPermissions(bootContext as never);

    const options = wireReviewerAgentMock.mock.calls[0]?.[0] as {
      readActiveLlm: () => { baseUrl?: string };
      streamProviderFor: (vendor: string) => LLMProvider | null;
    };
    expect(options.readActiveLlm()).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://10.0.0.9:8000/v1",
    });
    // Without a marketplace preset, select the guarded self-hosted transport.
    expect(options.streamProviderFor("openai-compatible")).toBe(provider);
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai-compatible",
        apiKey: "internal-key",
        model: "Qwen3.6-35B",
        baseUrl: "http://10.0.0.9:8000/v1",
        fetch: expect.any(Function),
      }),
    );
    // The direct self-hosted branch carries no marketplace metadata.
    expect(createProvider.mock.calls[0]?.[0]).not.toHaveProperty("providerMetadata");

    const providerConfig = createProvider.mock.calls[0]?.[0];
    // Lock forwarding to the configured origin, including its private-network and loopback predicates.
    await providerConfig?.fetch?.("http://10.0.0.9:8000/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    expect(fetchPublicHttpResponse).toHaveBeenCalledWith(
      "http://10.0.0.9:8000/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        allowPrivateNetworks: expect.any(Function),
        allowLoopback: expect.any(Function),
        maxRedirects: 0,
        fetchImpl: expect.any(Function),
      }),
    );
    // Reject cross-origin requests before the network guard.
    await expect(
      providerConfig?.fetch?.("http://evil.example/v1/chat/completions", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("configured origin");

    vi.doUnmock("electron");
    vi.doUnmock("../../../engine/llm/provider-factory.js");
    vi.doUnmock("../reviewer-wiring.js");
    vi.doUnmock("../../../ipc/domains/permissions.js");
    vi.resetModules();
  });
});

describe("Permission policy P4 LlmReviewerProviderAdapter", () => {
  it("collects streamTurn `text_delta` events into a single string", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: '{"level":' },
      { type: "text_delta", text: ' "low",' },
      { type: "text_delta", text: ' "reason": "ok"}' },
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 6 },
      },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const out = await adapter.complete({
      model: "gpt-4o-mini",
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(out.text).toBe('{"level": "low", "reason": "ok"}');
    expect(out.tokensIn).toBe(10);
    expect(out.tokensOut).toBe(6);
  });

  it("ignores reasoning_delta + tool_call events", async () => {
    const provider = stubProvider([
      { type: "reasoning_delta", text: "thinking..." },
      { type: "text_delta", text: '{"level":"high"}' },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const out = await adapter.complete({
      model: "claude-haiku",
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(out.text).toBe('{"level":"high"}');
  });

  it("throws on `error` stream event", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: '{"level":"low"}' },
      { type: "error", error: "rate limit" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    await expect(
      adapter.complete({
        model: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
      }),
    ).rejects.toThrow(/rate limit/);
  });

  it("aborts mid-stream when abortSignal fires", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: "first" },
      { type: "text_delta", text: "second" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.complete({
        model: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("user-selected permission reviewer model", () => {
  const llmSettings = () => ({
    mode: "llm" as const,
    fallbackOnError: "rule" as const,
  });

  it.each([
    ["its provider is not connected", { label: "claude/selected", available: true }],
    ["it is not offered", { label: "claude/retired", available: false }],
  ])("fails as unavailable when %s, never degrading to rule or the chat model", (_case, selectedModel) => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewer = vi.spyOn(pm, "setReviewer");
    const streamProviderFor = vi.fn(() => null);
    const result = wireReviewerAgent({
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: llmSettings,
      readActiveLlm: () => ({ provider: "claude", model: selectedModel.label.slice("claude/".length) }),
      streamProviderFor,
      selectedModel,
      verdictCachePath: join(tmpDir, "cache-selected.jsonl"),
    });
    expect(result.runtimeMode).toBe("llm-model-unavailable");
    expect(pm.isReviewerDegradedToRule()).toBe(false);
    expect(result.rationaleScopeReviewer).toBeInstanceOf(UnavailableRationaleScopeReviewer);
    expect(setReviewer.mock.lastCall?.[0].unavailableReason).toBe(
      `Selected permission reviewer model ${selectedModel.label} is unavailable`,
    );
    expect(streamProviderFor).toHaveBeenCalledTimes(selectedModel.available ? 1 : 0);
  });

  it("wires the selected model as the reviewer when it can run", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewer = vi.spyOn(pm, "setReviewer");
    const result = wireReviewerAgent({
      networkFetch: unusedNetworkFetch,
      permissionManager: pm,
      readSettings: llmSettings,
      readActiveLlm: () => ({ provider: "claude", model: "selected-model" }),
      streamProviderFor: () => stubProvider([{ type: "message_complete", stopReason: "end_turn" }]),
      selectedModel: { label: "claude/selected-model", available: true },
      verdictCachePath: join(tmpDir, "cache-selected-ok.jsonl"),
    });
    expect(result.runtimeMode).toBe("llm");
    expect(result.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(result.effectiveSettings).toMatchObject({ provider: "claude", model: "selected-model" });
    expect(setReviewer.mock.lastCall?.[0]).not.toHaveProperty("unavailableReason");
    expect(setReviewer.mock.lastCall?.[0].cacheScope).toMatchObject({ provider: "claude", model: "selected-model" });
  });
});
