/** Renderer failures use stable codes and validated details; uncoded failures are bugs. */
import { CREDENTIAL_ISSUERS, scrubDiagnosticSecrets, type CredentialIssuer } from "../shared/dlp.js";
import type { SourceWarningView } from "./sources/warnings.js";

export const MARKETPLACE_ERROR_CODES = [
  "GIT_RUNTIME_MISSING",
  "GIT_RUNTIME_TOO_OLD",
  "GIT_RUNTIME_INSTALL_FAILED",
  "SOURCE_URL_REJECTED",
  "SOURCE_POLICY_BLOCKED",
  "SOURCE_CONFIRMATION_REQUIRED",
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
  "SOURCE_LOCAL_UNREADABLE",
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

/** Scrub all detail strings, including identifiers, at storage and renderer boundaries. */
type DetailFieldKind = "string" | "number" | "string[]" | "credential-issuer";

/** Validate boundary details against each code reason and its allowed field types. */
export const MARKETPLACE_ERROR_DETAIL_FIELDS = {
  GIT_RUNTIME_INSTALL_FAILED: {
    checking: {},
    downloading: {},
    verifying: {},
    extracting: {},
    "smoke-testing": {},
    installing: {},
  },
  /** Unsafe addresses and unsupported folder forms are rejected without a confirmation override. */
  SOURCE_URL_REJECTED: {
    "credentials-in-url": {},
    "helper-transport": { scheme: "string" },
    "scheme-unsupported": { scheme: "string" },
    format: {},
    "address-metadata": { host: "string", address: "string" },
    "address-unroutable": { host: "string", address: "string" },
    "catalog-this-computer": { source: "string", host: "string" },
    "deep-link-path": {},
    "relative-path": {},
    "device-path": {},
    "windows-path": {},
    "network-file-url": {},
    "unc-without-share": {},
    /** A UNC server spelled with an account (`\\user:secret@server\share`): credentials never belong in a folder path. */
    "unc-credentials": {},
    "outside-root": {},
    "folder-options": {},
    "folder-pick-unknown": {},
  },
  /** Credential-shaped ids cannot be safely round-tripped; stored legacy ids use removal-only handles. */
  SOURCE_ID_INVALID: {
    "reserved-prefix": { prefix: "string", issuer: "credential-issuer" },
    "holds-credential": {},
    "stored-id-holds-credential": {},
  },
  /** Drop credential-shaped package identifiers with diagnostics; direct packages fail the whole source. */
  SOURCE_INDEX_INVALID: {
    "name-reserved-prefix": { prefix: "string", issuer: "credential-issuer" },
    "version-reserved-prefix": { prefix: "string", issuer: "credential-issuer" },
    "component-reserved-prefix": { prefix: "string", issuer: "credential-issuer" },
    "name-holds-credential": {},
    "version-holds-credential": {},
    "component-holds-credential": {},
  },
  SOURCE_POLICY_BLOCKED: {
    "blocked-by-pattern": { target: "string", pattern: "string", policyPath: "string" },
    "not-in-allow-list": { target: "string", policyPath: "string" },
    "https-required": { target: "string", policyPath: "string" },
    "private-network-blocked": { target: "string", address: "string", policyPath: "string" },
    "local-sources-blocked": { target: "string", policyPath: "string" },
    "direct-install-blocked": { target: "string", policyPath: "string" },
    "policy-invalid": { error: "string" },
  },
  /** Confirmation reasons name the target or catalog source requiring consent. */
  SOURCE_CONFIRMATION_REQUIRED: {
    unencrypted: { host: "string" },
    "token-unencrypted": { host: "string" },
    "internal-network": { host: "string", address: "string" },
    "this-computer": { host: "string", address: "string" },
    "internal-downloads": { source: "string", host: "string" },
    "network-folder": { server: "string", path: "string" },
    "unencrypted-updates": { source: "string" },
  },
  /** Repository-not-found after offering a token may mean that token lacks access. */
  SOURCE_AUTH_REQUIRED: {
    token: { host: "string" },
    "token-no-access": { host: "string" },
    /** Plain HTTP sign-in requires token-unencrypted consent. */
    "token-unencrypted": { host: "string" },
    ssh: { host: "string" },
  },
  SOURCE_SSH_HOST_UNKNOWN: {
    unknown: { host: "string", port: "number" },
    changed: { host: "string", port: "number" },
  },
  SOURCE_REF_NOT_FOUND: {
    missing: { ref: "string", repository: "string", available: "string[]" },
  },
  /** Without a token, repository-not-found does not distinguish private from missing. */
  SOURCE_UNREACHABLE: {
    offline: {},
    dns: { host: "string" },
    refused: { host: "string" },
    timeout: { host: "string" },
    "http-status": { host: "string", status: "number" },
    tls: { host: "string" },
    proxy: { host: "string", proxy: "string" },
    "not-found": { host: "string" },
    "not-found-ssh": { host: "string" },
  },
  /** Repair preserves readable pins; state-loss repairs must trust the source current history. */
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
  /** Unreadable user registry data blocks mutations; repair must never silently replace it. */
  SOURCE_LIST_UNREADABLE: {
    unreadable: { fsCode: "string" },
    invalid: {},
  },
  /** Failed folder reads keep serving the last good snapshot and retry on the next read. */
  /** Address aliases and overlapping folders remain duplicates even under a new source id. */
  SOURCE_ID_TAKEN: {
    "repository-already-added": { url: "string", existingId: "string" },
    "folder-already-added": { path: "string", existingId: "string" },
    "folder-inside-source": { path: "string", existingId: "string", existingPath: "string" },
    "folder-contains-source": { path: "string", existingId: "string", existingPath: "string" },
  },
  SOURCE_LOCAL_UNREADABLE: {
    "not-found": { path: "string" },
    permission: { path: "string", message: "string" },
    io: { path: "string", message: "string" },
    moved: { path: "string", target: "string" },
    "not-a-directory": { path: "string" },
    "ambiguous-case": { path: "string" },
    "changed-during-read": { path: "string" },
    /** Classifier failure leaves network location unknown rather than guessed. */
    "classifier-unavailable": { path: "string" },
  },
  /** Reject escaping links, special files, normalized-name collisions and resource-limit violations. */
  CONTENT_RULE_VIOLATION: {
    "link-outside-folder": { path: "string", target: "string" },
    "link-to-network": { path: "string", target: "string" },
    "link-to-skipped": { path: "string", target: "string" },
    "special-file": { path: "string" },
    "case-collision": { path: "string" },
    limit: { path: "string", limit: "string" },
  },
  /** Folder plugins require both plugin.json and a built dist tree. */
  NO_INSTALLABLE_ARTIFACT: {
    "folder-has-no-build": { name: "string" },
  },
  /** Policy or installed-generation changes expire reviews, including component digest mismatches. */
  PLAN_EXPIRED: {
    "policy-changed": {},
    "package-changed": {},
  },
  PACKAGE_INCOMPATIBLE: {
    min_app_version: { name: "string", version: "string" },
    platform: { name: "string", platform: "string" },
    host_protocol: { name: "string" },
  },
} as const satisfies Partial<Record<MarketplaceErrorCode, Record<string, Record<string, DetailFieldKind>>>>;

type DetailFields = typeof MARKETPLACE_ERROR_DETAIL_FIELDS;
type FieldValue<K> = K extends "string" ? string : K extends "number" ? number : K extends "string[]" ? readonly string[] : K extends "credential-issuer" ? CredentialIssuer : never;
type DetailOf<C extends keyof DetailFields> = {
  [R in keyof DetailFields[C]]: { reason: R } & { -readonly [F in keyof DetailFields[C][R]]: FieldValue<DetailFields[C][R][F]> };
}[keyof DetailFields[C]];

export type MarketplaceErrorDetail<C extends MarketplaceErrorCode = MarketplaceErrorCode> = C extends keyof DetailFields ? DetailOf<C> : never;

export const MARKETPLACE_ERROR_REASONS: ReadonlyArray<readonly [MarketplaceErrorCode, string]> = Object.entries(MARKETPLACE_ERROR_DETAIL_FIELDS).flatMap(
  ([code, reasons]) => Object.keys(reasons).map((reason) => [code as MarketplaceErrorCode, reason] as const),
);

function fieldMatches(value: unknown, kind: DetailFieldKind): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (kind === "credential-issuer") return typeof value === "string" && (CREDENTIAL_ISSUERS as readonly string[]).includes(value);
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Invalid reason or detail fields are dropped while the failure code is retained. */
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

/** Scrub every nested string and key before storage or renderer egress. */
export function scrubMarketplaceStrings<T>(value: T): T {
  if (typeof value === "string") return scrubDiagnosticSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubMarketplaceStrings(item)) as T;
  if (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    // Keys are strings too (an MCP server's name keys its consent): two masked alike stay two entries.
    const scrubbed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const masked = scrubDiagnosticSecrets(key);
      let name = masked;
      for (let n = 2; Object.hasOwn(scrubbed, name); n += 1) name = `${masked} (${n})`;
      Object.defineProperty(scrubbed, name, { value: scrubMarketplaceStrings(item), enumerable: true, writable: true, configurable: true });
    }
    return scrubbed as T;
  }
  return value;
}

export function scrubMarketplaceErrorDetail<D extends MarketplaceErrorDetail>(code: MarketplaceErrorCode, detail: D): D {
  if (parseMarketplaceErrorDetail(code, detail) === undefined) throw new TypeError(`${JSON.stringify(detail)} is not a detail of ${code}`);
  return scrubMarketplaceStrings(detail);
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

/** Entered-target warnings exclude catalog downloads and enabling plaintext automatic updates. */
export type EnteredTargetWarningView = SourceWarningView & { warning: Exclude<SourceWarningView["warning"], "internal-downloads" | "unencrypted-updates"> };

/** Include all required target warnings in one confirmation; detail carries the first. */
export class ConfirmationRequiredError extends MarketplaceError {
  constructor(
    message: string,
    readonly warnings: readonly EnteredTargetWarningView[],
    options?: { cause?: unknown },
  ) {
    const first = warnings[0];
    if (!first) throw new TypeError("a confirmation needs at least one warning");
    super("SOURCE_CONFIRMATION_REQUIRED", message, { ...options, detail: confirmationDetail(first) });
    this.name = "ConfirmationRequiredError";
  }
}

function confirmationDetail(view: EnteredTargetWarningView): MarketplaceErrorDetail<"SOURCE_CONFIRMATION_REQUIRED"> {
  const host = view.host ?? "";
  switch (view.warning) {
    case "unencrypted":
    case "token-unencrypted":
      return { reason: view.warning, host };
    case "internal-network":
    case "this-computer":
      return { reason: view.warning, host, address: view.address ?? "" };
    case "network-folder":
      return { reason: view.warning, server: host, path: view.address ?? "" };
  }
}

export function isMarketplaceError(error: unknown): error is MarketplaceError {
  return error instanceof MarketplaceError;
}
