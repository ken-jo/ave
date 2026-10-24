import { writeFile } from "node:fs/promises";
import { checkpointFileMutation, withCodeCheckpoint } from "../../memory/code-checkpoints.js";

export function createCodeCheckpointTurn(getSessionId: () => string) {
  return <T>(messageId: string, run: () => Promise<T>) =>
    withCodeCheckpoint({ sessionId: getSessionId(), messageId }, run);
}

export function createCodeCheckpointEdit(getPath: () => string) {
  return (content = "agent") => {
    const path = getPath();
    return checkpointFileMutation([{ path, content }], () => writeFile(path, content));
  };
}
