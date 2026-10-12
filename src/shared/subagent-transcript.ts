import type { SerializedHistoryMessage } from "./chat-history.js";

/** An owner-scoped read of one persisted child transcript. */
export interface SubAgentTranscriptRequest {
  originSessionId: string;
  childSessionId: string;
}

export type SubAgentTranscriptResult =
  | {
      ok: true;
      childSessionId: string;
      messages: SerializedHistoryMessage[];
      title?: string;
      spawnId?: string;
      originToolUseId?: string;
    }
  | { ok: false; error?: string };
