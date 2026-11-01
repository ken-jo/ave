import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { BuiltinLlmJudge } from "../../../permissions/judge/builtin-llm-judge.js";
import { resolveJudge } from "../../../permissions/judge/judge-engine.js";
import { collectingAudit, judgeRequest, judgeSettings } from "../../../permissions/judge/__tests__/judge-request-fixture.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { createRootSessionResolver } from "../../../permissions/root-session-resolver.js";
import { wireJudgeAgent } from "../judge-wiring.js";
import { wireReviewerAgent } from "../reviewer-wiring.js";

let directory: string;
beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  directory = mkdtempSync(join(tmpdir(), "judge-wiring-"));
});
afterEach(async () => { await cleanupTmpDir(directory); });

function reviewer(permissionManager: PermissionManager) {
  const provider: LLMProvider = {
    vendor: "openai",
    async *streamTurn() {
      yield { type: "text_delta", text: '{"level":"high","reason":"destructive effect"}' };
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  };
  const defaults = readPermissionSettings(join(directory, "absent.json")).permissions.reviewer;
  return wireReviewerAgent({
    permissionManager,
    networkFetch: unusedNetworkFetch,
    readSettings: () => ({ ...defaults, mode: "llm" }),
    readActiveLlm: () => ({ provider: "openai", model: "current-reviewer" }),
    streamProviderFor: () => provider,
    verdictCachePath: join(directory, "verdicts.jsonl"),
  });
}

describe("judge boot wiring", () => {
  it.each([true, false, undefined])("propagates unreadable settings metadata without changing normalized settings: %s", (settingsUnreadable) => {
    const permissionManager = new PermissionManager(join(directory, "permissions.json"));
    const setJudge = vi.spyOn(permissionManager, "setJudge");
    const settings = judgeSettings({ chain: [], mode: "shadow" });
    const engine = wireJudgeAgent({
      permissionManager, reviewer: reviewer(permissionManager), settings, settingsUnreadable,
      providerForModel: () => null, networkFetch: unusedNetworkFetch,
      audit: collectingAudit().logger, resolveRootSessionId: (id) => id,
    });
    expect(engine.settings).toBe(settings);
    expect(engine.chain).toEqual([]);
    expect(engine.settingsUnreadable).toBe(settingsUnreadable === true ? true : undefined);
    expect(setJudge.mock.lastCall?.[0]).toBe(engine);
  });

  it.each([true, false, undefined])("preserves rejected-chain metadata without changing ordinary off settings: %s", (chainRejected) => {
    const permissionManager = new PermissionManager(join(directory, "permissions.json"));
    const setJudge = vi.spyOn(permissionManager, "setJudge");
    const settings = judgeSettings({ chain: [], mode: "active" });
    const engine = wireJudgeAgent({
      permissionManager, reviewer: reviewer(permissionManager), settings, chainRejected,
      providerForModel: () => null, networkFetch: unusedNetworkFetch,
      audit: collectingAudit().logger, resolveRootSessionId: (id) => id,
    });
    expect(engine.settings).toBe(settings);
    expect(engine.chain).toEqual([]);
    expect(engine.chainRejected).toBe(chainRejected === true ? true : undefined);
    expect(setJudge.mock.lastCall?.[0]).toBe(engine);
  });

  it("defaults the builtin stage to the current reviewer without constructing another provider", () => {
    const permissionManager = new PermissionManager(join(directory, "permissions.json"));
    const result = reviewer(permissionManager);
    const providerForModel = vi.fn(() => null);
    const engine = wireJudgeAgent({
      permissionManager,
      reviewer: result,
      settings: judgeSettings({ chain: [{ id: "builtin", provider: "builtin-llm" }] }),
      providerForModel,
      networkFetch: unusedNetworkFetch,
      audit: collectingAudit().logger,
      resolveRootSessionId: (id) => id,
    });
    expect(engine.chain[0]?.judge).toBeInstanceOf(BuiltinLlmJudge);
    expect(engine.chain[0]?.judge?.model).toBe("openai/current-reviewer");
    expect(providerForModel).not.toHaveBeenCalled();
  });

  it("uses the selected provider and exact model, leaving unavailable selections unavailable", async () => {
    const permissionManager = new PermissionManager(join(directory, "permissions.json"));
    const result = reviewer(permissionManager);
    const calls: string[] = [];
    const provider: LLMProvider = {
      vendor: "openai-compatible",
      async *streamTurn(options) {
        calls.push(options.model);
        yield { type: "text_delta", text: '{"level":"high","reason":"explicit risk"}' };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    const model = { vendor: "openai-compatible" as const, model: "configured/model" };
    const providerForModel = vi.fn((): LLMProvider | null => provider);
    const deps = {
      permissionManager, reviewer: result,
      settings: judgeSettings({ chain: [{ id: "selected", provider: "builtin-llm", model }] }),
      providerForModel, networkFetch: unusedNetworkFetch, audit: collectingAudit().logger,
      selectedModelCacheScope: () => ({ provider: model.vendor, baseUrl: "https://selected.example/v1" }),
      resolveRootSessionId: (id: string) => id,
    };
    const engine = wireJudgeAgent(deps);
    const stage = engine.chain[0]!;
    expect(stage.judge?.model).toBe("openai-compatible/configured/model");
    expect((stage.judge as BuiltinLlmJudge).cacheScope).toEqual({
      provider: model.vendor, baseUrl: "https://selected.example/v1",
    });
    await stage.judge!.judge(judgeRequest(), new AbortController().signal);
    expect(providerForModel).toHaveBeenCalledWith(model);
    expect(calls).toEqual(["configured/model"]);
    providerForModel.mockReturnValue(null);
    expect(wireJudgeAgent(deps).chain[0]?.judge).toBeNull();
  });

  it("retains breaker state across rewires and resolves sibling children to one counter", async () => {
    const permissionManager = new PermissionManager(join(directory, "permissions.json"));
    const result = reviewer(permissionManager);
    const audit = collectingAudit();
    const root = "11111111-1111-4111-8111-111111111111";
    const first = "sub-11111111-22222222-2222-4222-8222-222222222222";
    const second = "sub-11111111-33333333-3333-4333-8333-333333333333";
    const resolveRootSessionId = createRootSessionResolver((id) => id === first || id === second ? root : undefined);
    const networkFetch = vi.fn(async () => new Response('{"decision":"deny","rationale":"unsafe effect"}'));
    const deps = {
      permissionManager, reviewer: result,
      settings: judgeSettings(),
      providerForModel: () => null, networkFetch, audit: audit.logger, resolveRootSessionId,
    };
    const engine = wireJudgeAgent(deps);
    const gate = { priorDecision: "undecided" as const, strictMode: false, capabilityGrant: false };
    await resolveJudge(gate, judgeRequest({ sessionId: resolveRootSessionId(first) }), engine);
    const rewired = wireJudgeAgent(deps);
    expect(rewired.breaker).toBe(engine.breaker);
    await resolveJudge(gate, judgeRequest({ sessionId: resolveRootSessionId(second) }), rewired);
    await resolveJudge(gate, judgeRequest({ sessionId: resolveRootSessionId(first) }), rewired);
    expect(rewired.breaker.snapshot(root)).toEqual({ consecutive: 3, total: 3, open: true });
    expect(networkFetch).toHaveBeenCalledTimes(3);
    expect(audit.chained).toHaveLength(3);
  });

  it("records the exact default subscription model identity", () => {
    const permissionManager = new PermissionManager(join(directory, "permissions.json"));
    const result = reviewer(permissionManager);
    result.effectiveSettings.provider = "subscription:codex";
    result.effectiveSettings.model = "default-model";
    const engine = wireJudgeAgent({
      permissionManager, reviewer: result,
      settings: judgeSettings({ chain: [{ id: "builtin", provider: "builtin-llm" }] }),
      providerForModel: () => null, networkFetch: unusedNetworkFetch,
      audit: collectingAudit().logger, resolveRootSessionId: (id) => id,
    });
    expect(engine.chain[0]?.judge?.model).toBe("subscription:codex/default-model");
  });
});
