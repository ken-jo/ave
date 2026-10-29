import { vi } from "vitest";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage, LLMVendor, StreamEvent } from "../llm/types.js";
import type { CompactWithBoundaryResult } from "../structured-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { makeConversationPermissionDeps } from "./support/conversation-loop-fixtures.js";

export function makeConversationLoopSettings(
  autoCompact = true,
  model = "claude-sonnet-4-5",
  provider: LLMVendor = "claude",
): ConversationLoopDeps["settingsService"] {
  return {
    get: (key: string) => {
      if (key === "chat") return { systemPrompt: "", autoCompact };
      if (key === "llm") return fakeLlmSettings({ provider, model });
      return {};
    },
    getAll: () => ({}),
    patch: vi.fn(),
    getSecret: () => null,
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  } as unknown as ConversationLoopDeps["settingsService"];
}

export function makeConversationLoopMemoryManager(
  messages: GenericMessage[] | null = [],
  sessionId = "abe633f3-a47a-4758-874e-abe9160daf36",
): ConversationLoopDeps["memoryManager"] {
  const sessions: Record<string, GenericMessage[]> = messages === null ? {} : { [sessionId]: messages };
  return {
    ...makePromptMemorySource(),
    listSessions: () => Object.keys(sessions).map((id) => ({ id, modifiedAt: new Date() })),
    getMemoryIndex: () => "",
    getUserPreferences: () => "",
    loadSession: (id: string) => sessions[id] ?? null,
    loadSessionMetadata: vi.fn(() => null),
    saveSession: vi.fn((id: string, msgs: GenericMessage[]) => {
      sessions[id] = msgs;
    }),
    saveSessionMetadata: vi.fn(),
    appendCheckpoint: vi.fn((_meta: unknown, cp: unknown) => ({ checkpoints: [cp],
    })),
    saveCheckpointSnapshot: vi.fn(),
    listMemoryEntries: () => [],
    saveMemory: vi.fn(),
    deleteMemory: vi.fn(),
    searchMemoryEntries: vi.fn(),
    getMemoryContext: () => "",
    updateUserPreferences: vi.fn(),
  } as unknown as ConversationLoopDeps["memoryManager"];
}

export function makeConversationLoopLongHistory(count = 20): GenericMessage[] {
  const messages: GenericMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i} ${"x".repeat(200)}`,
    });
  }
  return messages;
}

export function makeConversationLoopMemoryReviewer(): NonNullable<ConversationLoopDeps["memoryReviewer"]> {
  return {
    review: async () => "reviewed recap",
  };
}

export function makeConversationLoopDeps(
  overrides: Partial<ConversationLoopDeps> = {},
): ConversationLoopDeps {
  return {
    settingsService: makeConversationLoopSettings(),
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: vi.fn(),
      setOriginSource: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveRolePrompt: vi.fn(),
    } as unknown as ConversationLoopDeps["systemPromptBuilder"],
    inputClassifier: {
      classify: vi.fn().mockReturnValue({ type: "chat" }),
    } as unknown as ConversationLoopDeps["inputClassifier"],
    routeEngine: {
      route: vi.fn().mockReturnValue({ route: "llm" }),
    } as unknown as ConversationLoopDeps["routeEngine"],
    toolRegistry: {
      listAll: () => [],
      getToolCatalogForScope: () => [],
      getToolSchemasForScope: () => [],
      // Model-visible tools exclude app-only tools even when the executable registry includes them.
      getVisibleTools: () => [],
      getModelVisibleTools: () => [],
    } as unknown as ConversationLoopDeps["toolRegistry"],
    memoryManager: makeConversationLoopMemoryManager(),
    memoryReviewer: makeConversationLoopMemoryReviewer(),
    networkFetch: unusedNetworkFetch,
    ...makeConversationPermissionDeps(),
    ...overrides,
  };
}

export function makeConversationTurnProvider() {
  return {
    vendor: "claude" as const,
    streamTurn: async function* () {
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "message_complete" as const };
    },
  };
}

// ASCII filler keeps token thresholds predictable; Hangul uses a different estimator weight.
export function makeHistoryExceedingEstimateThreshold(threshold: number): GenericMessage[] {
  const charsPerMsg = (threshold / 2 + 500) * 4;
  return [
    { role: "user", content: "a".repeat(Math.ceil(charsPerMsg)) },
    { role: "assistant", content: "b".repeat(Math.ceil(charsPerMsg)) },
  ];
}

// Include the boundary summary and preserved tail consumed by the loop.
export function makeSyntheticCompactResult(
  originalMessages: GenericMessage[],
): CompactWithBoundaryResult {
  const boundaryStub: GenericMessage = {
    role: "user",
    content: "[compact boundary stub]",
    meta: {
      compactBoundary: true,
      compactNum: 1,
      checkpointMeta: {
        removedMessages: Math.max(0, originalMessages.length - 2),
        freedTokens: 1_000,
        compactNum: 1,
        trigger: "auto-compact",
      },
    },
  };
  const recent = originalMessages.slice(-2);
  return {
    status: CompressionStatus.SUMMARIZED,
    boundary: {
      id: "test-boundary-1",
      compactNum: 1,
      summary: { goal: "test", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
      toolBoundaryLedger: [],
      pinnedArtifacts: [],
      createdAt: new Date().toISOString(),
    } as unknown as NonNullable<CompactWithBoundaryResult["boundary"]>,
    newHistory: [boundaryStub, ...recent],
    removedCount: originalMessages.length - recent.length - 1,
    estimatedAfter: 100,
    truncatedCount: 0,
  };
}

export function endTurnScript(text: string): StreamEvent[][] {
  return [
    [
      { type: "text_delta", text },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ];
}
