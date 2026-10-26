// Retain only explicitly shared events from the canonical timeline for bounded replay and snapshots.
// Never retain owner-only tools, reasoning, resources, paths, or memory.
import {
  projectSharedConversationEvent,
  type PlatformConversationEventEnvelope,
  type PlatformConversationTimeline,
  type SharedConversationProjectionEvent,
} from "./conversation-platform-protocol.js";
import { requirePositiveInteger } from "../shared/safe-integer.js";

// Safe surfaces can validate failure summaries without importing owner-detail contracts.
export { toSafeTurnFailureSummary } from "./turn-failure-summary.js";
export type { TurnFailureCategory, TurnFailureSummary } from "./turn-failure-summary.js";

export const SHARED_CONVERSATION_PROTOCOL_VERSION = 1 as const;

export interface SharedConversationEventEnvelope {
  readonly version: typeof SHARED_CONVERSATION_PROTOCOL_VERSION;
  readonly conversationId: string;
  // Dense projection cursors advance only for shared events.
  readonly cursor: number;
  readonly emittedAt: number;
  readonly event: SharedConversationProjectionEvent;
}

interface SharedConversationReplay {
  readonly conversationId: string;
  readonly afterCursor: number | null;
  readonly oldestRetainedCursor: number | null;
  readonly latestCursor: number;
  // Missing replay continuity requires a new safe snapshot.
  readonly snapshotRequired: boolean;
  readonly events: readonly SharedConversationEventEnvelope[];
}

export interface SharedConversationSnapshot {
  readonly version: typeof SHARED_CONVERSATION_PROTOCOL_VERSION;
  readonly conversationId: string;
  readonly cursor: number;
  readonly updatedAt: number | null;
  /** The host activity coordinator is authoritative for this value. */
  readonly busy: boolean;
  readonly awaitingLocalApproval: boolean;
  /** Bounded visible assistant text; never reasoning or tool output. */
  readonly assistantText: string;
}

export interface SharedConversationProjectionSubscription {
  readonly replay: SharedConversationReplay;
  unsubscribe(): void;
}

export interface SharedConversationProjectionStore {
  start(): void;
  stop(): void;
  isStarted(): boolean;
  read(conversationId: string, options?: { readonly afterCursor?: number }): SharedConversationReplay;
  snapshot(conversationId: string, host: { readonly busy: boolean }): SharedConversationSnapshot;
  subscribe(
    conversationId: string,
    listener: (event: SharedConversationEventEnvelope) => void,
    options?: { readonly afterCursor?: number },
  ): SharedConversationProjectionSubscription;
  subscriberCount(): number;
}

export interface SharedConversationProjectionStoreOptions {
  // Default replay retention is 256 events per conversation.
  readonly replayLimitPerConversation?: number;
  // Default tracked-state cap is 32 conversations.
  readonly maxTrackedConversations?: number;
  // Default assistant-text retention is 16 KiB per conversation.
  readonly maxAssistantTextChars?: number;
}

type ConversationState = {
  latestCursor: number;
  updatedAt: number | null;
  events: SharedConversationEventEnvelope[];
  assistantText: string;
  awaitingLocalApproval: boolean;
};

type Subscriber = {
  readonly conversationId: string;
  readonly listener: (event: SharedConversationEventEnvelope) => void;
  active: boolean;
};

const DEFAULT_REPLAY_LIMIT = 256;
const DEFAULT_TRACKED_CONVERSATIONS = 32;
const DEFAULT_ASSISTANT_TEXT_CHARS = 16 * 1024;

export function createSharedConversationProjectionStore(
  timeline: PlatformConversationTimeline,
  options: SharedConversationProjectionStoreOptions = {},
): SharedConversationProjectionStore {
  const replayLimit = requirePositiveInteger(
    options.replayLimitPerConversation ?? DEFAULT_REPLAY_LIMIT,
    `replayLimitPerConversation must be a positive safe integer.`,
  );
  const maxTracked = requirePositiveInteger(
    options.maxTrackedConversations ?? DEFAULT_TRACKED_CONVERSATIONS,
    `maxTrackedConversations must be a positive safe integer.`,
  );
  const maxAssistantTextChars = requirePositiveInteger(
    options.maxAssistantTextChars ?? DEFAULT_ASSISTANT_TEXT_CHARS,
    `maxAssistantTextChars must be a positive safe integer.`,
  );
  const states = new Map<string, ConversationState>();
  const subscribers = new Set<Subscriber>();
  let unsubscribeTimeline: (() => void) | undefined;
  const touch = (conversationId: string, state: ConversationState) => {
    // Delete before replacing a Map key to refresh its LRU position.
    states.delete(conversationId);
    states.set(conversationId, state);
  };

  const start = () => {
    if (unsubscribeTimeline) return;
    unsubscribeTimeline = timeline.subscribe(onTimelineEvent).unsubscribe;
  };

  const stop = () => {
    unsubscribeTimeline?.();
    unsubscribeTimeline = undefined;
  };

  const read = (
    conversationId: string,
    readOptions: { readonly afterCursor?: number } = {},
  ): SharedConversationReplay => {
    validateConversationId(conversationId);
    const afterCursor = readOptions.afterCursor === undefined
      ? null
      : validateCursor(readOptions.afterCursor);
    const state = states.get(conversationId);
    if (!state) {
      return {
        conversationId,
        afterCursor,
        oldestRetainedCursor: null,
        latestCursor: 0,
        // A cursor for evicted state requires a snapshot, never an inferred empty catch-up.
        snapshotRequired: afterCursor !== null && afterCursor > 0,
        events: [],
      };
    }
    touch(conversationId, state);
    const oldestRetainedCursor = state.events[0]?.cursor ?? null;
    const snapshotRequired = afterCursor !== null && (
      afterCursor > state.latestCursor
      || (oldestRetainedCursor !== null && afterCursor < oldestRetainedCursor - 1)
    );
    return {
      conversationId,
      afterCursor,
      oldestRetainedCursor,
      latestCursor: state.latestCursor,
      snapshotRequired,
      events: snapshotRequired
        ? []
        : state.events
          .filter((event) => afterCursor === null || event.cursor > afterCursor)
          .map(clone),
    };
  };

  const snapshot = (
    conversationId: string,
    host: { readonly busy: boolean },
  ): SharedConversationSnapshot => {
    validateConversationId(conversationId);
    const state = states.get(conversationId);
    if (state) touch(conversationId, state);
    return {
      version: SHARED_CONVERSATION_PROTOCOL_VERSION,
      conversationId,
      cursor: state?.latestCursor ?? 0,
      updatedAt: state?.updatedAt ?? null,
      busy: host.busy,
      awaitingLocalApproval: state?.awaitingLocalApproval ?? false,
      assistantText: state?.assistantText ?? "",
    };
  };

  const subscribe = (
    conversationId: string,
    listener: (event: SharedConversationEventEnvelope) => void,
    subscribeOptions: { readonly afterCursor?: number } = {},
  ): SharedConversationProjectionSubscription => {
    validateConversationId(conversationId);
    if (typeof listener !== "function") {
      throw new TypeError("Shared conversation listener must be a function.");
    }
    start();
    // Synchronous read-and-subscribe prevents live events from overtaking replay.
    const replay = read(conversationId, subscribeOptions);
    const subscriber: Subscriber = { conversationId, listener, active: true };
    subscribers.add(subscriber);
    let active = true;
    return {
      replay,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        subscriber.active = false;
        subscribers.delete(subscriber);
      },
    };
  };

  const onTimelineEvent = (envelope: PlatformConversationEventEnvelope) => {
    const projected = projectSharedConversationEvent(envelope.event);
    if (!projected) return;

    // Use dense safe cursors; semantic cursor gaps disclose counts of owner-only events.
    const state = getOrCreateState(envelope.conversationId);
    state.latestCursor += 1;
    state.updatedAt = envelope.emittedAt;
    applySnapshotProjection(state, projected, maxAssistantTextChars);
    const shared: SharedConversationEventEnvelope = {
      version: SHARED_CONVERSATION_PROTOCOL_VERSION,
      conversationId: envelope.conversationId,
      cursor: state.latestCursor,
      emittedAt: envelope.emittedAt,
      event: projected,
    };
    state.events.push(shared);
    if (state.events.length > replayLimit) {
      state.events.splice(0, state.events.length - replayLimit);
    }
    for (const subscriber of [...subscribers]) {
      if (!subscriber.active || subscriber.conversationId !== envelope.conversationId) continue;
      try {
        subscriber.listener(clone(shared));
      } catch {
        // Remote observers cannot block the timeline; adapters own backpressure and disconnect policy.
      }
    }
  };

  const getOrCreateState = (conversationId: string): ConversationState => {
    const existing = states.get(conversationId);
    if (existing) {
      touch(conversationId, existing);
      return existing;
    }
    const state: ConversationState = {
      latestCursor: 0,
      updatedAt: null,
      events: [],
      assistantText: "",
      awaitingLocalApproval: false,
    };
    touch(conversationId, state);
    while (states.size > maxTracked) {
      const oldest = states.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
    return state;
  };

  return {
    start,
    stop,
    isStarted: () => unsubscribeTimeline !== undefined,
    read,
    snapshot,
    subscribe,
    subscriberCount: () => subscribers.size,
  };
}

function applySnapshotProjection(
  state: ConversationState,
  event: SharedConversationProjectionEvent,
  maxAssistantTextChars: number,
): void {
  switch (event.kind) {
    case "turn.started":
      state.assistantText = "";
      state.awaitingLocalApproval = false;
      return;
    case "assistant.text.delta":
      state.assistantText = appendBounded(state.assistantText, event.text, maxAssistantTextChars);
      return;
    case "approval.waiting-local":
      state.awaitingLocalApproval = true;
      return;
    case "tool.state":
      if (event.state === "running") state.awaitingLocalApproval = false;
      return;
    case "turn.failed":
    case "turn.completed":
      state.awaitingLocalApproval = false;
      return;
    case "compaction.started":
    case "compaction.completed":
      return;
  }
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const combined = current + chunk;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("afterCursor must be a non-negative safe integer.");
  }
  return value;
}

function validateConversationId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("conversationId must be a non-empty string.");
  }
}
