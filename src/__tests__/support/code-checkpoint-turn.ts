import { withCodeCheckpoint } from "../../memory/code-checkpoints.js";

export function createCodeCheckpointTurn(getSessionId: () => string) {
  return <T>(messageId: string, run: () => Promise<T>) =>
    withCodeCheckpoint({ sessionId: getSessionId(), messageId }, run);
}
