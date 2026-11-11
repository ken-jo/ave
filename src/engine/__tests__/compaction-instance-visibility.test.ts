import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import { SessionRepository } from "../../memory/session-repository.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { ConversationLoop, type ConversationLoopDeps } from "../conversation-loop.js";
import { createProvider, secretKeyFor } from "../llm/provider-factory.js";
import type { GenericMessage, LLMProvider, ProviderConfig, StreamTurnParams } from "../llm/types.js";
import { SUMMARY_TEMPLATE_HEADERS_V1 } from "../structured-compact.js";
import { systemSubagentModelOptions } from "../system-subagent-route.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";

vi.mock("../llm/provider-factory.js", async (original) => ({
  ...await original<typeof import("../llm/provider-factory.js")>(),
  createProvider: vi.fn(),
}));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ave-compaction-visibility-"));
  vi.stubEnv("AVE_HOME", home);
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(home);
});

describe("hidden compaction instance persistence", () => {
  it.each([false, true])("retains only real conversation sessions when a separate route is selected=%s", async (selected) => {
    const llm = structuredClone(DEFAULT_SETTINGS.llm);
    llm.provider = "openai";
    llm.vendors.openai = {
      ...getLlmVendorSettings(llm.vendors, "openai"),
      model: "chat-model", baseUrl: "https://chat.example.test/v1", contextWindow: 16_000,
    };
    llm.vendors.ollama = {
      ...getLlmVendorSettings(llm.vendors, "ollama"),
      model: "recap-model", baseUrl: "http://localhost:11434", contextWindow: 16_000,
    };
    const secrets = new Map([
      [secretKeyFor("openai"), "chat-route-secret"],
      [secretKeyFor("ollama"), "recap-route-secret"],
    ]);
    const baseDeps = makeConversationLoopDeps();
    const get = baseDeps.settingsService.get.bind(baseDeps.settingsService);
    const settingsService = {
      ...baseDeps.settingsService,
      get: (key: string) => key === "llm" ? llm : get(key as never),
      getSecret: async (key: string) => secrets.get(key) ?? null,
    } as ConversationLoopDeps["settingsService"];
    if (selected) {
      const choices = await systemSubagentModelOptions(settingsService);
      const recapChoice = choices.find((choice) => choice.vendor === "ollama" && choice.model === "recap-model");
      if (!recapChoice) throw new Error("Recap route fixture is unavailable");
      llm.compactionModelSelection = recapChoice;
    }
    const calls: Array<{ config: ProviderConfig; params: StreamTurnParams }> = [];
    const recap = SUMMARY_TEMPLATE_HEADERS_V1.map((header) => `## ${header}\nPreserved ${header}`).join("\n\n");
    vi.mocked(createProvider).mockImplementation((config): LLMProvider => ({
      vendor: config.vendor,
      async *streamTurn(params) {
        calls.push({ config, params });
        yield { type: "text_delta", text: recap };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    }));
    const memoryManager = new MemoryManager({ aveDir: home });
    const subagentHome = openFeatureNamespace("subagent").dir;
    const sideChatHome = openFeatureNamespace("side-chat").dir;
    const subagentSessions = new SessionRepository({ aveDir: subagentHome });
    const sideChatSessions = new SessionRepository({ aveDir: sideChatHome });
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager,
      settingsService,
      memoryReviewer: new MemoryReviewerService({ resolveActiveChatOneShot: () => null }),
    }));
    await loop.whenProviderReady();
    const sessionId = loop.getSessionId();
    const visibleChildId = "d649ec71-85c6-420d-a5c9-d9ecfe6cc03a";
    const sideChatId = "184c7218-9350-427f-83dc-358459a898d1";
    const history: GenericMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Conversation detail ${index}. ${"Keep this conversation context. ".repeat(60)}`,
    }));
    loop.history.restore(history);
    await memoryManager.sessions.saveSession(sessionId, history);
    await memoryManager.sessions.saveSessionMetadata(sessionId, { sessionKind: "main", title: "Main conversation" });
    await subagentSessions.saveSession(visibleChildId, [{ role: "assistant", content: "Visible child result" }]);
    await subagentSessions.saveSessionMetadata(visibleChildId, {
      sessionKind: "subagent", originSessionId: sessionId, spawnId: "visible-child", subAgentTitle: "Visible child",
    });
    await sideChatSessions.saveSession(sideChatId, [{ role: "user", content: "Side conversation" }]);
    expect(memoryManager.sessions.listSessions({ kind: "all" }).map((entry) => entry.id)).toEqual([sessionId]);
    expect(subagentSessions.listSubAgentSessionsForOrigin(sessionId).map((entry) => entry.childSessionId)).toEqual([visibleChildId]);
    const onCompactOccurred = vi.fn();

    const result = await loop.manualCompact({ onCompactOccurred });

    expect(result.compacted).toBe(true);
    expect(onCompactOccurred).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({ tools: [], model: selected ? "recap-model" : "chat-model" });
    expect(calls[0]?.config).toMatchObject({
      vendor: selected ? "ollama" : "openai",
      apiKey: selected ? "recap-route-secret" : "chat-route-secret",
    });
    const liveHistory = loop.history.getMessages();
    await vi.waitFor(() => expect(memoryManager.sessions.loadSession(sessionId)).toEqual(liveHistory));
    const reopenedMain = new SessionRepository({ aveDir: home });
    const reopenedChildren = new SessionRepository({ aveDir: subagentHome });
    const reopenedSideChat = new SessionRepository({ aveDir: sideChatHome });
    expect(reopenedMain.listSessions({ kind: "all" }).map((entry) => entry.id)).toEqual([sessionId]);
    expect(reopenedChildren.listSessions({ kind: "all" }).map((entry) => entry.id)).toEqual([visibleChildId]);
    expect(reopenedSideChat.listSessions({ kind: "all" }).map((entry) => entry.id)).toEqual([sideChatId]);
    expect(reopenedChildren.listSubAgentSessionsForOrigin(sessionId).map((entry) => entry.childSessionId)).toEqual([visibleChildId]);
    expect(reopenedMain.loadSessionMetadata(sessionId)?.checkpoints).toHaveLength(1);
    expect(liveHistory.filter((message) => message.meta?.compactBoundary)).toHaveLength(1);
    expect(liveHistory.some((message) => message.meta?.compactBoundary && String(message.content).includes("Preserved Goal"))).toBe(true);
    expect(liveHistory.every((message) => message.meta?.subAgentReport === undefined)).toBe(true);
  });
});
