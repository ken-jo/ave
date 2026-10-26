// Fan out isolated receiver frames; main conversations use the canonical semantic timeline.
import type { LegacyChatStreamSink } from "../engine/conversation-platform-protocol.js";

type ChatStreamSink = LegacyChatStreamSink;

export interface StreamEventSource {
  subscribe(fn: LegacyChatStreamSink): () => void;
  subscriberCount(): number;
}

export interface StreamBroadcaster {
  sink: ChatStreamSink;
  // Unsubscribe is idempotent, including during broadcast.
  subscribe(fn: ChatStreamSink): () => void;
  subscriberCount(): number;
}

export function createStreamBroadcaster(): StreamBroadcaster {
  const subscribers = new Set<ChatStreamSink>();

  const sink: ChatStreamSink = (channel, payload) => {
    // Snapshot subscriptions so callbacks may add or remove listeners during fan-out.
    for (const fn of [...subscribers]) {
      try {
        fn(channel, payload);
      } catch {
        // One failed display sink must not block the others.
      }
    }
  };

  function subscribe(fn: ChatStreamSink): () => void {
    subscribers.add(fn);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(fn);
    };
  }

  function subscriberCount(): number {
    return subscribers.size;
  }

  return { sink, subscribe, subscriberCount };
}
