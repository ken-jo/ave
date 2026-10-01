/**
 * Error codes of the git marketplace (design §14, §18.8).
 *
 * Every failure the marketplace reports to the renderer carries one of these
 * codes; the renderer maps a code to its `gitMarketplace.*` sentence. A
 * failure without a code is a bug, not a user-facing state, so nothing here
 * has an "unknown" member.
 *
 * A failure may also carry a `detail`: why it happened and the values its
 * sentence names (host, ref, rule …). The reasons a code can carry are the
 * keys of {@link MARKETPLACE_ERROR_DETAIL_FIELDS}; a failure without a detail
 * renders its code's reason-less sentence.
 */
import { scrubDiagnosticSecrets } from "../shared/dlp.js";

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
  "SOURCE_LOCAL_DATA_DAMAGED",
  "SOURCE_LIST_UNREADABLE",
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
  "process-entry-unconfined",
  "process-entry-requires-pinned-artifact",
  "NO_INSTALLABLE_ARTIFACT",
  "CONTENT_RULE_VIOLATION",
] as const;

export type MarketplaceErrorCode = (typeof MARKETPLACE_ERROR_CODES)[number];

/**
 * A detail field's type. `string` is a structured identifier the code built
 * (a host, a ref, a rule, a path); `text` is diagnostic text from elsewhere
 * (a parser's or a proxy configuration's own words), which may quote a
 * secret and is scrubbed wherever a detail leaves main or is stored
 * ({@link scrubMarketplaceErrorDetail}).
 */
type DetailFieldKind = "string" | "text" | "number" | "string[]";

/**
 * The reasons each code can carry, and the fields of each reason's detail
 * with their types. A detail is checked against this table wherever it
 * crosses a boundary (the IPC envelope, a source's `state.json`), so a reason
 * the code does not have, or a field of the wrong type, never reaches a
 * sentence.
 */
export const MARKETPLACE_ERROR_DETAIL_FIELDS = {
  /** The install phase that failed (§9.2); `installing` is the final move into place. */
  GIT_RUNTIME_INSTALL_FAILED: {
    checking: {},
    downloading: {},
    verifying: {},
    extracting: {},
    "smoke-testing": {},
    installing: {},
  },
  SOURCE_URL_REJECTED: {
    "credentials-in-url": {},
    "scheme-unsupported": { scheme: "string" },
    format: {},
  },
  SOURCE_POLICY_BLOCKED: {
    "blocked-by-pattern": { target: "string", pattern: "string", policyPath: "string" },
    "not-in-allow-list": { target: "string", policyPath: "string" },
    "policy-invalid": { error: "text" },
  },
  /**
   * `token-no-access`: the host answered "repository not found" after Ave
   * offered the stored token, so the token may not reach the repository.
   */
  SOURCE_AUTH_REQUIRED: {
    token: { host: "string" },
    "token-no-access": { host: "string" },
    ssh: { host: "string" },
  },
  SOURCE_SSH_HOST_UNKNOWN: {
    unknown: { host: "string", port: "number" },
    changed: { host: "string", port: "number" },
  },
  SOURCE_REF_NOT_FOUND: {
    missing: { ref: "string", repository: "string", available: "string[]" },
  },
  /**
   * `not-found` and `not-found-ssh`: the host answered "repository not
   * found" without a token from Ave. Hosts give that answer for a private
   * repository too, so neither says which it is.
   */
  SOURCE_UNREACHABLE: {
    offline: {},
    dns: { host: "string" },
    refused: { host: "string" },
    timeout: { host: "string" },
    "http-status": { host: "string", status: "number" },
    tls: { host: "string" },
    proxy: { host: "string", proxy: "text" },
    "not-found": { host: "string" },
    "not-found-ssh": { host: "string" },
  },
  /**
   * The source's downloaded copy under `marketplaces/<id>` (§2.1) cannot be
   * used; Repair moves it aside and syncs the source again. The `state-*`
   * reasons lost the pin, so Repair trusts the history the source serves
   * then; `snapshot-*` and `repository-damaged` keep it. `repair-failed` is
   * moving the copy aside failing with a pin kept, `repair-failed-unpinned`
   * the same without a pin to keep, `repair-write-failed` writing the kept
   * pin back; none loses a readable pin.
   */
  SOURCE_LOCAL_DATA_DAMAGED: {
    "state-missing": { sourceId: "string" },
    "state-invalid": { sourceId: "string" },
    "state-unreadable": { sourceId: "string" },
    "snapshot-invalid": { sourceId: "string" },
    "snapshot-unreadable": { sourceId: "string" },
    "repository-damaged": { sourceId: "string" },
    "repair-failed": { sourceId: "string" },
    "repair-failed-unpinned": { sourceId: "string" },
    "repair-write-failed": { sourceId: "string" },
  },
  /**
   * `marketplaces/sources.json`, the list of sources the user added, cannot
   * be read (`fsCode` is the fs error's code) or is not in the format Ave
   * writes; the registry changes no source until it is fixed or deleted.
   * No repair: the file is the user's data.
   */
  SOURCE_LIST_UNREADABLE: {
    unreadable: { fsCode: "string" },
    invalid: {},
  },
  PACKAGE_INCOMPATIBLE: {
    min_app_version: { name: "string", version: "string" },
    platform: { name: "string", platform: "string" },
    host_protocol: { name: "string" },
  },
} as const satisfies Partial<Record<MarketplaceErrorCode, Record<string, Record<string, DetailFieldKind>>>>;

type DetailFields = typeof MARKETPLACE_ERROR_DETAIL_FIELDS;
type FieldValue<K> = K extends "string" | "text" ? string : K extends "number" ? number : K extends "string[]" ? readonly string[] : never;
type DetailOf<C extends keyof DetailFields> = {
  [R in keyof DetailFields[C]]: { reason: R } & { -readonly [F in keyof DetailFields[C][R]]: FieldValue<DetailFields[C][R][F]> };
}[keyof DetailFields[C]];

/** The detail a failure with code `C` may carry; `never` for a code without reasons. */
export type MarketplaceErrorDetail<C extends MarketplaceErrorCode = MarketplaceErrorCode> = C extends keyof DetailFields ? DetailOf<C> : never;

/** Every code that has reasons, paired with each of its reasons. */
export const MARKETPLACE_ERROR_REASONS: ReadonlyArray<readonly [MarketplaceErrorCode, string]> = Object.entries(MARKETPLACE_ERROR_DETAIL_FIELDS).flatMap(
  ([code, reasons]) => Object.keys(reasons).map((reason) => [code as MarketplaceErrorCode, reason] as const),
);

function fieldMatches(value: unknown, kind: DetailFieldKind): boolean {
  if (kind === "string" || kind === "text") return typeof value === "string";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * `value` as the detail of a failure with `code`, or undefined when it is not
 * one: a code without reasons, a reason of another code, or a field that is
 * missing, extra or of the wrong type. The caller keeps the code and drops
 * the detail.
 */
export function parseMarketplaceErrorDetail<C extends MarketplaceErrorCode>(code: C, value: unknown): MarketplaceErrorDetail<C> | undefined;
export function parseMarketplaceErrorDetail(code: string, value: unknown): MarketplaceErrorDetail | undefined;
export function parseMarketplaceErrorDetail(code: string, value: unknown): MarketplaceErrorDetail | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(MARKETPLACE_ERROR_DETAIL_FIELDS, code)) return undefined;
  const reasons: Readonly<Record<string, Readonly<Record<string, DetailFieldKind>>>> = MARKETPLACE_ERROR_DETAIL_FIELDS[code as keyof DetailFields];
  const record = value as Record<string, unknown>;
  if (typeof record.reason !== "string" || !Object.hasOwn(reasons, record.reason)) return undefined;
  const fields = reasons[record.reason]!;
  const keys = Object.keys(record).filter((key) => key !== "reason");
  if (keys.length !== Object.keys(fields).length) return undefined;
  for (const key of keys) {
    if (!Object.hasOwn(fields, key) || !fieldMatches(record[key], fields[key]!)) return undefined;
  }
  return { ...record } as MarketplaceErrorDetail;
}

/**
 * `detail` with every `text` field scrubbed of credentials; identifiers are
 * kept as they are. Called once at each boundary a detail crosses: the IPC
 * envelope, the source status view, the stored `lastSync.detail` and the git
 * runtime status.
 */
export function scrubMarketplaceErrorDetail<D extends MarketplaceErrorDetail>(code: MarketplaceErrorCode, detail: D): D {
  if (parseMarketplaceErrorDetail(code, detail) === undefined) throw new TypeError(`${JSON.stringify(detail)} is not a detail of ${code}`);
  const fields: Readonly<Record<string, DetailFieldKind>> = (MARKETPLACE_ERROR_DETAIL_FIELDS[code as keyof DetailFields] as Readonly<Record<string, Readonly<Record<string, DetailFieldKind>>>>)[detail.reason]!;
  const scrubbed: Record<string, unknown> = { ...detail };
  for (const [field, kind] of Object.entries(fields)) {
    if (kind === "text") scrubbed[field] = scrubDiagnosticSecrets(scrubbed[field] as string);
  }
  return scrubbed as D;
}

export class MarketplaceError extends Error {
  readonly detail: MarketplaceErrorDetail | undefined;

  /** A `detail` must be one of `code`'s reasons; anything else is a bug and throws here. */
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: MarketplaceErrorDetail },
  ) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "MarketplaceError";
    if (options?.detail !== undefined && parseMarketplaceErrorDetail(code, options.detail) === undefined) {
      throw new TypeError(`${JSON.stringify(options.detail)} is not a detail of ${code}`);
    }
    this.detail = options?.detail;
  }
}

export function isMarketplaceError(error: unknown): error is MarketplaceError {
  return error instanceof MarketplaceError;
}
