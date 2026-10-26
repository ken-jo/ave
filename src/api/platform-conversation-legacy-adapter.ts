// Adapt the canonical semantic timeline to legacy IPC and SSE frames.
import { CHANNELS } from "../contract/app-contract.js";
import { createStreamBroadcaster } from "./stream-broadcaster.js";
import type {
  LegacyChatStreamSink,
  PlatformConversationEvent,
  PlatformConversationEventEnvelope,
  PlatformConversationEventSink,
  PlatformConversationTimeline,
} from "../engine/conversation-platform-protocol.js";
export { createPlatformTurnId } from "../engine/conversation-platform-protocol.js";

export interface LegacyChatStreamEventSource {
  subscribe(fn: LegacyChatStreamSink): () => void;
  subscriberCount(): number;
}

export interface LegacyChatStreamProjectionOptions {
  readonly streamId?: number;
  readonly sessionId?: string;
  readonly sendRequestId?: string;
  readonly streamChannel?: string;
  readonly fallbackChannel?: string;
}

interface LegacyChatStreamFrame {
  readonly channel: string;
  readonly payload: Record<string, unknown>;
}

// Keep legacy event names and numeric stream ids confined to this adapter.
function projectPlatformConversationEventToLegacyChatFrame(
  event: PlatformConversationEvent,
  options: LegacyChatStreamProjectionOptions = {},
): LegacyChatStreamFrame | undefined {
  const streamChannel = options.streamChannel ?? CHANNELS.chat.stream;
  const fallbackChannel = options.fallbackChannel ?? CHANNELS.chat.fallback;
  const withStreamId = (payload: Record<string, unknown>): Record<string, unknown> => (
    options.streamId === undefined ? payload : { streamId: options.streamId, ...payload }
  );

  switch (event.kind) {
    case "turn.started":
      return undefined;
    case "user.message":
      return streamFrame(streamChannel, withStreamId({
        type: "user_message",
        text: event.ownerDetail.text,
        origin: event.origin,
        messageId: event.ownerDetail.messageId,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.sendRequestId !== undefined ? { sendRequestId: options.sendRequestId } : {}),
        ...(event.ownerDetail.hostSubmitted
          ? { hostSubmitted: event.ownerDetail.hostSubmitted }
          : {}),
      }));
    case "assistant.reasoning.delta":
      return streamFrame(streamChannel, withStreamId({
        type: "reasoning_delta",
        text: event.ownerDetail.text,
      }));
    case "assistant.text.delta":
      return streamFrame(streamChannel, withStreamId({ type: "text_delta", text: event.text }));
    case "assistant.round.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "assistant_round",
        messageId: event.round.ownerDetail.messageId,
        roundIndex: event.round.roundIndex,
        text: event.round.text,
        thought: event.round.ownerDetail.thought,
        stopReason: event.round.stopReason,
        hasToolCalls: event.round.hasToolCalls,
      }));
    case "tool.started":
      return streamFrame(streamChannel, withStreamId({
        type: "tool_start",
        ...legacyToolReference(event.tool),
        input: event.ownerDetail.input,
      }));
    case "tool.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "tool_end",
        ...legacyToolReference(event.tool),
        result: event.ownerDetail.result,
        isError: event.isError,
        ...(event.cancelled ? { cancelled: true } : {}),
        ...(event.ownerDetail.executionPlan === undefined
          ? {}
          : { executionPlan: event.ownerDetail.executionPlan }),
        ...(event.ownerDetail.uiPayload === undefined ? {} : { uiPayload: event.ownerDetail.uiPayload }),
        durationMs: event.durationMs,
      }));
    case "tool.output.delta":
      return streamFrame(streamChannel, withStreamId({
        type: "tool_output",
        ...legacyToolReference(event.tool),
        text: event.ownerDetail.text,
      }));
    case "permission.reviewed":
      return streamFrame(streamChannel, withStreamId({
        type: "permission_review",
        reviewStatus: event.review.status,
        ...legacyToolReference(event.review.tool),
        ...(event.review.verdictLevel === undefined ? {} : { verdictLevel: event.review.verdictLevel }),
        ...(event.review.ownerDetail.reason === undefined ? {} : { reason: event.review.ownerDetail.reason }),
        ...(event.review.ownerDetail.approvalPurpose === undefined
          ? {}
          : { approvalPurpose: event.review.ownerDetail.approvalPurpose }),
      }));
    case "turn.error":
      return streamFrame(streamChannel, withStreamId({
        type: "error",
        error: event.ownerDetail.message,
        ...(event.ownerDetail.systemNotice === undefined
          ? {}
          : { systemNotice: event.ownerDetail.systemNotice }),
      }));
    case "permission.mode.changed":
      return streamFrame(streamChannel, withStreamId({ type: "permission_mode_changed", mode: event.mode }));
    case "compaction.started":
      return streamFrame(streamChannel, withStreamId({
        type: "compact_started",
        triggerSource: event.triggerSource,
        estimatedBefore: event.estimatedBefore,
        preflight: event.preflight,
      }));
    case "compaction.failed":
      return streamFrame(streamChannel, withStreamId({ type: "compact_failed" }));
    case "compaction.recovery.exhausted":
      return streamFrame(streamChannel, withStreamId({ type: "recovery_exhausted" }));
    case "compaction.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "compact_notice",
        removedMessages: event.removedMessages,
        freedTokens: event.freedTokens,
        estimatedAfter: event.estimatedAfter,
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
        ...(event.ownerDetail.summary === undefined ? {} : { summary: event.ownerDetail.summary }),
        ...(event.compactNum === undefined ? {} : { compactNum: event.compactNum }),
        ...(event.compactStatus === undefined ? {} : { compactStatus: event.compactStatus }),
        ...(event.ownerDetail.truncatedDir === undefined ? {} : { truncatedDir: event.ownerDetail.truncatedDir }),
      }));
    case "usage.reported":
      return streamFrame(streamChannel, withStreamId({ type: "turn_summary", ...event.ownerDetail }));
    case "model.status":
      return streamFrame(streamChannel, withStreamId({ type: "llm_status", ...event.ownerDetail.status }));
    case "model.fallback":
      return streamFrame(fallbackChannel, { from: event.from, to: event.to });
    case "guidance.applied":
      return streamFrame(streamChannel, withStreamId({
        type: "guidance_injected",
        text: event.text,
        messageId: event.ownerDetail.messageId,
        ...(event.subAgentReport ? { subAgentReport: event.subAgentReport } : {}),
      }));
    case "guidance.dropped":
      return streamFrame(streamChannel, withStreamId({ type: "guidance_dropped", text: event.text }));
    case "loop.decision":
      // Conversation frames omit loop decisions; decision consumers read platform events directly.
      return undefined;
    case "suggestions.updated":
      return streamFrame(streamChannel, withStreamId({ type: "suggested_replies", reply: event.reply }));
    case "turn.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "done",
        ...(event.route === "command" ? { route: "command" } : {}),
      }));
    case "privacy.redacted":
      return streamFrame(streamChannel, {
        type: "redact_notice",
        count: event.count,
        byKind: event.byKind,
      });
  }
}

export function createLegacyChatStreamEventSink(
  sink: LegacyChatStreamSink,
  options: LegacyChatStreamProjectionOptions,
): PlatformConversationEventSink {
  return (event) => {
    const frame = projectPlatformConversationEventToLegacyChatFrame(event, options);
    if (!frame) return;
    try {
      sink(frame.channel, frame.payload);
    } catch {
    }
  };
}

// Display adapters may subscribe to the semantic timeline but cannot publish to it.
export function createPlatformConversationLegacyStreamAdapter(
  timeline: PlatformConversationTimeline,
): LegacyChatStreamEventSource {
  const broadcaster = createStreamBroadcaster();
  let unsubscribeTimeline: (() => void) | undefined;

  const attach = () => {
    if (unsubscribeTimeline || broadcaster.subscriberCount() === 0) return;
    unsubscribeTimeline = timeline.subscribe(deliver).unsubscribe;
  };
  const detach = () => {
    if (broadcaster.subscriberCount() !== 0 || !unsubscribeTimeline) return;
    unsubscribeTimeline();
    unsubscribeTimeline = undefined;
  };
  const deliver = (envelope: PlatformConversationEventEnvelope) => {
    const frame = projectPlatformConversationEventToLegacyChatFrame(envelope.event, {
      streamId: readStreamIdFromTurnId(envelope.turnId),
    });
    if (!frame) return;
    broadcaster.sink(frame.channel, frame.payload);
  };

  return {
    subscribe: (subscriber) => {
      const unsubscribe = broadcaster.subscribe(subscriber);
      attach();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        detach();
      };
    },
    subscriberCount: broadcaster.subscriberCount,
  };
}

function streamFrame(channel: string, payload: Record<string, unknown>): LegacyChatStreamFrame {
  return { channel, payload };
}

function legacyToolReference(
  tool: Extract<PlatformConversationEvent, { readonly kind: "tool.started" }> ["tool"],
): Record<string, unknown> {
  return {
    name: tool.name,
    groupId: tool.groupId,
    toolUseId: tool.toolUseId,
    displayOrder: tool.displayOrder,
    ...(tool.source === undefined ? {} : { source: tool.source }),
    ...(tool.category === undefined ? {} : { toolCategory: tool.category }),
    ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
    ...(tool.mcpServerId === undefined ? {} : { mcpServerId: tool.mcpServerId }),
  };
}

function readStreamIdFromTurnId(turnId: string | undefined): number | undefined {
  const match = /^local-stream\/(\d+)$/.exec(turnId ?? "");
  if (!match) return undefined;
  const streamId = Number(match[1]);
  return Number.isSafeInteger(streamId) && streamId >= 0 ? streamId : undefined;
}
