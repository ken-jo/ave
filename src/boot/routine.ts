import { ConversationLoop } from "../engine/conversation-loop.js";
import { RoutineEngine } from "../routines/routine-engine.js";
import type { Routine } from "../routines/routine-engine.js";

export function createRoutineEngine(opts: {
  createConversationLoop: (input: Routine) => ConversationLoop;
  /** Snapshot the active plugin set when resolving inherited routine scope. */
  getActivePluginIds?: () => string[];
}): RoutineEngine {
  return new RoutineEngine({
    createConversationLoop: opts.createConversationLoop,
    getActivePluginIds: opts.getActivePluginIds,
  });
}
