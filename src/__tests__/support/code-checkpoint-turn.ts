import { writeFile } from "node:fs/promises";
import { checkpointFileMutation, getTurnChangeReview, withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import type { TurnChangeReview, TurnReviewResult } from "../../shared/turn-change-review.js";

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

/** The project scope a test's turn changes are reviewed and decided in: its root, and no other folder. */
export function createProjectScope(getRoot: () => string) {
  return () => ({ cwd: getRoot(), extraAllowedDirectories: [] as string[] });
}

/** The latest turn's change review, with each file's current details. */
export function createCurrentTurnReview(getSessionId: () => string, scope: ReturnType<typeof createProjectScope>) {
  return () => getTurnChangeReview(getSessionId(), "latest", scope, { currentDetails: true });
}

/** The review a result carries; a refused review fails the test with its error. */
export function availableReview(result: TurnReviewResult): TurnChangeReview {
  if (!result.ok) throw new Error(result.error);
  return result.review;
}
