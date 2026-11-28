import { issueUserOwnedBrowserScope } from "../../../permissions/user-owned-browser-scope.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { collectJudgeEvents, judgeRecords, judgeSettings, scriptedStage } from "../../../permissions/judge/__tests__/judge-request-fixture.js";
import { wireJudgeAgent } from "../judge-wiring.js";
import { wireReviewerAgent } from "../reviewer-wiring.js";

let directory: string;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  directory = mkdtempSync(join(tmpdir(), "reviewer-model-audit-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(directory);
});

describe("implicit reviewer decision logging", () => {
  for (const observer of [false, true]) {
    it.each(["llm", "disabled"] as const)(`records %s outcomes in the authoritative ${observer ? "shadow baseline" : "ordinary review"}`, async (mode) => {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setMode("auto");
      const defaults = readPermissionSettings(join(directory, "absent-settings.json")).permissions.reviewer;
      const provider: LLMProvider = {
        vendor: "openai",
        async *streamTurn() {
          yield { type: "text_delta", text: '{"level":"low","reason":"reviewed action"}' };
          yield { type: "message_complete", stopReason: "end_turn" };
        },
      };
      const reviewer = wireReviewerAgent({
        permissionManager: manager,
        readSettings: () => ({ ...defaults, mode }),
        readActiveLlm: () => ({ provider: "openai", model: "selected-reviewer-model" }),
        selectedModel: { label: "openai/selected-reviewer-model", available: true },
        streamProviderFor: () => provider,
        networkFetch: async () => new Response("{}"),
        verdictCachePath: join(directory, "verdicts.jsonl"),
      });
      expect(reviewer.runtimeMode).toBe(mode);
      const events = collectJudgeEvents();

      wireJudgeAgent({
        permissionManager: manager,
        reviewer,
        settings: judgeSettings({
          chain: observer ? [scriptedStage("observer")] : [],
          mode: observer ? "shadow" : "active",
        }),
        providerForModel: () => null,
        networkFetch: async () => new Response('{"decision":"deny","rationale":"shadow observation"}'),
        resolveRootSessionId: (id) => id,
      });
      const result = await manager.dispatchReviewer("bash", {
        sessionId: "reviewer-model-session",
        invocationId: "reviewer-model-invocation",
        source: "builtin", category: "shell", pathFields: [],
        finalInput: { command: "echo reviewed" }, executionCwd: directory,
        allowedDirectories: [directory], sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
      }, undefined, { lane: "foreground-auto" });
      expect(result).toMatchObject(mode === "llm"
        ? { outcome: "fresh", verdict: { level: "low" }, judge: { decision: "allow", applied: true } }
        : { outcome: "unavailable", verdict: { level: "high" }, judge: { decision: "ask", applied: true, source: "fallback", fallback: "unavailable" } });
      const records = judgeRecords(events).filter((record) => record.applied === true);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        mode: "active", applied: true, decision: mode === "llm" ? "allow" : "ask",
        stages: [{ provider: "builtin-llm", outcome: mode === "llm" ? "decided" : "failed" }],
      });
    });
  }
});

it("validates a disabled logical surface before emitting its unavailable decision", async () => {
  const manager = new PermissionManager(join(directory, "surface-permissions.json"));
  const reviewer = wireReviewerAgent({ permissionManager: manager,
    readSettings: () => ({ mode: "disabled", fallbackOnError: "deny" }),
    readActiveLlm: () => ({ provider: "openai", model: "unused-reviewer-model" }),
    streamProviderFor: () => { throw new Error("Disabled review cannot resolve a model"); },
    networkFetch: async () => { throw new Error("Disabled review cannot fetch"); },
    verdictCachePath: join(directory, "surface-verdicts.jsonl") });
  const classify = vi.spyOn(reviewer.classifier, "classify");
  const logical = vi.fn(async () => ({ consistent: true, reason: "Must not run" }));
  manager.setReviewer({ classifier: Object.assign(reviewer.classifier, { reviewUserOwnedSurface: logical }), cache: reviewer.cache });
  const cacheLookup = vi.spyOn(reviewer.cache, "lookup");
  const customFetch = vi.fn(async () => new Response('{"decision":"allow","rationale":"Must not run"}'));
  const events = collectJudgeEvents();

  wireJudgeAgent({ permissionManager: manager, reviewer,
    settings: judgeSettings({ chain: [scriptedStage("custom-reviewer")], mode: "active" }),
    providerForModel: () => null, networkFetch: customFetch, resolveRootSessionId: id => id });
  manager.setUserOwnedSurfaceChoice("surface-session", "browser", "auto");
  const pending = manager.checkDetailed("browser_action", "builtin", "read", undefined, {
    sessionId: "surface-session", trustOrigin: "llm-tool-arg",
    userOwnedBrowser: issueUserOwnedBrowserScope({ kind: "browser-origin", origin: "https://example.test", tabOpener: "user",
      tabId: "tab", documentId: 1, controlGeneration: 1 }, () => true) });
  expect(pending.reviewer?.route).toBe("foreground-auto");
  const input = { sessionId: "surface-session", invocationId: "surface-action", source: "builtin" as const,
    category: "read" as const, pathFields: [], finalInput: { tabId: "tab", action: "read details" },
    executionCwd: directory, allowedDirectories: [directory], sensitivePathsAdjacent: [], trustOrigin: "llm-tool-arg" as const,
    conversationContext: { recentUserMessage: "Read the details in this tab", currentTaskStep: "Read current page details" }, permissionDecision: pending };
  try {
    await expect(manager.dispatchReviewer("browser_action", { ...input, permissionDecision: { ...pending } })).rejects.toThrow("issued surface request");
    await expect(manager.dispatchReviewer("browser_action", { ...input, sessionId: "other-session" })).rejects.toThrow("issued surface action");
    const review = await manager.dispatchReviewer("browser_action", input);
    expect(review).toMatchObject({ outcome: "unavailable", verdict: { level: "high" }, judge: { applied: true, decision: "ask", fallback: "unavailable" } });
    expect(manager.resolveReviewedPermission(pending, review)).toMatchObject({ decision: "ask", reasonCode: "user-owned-surface-human-required" });
    const records = judgeRecords(events).filter((record) => record.applied === true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ mode: "active", applied: true, decision: "ask", fallback: "unavailable",
      stages: [{ provider: "builtin-llm", outcome: "failed" }] });
    expect(classify).not.toHaveBeenCalled();
    expect(logical).not.toHaveBeenCalled();
    expect(cacheLookup).not.toHaveBeenCalled();
    expect(customFetch).not.toHaveBeenCalled();
  } finally { await reviewer.cache.flush(); }
});
