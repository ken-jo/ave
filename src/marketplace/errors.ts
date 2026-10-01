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

/**
 * A detail field's type. Every string in a detail, an identifier as much as
 * a person's or a remote's text, is scrubbed wherever a detail leaves main or
 * is stored ({@link scrubMarketplaceStrings}): a grammar that admits a name
 * admits a token of the same shape, so no field is exempt. The scrubber
 * matches token shapes, not prefixes alone, so real names pass unchanged.
 */
/** `credential-issuer`: one of {@link CREDENTIAL_ISSUERS}, the issuer a reserved prefix looks like (§18.8). */
type DetailFieldKind = "string" | "number" | "string[]" | "credential-issuer";

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
  /**
   * The address refusals of §18.3 #1–4 and #7: a `<helper>::` transport, a
   * credential in the address, a metadata or unroutable address (entered or
   * named by a catalog, on the address the connection would use), a
   * catalog download to another service on this computer, and a folder in a
   * deep link. None has a confirmation.
   *
   * The folder forms Ave cannot read (§18.3, §18.4.1 stage 1), each with
   * what to enter instead: a relative path (`./x`, `C:foo`, `~user`), a
   * Windows device path, a drive or UNC path on macOS or Linux, a `file:`
   * URL naming another computer there, a UNC path without its share, a `..`
   * that climbs above the drive, share or `/`, and a branch, folder field or
   * sign-in given with a folder, which has none of them.
   */
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
    /** A *Choose folder…* selection main no longer holds (replaced, used for an add, or too old) or never made (§18.9). */
    "folder-pick-unknown": {},
  },
  /**
   * An id the user entered that has a credential's shape (§18.8): the
   * renderer only ever sees it masked, so it could never be named again.
   * `reserved-prefix`: it holds a credential format's prefix at a boundary
   * (`glpat-…`), named with the issuer it looks like so the user knows what
   * to change; `holds-credential`: a shape with no prefix to name.
   * `stored-id-holds-credential`: a source an earlier build stored under
   * such an id, named by its row's handle for anything but Remove.
   */
  SOURCE_ID_INVALID: {
    "reserved-prefix": { prefix: "string", issuer: "credential-issuer" },
    "holds-credential": {},
    "stored-id-holds-credential": {},
  },
  /**
   * A package whose name, version or component name has a credential's
   * shape (§18.8): `*-reserved-prefix` when it holds a credential format's
   * prefix, named with its issuer, `*-holds-credential` for a shape with no
   * prefix to name. A marketplace drops such a package with a diagnostic; a
   * direct package, which is the whole source, fails with this reason.
   */
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
    /** `allowLocalSources: false`: no folder is a source or a direct install (§18.6). */
    "local-sources-blocked": { target: "string", policyPath: "string" },
    /** `allowDirectInstall: false`: packages install from marketplaces only (§12). */
    "direct-install-blocked": { target: "string", policyPath: "string" },
    "policy-invalid": { error: "string" },
  },
  /**
   * A target needs a confirmation the source does not hold (§18.2, §18.5):
   * the reason is the warning, with the host (and the address it resolved
   * to) or, for `internal-downloads`, the source whose catalog named the host.
   */
  SOURCE_CONFIRMATION_REQUIRED: {
    unencrypted: { host: "string" },
    "token-unencrypted": { host: "string" },
    "internal-network": { host: "string", address: "string" },
    "this-computer": { host: "string", address: "string" },
    "internal-downloads": { source: "string", host: "string" },
    /** A folder on another computer (§18.4.1 stage 2): the server, empty when the drive's mapping names none, and the folder. */
    "network-folder": { server: "string", path: "string" },
  },
  /**
   * `token-no-access`: the host answered "repository not found" after Ave
   * offered the stored token, so the token may not reach the repository.
   */
  SOURCE_AUTH_REQUIRED: {
    token: { host: "string" },
    "token-no-access": { host: "string" },
    /** The host wants sign-in over plain http, and the source does not hold `token-unencrypted` (§18.2.2). */
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
    proxy: { host: "string", proxy: "string" },
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
  /**
   * A folder source, or a folder being added, cannot be read (§18.4): gone
   * (`not-found`), refused by the system (`permission`, `io`, with the
   * system's message), now pointing elsewhere than the folder that was
   * added (`moved`), not a folder, spelled ambiguously on a case-sensitive
   * volume, or changed while it was read. The last good snapshot stays
   * served, and the next read tries again.
   */
  /**
   * A repository that is already a source under any spelling of its address
   * (`url` is the address being added, normalized), or a folder that
   * overlaps a folder source (§18.4.4): the same directory, one inside it,
   * or one containing it, by path or through an alias. A new id cannot
   * resolve these; the sentence says which source and what to do. A taken
   * id alone has no detail: choosing another id resolves it.
   */
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
    /** The Windows folder classifier is missing or broken (§18.4.1 stage 2): Ave cannot tell whether `path` is on another computer. */
    "classifier-unavailable": { path: "string" },
  },
  /**
   * A folder's file breaks a reading rule (§18.4.5, §5.4, §5.5): a link that
   * leaves the folder or names another computer (never followed), a device,
   * socket or FIFO, two names equal after NFC or ignoring case, or a limit.
   * `path` is relative to the folder; `target` is the link's own text.
   */
  CONTENT_RULE_VIOLATION: {
    "link-outside-folder": { path: "string", target: "string" },
    "link-to-network": { path: "string", target: "string" },
    "link-to-skipped": { path: "string", target: "string" },
    "special-file": { path: "string" },
    "case-collision": { path: "string" },
    limit: { path: "string", limit: "string" },
  },
  /** A folder plugin without a built tree (`plugin.json` and `dist/`, §18.4.2). */
  NO_INSTALLABLE_ARTIFACT: {
    "folder-has-no-build": { name: "string" },
  },
  /**
   * `policy-changed`: the plan was made under another managed policy (§18.6).
   * `package-changed`: an approval of an installed package's components named
   * a generation, or digests, that are no longer installed (§18.7.5).
   */
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

/** The detail a failure with code `C` may carry; `never` for a code without reasons. */
export type MarketplaceErrorDetail<C extends MarketplaceErrorCode = MarketplaceErrorCode> = C extends keyof DetailFields ? DetailOf<C> : never;

/** Every code that has reasons, paired with each of its reasons. */
export const MARKETPLACE_ERROR_REASONS: ReadonlyArray<readonly [MarketplaceErrorCode, string]> = Object.entries(MARKETPLACE_ERROR_DETAIL_FIELDS).flatMap(
  ([code, reasons]) => Object.keys(reasons).map((reason) => [code as MarketplaceErrorCode, reason] as const),
);

function fieldMatches(value: unknown, kind: DetailFieldKind): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (kind === "credential-issuer") return typeof value === "string" && (CREDENTIAL_ISSUERS as readonly string[]).includes(value);
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
 * `value` with every string in it, keys included, at any depth, scrubbed of credentials by
 * the one diagnostic scrubber (`scrubDiagnosticSecrets`). Main calls it on
 * everything the marketplace hands the renderer (each request's answer, each
 * broadcast, each failure's detail) and on a detail before it is stored, so
 * no string crosses unscrubbed and the renderer never scrubs.
 */
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

/** `detail`, checked to belong to `code`, with every string scrubbed ({@link scrubMarketplaceStrings}). */
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

/** A warning an entered target (a source's own address) can need; `internal-downloads` is about other hosts a catalog names. */
export type EnteredTargetWarningView = SourceWarningView & { warning: Exclude<SourceWarningView["warning"], "internal-downloads"> };

/**
 * SOURCE_CONFIRMATION_REQUIRED for a source's own address, with every warning
 * it needs, so one confirmation step asks for all of them; `detail` is the
 * first.
 */
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

/** The detail of one entered-target warning: the fields its sentence names. */
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
