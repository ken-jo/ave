/** All adapters share one semantic timeline; raw frames are not an alternative event source.
 * Shared surfaces require explicit projection and grants; ownerDetail stays trusted-owner-only. */
import type { McpUiPayload } from "../mcp/types.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import {
  isSharedApprovalToolIdentifier,
  type ApprovalPurposeSuggestion,
  type RiskLevel,
  type PermissionReviewStatus,
} from "../shared/permission-review-status.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { FallbackStatus } from "./llm/vercel/fallback-chain.js";
import type { TurnCallbacks, TurnDecisionEvent } from "./turn/types.js";
import {
  createConversationEventHub,
  type ConversationEventHub,
  type ConversationEventHubOptions,
  type ConversationEventReplay,
  type ConversationEventSubscriptionOptions,
} from "./conversation-event-hub.js";
import {
  toSafeTurnFailureSummary,
  type TurnFailureSummary,
} from "./turn-failure-summary.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import type { AuthorizationRequiredState } from "../shared/authorization-required.js";

const PLATFORM_CONVERSATION_PROTOCOL_VERSION = 1 as const;

type PlatformConversationProtocolVersion =
  typeof PLATFORM_CONVERSATION_PROTOCOL_VERSION;

/** Portable tool references exclude arguments, results, plans, and UI resource URIs. */
interface ConversationToolReference {
  readonly name: string;
  readonly groupId: string;
  readonly toolUseId: string;
  readonly displayOrder: number;
  readonly source?: ToolSource;
  readonly category?: ToolCategory;
  readonly pluginId?: string;
  readonly mcpServerId?: string;
}

interface ConversationToolStartOwnerDetail {
  readonly input: Record<string, unknown>;
}

interface ConversationToolEndOwnerDetail {
  readonly result: string;
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
  readonly uiPayload?: McpUiPayload;
}

interface ConversationAssistantRound {
  readonly roundIndex: number;
  readonly text: string;
  readonly stopReason: "end_turn" | "tool_use" | "max_tokens";
  readonly hasToolCalls: boolean;
  /** Reasoning is intentionally owner-only by default. */
  readonly ownerDetail: {
    readonly thought: string;
    // Durable row handles are owner-only; shared surfaces cannot address owner history.
    readonly messageId: string;
  };
}

interface ConversationPermissionReview {
  readonly status: PermissionReviewStatus;
  readonly tool: ConversationToolReference;
  readonly verdictLevel?: RiskLevel;
  /** Reason and generated approval purpose are owner-only review context. */
  readonly ownerDetail: {
    readonly reason?: string;
    readonly approvalPurpose?: ApprovalPurposeSuggestion;
  };
}

type ConversationUsageReport = Parameters<
  NonNullable<TurnCallbacks["onTurnSummary"]>
>[0];

/** Keep the event union closed so every addition explicitly defines owner and shared fields. */
export type PlatformConversationEvent =
  | { readonly kind: "turn.started" }
  // Publish input once for every origin; adapters deduplicate local echoes and keep text owner-only.
  | {
    readonly kind: "user.message";
    /** Host-resolved input provenance; a surface payload cannot supply it. */
    readonly origin: ChatInputOrigin;
    readonly ownerDetail: {
      readonly text: string;
      // Announce the host-minted row ID with input so rendering binds to the persisted row.
      readonly messageId: string;
      // Host-started turns need rendering everywhere; text origin does not identify who submitted them.
      readonly hostSubmitted?: true;
    };
  }
  | { readonly kind: "assistant.reasoning.delta"; readonly ownerDetail: { readonly text: string } }
  | { readonly kind: "assistant.text.delta"; readonly text: string }
  | { readonly kind: "assistant.round.completed"; readonly round: ConversationAssistantRound }
  | {
    readonly kind: "tool.started";
    readonly tool: ConversationToolReference;
    readonly ownerDetail: ConversationToolStartOwnerDetail;
  }
  | {
    readonly kind: "tool.completed";
    readonly tool: ConversationToolReference;
    readonly isError: boolean;
    readonly cancelled?: boolean;
    readonly durationMs: number;
    readonly ownerDetail: ConversationToolEndOwnerDetail;
  }
  | {
    // Live shell output is capped display data; tool.completed remains the result authority.
    readonly kind: "tool.output.delta";
    readonly tool: ConversationToolReference;
    /** Command output can hold user and private material. */
    readonly ownerDetail: { readonly text: string };
  }
  | { readonly kind: "permission.reviewed"; readonly review: ConversationPermissionReview }
  | {
    readonly kind: "turn.error";
    // Shared failures use closed categories and fixed sentences, never raw error text.
    readonly failure?: TurnFailureSummary;
    readonly ownerDetail: {
      readonly message: string;
      readonly systemNotice?: "context-error" | "stream-error";
    };
  }
  | { readonly kind: "permission.mode.changed"; readonly mode: ExecutionMode }
  | {
    readonly kind: "compaction.started";
    readonly triggerSource: Parameters<NonNullable<TurnCallbacks["onCompactStarted"]>>[0]["triggerSource"];
    readonly estimatedBefore: number;
    readonly preflight: number;
  }
  | { readonly kind: "compaction.failed" }
  | { readonly kind: "compaction.recovery.exhausted" }
  | {
    readonly kind: "compaction.completed";
    readonly removedMessages: number;
    readonly freedTokens: number;
    readonly estimatedAfter: number;
    readonly trigger?: "auto-compact" | "manual";
    readonly compactNum?: number;
    readonly compactStatus?: import("../shared/compact-status.js").CompressionStatus;
    /** Summary and filesystem path can contain user/private material. */
    readonly ownerDetail: { readonly summary?: string; readonly truncatedDir?: string };
  }
  | { readonly kind: "usage.reported"; readonly ownerDetail: ConversationUsageReport }
  | { readonly kind: "model.status"; readonly ownerDetail: { readonly status: FallbackStatus } }
  | { readonly kind: "model.fallback"; readonly from: string; readonly to: string }
  | {
    readonly kind: "guidance.applied";
    readonly text: string;
    readonly subAgentReport?: { readonly title?: string };
    // Injection row IDs remain owner-only history handles.
    readonly ownerDetail: { readonly messageId: string };
  }
  | { readonly kind: "guidance.dropped"; readonly text: string }
  // Decisions expose branch counts without private content; shared projections omit control flow.
  | { readonly kind: "loop.decision"; readonly decision: TurnDecisionEvent }
  | { readonly kind: "suggestions.updated"; readonly reply: string | null }
  | {
    readonly kind: "turn.completed";
    readonly route?: "command";
    /** Owner-safe terminal state for a host with no approval surface. */
    readonly authorizationRequired?: AuthorizationRequiredState;
  }
  | {
    readonly kind: "privacy.redacted";
    readonly count: number;
    readonly byKind: Readonly<Record<string, number>>;
  };

interface PlatformConversationEventInput {
  readonly conversationId: string;
  readonly turnId?: string;
  readonly event: PlatformConversationEvent;
  /** Semantic events are live-only unless an explicitly safe projector retains them. */
  readonly replay?: boolean;
}

export interface PlatformConversationEventEnvelope {
  readonly version: PlatformConversationProtocolVersion;
  readonly eventId: string;
  readonly conversationId: string;
  readonly cursor: number;
  readonly turnId?: string;
  readonly emittedAt: number;
  readonly event: PlatformConversationEvent;
}

type PlatformConversationEventListener = (
  event: PlatformConversationEventEnvelope,
) => void;

interface PlatformConversationSubscriptionOptions {
  readonly conversationId?: string;
  readonly afterCursor?: number;
  readonly replay?: "none" | "available";
}

interface PlatformConversationReplay {
  readonly conversationId: string;
  readonly afterCursor: number | null;
  readonly oldestRetainedCursor: number | null;
  readonly latestCursor: number;
  readonly snapshotRequired: boolean;
  readonly events: readonly PlatformConversationEventEnvelope[];
}

interface PlatformConversationSubscription {
  readonly replay: PlatformConversationReplay | undefined;
  unsubscribe(): void;
}

export interface PlatformConversationTimeline {
  publish(input: PlatformConversationEventInput): PlatformConversationEventEnvelope;
  subscribe(
    listener: PlatformConversationEventListener,
    options?: PlatformConversationSubscriptionOptions,
  ): PlatformConversationSubscription;
  read(
    conversationId: string,
    options?: { readonly afterCursor?: number },
  ): PlatformConversationReplay;
  subscriberCount(): number;
}

// Producers emit semantic events, never arbitrary channel/payload pairs.
export type PlatformConversationEventSink = (
  event: PlatformConversationEvent,
) => void;

// Allocate opaque host turn IDs without coupling producers to transport adapters.
export function createPlatformTurnId(streamId: number): string {
  if (!Number.isSafeInteger(streamId) || streamId < 0) {
    throw new RangeError("streamId must be a non-negative safe integer.");
  }
  return `local-stream/${streamId}`;
}

// Rich compatibility details stay outside the semantic producer contract.
export type LegacyChatStreamSink = (channel: string, payload: unknown) => void;

const TIMELINE_CHANNEL = "platform.conversation.event";

export function createPlatformConversationTimeline(
  options: ConversationEventHubOptions = {},
): PlatformConversationTimeline {
  const hub = createConversationEventHub(options);

  const publish = (
    input: PlatformConversationEventInput,
  ): PlatformConversationEventEnvelope => {
    const envelope = hub.publish({
      sessionId: input.conversationId,
      channel: TIMELINE_CHANNEL,
      payload: input.event,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      // Raw owner details are live-only; reconnect requires explicitly safe snapshots and replay.
      replay: input.replay ?? false,
    });
    return toPlatformEnvelope(envelope);
  };

  const read = (
    conversationId: string,
    options: { readonly afterCursor?: number } = {},
  ): PlatformConversationReplay => toPlatformReplay(hub.read(conversationId, options));

  const subscribe = (
    listener: PlatformConversationEventListener,
    options: PlatformConversationSubscriptionOptions = {},
  ): PlatformConversationSubscription => {
    const subscription = hub.subscribe(
      (envelope) => {
        // Reject generic payloads even if a future internal caller reuses the hub.
        if (envelope.channel !== TIMELINE_CHANNEL) return;
        listener(toPlatformEnvelope(envelope));
      },
      toHubSubscriptionOptions(options),
    );
    return {
      replay: subscription.replay === undefined
        ? undefined
        : toPlatformReplay(subscription.replay),
      unsubscribe: subscription.unsubscribe,
    };
  };

  return { publish, subscribe, read, subscriberCount: () => hub.subscriberCount() };
}

/** Bind host session and turn identity; display publication failures must not abort model execution. */
export function createPlatformConversationEventSink(
  timeline: PlatformConversationTimeline,
  context: { readonly conversationId: string; readonly turnId?: string },
): PlatformConversationEventSink {
  return (event) => {
    try {
      timeline.publish({
        conversationId: context.conversationId,
        ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
        event,
      });
    } catch {
      // Malformed owner detail must not block execution or other surfaces.
    }
  };
}

/** Whitelist projection does not itself authorize a recipient to receive the result. */
export type SharedConversationProjectionEvent =
  | { readonly kind: "turn.started" }
  | { readonly kind: "assistant.text.delta"; readonly text: string }
  | { readonly kind: "tool.state"; readonly state: "running" | "completed" | "failed" | "cancelled" }
  | {
    readonly kind: "approval.waiting-local";
    // Share only grammar-valid tool identifiers, never arguments, paths, or review reasons.
    readonly tool?: string;
  }
  | { readonly kind: "compaction.started" }
  | { readonly kind: "compaction.completed" }
  | { readonly kind: "turn.failed"; readonly failure?: TurnFailureSummary }
  | { readonly kind: "turn.completed" };

export function projectSharedConversationEvent(
  event: PlatformConversationEvent,
): SharedConversationProjectionEvent | undefined {
  switch (event.kind) {
    case "turn.started":
      return { kind: "turn.started" };
    case "user.message":
      // Shared input would duplicate local echoes and disclose other surfaces user text.
      return undefined;
    case "assistant.text.delta":
      return { kind: "assistant.text.delta", text: event.text };
    case "tool.started":
      return { kind: "tool.state", state: "running" };
    case "tool.completed":
      // A user stop is reported as its own state; remote surfaces should not
      // show "failed" for something the user deliberately halted.
      return {
        kind: "tool.state",
        state: event.cancelled ? "cancelled" : event.isError ? "failed" : "completed",
      };
    case "tool.output.delta":
      // Owner-only: command output never crosses the shared projection, and
      // `tool.state` already tells a shared surface the call is running.
      return undefined;
    case "permission.reviewed": {
      if (event.review.status !== "needs_approval") return undefined;
      const tool = sharedApprovalToolIdentifier(event.review.tool);
      return tool === undefined
        ? { kind: "approval.waiting-local" }
        : { kind: "approval.waiting-local", tool };
    }
    case "compaction.started":
      return { kind: "compaction.started" };
    case "compaction.completed":
      return { kind: "compaction.completed" };
    case "compaction.failed":
      // Local transcript notice only; maintenance failure never closes a shared turn.
      return undefined;
    case "turn.error": {
      // Re-validate producer summaries against the closed category union and bounded fields.
      const failure = toSafeTurnFailureSummary(event.failure);
      return failure === undefined
        ? { kind: "turn.failed" }
        : { kind: "turn.failed", failure };
    }
    case "turn.completed":
      return { kind: "turn.completed" };
    default:
      return undefined;
  }
}

// Remote projection validates even host-controlled tool names against the shared grammar.
function sharedApprovalToolIdentifier(
  tool: ConversationToolReference,
): string | undefined {
  if (typeof tool.name !== "string") return undefined;
  const identifier = tool.source === undefined ? tool.name : `${tool.source}:${tool.name}`;
  return isSharedApprovalToolIdentifier(identifier) ? identifier : undefined;
}

function toHubSubscriptionOptions(
  options: PlatformConversationSubscriptionOptions,
): ConversationEventSubscriptionOptions {
  return {
    ...(options.conversationId === undefined
      ? {}
      : { sessionId: options.conversationId }),
    ...(options.afterCursor === undefined ? {} : { afterCursor: options.afterCursor }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
  };
}

function toPlatformEnvelope(
  envelope: ReturnType<ConversationEventHub["publish"]>,
): PlatformConversationEventEnvelope {
  if (envelope.channel !== TIMELINE_CHANNEL) {
    throw new TypeError("Conversation timeline received an unexpected channel.");
  }
  return {
    version: PLATFORM_CONVERSATION_PROTOCOL_VERSION,
    eventId: envelope.eventId,
    conversationId: envelope.sessionId,
    cursor: envelope.cursor,
    ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
    emittedAt: envelope.emittedAt,
    event: envelope.payload as PlatformConversationEvent,
  };
}

function toPlatformReplay(replay: ConversationEventReplay): PlatformConversationReplay {
  return {
    conversationId: replay.sessionId,
    afterCursor: replay.afterCursor,
    oldestRetainedCursor: replay.oldestRetainedCursor,
    latestCursor: replay.latestCursor,
    snapshotRequired: replay.snapshotRequired,
    events: replay.events.map((event) => toPlatformEnvelope(event)),
  };
}
