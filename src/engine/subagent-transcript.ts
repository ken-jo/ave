// Build child transcript snapshots with the shared renderer reducers outside the main stream.
// Mask results, thoughts, and text here; executor inputs arrive already masked.
import { maskSensitiveData } from "../audit/dlp-filter.js";
import {
  applyReasoningDelta,
  applyToolStart,
  applyToolEnd,
  dropPendingLlmStatusAssistant,
  upsertStreamingReasoning,
  finalizeStreamingReasoning,
  upsertPermissionReview,
  upsertStreamingAssistant,
  finalizeStreamingAssistant,
  type ChatEntry,
} from "../lib/chat-stream-state.js";
import { formatLlmStatusMessage } from "../lib/llm-status-message.js";
import type { ToolCallMeta } from "../tools/executor.js";
import type { PermissionReviewEvent } from "../shared/permission-review-status.js";
import type { McpUiPayload } from "../mcp/types.js";
import type { FallbackStatus } from "./llm/vercel/fallback-chain.js";
import type { TurnCallbacks } from "./turn/types.js";

type AssistantRound = Parameters<NonNullable<TurnCallbacks["onAssistantRound"]>>[0];

export class SubAgentTranscriptAccumulator {
  private entries: ChatEntry[] = [];
  // Mask accumulated reasoning, never individual deltas: secrets can span chunk boundaries.
  // Reset raw accumulation at each round boundary.
  private roundReasoning = "";

  snapshot(): ChatEntry[] {
    return this.entries;
  }

  onToolStart(name: string, input: Record<string, unknown>, meta: ToolCallMeta): void {
    // Executor inputs are already masked; masking again can corrupt redacted text.
    this.entries = applyToolStart(dropPendingLlmStatusAssistant(this.entries), {
      groupId: meta.groupId,
      toolUseId: meta.toolUseId,
      name,
      displayOrder: meta.displayOrder,
      input,
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.category ? { category: meta.category } : {}),
      ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
      ...(meta.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
    });
  }

  onToolEnd(
    _name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: McpUiPayload | undefined,
    durationMs: number,
  ): void {
    // Mask result text and server titles before persistence; preserve structural IDs and URIs.
    // Keep host-minted generationId so transcript cards resolve their backend.
    const storedUiPayload: McpUiPayload | undefined = uiPayload
      ? {
          ...uiPayload,
          ...(uiPayload.title !== undefined
            ? { title: maskSensitiveData(uiPayload.title).masked }
            : {}),
        }
      : undefined;
    this.entries = applyToolEnd(dropPendingLlmStatusAssistant(this.entries), {
      groupId: meta.groupId,
      toolUseId: meta.toolUseId,
      result: maskSensitiveData(result).masked,
      isError,
      ...(storedUiPayload ? { uiPayload: storedUiPayload } : {}),
      durationMs,
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.category ? { category: meta.category } : {}),
      ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
      ...(meta.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
      ...(meta.executionPlan !== undefined
        ? { executionPlan: meta.executionPlan }
        : {}),
    });
  }

  onPermissionReview(event: PermissionReviewEvent): void {
    this.entries = upsertPermissionReview(dropPendingLlmStatusAssistant(this.entries), {
      status: event.status,
      toolName: event.toolName,
      groupId: event.groupId,
      toolUseId: event.toolUseId,
      ...(event.toolCategory ? { toolCategory: event.toolCategory } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(event.displayOrder !== undefined ? { displayOrder: event.displayOrder } : {}),
      ...(event.verdictLevel ? { verdictLevel: event.verdictLevel } : {}),
      ...(event.reason ? { reason: maskSensitiveData(event.reason).masked } : {}),
      ...(event.approvalPurpose ? { approvalPurpose: event.approvalPurpose } : {}),
    });
  }

  /** Show live reasoning while the child thinks, then replace it with the completed round thought. */
  onReasoningDelta(delta: string): void {
    if (!delta) return;
    this.roundReasoning += delta;
    const masked = maskSensitiveData(this.roundReasoning).masked;
    if (!masked) return;
    this.entries = applyReasoningDelta(this.entries, masked);
  }

  // Retry status yields to real reasoning, text, tool, or permission-review content.
  onLlmStatus(status: FallbackStatus): boolean {
    const message = formatLlmStatusMessage(status);
    if (!message) return false;
    const next = upsertStreamingAssistant(this.entries, message, "status");
    if (next === this.entries) return false;
    this.entries = next;
    return true;
  }

  // Terminal snapshots must clear status-only entries because no later stream frame will replace them.
  finish(): boolean {
    const next = dropPendingLlmStatusAssistant(this.entries);
    if (next === this.entries) return false;
    this.entries = next;
    return true;
  }

  /** Finalize each round reasoning and text through DLP before adding transcript entries. */
  onAssistantRound(
    thought: string,
    text: string,
    stopReason: AssistantRound["stopReason"],
    hasToolCalls: AssistantRound["hasToolCalls"],
  ): void {
    this.roundReasoning = "";
    this.entries = dropPendingLlmStatusAssistant(this.entries);
    const maskedThought = thought ? maskSensitiveData(thought).masked : "";
    if (maskedThought) {
      this.entries = upsertStreamingReasoning(this.entries, maskedThought);
    }
    // Clear live reasoning even when final thought is empty, or its spinner never stops.
    this.entries = finalizeStreamingReasoning(this.entries, maskedThought);
    const maskedText = text ? maskSensitiveData(text).masked : "";
    if (maskedText) {
      this.entries = upsertStreamingAssistant(this.entries, maskedText);
      // Preserve round completion boundaries; child transcripts have no turn_summary carrier.
      const phase = stopReason === "end_turn" && !hasToolCalls ? "final" : "work";
      this.entries = finalizeStreamingAssistant(this.entries, maskedText, {
        phase,
        overrideText: maskedText,
      });
    }
  }
}
