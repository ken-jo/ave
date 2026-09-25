/**
 * Error codes of the git marketplace (design §14).
 *
 * Every failure the marketplace reports to the renderer carries one of these
 * codes; the renderer maps a code to its `marketplace.error.*` message. A
 * failure without a code is a bug, not a user-facing state, so nothing here
 * has an "unknown" member.
 */
export const MARKETPLACE_ERROR_CODES = [
  "GIT_RUNTIME_MISSING",
  "GIT_RUNTIME_TOO_OLD",
  "GIT_RUNTIME_INSTALL_FAILED",
  "SOURCE_URL_REJECTED",
  "SOURCE_POLICY_BLOCKED",
  "SOURCE_NAME_RESERVED",
  "SOURCE_ID_INVALID",
  "SOURCE_ID_TAKEN",
  "SOURCE_AUTH_REQUIRED",
  "SOURCE_SSH_HOST_UNKNOWN",
  "SOURCE_REF_NOT_FOUND",
  "SOURCE_UNREACHABLE",
  "SOURCE_NOT_A_MARKETPLACE",
  "SOURCE_INDEX_INVALID",
  "SOURCE_HISTORY_REWRITTEN",
  "SOURCE_DISABLED",
  "PLAN_EXPIRED",
  "PACKAGE_INCOMPATIBLE",
  "PACKAGE_COMPAT_UNDECLARED",
  "PACKAGE_YANKED",
  "PACKAGE_REVOKED",
  "PACKAGE_ID_CONFLICT",
  "PACKAGE_REQUIRED_BY_POLICY",
  "PACKAGE_POLICY_BLOCKED",
  "ARTIFACT_NOT_PINNED",
  "ARTIFACT_DIGEST_MISMATCH",
  "MANIFEST_MISMATCH",
  "NO_INSTALLABLE_ARTIFACT",
  "CONTENT_RULE_VIOLATION",
] as const;

export type MarketplaceErrorCode = (typeof MARKETPLACE_ERROR_CODES)[number];

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MarketplaceError";
  }
}

export function isMarketplaceError(error: unknown): error is MarketplaceError {
  return error instanceof MarketplaceError;
}
