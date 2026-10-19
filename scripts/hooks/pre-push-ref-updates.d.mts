/** One ref update as git reports it on the pre-push hook's stdin. */
export interface PrePushRefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface PrePushInput {
  /**
   * Whether git's ref-update list was successfully read. False means nothing
   * is known about the push — distinct from a list that was read and is empty.
   */
  readable: boolean;
  text: string;
}

export interface PrePushUpdates {
  updates: PrePushRefUpdate[];
  /**
   * Every reported ref update was understood, so a caller enforcing branch
   * policy is deciding on the real set. False for an unreadable input or a
   * malformed line.
   */
  complete: boolean;
}

export declare function isIntegrationBranchRef(ref: string): boolean;

export interface RemoteHeads {
  defaultRef: string;
  heads: Map<string, string>;
}
export interface BaseCandidate {
  ref: string;
  sha: string;
}
export interface GitResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}
export type GitRunner = (args: string[]) => GitResult;

export declare function parseRemoteHeads(text: string): RemoteHeads | null;
export declare function selectBaseCandidates(remoteHeads: RemoteHeads): BaseCandidate[];
export declare function findMissingCandidateTips(candidates: BaseCandidate[], git: GitRunner): BaseCandidate[];
export declare function chooseNewBranchBase(
  localSha: string,
  candidates: BaseCandidate[],
  git: GitRunner,
): { ref: string; sha: string; count: number } | null;

export declare function parsePrePushUpdates(input: PrePushInput): PrePushUpdates;

/** Name the branch a `HEAD` update pushes when HEAD is that branch at the pushed commit. */
export declare function resolveHeadUpdates(
  parsed: PrePushUpdates,
  headBranch: () => { ref: string; sha: string } | null,
): PrePushUpdates;

/**
 * Read git's ref-update list from the hook's stdin. `readable: false` means
 * the list could not be read at all, which is not the same as an empty one.
 */
export declare function readPrePushInput(): PrePushInput;
