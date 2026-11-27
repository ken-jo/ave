export const WORK_DECISION_AUTHORITY_REVOKED = "remote-controller-authority-revoked";

/** Host-only evidence. Refresh after preparation, then check synchronously at the commit point. */
export interface WorkDecisionAuthority {
  refreshCurrent(): Promise<boolean>;
  isCurrent(): boolean;
}

export class WorkDecisionAuthorityError extends Error {
  readonly code = WORK_DECISION_AUTHORITY_REVOKED;

  constructor() {
    super("Remote work decision authority has been revoked");
  }
}
