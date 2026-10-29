import { describe, expect, it, vi } from "vitest";

import { ConversationLoop, type ConversationLoopDeps } from "../conversation-loop.js";
import { makeConversationLoopDeps, makeConversationLoopMemoryManager } from "./conversation-loop-test-helpers.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

function makeLoop(
  memoryManager: ConversationLoopDeps["memoryManager"],
): ConversationLoop {
  return new ConversationLoop(makeConversationLoopDeps({ memoryManager }));
}

describe("ConversationLoop.branchFromCheckpoint invalid cases", () => {
  it("throws when the requested checkpoint number is not in session metadata", async () => {
    const memoryManager = {
      loadSessionMetadata: vi.fn(() => ({ checkpoints: [] })),
      loadCheckpointSnapshot: vi.fn(() => null),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const loop = makeLoop(memoryManager);

    await expect(loop.branchFromCheckpoint(7)).rejects.toThrow(/Checkpoint #7 not found/);
  });

  it("throws when the checkpoint exists but no pre-compact snapshot was persisted", async () => {
    const memoryManager = {
      loadSessionMetadata: vi.fn(() => ({
        checkpoints: [{ compactNum: 3, messageCountAtTrigger: 2 }],
      })),
      loadCheckpointSnapshot: vi.fn(() => null),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const loop = makeLoop(memoryManager);

    await expect(loop.branchFromCheckpoint(3)).rejects.toThrow(/no snapshot found for checkpoint #3/);
  });

  it("throws when the snapshot is shorter than the checkpoint's messageCountAtTrigger", async () => {
    const memoryManager = {
      loadSessionMetadata: vi.fn(() => ({
        checkpoints: [{ compactNum: 1, messageCountAtTrigger: 4 }],
      })),
      loadCheckpointSnapshot: vi.fn(() => []),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const loop = makeLoop(memoryManager);

    await expect(loop.branchFromCheckpoint(1)).rejects.toThrow(/snapshot length 0 < checkpoint messageCountAtTrigger 4/);
  });
});

describe("ConversationLoop.branchFromCheckpoint summary", () => {
  it("sends the copied summary on the fork's first request", async () => {
    const SOURCE = "abe633f3-a47a-4758-874e-abe9160daf36";
    const snapshot: GenericMessage[] = [
      { role: "user", content: "start the audit" },
      { role: "assistant", content: "auditing" },
      { role: "user", content: "continue" },
    ];
    const base = makeConversationLoopMemoryManager([], SOURCE) as unknown as Record<string, unknown>;
    const metadata = new Map<string, Record<string, unknown>>([[SOURCE, {
      checkpoints: [{
        id: "cp-2", compactNum: 2, messageCountAtTrigger: 3, trigger: "manual",
        triggeredAt: "2026-10-15T00:00:00.000Z", ctxUsageAtTrigger: 0.5, summary: "SUMMARY-FROM-CHECKPOINT",
      }],
    }]]);
    const memoryManager = {
      ...base,
      loadCheckpointSnapshot: vi.fn(() => snapshot),
      rehydrateToolResultArtifacts: vi.fn((_id: string, messages: GenericMessage[]) => messages),
      loadSessionMetadata: vi.fn((id: string) => metadata.get(id) ?? null),
      saveSessionMetadata: vi.fn(async (id: string, meta: Record<string, unknown>) => { metadata.set(id, meta); }),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const requests: StreamTurnParams[] = [];
    const loop = makeLoop(memoryManager);
    (loop as unknown as { provider: LLMProvider }).provider = {
      vendor: "claude",
      async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
        requests.push(input);
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    await loop.resetAndResume(SOURCE);

    const fork = await loop.branchFromCheckpoint(2);
    expect(fork.shouldAutoContinue).toBe(true);
    expect(await loop.loadSession(fork.newSessionId)).toBe(true);
    await loop.runTurn("what did we decide?", undefined, undefined, { ...userKeyboardTurn() });

    const first = requests[0]!;
    expect(first.systemPrompt).not.toContain("SUMMARY-FROM-CHECKPOINT");
    expect(first.messages[0]!.meta?.compactBoundary).toBe(true);
    expect(String(first.messages[0]!.content))
      .toContain("<prior-context-summary>\nSUMMARY-FROM-CHECKPOINT\n</prior-context-summary>");
    expect(first.messages.slice(1, 4).map((m) => m.content)).toEqual(snapshot.map((m) => m.content));
  });
});
