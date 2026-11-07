// No user content in logs: a session's new title is logged by id and length, never by its text.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => h.logger),
}));

import { PostTurnHookChain } from "../post-turn-hook-chain.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { SettingsService } from "../../data/settings-store.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

describe("PostTurnHookChain title log", () => {
  it("logs the session id and title length, not the title", async () => {
    const memoryManager = {
      sessions: {
        saveSession: vi.fn(),
        saveSessionMetadata: vi.fn(),
        loadSessionMetadata: vi.fn().mockReturnValue(null),
      },
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => (key === "llm" ? fakeLlmSettings() : { systemPrompt: "", autoCompact: false })),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });
    const output = "정리 완료입니다.<title>환자 김민수 진료 기록</title>";

    await chain.run({
      sessionId: "session-title-log",
      messages: [{ role: "user", content: "정리해줘" }, { role: "assistant", content: output }],
      input: "정리해줘",
      output,
      toolCalls: [],
      route: "chat",
    });

    const logged = JSON.stringify([...h.logger.info.mock.calls, ...h.logger.warn.mock.calls, ...h.logger.debug.mock.calls]);
    expect(logged).toContain("session-title-log");
    expect(logged).not.toContain("김민수");
    expect(h.logger.info).toHaveBeenCalledWith("update-title: session %s title set (%d chars)", "session-title-log", "환자 김민수 진료 기록".length);
  });
});
