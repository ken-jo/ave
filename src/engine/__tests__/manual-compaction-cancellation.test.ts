import { describe, expect, it, vi } from "vitest";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { ConversationLoop, type ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { SUMMARY_TEMPLATE_HEADERS_V1 } from "../structured-compact.js";
import {
  makeConversationLoopDeps,
  makeConversationLoopMemoryManager,
} from "./conversation-loop-test-helpers.js";

function manualCompactionFixture() {
  const history: GenericMessage[] = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index} ${"x".repeat(200)}`,
  }));
  const memoryManager = makeConversationLoopMemoryManager(history);
  const memoryReviewer = new MemoryReviewerService({ resolveActiveChatOneShot: () => null });
  const deps = makeConversationLoopDeps({ memoryManager, memoryReviewer });
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "claude";
  llm.vendors.claude = { ...getLlmVendorSettings(llm.vendors, "claude"), model: "chat-model", contextWindow: 4_096 };
  const get = deps.settingsService.get.bind(deps.settingsService);
  deps.settingsService = {
    ...deps.settingsService,
    get: (key: string) => key === "llm" ? llm : get(key as never),
  } as ConversationLoopDeps["settingsService"];
  const loop = new ConversationLoop(deps);
  loop.provider = {
    vendor: "claude",
    async *streamTurn() { yield { type: "message_complete", stopReason: "end_turn" }; },
  };
  loop.history.restore(history);
  const recapStarted = vi.fn<(signal: AbortSignal) => void>();
  vi.spyOn(loop, "generateCompactionText").mockImplementation((_prompt, _systemPrompt, signal) => {
    return new Promise<string>((_resolve, reject) => {
      if (!signal) throw new Error("Compaction generation received no cancellation signal");
      recapStarted(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  return { loop, memoryManager, recapStarted };
}

describe("manual compaction cancellation", () => {
  it.each(["caller", "stop", "transition", "replacement", "workspace"] as const)("interrupts the compact command on %s without publishing completion", async (action) => {
    const { loop, memoryManager, recapStarted } = manualCompactionFixture();
    const before = loop.history.getMessages();
    const caller = new AbortController();
    const onCompactOccurred = vi.fn();
    const onTurnComplete = vi.fn();
    const onTextDelta = vi.fn();
    const pending = loop.runTurn("/compact", { onCompactOccurred, onTurnComplete, onTextDelta }, caller.signal, userKeyboardTurn());
    await vi.waitFor(() => expect(recapStarted).toHaveBeenCalledOnce());
    expect(loop.currentAbortController).not.toBeNull();
    if (action === "caller") caller.abort(new Error("caller cancelled compaction"));
    else if (action === "transition") await loop.runSessionTransition("load-session", () => {});
    else if (action === "replacement") loop.replaceSessionIdentity("41a56357-be2a-42c7-819b-0bf0bc843b39");
    else if (action === "workspace") loop.revokeProjectWork();
    else loop.abortCurrentTurn();
    await expect(pending).resolves.toMatchObject({ stopReason: "interrupted" });
    expect(recapStarted.mock.calls[0]?.[0].aborted).toBe(true);
    expect(onCompactOccurred).not.toHaveBeenCalled();
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(loop.history.getMessages()).toEqual(before);
    expect(memoryManager.sessions.saveCheckpointSnapshot).not.toHaveBeenCalled();
    expect(loop.manualCompactionAbortController).toBeNull();
    expect(loop.currentAbortController).toBeNull();
    expect(loop.isCompacting).toBe(false);
  });

  it.each(["stop", "transition", "replacement", "workspace"] as const)(
    "cancels an idle manual recap on %s without writing a boundary", async (action) => {
      const { loop, memoryManager, recapStarted } = manualCompactionFixture();
      const before = loop.history.getMessages();
      const onCompactOccurred = vi.fn();
      const pending = loop.manualCompact({ onCompactOccurred });
      await vi.waitFor(() => expect(recapStarted).toHaveBeenCalledOnce());
      expect(loop.currentAbortController).toBeNull();
      if (action === "transition") await loop.runSessionTransition("load-session", () => {});
      else if (action === "replacement") loop.replaceSessionIdentity("41a56357-be2a-42c7-819b-0bf0bc843b39");
      else if (action === "workspace") loop.revokeProjectWork();
      else loop.abortCurrentTurn();
      await expect(pending).resolves.toMatchObject({ compacted: false, compactedAt: null, removedMessageCount: 0 });
      expect(recapStarted.mock.calls[0]?.[0].aborted).toBe(true);
      expect(onCompactOccurred).not.toHaveBeenCalled();
      expect(loop.history.getMessages()).toEqual(before);
      expect(memoryManager.sessions.saveCheckpointSnapshot).not.toHaveBeenCalled();
      expect(loop.compactNum).toBe(0);
      expect(loop.manualCompactionAbortController).toBeNull();
      expect(loop.isCompacting).toBe(false);
    },
  );

  it("does not apply an outgoing boundary when the session changes during checkpoint preparation", async () => {
    const { loop, memoryManager } = manualCompactionFixture();
    const outgoingSessionId = loop.sessionId;
    const before = loop.history.getMessages();
    vi.mocked(loop.generateCompactionText).mockResolvedValue(SUMMARY_TEMPLATE_HEADERS_V1.map((header) => `## ${header}\nsummary`).join("\n\n"));
    const snapshotStarted = vi.fn();
    let releaseSnapshot = () => {};
    vi.mocked(memoryManager.sessions.saveCheckpointSnapshot).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
      snapshotStarted();
    }));
    const onCompactOccurred = vi.fn();
    const pending = loop.manualCompact({ onCompactOccurred });
    await vi.waitFor(() => expect(snapshotStarted).toHaveBeenCalledOnce());
    expect(memoryManager.sessions.saveCheckpointSnapshot).toHaveBeenCalledWith(outgoingSessionId, 1, before);
    loop.replaceSessionIdentity("41a56357-be2a-42c7-819b-0bf0bc843b39");
    const incomingHistory: GenericMessage[] = [{ role: "user", content: "incoming session question" }];
    loop.history.clear();
    loop.history.restore(incomingHistory);
    const incomingMessages = loop.history.getMessages();
    releaseSnapshot();
    await expect(pending).resolves.toMatchObject({ compacted: false, compactedAt: null });
    expect(loop.history.getMessages()).toEqual(incomingMessages);
    expect(memoryManager.sessions.saveSessionMetadata).not.toHaveBeenCalled();
    expect(onCompactOccurred).not.toHaveBeenCalled();
    expect(loop.compactNum).toBe(0);
  });

  it("persists an already committed boundary while suppressing completion after a later cancellation", async () => {
    const { loop, memoryManager } = manualCompactionFixture();
    const sessionId = loop.sessionId;
    vi.mocked(loop.generateCompactionText).mockResolvedValue(SUMMARY_TEMPLATE_HEADERS_V1.map((header) => `## ${header}\nsummary`).join("\n\n"));
    const metadataStarted = vi.fn();
    let releaseMetadata = () => {};
    vi.mocked(memoryManager.sessions.saveSessionMetadata).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseMetadata = resolve;
      metadataStarted();
    }));
    const lifecycle = vi.spyOn(loop, "fireLifecycleEvent");
    const onCompactOccurred = vi.fn();
    const pending = loop.manualCompact({ onCompactOccurred });
    await vi.waitFor(() => expect(metadataStarted).toHaveBeenCalledOnce());
    const committedHistory = loop.history.getMessages();
    expect(loop.compactNum).toBe(1);
    loop.abortCurrentTurn();
    releaseMetadata();
    await expect(pending).resolves.toMatchObject({ compacted: true });
    expect(loop.history.getMessages()).toEqual(committedHistory);
    expect(memoryManager.sessions.saveSession).toHaveBeenCalledWith(sessionId, committedHistory);
    expect(onCompactOccurred).not.toHaveBeenCalled();
    expect(lifecycle.mock.calls.some(([event]) => event === "PostCompact")).toBe(false);
  });
});
