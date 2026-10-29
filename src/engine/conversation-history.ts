import { normalizeToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";

import type { GenericMessage } from "./llm/types.js";
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { trimOversizedToolResult } from "../shared/tool-result-trim.js";
import { isBoundedSkillReadResult } from "../main/skill-overlay.js";
import { normalizeLocalUserContentParts } from "../main/subscription-attachment-input.js";
import { noteToolResultsReturnedToModel } from "../tools/host-terminal-turn.js";

export interface ConversationHistoryOptions {
  maxMessages?: number;
}

/** Appended rows are addressable through meta.messageId without a presence check. */
export type StoredMessage = GenericMessage & {
  meta: NonNullable<GenericMessage["meta"]> & { messageId: string };
};

const DEFAULT_MAX_MESSAGES = Number.POSITIVE_INFINITY;

export class ConversationHistory {
  private messages: GenericMessage[] = [];
  private readonly maxMessages: number;

  constructor(options?: ConversationHistoryOptions) {
    // Default history is unbounded; token compaction owns context reduction.
    this.maxMessages = normalizeMaxMessages(options?.maxMessages);
  }

  append(message: GenericMessage): StoredMessage {
    return this.appendAt(message, this.messages.length);
  }

  /** Insert a completed result in its assistant's call order, even when siblings finish out of order. */
  appendToolResult(message: Extract<GenericMessage, { role: "tool_result" }>): StoredMessage {
    let assistantIndex = this.messages.length - 1;
    while (assistantIndex >= 0 && this.messages[assistantIndex].role === "tool_result") assistantIndex--;
    const assistant = this.messages[assistantIndex];
    const calls = assistant?.role === "assistant" ? assistant.toolCalls ?? [] : [];
    const order = calls.findIndex((call) => call.id === message.toolUseId);
    let index = this.messages.length;
    if (order >= 0) {
      for (let i = assistantIndex + 1; i < this.messages.length; i++) {
        const sibling = this.messages[i];
        if (sibling.role === "tool_result" && calls.findIndex((call) => call.id === sibling.toolUseId) > order) {
          index = i;
          break;
        }
      }
    }
    return this.appendAt(message, index);
  }

  /** The one point where a row enters the history. A tool result entering it during a user turn marks that turn as having fed the model
   * content the user did not type (host terminal commands then need a fresh card), whichever path appended it. */
  private appendAt(message: GenericMessage, index: number): StoredMessage {
    const stored = stampMessageId(stampCreatedAt(applyToolResultCap(message)));
    if (stored.role === "tool_result") noteToolResultsReturnedToModel();
    this.messages.splice(index, 0, stored);
    this.trim();
    this.appendObserver?.(stored);
    return stored;
  }

  private appendObserver: ((message: StoredMessage) => void) | undefined;

  /** The single append observer may schedule writes, never throw or mutate history. */
  setAppendObserver(observer: ((message: StoredMessage) => void) | undefined): void {
    this.appendObserver = observer;
  }

  /** Typed summary attachment is a no-op without an assistant row.
   * Shared row references make later attachment visible through earlier array snapshots. */
  attachTurnSummaryToLastAssistant(
    turnSummary: NonNullable<NonNullable<GenericMessage["meta"]>["turnSummary"]>,
  ): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant") {
        m.meta = { ...(m.meta ?? {}), turnSummary };
        return true;
      }
    }
    return false;
  }

  /** Return a shallow array copy; later row metadata mutations remain visible to snapshots. */
  getMessages(): GenericMessage[] {
    return [...this.messages];
  }

  /** Roll back an injected row by identity without truncating later unrelated history. */
  removeExact(message: GenericMessage): boolean {
    const index = this.messages.indexOf(message);
    if (index < 0) return false;
    this.messages.splice(index, 1);
    return true;
  }

  // Compaction replaces row identities; remove every clone when rolling back an injection.
  removeByHostInjectionId(hostInjectionId: string): number {
    const before = this.messages.length;
    this.messages = this.messages.filter(
      (message) => message.meta?.hostInjectionId !== hostInjectionId,
    );
    return before - this.messages.length;
  }

  repairToolPairInvariant(): { removedMessages: number; removedToolCalls: number } {
    const { messages, removedMessages, removedToolCalls } = normalizeToolPairInvariant(this.messages);
    if (removedMessages > 0 || removedToolCalls > 0) {
      this.messages = messages;
    }
    return { removedMessages, removedToolCalls };
  }

  clear(): void {
    this.messages = [];
  }

  restore(messages: GenericMessage[]): void {
    /** Preserve original timestamps and re-derive tool caps from untrusted disk content.
     * Discard remote or malformed user binary parts before any provider replay. */
    const capped: GenericMessage[] = [];
    // Re-mint duplicate IDs so row lookup cannot silently return the wrong row.
    const seenIds = new Set<string>();
    for (const message of messages) {
      const normalized = normalizeRestoredUserContent(
        applyToolResultCap(message, { recompute: true }),
      );
      // Mint missing legacy IDs while retaining existing IDs across reload.
      if (normalized) capped.push(stampMessageId(normalized, seenIds));
    }
    this.messages = normalizeToolPairInvariant(capped).messages;
    this.trim();
  }

  truncate(count: number): void {
    if (count < 0) return;
    if (count >= this.messages.length) return;
    this.messages = this.messages.slice(0, count);
  }

  get length(): number {
    return this.messages.length;
  }

  /** Default history has no count cap; token compaction must not silently evict transcript rows. */
  getCapacityRemaining(): number {
    if (!Number.isFinite(this.maxMessages)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.maxMessages - this.messages.length);
  }

  getLastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") return msg.content;
    }
    return "";
  }

  /** Non-empty reasoning counts as spend even when the last assistant text is empty. */
  getLastAssistantThought(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") return msg.thought ?? "";
    }
    return "";
  }

  private trim(): void {
    if (Number.isFinite(this.maxMessages) && this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
      this.messages = normalizeToolPairInvariant(this.messages, { preserveOpenToolTail: true }).messages;
    }
  }
}

interface NormalizeToolPairOptions {
  preserveOpenToolTail?: boolean;
}

/** Stamp missing creation times at append; preserve timestamps already supplied. */
function stampCreatedAt(message: GenericMessage): GenericMessage {
  if (message.meta?.createdAt !== undefined) return message;
  return { ...message, meta: { ...(message.meta ?? {}), createdAt: Date.now() } };
}

/** Preserve supplied row IDs and mint missing in-memory IDs randomly; file legacy IDs are deterministic.
 * UUIDs are structural keys and must survive content redaction unchanged. */
function stampMessageId(message: GenericMessage, taken?: Set<string>): StoredMessage {
  const existing = message.meta?.messageId;
  // Only non-empty, unique string IDs are usable after restore.
  const usable =
    typeof existing === "string" && existing.length > 0 && !(taken?.has(existing) ?? false);
  const messageId = usable ? existing : createDlpSafeUuid();
  taken?.add(messageId);
  return { ...message, meta: { ...(message.meta ?? {}), messageId } };
}

function normalizeMaxMessages(maxMessages: number | undefined): number {
  if (maxMessages === undefined) return DEFAULT_MAX_MESSAGES;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) return DEFAULT_MAX_MESSAGES;
  return Math.floor(maxMessages);
}

/** Mark oversized tool results without replacing raw inspection content.
 * Restore re-measures and strips forged truncation or serializedStub claims; append is idempotent. */
function applyToolResultCap(
  message: GenericMessage,
  opts?: { recompute?: boolean },
): GenericMessage {
  if (message.role !== "tool_result") return message;
  if (message.meta?.outputArtifact !== undefined) {
    const outputArtifact = normalizeToolOutputArtifactInfo(message.meta.outputArtifact);
    const { outputArtifact: _oldArtifact, ...meta } = message.meta;
    message = { ...message, meta: { ...meta, ...(outputArtifact ? { outputArtifact } : { outputArtifactUnavailable: true as const }) } };
  }
  if (!opts?.recompute && message.meta?.truncated !== undefined) return message;
  // Host-bounded skill instructions must not be clipped; also strip forged truncation flags.
  const trimmed = isBoundedSkillReadResult(message)
    ? { truncated: undefined }
    : trimOversizedToolResult(message.content);
  if (trimmed.truncated === undefined) {
    if (!opts?.recompute) return message;
    // Sub-cap restored content still needs forged host metadata removed.
    if (message.meta?.truncated === undefined && message.meta?.serializedStub === undefined) {
      return message;
    }
    const { truncated: _t, serializedStub: _s, ...cleanMeta } = message.meta ?? {};
    return { ...message, meta: cleanMeta };
  }
  const { serializedStub: _s, ...preservedMeta } = message.meta ?? {};
  return {
    ...message,
    meta: { ...preservedMeta, truncated: trimmed.truncated },
  };
}

/** Apply the untrusted-user attachment policy while preserving trusted tool results. */
function normalizeRestoredUserContent(message: GenericMessage): GenericMessage | null {
  if (message.role !== "user" || typeof message.content === "string") return message;
  const content = normalizeLocalUserContentParts(message.content);
  return content ? { ...message, content } : null;
}

export function normalizeToolPairInvariant(
  messages: GenericMessage[],
  options: NormalizeToolPairOptions = {},
): {
  messages: GenericMessage[];
  removedMessages: number;
  removedToolCalls: number;
} {
  const futureResultCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "tool_result") {
      futureResultCounts.set(message.toolUseId, (futureResultCounts.get(message.toolUseId) ?? 0) + 1);
    }
  }

  const availableToolCalls = new Set<string>();
  const normalized: GenericMessage[] = [];
  let removedMessages = 0;
  let removedToolCalls = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const isOpenToolTail =
        options.preserveOpenToolTail === true &&
        messages.slice(i + 1).every((next) => next.role === "tool_result");
      const pairedToolCalls = isOpenToolTail
        ? message.toolCalls
        : message.toolCalls.filter((toolCall) => (futureResultCounts.get(toolCall.id) ?? 0) > 0);
      removedToolCalls += message.toolCalls.length - pairedToolCalls.length;

      if (pairedToolCalls.length > 0) {
        for (const toolCall of pairedToolCalls) {
          availableToolCalls.add(toolCall.id);
        }
        normalized.push({ ...message, toolCalls: pairedToolCalls });
        continue;
      }

      const { toolCalls: _toolCalls, ...withoutToolCalls } = message;
      const hasVisibleAssistantPayload =
        withoutToolCalls.content.length > 0 ||
        Boolean(withoutToolCalls.thought && withoutToolCalls.thought.length > 0) ||
        Boolean(withoutToolCalls.thinkingBlocks && withoutToolCalls.thinkingBlocks.length > 0);
      if (hasVisibleAssistantPayload) {
        normalized.push(withoutToolCalls);
      } else {
        removedMessages += 1;
      }
      continue;
    }

    if (message.role === "tool_result") {
      const count = futureResultCounts.get(message.toolUseId) ?? 0;
      if (count <= 1) {
        futureResultCounts.delete(message.toolUseId);
      } else {
        futureResultCounts.set(message.toolUseId, count - 1);
      }
      if (availableToolCalls.has(message.toolUseId)) {
        normalized.push(message);
        availableToolCalls.delete(message.toolUseId);
      } else {
        removedMessages += 1;
      }
      continue;
    }

    normalized.push(message);
  }

  return {
    messages: normalized,
    removedMessages,
    removedToolCalls,
  };
}
