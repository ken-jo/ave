/** Compose one host-owned surface runtime and inject it into every local transport. */
import {
  createConversationActivityCoordinator,
  type ConversationActivityCoordinator,
} from "./conversation-activity-coordinator.js";
import {
  createConversationTurnRegistry,
  type ConversationTurnRegistry,
} from "./conversation-turn-registry.js";
import {
  createSharedConversationProjectionStore,
  type SharedConversationProjectionStore,
} from "./shared-conversation-projection.js";
import {
  createPlatformConversationTimeline,
  type PlatformConversationTimeline,
} from "./conversation-platform-protocol.js";

export interface ConversationSurfaceRuntime {
  readonly timeline: PlatformConversationTimeline;
  /** Derived safe state used only by explicitly authorized shared surfaces. */
  readonly sharedProjection: SharedConversationProjectionStore;
  // Share execution leases and compatibility correlation IDs across surfaces.
  readonly activity: ConversationActivityCoordinator;
  /** Live public-turn ownership; only a matching host actor/share can cancel. */
  readonly turns: ConversationTurnRegistry;
}

export function createConversationSurfaceRuntime(): ConversationSurfaceRuntime {
  const timeline = createPlatformConversationTimeline();
  const sharedProjection = createSharedConversationProjectionStore(timeline);
  // Runtime ownership prevents one optional transport from silencing another.
  sharedProjection.start();
  return {
    timeline,
    sharedProjection,
    activity: createConversationActivityCoordinator(),
    turns: createConversationTurnRegistry(),
  };
}
