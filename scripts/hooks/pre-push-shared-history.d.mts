import type { GitRunner, PrePushRefUpdate } from "./pre-push-ref-updates.mjs";

export type RemoteDefaultHead = { ref: string; sha: string } | { empty: true };

export declare function parseRemoteDefaultHead(text: string): RemoteDefaultHead | null;

export interface SharedHistoryVerdict {
  kind: "skip" | "ok" | "refuse";
  message: string;
}

export declare function checkSharedHistory(options: {
  updates: PrePushRefUpdate[];
  remoteName: string | null;
  remoteLocation: string | null;
  git: GitRunner;
  fetchGit: GitRunner;
}): SharedHistoryVerdict;
