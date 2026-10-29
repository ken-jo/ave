import type {
  ApprovalPurposeSuggestion,
  RiskLevel,
  PermissionReviewStatus,
  ToolCategory,
  ToolSource,
} from "../shared/permission-review-status.js";
import { isLLMVendor, type LLMVendor } from "../shared/llm-vendor-defaults.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { McpUiPayload } from "../mcp/types.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import { isExternalSurfaceInputOrigin } from "../shared/chat-origin.js";
import { t } from "../i18n/index.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import { parseResolvedModelPricing, type ModelUsageSegment } from "../shared/model-pricing.js";

type TokenUsageSegment = ModelUsageSegment<LLMVendor>;

export type CheckpointTrigger = "auto-compact" | "manual";

export const EMPTY_ASSISTANT_RESPONSE_TEXT = t("be_chatStreamState.emptyAssistantResponse");

export type ChatStreamEvent = {
  type: string;
  streamId?: number;
  sessionId?: string;
  sendRequestId?: string;
  text?: string;
  origin?: string;
  /** Bind durable history ids so row actions do not depend on mutable transcript positions. */
  messageId?: string;
  thought?: string;
  name?: string;
  error?: string;
  systemNotice?: "context-error" | "stream-error";
  result?: string;
  isError?: boolean;
  cancelled?: boolean;
  input?: Record<string, unknown>;
  groupId?: string;
  toolUseId?: string;
  displayOrder?: number;
  reviewStatus?: PermissionReviewStatus;
  toolCategory?: ToolCategory;
  source?: ToolSource;
  pluginId?: string;
  mcpServerId?: string;
  executionPlan?: HostShellExecutionPlanAuditProjection;
  verdictLevel?: RiskLevel;
  approvalPurpose?: ApprovalPurposeSuggestion;
  roundIndex?: number;
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  endedByEndTurn?: true;
  hasToolCalls?: boolean;
  removedMessages?: number;
  freedTokens?: number;
  /** Use actual post-compact tokens when present, otherwise subtract freed tokens from the last estimate. */
  estimatedAfter?: number;



  triggerSource?: "estimate" | "context-tokens" | "manual" | "force-recover" | "rate-limit";
  /** Exhausted recovery requires a persistent manual-action banner; compaction can no longer reduce context. */
  recoveryExhausted?: true;
  estimatedBefore?: number;
  preflight?: number;
  trigger?: CheckpointTrigger;
  summary?: string;
  compactNum?: number;



  compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
  truncatedDir?: string;
  /** Batch provenance distinguishes child reports from ordinary queued guidance. */
  subAgentReport?: { title?: string };
  route?: "command";
  mode?: ExecutionMode;
  phase?: "attempt" | "retry" | "fallback";
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  from?: string;
  to?: string;
  reason?: string;
  uiPayload?: McpUiPayload;
  /** Emit tool duration on every terminal path, including denial and rate limiting. */
  durationMs?: number;
  /** Emit one aggregate footer after done; cumulative tool time may be zero on aborted turns. */
  turnDurationMs?: number;
  toolCount?: number;
  cumulativeToolMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Fresh input sums input minus cache reads/writes; projected next-request input remains a separate context value. */
  freshInputTokens?: number;



  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  vendorProvider?: LLMVendor;
  vendorModel?: string;
  usageByModel?: TokenUsageSegment[];
  subscriptionUsage?: SubscriptionUsageTelemetry[];
  breakdown?: Record<string, { count: number; ms: number }>;
};

export type ToolEntryItem = {
  toolUseId: string;
  name: string;
  displayOrder: number;
  /** Cancelled is distinct from error so user stops cannot inherit failure styling or group error state. */
  status: "running" | "done" | "error" | "cancelled";
  input?: Record<string, unknown>;
  result?: string;
  source?: ToolSource;
  category?: ToolCategory;
  pluginId?: string;
  mcpServerId?: string;
  executionPlan?: HostShellExecutionPlanAuditProjection;
  uiPayload?: McpUiPayload;
  /** Duration is absent while running and populated on completion. */
  durationMs?: number;
  /** Use start time for live elapsed display, then replace it with final duration. */
  startedAt?: number;
  /** Keep only a bounded live output tail; completion replaces it with the final result. */
  liveOutput?: string;
};

export const LIVE_TOOL_OUTPUT_TAIL_CHARS = 16 * 1024;

function applyToolOutput(
  entries: ChatEntry[],
  payload: { groupId: string; toolUseId: string; text: string },
): ChatEntry[] {
  if (payload.text.length === 0) return entries;
  const groupIdx = findLastIdx(
    entries,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  if (groupIdx < 0) return entries;
  const group = entries[groupIdx] as ToolGroupEntry;
  const toolIdx = group.tools.findIndex(
    (tool: ToolEntryItem) => tool.toolUseId === payload.toolUseId && tool.status === "running",
  );
  if (toolIdx < 0) return entries;
  const tool = group.tools[toolIdx]!;
  const combined = (tool.liveOutput ?? "") + payload.text;
  const liveOutput = combined.length > LIVE_TOOL_OUTPUT_TAIL_CHARS
    ? combined.slice(combined.length - LIVE_TOOL_OUTPUT_TAIL_CHARS)
    : combined;
  const next = [...entries];
  next[groupIdx] = {
    ...group,
    tools: group.tools.map((entry: ToolEntryItem, index: number) =>
      index === toolIdx ? { ...entry, liveOutput } : entry),
  };
  return next;
}

export type ChatEntry =
  | {
      kind: "user";
      text: string;
      /** External-origin badges are live display state; message bodies still persist normally. */
      origin?: string;
      injectHint?: "queue" | "interrupt" | "sub-agent";
      subAgentTitle?: string;
      createdAt?: number;
      /** Use durable row ids for rewind, edit, and fork; compaction invalidates positions. Only non-history entries lack ids. */
      messageId?: string;
      /** Only explicitly pending optimistic echoes may claim announced row ids; guidance and restored rows must never absorb them. This renderer-local marker is never persisted. */
      awaitingHostId?: true;
      /** Restored unanswered questions belong to interrupted prior runs; this marker is display-only. */
      restored?: true;
    }
  | {
      kind: "reasoning";
      text: string;
      streaming?: boolean;
      createdAt?: number;
      lastDeltaAt?: number;
      /** Measure thinking from first to last thinking delta, not answer finalization; replay has no reliable end time. */
      durationMs?: number;
    }
  | {
      kind: "assistant";
      text: string;
      streaming?: boolean;
      route?: "command";
      phase?: "status" | "work" | "final";
      messageId?: string;
      createdAt?: number;
      systemNotice?: "context-error" | "stream-error" | "operation-error";
      /** Renderer-local target for a refused operation; never persisted as model output. */
      noticePaneTabId?: string;
      terminalError?: true;
      interrupted?: boolean;
      interruptedBy?: "host-exit";
      /** Only disk replay marks restored entries so old system notices do not appear as fresh errors; never persist this display state. */
      restored?: boolean;
    }
  // Keep reviewer entries as audit history; attach them to matching tools and render standalone only until the tool exists.
  | {
      kind: "permission_review";
      status: PermissionReviewStatus;
      toolName: string;
      toolCategory?: ToolCategory;
      source?: ToolSource;
      groupId: string;
      toolUseId: string;
      displayOrder: number;
      createdAt?: number;
      verdictLevel?: RiskLevel;
      reason?: string;
      approvalPurpose?: ApprovalPurposeSuggestion;
    }
  | { kind: "tool_group"; groupId: string; groupIds: string[]; status: "running" | "done" | "error"; tools: ToolEntryItem[] }
  | {
      kind: "ask_user_answer";
      sourceToolUseId: string;
      dismissed?: boolean;
      rows: Array<{ label: string; value: string }>;
    }
  | { kind: "system"; text: string }
  // Compaction checkpoints retain session identity unless the user explicitly branches.
  | {
      kind: "checkpoint";
      trigger?: CheckpointTrigger;
      removedMessages: number;
      freedTokens: number;
      summary?: string;
      compactNum?: number;



      compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
      truncatedDir?: string;
    }

  | {
      kind: "session_resume";
      preambleChars: number;
    }
  // Post-compact context estimates are not provider billing usage; replay must not synthesize them.
  | {
      kind: "context_usage";
      tokensIn: number;
      source: "compact-estimate";
    }

  // Keep imported trigger prompts as provenance markers; normal chat entries carry assistant output and usage.

  // Do not flatten isolated trigger prompts into user-authored messages or erase their origin.
  | {
      kind: "imported_trigger";
      sessionId: string;
      source: string;
      prompt: string;
      summary: string;
      toolCallCount: number;
      importedAt: string;
    }
  // Persist aggregate footers so turn totals survive reload.
  | {
      kind: "turn_summary";
      endedByEndTurn?: true;
      turnDurationMs: number;
      toolCount: number;
      /** Zero cumulative tool time means unavailable; hide that footer slice. */
      cumulativeToolMs: number;
      /** Use the same projected context input for the footer and progress ring. */
      tokensIn: number;
      /** Fresh billing input excludes cache reads and writes and is required at emit time. */
      freshInputTokens: number;
      tokensOut: number;
      /** Optional cache breakdown is present only when nonzero usage was reported. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      vendorProvider?: LLMVendor;
      vendorModel?: string;
      usageByModel?: TokenUsageSegment[];
      subscriptionUsage?: SubscriptionUsageTelemetry[];
      breakdown?: Record<string, { count: number; ms: number }>;
    };

type ReasoningEntry = Extract<ChatEntry, { kind: "reasoning" }>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;
type UserEntry = Extract<ChatEntry, { kind: "user" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;
type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

/** Copy only safe subscription telemetry and discard malformed segments. */
export function normalizeSubscriptionUsageList(
  value: unknown,
): SubscriptionUsageTelemetry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.flatMap((segment) => {
    const telemetry = normalizeSubscriptionUsageTelemetry(segment);
    return telemetry ? [telemetry] : [];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function isTurnStartEntry(entry: ChatEntry | undefined): boolean {
  return entry?.kind === "user" || entry?.kind === "imported_trigger";
}

/** Stop at a turn boundary before touching older answers; injected guidance belongs to this turn only while the preceding answer is streaming. */
function currentTurnAssistantIdx(entries: readonly ChatEntry[]): number {
  let crossedInjectedLine = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === "assistant") {
      return crossedInjectedLine && !entry.streaming ? -1 : i;
    }
    if (isTurnStartEntry(entry)) {
      if (entry?.kind === "user" && entry.injectHint) {
        crossedInjectedLine = true;
        continue;
      }
      return -1;
    }
  }
  return -1;
}

export function markTurnAssistantInterrupted(entries: ChatEntry[]): ChatEntry[] {
  const idx = currentTurnAssistantIdx(entries);
  if (idx < 0) return entries;
  const entry = entries[idx] as AssistantEntry;
  if (entry.interrupted) return entries;
  const next = [...entries];
  // Leave streaming set until the turn's closing frame can locate the entry.
  next[idx] = { ...entry, interrupted: true };
  return next;
}

export function clearTurnAssistantInterrupted(entries: ChatEntry[]): ChatEntry[] {
  const idx = currentTurnAssistantIdx(entries);
  if (idx < 0) return entries;
  const entry = entries[idx] as AssistantEntry;
  if (!entry.interrupted) return entries;
  const next = [...entries];
  const { interrupted: _interrupted, ...rest } = entry;
  next[idx] = rest;
  return next;
}

export function appendUserEntry(
  entries: ChatEntry[],
  text: string,
  injectHint?: "queue" | "interrupt",
): ChatEntry[] {
  // Stamp optimistic entries immediately so live timestamps and day indexing match later history replay.
  return [
    ...entries,
    {
      kind: "user",
      text,
      createdAt: Date.now(),
      awaitingHostId: true,
      ...(injectHint ? { injectHint } : {}),
    },
  ];
}

/** Append external inputs and reconcile local optimistic echoes in arrival order, binding the host's durable row id. */
export function applyUserMessageFrame(
  entries: ChatEntry[],
  frame: { text?: string; origin?: string; messageId?: string; hostSubmitted?: boolean },
): ChatEntry[] {
  // Host-submitted turns have no local echo; text origin alone cannot identify who initiated a turn.
  if (frame.hostSubmitted === true || isExternalSurfaceInputOrigin(frame.origin)) {
    const text = typeof frame.text === "string" ? frame.text : "";
    if (text.length === 0) return entries;
    return [
      ...entries,
      {
        kind: "user",
        text,
        origin: frame.origin,
        createdAt: Date.now(),
        ...(frame.messageId !== undefined ? { messageId: frame.messageId } : {}),
      },
    ];
  }
  if (frame.messageId === undefined) return entries;
  // Claim each explicitly pending echo once; missing ids on guidance, imported, or legacy rows do not qualify.
  const pending = entries.findIndex((e) => e.kind === "user" && e.awaitingHostId === true);
  if (pending < 0) return entries;
  const next = [...entries];
  const { awaitingHostId: _claimed, ...claimedEntry } = next[pending] as UserEntry;
  next[pending] = { ...claimedEntry, messageId: frame.messageId };
  return next;
}

/** Remove only the rejected send's optimistic bubble; delayed prior-turn frames must not cause another entry to be deleted. */
export function dropOptimisticUserEntry(entries: ChatEntry[], text: string): ChatEntry[] {
  const last = entries[entries.length - 1];
  if (!last || last.kind !== "user" || last.text !== text) return entries;
  return entries.slice(0, -1);
}

/** Deduplicate imported trigger cards by session id across reload and delivery retries. */
export function appendImportedTriggerEntry(
  entries: ChatEntry[],
  payload: {
    sessionId: string;
    source: string;
    prompt: string;
    summary: string;
    toolCallCount: number;
    importedAt: string;
  },
): ChatEntry[] {
  const exists = entries.some(
    (e) => e.kind === "imported_trigger" && e.sessionId === payload.sessionId,
  );
  if (exists) return entries;
  return [
    ...entries,
    {
      kind: "imported_trigger",
      ...payload,
    },
  ];
}

export function upsertStreamingReasoning(
  entries: ChatEntry[],
  text: string,
): ChatEntry[] {
  if (!text) {
    return entries;
  }

  const next = [...entries];
  const reasoningIdx = streamingEntryIdx(next, "reasoning");

  if (reasoningIdx >= 0) {
    next[reasoningIdx] = { ...(next[reasoningIdx] as ReasoningEntry), text, streaming: true, lastDeltaAt: Date.now() };
    return next;
  }
  const now = Date.now();
  const reasoning = { kind: "reasoning" as const, text, streaming: true, createdAt: now, lastDeltaAt: now };

  insertReasoning(next, reasoning);
  return next;
}

export function upsertStreamingAssistant(
  entries: ChatEntry[],
  text: string,
  phase?: "status",
): ChatEntry[] {
  if (!text) {
    return entries;
  }

  const next = [...entries];
  const turnStartIdx = findLastIdx(next, isTurnStartEntry);
  const turnEntries = next.slice(turnStartIdx + 1);

  if (phase === "status") {
    const hasSettledTerminalState = turnEntries.some(
      (entry) =>
        entry.kind === "turn_summary" ||
        (
          entry.kind === "assistant" &&
          entry.streaming !== true &&
          (
            entry.phase === "final" ||
            entry.terminalError === true ||
            entry.systemNotice !== undefined ||
            entry.interrupted === true
          )
        ),
    );
    if (hasSettledTerminalState) return entries;

    const hasLiveModelWork = turnEntries.some(
      (entry) =>
        (entry.kind === "assistant" && entry.streaming === true && entry.phase !== "status") ||
        (entry.kind === "reasoning" && entry.streaming === true),
    );
    if (hasLiveModelWork) return entries;

    const relativeStatusIdx = findLastIdx(
      turnEntries,
      (entry): entry is AssistantEntry =>
        entry.kind === "assistant" && entry.streaming === true && entry.phase === "status",
    );
    if (relativeStatusIdx >= 0) {
      const statusIdx = turnStartIdx + 1 + relativeStatusIdx;
      const current = next[statusIdx] as AssistantEntry;
      if (current.text === text && current.streaming === true && current.phase === "status") {
        return entries;
      }
      next[statusIdx] = {
        ...current,
        text,
        streaming: true,
        phase: "status",
      };
    } else {
      next.push({ kind: "assistant" as const, text, streaming: true, phase: "status" });
    }
    return next;
  }

  const relativeAssistantIdx = findLastIdx(
    turnEntries,
    (entry): entry is AssistantEntry => entry.kind === "assistant" && entry.streaming === true,
  );
  if (relativeAssistantIdx >= 0) {
    const assistantIdx = turnStartIdx + 1 + relativeAssistantIdx;
    next[assistantIdx] = {
      ...(next[assistantIdx] as AssistantEntry),
      text,
      streaming: true,
      phase: undefined,
    };
  } else {
    next.push({ kind: "assistant" as const, text, streaming: true });
  }
  return next;
}

export function finalizeStreamingReasoning(
  entries: ChatEntry[],
  fallbackText: string,
): ChatEntry[] {
  const next = [...entries];
  const reasoningIdx = streamingEntryIdx(next, "reasoning");

  if (reasoningIdx >= 0) {
    const reasoning = next[reasoningIdx] as ReasoningEntry;
    const text = reasoning.text || fallbackText;
    if (!text) {
      next.splice(reasoningIdx, 1);
      return next;
    }
    next[reasoningIdx] = {
      ...reasoning,
      text,
      streaming: false,
      ...(reasoning.createdAt !== undefined
        ? { durationMs: Math.max(0, (reasoning.lastDeltaAt ?? Date.now()) - reasoning.createdAt) }
        : {}),
    };
    return next;
  }

  if (!fallbackText) {
    return next;
  }

  const reasoning = {
    kind: "reasoning" as const,
    text: fallbackText,
    streaming: false,
  };
  insertReasoning(next, reasoning);
  return next;
}

export function finalizeStreamingAssistant(
  entries: ChatEntry[],
  fallbackText: string,
  opts?: {
    route?: "command";
    phase?: "work" | "final";
    overrideText?: string;
    /** Keep learned row ids when omitted on re-finalization; later rounds may explicitly replace them. */
    messageId?: string;
    /** Replay timestamps override live construction time so reload preserves original turn dates. */
    createdAt?: number;
    /** Preserve host system-notice markers on both live and replay paths for error styling. */
    systemNotice?: "context-error" | "stream-error";
    /** Restore persisted interruption markers on replay and never clear them on re-finalization. */
    interrupted?: boolean;
    interruptedBy?: "host-exit";
    /** Only replay marks restored entries so live and historical system notices remain distinguishable. */
    restored?: boolean;
  },
): ChatEntry[] {
  const next = [...entries];
  const assistantIdx = streamingEntryIdx(next, "assistant");

  if (assistantIdx >= 0) {
    const assistant = { ...(next[assistantIdx] as AssistantEntry) };
    const text = opts?.overrideText !== undefined ? opts.overrideText : assistant.text || fallbackText;
    if (!text) {
      // Keep empty assistant rows with same-turn tool or checkpoint siblings; splice only orphans without crossing turn boundaries.
      const turnStartIdx = findLastIdx(next.slice(0, assistantIdx), isTurnStartEntry);
      const nextTurnStartIdx = next.findIndex((e, i) => i > assistantIdx && isTurnStartEntry(e));
      const hasTurnSiblings = next
        .slice(turnStartIdx + 1, nextTurnStartIdx === -1 ? next.length : nextTurnStartIdx)
        .some((e) => e.kind === "tool_group" || e.kind === "checkpoint");
      if (!hasTurnSiblings) {
        next.splice(assistantIdx, 1);
        return next;
      }
    }
    next[assistantIdx] = {
      ...assistant,
      text,
      streaming: false,
      // Always assign route, including undefined, so finalization clears stale streaming state.
      route: opts?.route,
      phase: opts?.phase,
      // Stamp the first finalization time and preserve it on later finalizations.
      createdAt: opts?.createdAt ?? assistant.createdAt ?? Date.now(),
      ...(opts?.messageId ?? assistant.messageId
        ? { messageId: opts?.messageId ?? assistant.messageId }
        : {}),
      ...(opts?.systemNotice !== undefined
        ? { systemNotice: opts.systemNotice }
        : assistant.systemNotice !== undefined
          ? { systemNotice: assistant.systemNotice }
          : {}),
      ...(opts?.interrupted === true || assistant.interrupted === true
        ? { interrupted: true }
        : {}),
      ...(opts?.interruptedBy ?? assistant.interruptedBy
        ? { interruptedBy: opts?.interruptedBy ?? assistant.interruptedBy }
        : {}),
      ...(opts?.restored === true || assistant.restored === true
        ? { restored: true }
        : {}),
    };
    return next;
  }

  // Textless host-exit markers still need cards for interruption badges and Continue actions.
  const isRestoredExitMarker = opts?.restored === true && opts.interruptedBy === "host-exit";
  if (!fallbackText && !isRestoredExitMarker) {
    return next;
  }

  // Replay without an original timestamp must leave it absent rather than inventing the load time.
  next.push({
    kind: "assistant",
    text: fallbackText,
    streaming: false,
    route: opts?.route,
    phase: opts?.phase,
    ...(opts?.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
    ...(opts?.systemNotice !== undefined ? { systemNotice: opts.systemNotice } : {}),
    ...(opts?.interrupted === true ? { interrupted: true } : {}),
    ...(opts?.interruptedBy !== undefined ? { interruptedBy: opts.interruptedBy } : {}),
    ...(opts?.restored === true ? { restored: true } : {}),
  });
  return next;
}

export function setAssistantError(
  entries: ChatEntry[],
  message: string,
  fallbackThought: string = "",
  systemNotice?: AssistantEntry["systemNotice"],
  noticePaneTabId?: string,
): ChatEntry[] {
  // Stamp live host-error notices immediately so styling matches replay.
  const next = finalizeStreamingReasoning(entries, fallbackThought);
  const assistantIdx = streamingEntryIdx(next, "assistant");

  const current = assistantIdx >= 0 ? (next[assistantIdx] as AssistantEntry) : undefined;
  // Aborts retain partial content, even empty; do not replace it with an error message.
  const interrupted = current?.interrupted === true;
  const baseEntry: AssistantEntry = {
    ...current,
    kind: "assistant" as const,
    text: interrupted ? current?.text ?? "" : message,
    streaming: false,
    // Retain partial-response lifecycle state on abort; remove provider-status identity when a terminal error replaces it.
    phase: interrupted ? current?.phase : undefined,
    terminalError: true,
    ...(systemNotice !== undefined ? { systemNotice } : {}),
    ...(noticePaneTabId !== undefined ? { noticePaneTabId } : {}),
  };

  if (assistantIdx >= 0) {
    next[assistantIdx] = baseEntry;
  } else {
    next.push(baseEntry);
  }
  return next;
}

export function upsertPermissionReview(
  entries: ChatEntry[],
  payload: {
    status: PermissionReviewStatus;
    toolName: string;
    toolCategory?: ToolCategory;
    source?: ToolSource;
    groupId: string;
    toolUseId: string;
    displayOrder?: number;
    verdictLevel?: RiskLevel;
    reason?: string;
    approvalPurpose?: ApprovalPurposeSuggestion;
  },
): ChatEntry[] {
  const next = [...entries];
  const idx = findLastIdx(
    next,
    (candidate): candidate is PermissionReviewEntry =>
      candidate.kind === "permission_review" &&
      candidate.toolUseId === payload.toolUseId,
  );
  const previous = idx >= 0 ? next[idx] : undefined;
  const previousCreatedAt = previous?.kind === "permission_review" ? previous.createdAt : undefined;
  const entry: PermissionReviewEntry = {
    kind: "permission_review",
    status: payload.status,
    toolName: payload.toolName,
    groupId: payload.groupId,
    toolUseId: payload.toolUseId,
    displayOrder: payload.displayOrder ?? 0,
    createdAt: previousCreatedAt ?? Date.now(),
    ...(payload.toolCategory ? { toolCategory: payload.toolCategory } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.verdictLevel ? { verdictLevel: payload.verdictLevel } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.approvalPurpose ? { approvalPurpose: payload.approvalPurpose } : {}),
  };
  if (idx >= 0) {
    next[idx] = entry;
    return next;
  }
  next.push(entry);
  return next;
}

export function applyToolStart(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    name: string;
    displayOrder?: number;
    input?: Record<string, unknown>;
    source?: ToolSource;
    category?: ToolCategory;
    pluginId?: string;
    mcpServerId?: string;
  },
): ChatEntry[] {
  const next = [...entries];
  let groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  const adjacentGroupIdx = getAdjacentToolGroupIndex(next);

  const tool: ToolEntryItem = {
    toolUseId: payload.toolUseId,
    name: payload.name,
    displayOrder: payload.displayOrder ?? 0,
    status: "running",
    input: payload.input,
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.category ? { category: payload.category } : {}),
    ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
    ...(payload.mcpServerId ? { mcpServerId: payload.mcpServerId } : {}),
    startedAt: Date.now(),
  };

  if (groupIdx >= 0) {
    const group = next[groupIdx] as ToolGroupEntry;
    const toolIdx = group.tools.findIndex((entry: ToolEntryItem) => entry.toolUseId === payload.toolUseId);
    const tools =
      toolIdx >= 0
        ? group.tools.map((entry: ToolEntryItem, index: number) => (index === toolIdx ? tool : entry))
        : [...group.tools, tool];

    next[groupIdx] = { ...group, status: "running", tools };
    return next;
  }

  if (adjacentGroupIdx >= 0) {
    const group = next[adjacentGroupIdx] as ToolGroupEntry;
    const groupIds = group.groupIds.includes(payload.groupId)
      ? group.groupIds
      : [...group.groupIds, payload.groupId];
    next[adjacentGroupIdx] = {
      ...group,
      groupIds,
      status: "running",
      tools: [...group.tools, tool],
    };
    return next;
  }

  const newGroup: ToolGroupEntry = {
    kind: "tool_group",
    groupId: payload.groupId,
    groupIds: [payload.groupId],
    status: "running",
    tools: [tool],
  };

  next.push(newGroup);
  return next;
}

export function applyToolEnd(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    result?: string;
    isError?: boolean;
    cancelled?: boolean;
    uiPayload?: ToolEntryItem["uiPayload"];
    durationMs?: number;
    source?: ToolSource;
    category?: ToolCategory;
    pluginId?: string;
    mcpServerId?: string;
    executionPlan?: ToolEntryItem["executionPlan"];
  },
): ChatEntry[] {
  const next = [...entries];
  const groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  if (groupIdx < 0) {
    return entries;
  }

  const group = next[groupIdx] as ToolGroupEntry;
  const tools = group.tools.map((tool: ToolEntryItem) => {
    if (tool.toolUseId !== payload.toolUseId) return tool;
    const { startedAt: _startedAt, liveOutput: _liveOutput, ...rest } = tool;
    return {
      ...rest,
      status: (payload.cancelled
        ? "cancelled"
        : payload.isError
          ? "error"
          : "done") as "done" | "error" | "cancelled",
      result: payload.result,
      ...(payload.source ? { source: payload.source } : {}),
      ...(payload.category ? { category: payload.category } : {}),
      ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
      ...(payload.mcpServerId ? { mcpServerId: payload.mcpServerId } : {}),
      ...(payload.executionPlan !== undefined
        ? { executionPlan: payload.executionPlan }
        : {}),
      ...(payload.uiPayload && { uiPayload: payload.uiPayload }),
      ...(typeof payload.durationMs === "number" && { durationMs: payload.durationMs }),
    };
  });
  const completedTool = tools.find((tool: ToolEntryItem) => tool.toolUseId === payload.toolUseId);
  const stillRunning = tools.some((tool: ToolEntryItem) => tool.status === "running");
  next[groupIdx] = { ...group, status: stillRunning ? "running" : "done", tools };
  const answerEntry = completedTool ? askUserAnswerEntryFromTool(completedTool) : null;
  if (answerEntry && !next.some((entry) => entry.kind === "ask_user_answer" && entry.sourceToolUseId === answerEntry.sourceToolUseId)) {
    next.push(answerEntry);
  }
  return next;
}

function askUserAnswerEntryFromTool(
  tool: ToolEntryItem,
): Extract<ChatEntry, { kind: "ask_user_answer" }> | null {
  if (tool.name !== "ask_user_question") return null;
  if (!tool.result) return null;

  const parsed = safeJsonParse(tool.result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = parsed as { answers?: unknown; dismissed?: unknown };
  if (result.dismissed === true) {
    return {
      kind: "ask_user_answer",
      sourceToolUseId: tool.toolUseId,
      dismissed: true,
      rows: [],
    };
  }
  if (!Array.isArray(result.answers)) return null;

  const questions = extractAskQuestions(tool.input);
  const rows = result.answers
    .map((answer, index) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
      const record = answer as { choice?: unknown; choices?: unknown; freeText?: unknown };
      const selectedChoices = Array.isArray(record.choices)
        ? record.choices
            .filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
            .map((choice) => choice.trim())
        : [];
      const primaryChoices =
        typeof record.choice === "string" && record.choice.trim().length > 0
          ? [record.choice.trim()]
          : selectedChoices;
      const freeText =
        typeof record.freeText === "string" && record.freeText.trim().length > 0
          ? record.freeText.trim()
          : undefined;
      const value = formatAskUserAnswer(primaryChoices, freeText);
      if (!value) return null;
      return {
        label: answerLabel(questions[index], index),
        value,
      };
    })
    .filter((row): row is { label: string; value: string } => row !== null);

  if (rows.length === 0) return null;
  return {
    kind: "ask_user_answer",
    sourceToolUseId: tool.toolUseId,
    rows,
  };
}

/** Label picked and typed answers separately; return empty when neither exists. */
export function formatAskUserAnswer(choices: string[], freeText?: string): string {
  const parts: string[] = [];
  if (choices.length > 0) {
    parts.push(`${t("askUserQuestionCard.answerChoicePrefix")}: ${choices.join(", ")}`);
  }
  if (freeText && freeText.trim().length > 0) {
    parts.push(`${t("askUserQuestionCard.answerFreeTextPrefix")}: ${freeText.trim()}`);
  }
  return parts.join(" / ");
}

function extractAskQuestions(input: ToolEntryItem["input"]): Array<{ question?: string; summaryHint?: string }> {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return {};
    const record = item as { question?: unknown; summaryHint?: unknown };
    return {
      question: typeof record.question === "string" ? record.question : undefined,
      summaryHint: typeof record.summaryHint === "string" ? record.summaryHint : undefined,
    };
  });
}

function answerLabel(question: { question?: string; summaryHint?: string } | undefined, index: number): string {
  const hint = question?.summaryHint?.trim();
  if (hint) return hint;
  const text = question?.question?.trim();
  if (!text) return t("be_chatStreamState.answerLabel", { index: String(index + 1) });
  return text.length <= 14 ? text : `${text.slice(0, 13)}…`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findLastIdx<T>(items: T[], predicate: (value: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function streamingEntryIdx(entries: ChatEntry[], kind: "assistant" | "reasoning"): number {
  return findLastIdx(entries, (entry) => entry.kind === kind && !!entry.streaming);
}

function insertReasoning(entries: ChatEntry[], reasoning: ReasoningEntry): void {
  const assistantIdx = streamingEntryIdx(entries, "assistant");
  entries.splice(assistantIdx < 0 ? entries.length : assistantIdx, 0, reasoning);
}

function getAdjacentToolGroupIndex(entries: ChatEntry[]): number {
  if (entries[entries.length - 1]?.kind === "tool_group") {
    return entries.length - 1;
  }
  return -1;
}

// Share transcript frame reduction across chat surfaces; hooks retain only stream-local state.

type TurnSummaryEntry = Extract<ChatEntry, { kind: "turn_summary" }>;

/** Any real activity or closing frame supersedes the provider-status placeholder. */
export function dropPendingLlmStatusAssistant(entries: ChatEntry[]): ChatEntry[] {
  const idx = findLastIdx(
    entries,
    (entry): entry is AssistantEntry =>
      entry.kind === "assistant" &&
      entry.streaming === true &&
      entry.phase === "status",
  );
  if (idx < 0) return entries;
  return [...entries.slice(0, idx), ...entries.slice(idx + 1)];
}

export function applyReasoningDelta(entries: ChatEntry[], thought: string): ChatEntry[] {
  return upsertStreamingReasoning(dropPendingLlmStatusAssistant(entries), thought);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsageByModel(value: unknown): TurnSummaryEntry["usageByModel"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap((segment) => {
    if (!segment || typeof segment !== "object") return [];
    const s = segment as {
      vendorProvider?: unknown;
      vendorModel?: unknown;
      pricing?: unknown;
      tokenUsage?: {
        inputTokens?: unknown;
        outputTokens?: unknown;
        cacheReadTokens?: unknown;
        cacheWriteTokens?: unknown;
        reasoningTokens?: unknown;
      };
    };
    if (!isLLMVendor(s.vendorProvider) || typeof s.vendorModel !== "string" || s.vendorModel.length === 0) return [];
    const usage = s.tokenUsage;
    if (!usage || !isFiniteNonNegative(usage.inputTokens) || !isFiniteNonNegative(usage.outputTokens)) {
      return [];
    }
    const pricing = parseResolvedModelPricing(s.pricing);
    return [{
      vendorProvider: s.vendorProvider,
      vendorModel: s.vendorModel,
      ...(pricing !== undefined ? { pricing } : {}),
      tokenUsage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(isFiniteNonNegative(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(isFiniteNonNegative(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(isFiniteNonNegative(usage.reasoningTokens) ? { reasoningTokens: usage.reasoningTokens } : {}),
      },
    }];
  });
  return parsed.length > 0 ? parsed : undefined;
}

/** Reject summary totals missing finite non-negative counts. */
export function parseTurnSummaryEvent(ev: ChatStreamEvent): Pick<
  TurnSummaryEntry,
  | "endedByEndTurn"
  | "turnDurationMs"
  | "toolCount"
  | "cumulativeToolMs"
  | "tokensIn"
  | "freshInputTokens"
  | "tokensOut"
  | "vendorProvider"
  | "vendorModel"
  | "usageByModel"
  | "subscriptionUsage"
> | null {
  if (ev.type !== "turn_summary") return null;
  const { turnDurationMs, toolCount, cumulativeToolMs, tokensIn, freshInputTokens, tokensOut, vendorProvider, vendorModel } = ev;
  if (
    !isFiniteNonNegative(turnDurationMs) ||
    !isFiniteNonNegative(toolCount) ||
    !isFiniteNonNegative(cumulativeToolMs) ||
    !isFiniteNonNegative(tokensIn) ||
    !isFiniteNonNegative(freshInputTokens) ||
    !isFiniteNonNegative(tokensOut)
  ) {
    return null;
  }
  const usageByModel = parseUsageByModel(ev.usageByModel);
  const subscriptionUsage = normalizeSubscriptionUsageList(ev.subscriptionUsage);
  return {
    ...(ev.endedByEndTurn === true ? { endedByEndTurn: true as const } : {}),
    turnDurationMs,
    toolCount,
    cumulativeToolMs,
    tokensIn,
    freshInputTokens,
    tokensOut,
    ...(isLLMVendor(vendorProvider) ? { vendorProvider } : {}),
    ...(typeof vendorModel === "string" && vendorModel.length > 0 ? { vendorModel } : {}),
    ...(usageByModel !== undefined ? { usageByModel } : {}),
    ...(subscriptionUsage !== undefined ? { subscriptionUsage } : {}),
  };
}

const TRANSCRIPT_FRAME_TYPES: ReadonlySet<ChatStreamEvent["type"]> = new Set<ChatStreamEvent["type"]>([
  "permission_review",
  "tool_start",
  "tool_output",
  "tool_end",
  "turn_summary",
  "compact_notice",
]);

export function isTranscriptFrame(ev: ChatStreamEvent): boolean {
  return TRANSCRIPT_FRAME_TYPES.has(ev.type);
}

/** Ignore invalid or unowned frames; text and closing branches retain hook-local state. */
export function applyTranscriptFrame(entries: ChatEntry[], ev: ChatStreamEvent): ChatEntry[] {
  switch (ev.type) {
    case "permission_review": {
      if (!ev.reviewStatus || !ev.name || !ev.groupId || ev.toolUseId === undefined) return entries;
      const { reviewStatus, name, toolCategory, source, groupId, toolUseId, displayOrder = 0, verdictLevel, reason, approvalPurpose } = ev;
      return upsertPermissionReview(dropPendingLlmStatusAssistant(entries), {
        status: reviewStatus,
        toolName: name,
        groupId,
        toolUseId,
        displayOrder,
        ...(toolCategory ? { toolCategory } : {}),
        ...(source ? { source } : {}),
        ...(verdictLevel ? { verdictLevel } : {}),
        ...(reason ? { reason } : {}),
        ...(approvalPurpose ? { approvalPurpose } : {}),
      });
    }
    case "tool_start": {
      if (!ev.name || !ev.groupId || ev.toolUseId === undefined) return entries;
      const { groupId, toolUseId, displayOrder = 0, name, input, source, toolCategory, pluginId, mcpServerId } = ev;
      return applyToolStart(dropPendingLlmStatusAssistant(entries), {
        groupId,
        toolUseId,
        displayOrder,
        name,
        input,
        ...(source ? { source } : {}),
        ...(toolCategory ? { category: toolCategory } : {}),
        ...(pluginId ? { pluginId } : {}),
        ...(mcpServerId ? { mcpServerId } : {}),
      });
    }
    case "tool_output": {
      if (!ev.groupId || ev.toolUseId === undefined || typeof ev.text !== "string") return entries;
      return applyToolOutput(entries, { groupId: ev.groupId, toolUseId: ev.toolUseId, text: ev.text });
    }
    case "tool_end": {
      if (!ev.name || !ev.groupId || ev.toolUseId === undefined) return entries;
      const { groupId, toolUseId, result, isError, cancelled, uiPayload, durationMs, source, toolCategory, pluginId, mcpServerId, executionPlan } = ev;
      return applyToolEnd(entries, {
        groupId,
        toolUseId,
        result,
        isError,
        ...(cancelled ? { cancelled: true } : {}),
        uiPayload,
        durationMs,
        ...(source ? { source } : {}),
        ...(toolCategory ? { category: toolCategory } : {}),
        ...(pluginId ? { pluginId } : {}),
        ...(mcpServerId ? { mcpServerId } : {}),
        ...(executionPlan !== undefined ? { executionPlan } : {}),
      });
    }
    case "turn_summary": {
      const summary = parseTurnSummaryEvent(ev);
      if (!summary) {
        console.warn("Malformed turn_summary stream event ignored", ev);
        return entries;
      }
      return [
        ...entries,
        {
          kind: "turn_summary",
          ...summary,
          ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
          ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {}),
          ...(ev.breakdown ? { breakdown: ev.breakdown } : {}),
        },
      ];
    }
    case "compact_notice": {
      const estimatedAfter = ev.estimatedAfter;
      const checkpointEntry = {
        kind: "checkpoint" as const,
        removedMessages: ev.removedMessages ?? 0,
        freedTokens: ev.freedTokens ?? 0,
        ...(ev.trigger ? { trigger: ev.trigger } : {}),
        ...(ev.summary ? { summary: ev.summary } : {}),
        ...(ev.compactNum !== undefined ? { compactNum: ev.compactNum } : {}),
        ...(ev.compactStatus !== undefined ? { compactStatus: ev.compactStatus } : {}),
        ...(ev.truncatedDir !== undefined ? { truncatedDir: ev.truncatedDir } : {}),
      };
      if (typeof estimatedAfter !== "number" || estimatedAfter < 0) return [...entries, checkpointEntry];
      return [
        ...entries,
        checkpointEntry,
        { kind: "context_usage" as const, tokensIn: estimatedAfter, source: "compact-estimate" as const },
      ];
    }
    default:
      return entries;
  }
}
