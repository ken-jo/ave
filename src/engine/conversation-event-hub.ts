/** Own ordered in-memory delivery; adapters own authentication, projection, and serialization. */

export const CONVERSATION_EVENT_PROTOCOL_VERSION = 1 as const;

export type ConversationEventProtocolVersion =
  typeof CONVERSATION_EVENT_PROTOCOL_VERSION;

// Payloads must be structured-cloneable to isolate producers and subscribers.
export type ConversationEventPayload = unknown;

export interface ConversationEventInput<TPayload = ConversationEventPayload> {
  readonly sessionId: string;
  readonly channel: string;
  // Projection belongs to surface adapters, not the opaque payload.
  readonly payload: TPayload;
  readonly turnId?: string;
  // Live-only events do not occupy the replay window.
  readonly replay?: boolean;
}

/** Cursors order one session, not all sessions; event IDs deduplicate within the hub lifetime. */
export interface ConversationEventEnvelope<
  TPayload = ConversationEventPayload,
> {
  readonly version: ConversationEventProtocolVersion;
  readonly eventId: string;
  readonly sessionId: string;
  readonly cursor: number;
  readonly channel: string;
  readonly turnId?: string;
  readonly emittedAt: number;
  readonly payload: TPayload;
}

/** Listeners are synchronous; adapters must queue async work and handle its rejections. */
export type ConversationEventListener = (
  event: ConversationEventEnvelope,
) => void;

export interface ConversationEventSubscriptionOptions {
  // Session filters apply to live delivery and replay.
  readonly sessionId?: string;
  // Replay excludes this session-local cursor itself.
  readonly afterCursor?: number;
  // Replay precedes live events and is disabled by default.
  readonly replay?: "none" | "available";
}

/** snapshotRequired means the adapter must fetch host state before treating replay as complete. */
export interface ConversationEventReplay {
  readonly sessionId: string;
  readonly afterCursor: number | null;
  readonly oldestRetainedCursor: number | null;
  readonly latestCursor: number;
  readonly snapshotRequired: boolean;
  readonly events: readonly ConversationEventEnvelope[];
}

export interface ConversationEventSubscription {
  readonly replay: ConversationEventReplay | undefined;
  unsubscribe(): void;
}

export interface ConversationEventHubOptions {
  // Zero disables retention; the default is 256 events per session.
  readonly replayLimitPerSession?: number;
  // Scoped subscribers pin state; inactive session states are evicted by LRU.
  readonly maxTrackedSessions?: number;
  // Timestamp seams must return finite numbers.
  readonly now?: () => number;
}

export interface ConversationEventHub {
  publish<TPayload>(
    input: ConversationEventInput<TPayload>,
  ): ConversationEventEnvelope<TPayload>;
  // A throwing subscriber must not block other surfaces.
  subscribe(
    listener: ConversationEventListener,
    options?: ConversationEventSubscriptionOptions,
  ): ConversationEventSubscription;
  read(
    sessionId: string,
    options?: { readonly afterCursor?: number },
  ): ConversationEventReplay;
  subscriberCount(): number;
}

type StoredSession = {
  latestCursor: number;
  events: ConversationEventEnvelope[];
};

type Subscriber = {
  listener: ConversationEventListener;
  sessionId: string | undefined;
  active: boolean;
  delivering: boolean;
  pending: ConversationEventEnvelope[];
};

const DEFAULT_REPLAY_LIMIT_PER_SESSION = 256;
const DEFAULT_MAX_TRACKED_SESSIONS = 256;

/** Adapters enforce authentication and privacy before publishing or rendering hub payloads. */
export function createConversationEventHub(
  options: ConversationEventHubOptions = {},
): ConversationEventHub {
  const replayLimit = validateReplayLimit(
    options.replayLimitPerSession ?? DEFAULT_REPLAY_LIMIT_PER_SESSION,
  );
  const maxTrackedSessions = validateTrackedSessionLimit(
    options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS,
  );
  const now = options.now ?? Date.now;
  const sessions = new Map<string, StoredSession>();
  const cursorTombstones = new Map<string, number>();
  let publishedEventCount = 0;
  let hasForgottenCursorTombstone = false;
  const subscribers = new Set<Subscriber>();

  function publish<TPayload>(
    input: ConversationEventInput<TPayload>,
  ): ConversationEventEnvelope<TPayload> {
    const sessionId = validateOpaqueId(input.sessionId, "sessionId");
    const channel = validateOpaqueId(input.channel, "channel");
    const turnId = input.turnId === undefined
      ? undefined
      : validateOpaqueId(input.turnId, "turnId");
    const emittedAt = now();
    if (!Number.isFinite(emittedAt)) {
      throw new RangeError("Conversation event clock must return a finite number.");
    }

    const existingSession = getTrackedSession(sessionId);
    const tombstoneLatestCursor = existingSession === undefined
      ? getCursorTombstone(sessionId)
      : undefined;
    const nextPublishedEventCount = publishedEventCount + 1;
    const session = existingSession ?? {
      latestCursor: tombstoneLatestCursor
        ?? (hasForgottenCursorTombstone ? nextPublishedEventCount - 1 : 0),
      events: [],
    };
    const cursor = session.latestCursor + 1;
    const stored = cloneEnvelope({
      version: CONVERSATION_EVENT_PROTOCOL_VERSION,
      eventId: createEventId(sessionId, cursor),
      sessionId,
      cursor,
      channel,
      ...(turnId === undefined ? {} : { turnId }),
      emittedAt,
      payload: input.payload,
    }) as ConversationEventEnvelope;

    session.latestCursor = cursor;
    if (input.replay !== false && replayLimit > 0) {
      session.events.push(stored);
      if (session.events.length > replayLimit) {
        session.events.splice(0, session.events.length - replayLimit);
      }
    }
    if (existingSession === undefined && tombstoneLatestCursor !== undefined) {
      cursorTombstones.delete(sessionId);
    }
    touchSession(sessionId, session);
    publishedEventCount = nextPublishedEventCount;
    evictInactiveSessions(sessionId);

    const targets = [...subscribers].filter((subscriber) =>
      subscriber.active && matchesSession(subscriber, stored));
    for (const subscriber of targets) subscriber.pending.push(stored);
    for (const subscriber of targets) drainSubscriber(subscriber);

    return cloneEnvelope(stored) as ConversationEventEnvelope<TPayload>;
  }

  function read(
    rawSessionId: string,
    readOptions: { readonly afterCursor?: number } = {},
  ): ConversationEventReplay {
    const sessionId = validateOpaqueId(rawSessionId, "sessionId");
    const afterCursor = readOptions.afterCursor === undefined
      ? null
      : validateCursor(readOptions.afterCursor, "afterCursor");
    const session = getTrackedSession(sessionId);
    const tombstoneLatestCursor = session === undefined
      ? getCursorTombstone(sessionId)
      : undefined;
    const latestCursor = session?.latestCursor
      ?? tombstoneLatestCursor
      ?? 0;
    const oldestRetainedCursor = session?.events[0]?.cursor ?? null;
    const snapshotRequired = afterCursor !== null && (
      hasReplayGap(afterCursor, latestCursor, oldestRetainedCursor)
      // After tombstone eviction, unknown cursor-bearing sessions require a snapshot.
      || (session === undefined && tombstoneLatestCursor === undefined
        && hasForgottenCursorTombstone)
    );
    const events = (session?.events ?? [])
      .filter((event) => afterCursor === null || event.cursor > afterCursor)
      .map((event) => cloneEnvelope(event));

    return {
      sessionId,
      afterCursor,
      oldestRetainedCursor,
      latestCursor,
      snapshotRequired,
      events,
    };
  }

  function subscribe(
    listener: ConversationEventListener,
    subscribeOptions: ConversationEventSubscriptionOptions = {},
  ): ConversationEventSubscription {
    if (typeof listener !== "function") {
      throw new TypeError("Conversation event listener must be a function.");
    }
    const sessionId = subscribeOptions.sessionId === undefined
      ? undefined
      : validateOpaqueId(subscribeOptions.sessionId, "sessionId");
    const afterCursor = subscribeOptions.afterCursor === undefined
      ? undefined
      : validateCursor(subscribeOptions.afterCursor, "afterCursor");
    if (afterCursor !== undefined && sessionId === undefined) {
      throw new TypeError("afterCursor requires a sessionId.");
    }
    if (subscribeOptions.replay === "available" && sessionId === undefined) {
      throw new TypeError("Replay requires a sessionId.");
    }
    if (subscribeOptions.replay !== undefined
      && subscribeOptions.replay !== "none"
      && subscribeOptions.replay !== "available") {
      throw new TypeError("Conversation event replay must be 'none' or 'available'.");
    }

    const subscriber: Subscriber = {
      listener,
      sessionId,
      active: true,
      delivering: false,
      pending: [],
    };
    subscribers.add(subscriber);

    const replay = sessionId === undefined
      ? undefined
      : read(sessionId, { afterCursor });
    if (subscribeOptions.replay === "available" && replay !== undefined && replay.events.length > 0) {
      // Queue the entire replay tail before callbacks can publish re-entrant live events.
      subscriber.pending.push(...replay.events);
      drainSubscriber(subscriber);
    }

    let active = true;
    return {
      replay,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        subscriber.active = false;
        subscriber.pending.length = 0;
        subscribers.delete(subscriber);
        evictInactiveSessions();
      },
    };
  }

  function subscriberCount(): number {
    return subscribers.size;
  }

  function drainSubscriber(subscriber: Subscriber): void {
    if (!subscriber.active || subscriber.delivering) return;
    subscriber.delivering = true;
    try {
      while (subscriber.active && subscriber.pending.length > 0) {
        const event = subscriber.pending.shift();
        if (!event) continue;
        try {
          // Detach each subscriber snapshot so one mutation or throw cannot affect another.
          subscriber.listener(cloneEnvelope(event));
        } catch {
          // Observer failures must not block the runtime.
        }
      }
    } finally {
      subscriber.delivering = false;
    }
  }

  function getTrackedSession(sessionId: string): StoredSession | undefined {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    touchSession(sessionId, session);
    return session;
  }

  function getCursorTombstone(sessionId: string): number | undefined {
    const latestCursor = cursorTombstones.get(sessionId);
    if (latestCursor === undefined) return undefined;
    // Tombstone LRU retains exact cursor floors for recently read or resumed sessions.
    cursorTombstones.delete(sessionId);
    cursorTombstones.set(sessionId, latestCursor);
    return latestCursor;
  }

  function touchSession(sessionId: string, session: StoredSession): void {
    // Delete before set: updating an existing Map key does not refresh LRU order.
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
  }

  function evictInactiveSessions(currentSessionId?: string): void {
    while (sessions.size > maxTrackedSessions) {
      const oldestInactiveSessionId = [...sessions.keys()].find((sessionId) =>
        sessionId !== currentSessionId && !hasActiveScopedSubscriber(sessionId)
      );
      if (oldestInactiveSessionId === undefined) break;

      const evictedSession = sessions.get(oldestInactiveSessionId);
      sessions.delete(oldestInactiveSessionId);
      if (evictedSession) {
        rememberCursorTombstone(
          oldestInactiveSessionId,
          evictedSession.latestCursor,
        );
      }
    }
    evictInactiveCursorTombstones();
  }

  function rememberCursorTombstone(sessionId: string, latestCursor: number): void {
    cursorTombstones.delete(sessionId);
    cursorTombstones.set(sessionId, latestCursor);
    evictInactiveCursorTombstones();
  }

  function evictInactiveCursorTombstones(): void {
    while (cursorTombstones.size > maxTrackedSessions) {
      const oldestInactiveSessionId = [...cursorTombstones.keys()].find(
        (sessionId) => !hasActiveScopedSubscriber(sessionId),
      );
      if (oldestInactiveSessionId === undefined) break;
      cursorTombstones.delete(oldestInactiveSessionId);
      // Seed forgotten sessions above the publication floor to prevent cursor or event ID collisions.
      hasForgottenCursorTombstone = true;
    }
  }

  function hasActiveScopedSubscriber(sessionId: string): boolean {
    // Unscoped listeners cannot pin unbounded history; scoped subscriptions own replay continuity.
    return [...subscribers].some((subscriber) =>
      subscriber.active && subscriber.sessionId === sessionId
    );
  }

  return { publish, subscribe, read, subscriberCount };
}

function matchesSession(subscriber: Subscriber, event: ConversationEventEnvelope): boolean {
  return subscriber.sessionId === undefined || subscriber.sessionId === event.sessionId;
}

function hasReplayGap(
  afterCursor: number,
  latestCursor: number,
  oldestRetainedCursor: number | null,
): boolean {
  if (afterCursor >= latestCursor) return false;
  const firstAvailable = oldestRetainedCursor ?? latestCursor + 1;
  return afterCursor < firstAvailable - 1;
}

function validateReplayLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("replayLimitPerSession must be a non-negative safe integer.");
  }
  return value;
}

function validateTrackedSessionLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("maxTrackedSessions must be a positive safe integer.");
  }
  return value;
}

function validateCursor(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(label + " must be a non-negative safe integer.");
  }
  return value;
}

function validateOpaqueId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(label + " must be a non-empty string.");
  }
  return value;
}

function createEventId(sessionId: string, cursor: number): string {
  return "conversation-event/v" + CONVERSATION_EVENT_PROTOCOL_VERSION
    + "/" + encodeURIComponent(sessionId) + "/" + cursor;
}

function cloneEnvelope<TPayload>(
  event: ConversationEventEnvelope<TPayload>,
): ConversationEventEnvelope<TPayload> {
  try {
    return structuredClone(event);
  } catch {
    throw new TypeError("Conversation event payload must be structured-cloneable.");
  }
}
