/** This module owns wire shape only; parseAwayAuthorityGrant owns scope, lifetime, categories, and call limits. */
import { hasUserKeyboardIntent, type UserKeyboardIntent } from "./chat-origin.js";
import { hasExactKeys, isRecord } from "./is-record.js";
import { isNonNegativeSafeInteger } from "./safe-integer.js";

/** Preset lifetimes must stay within the grant parser’s ceiling. */
export const AWAY_AUTHORITY_DURATION_PRESETS = ["30m", "1h", "2h", "4h"] as const;
export type AwayAuthorityDurationPreset = (typeof AWAY_AUTHORITY_DURATION_PRESETS)[number];

/** Preset call budgets must stay within the policy ceiling. */
export const AWAY_AUTHORITY_BUDGET_PRESETS = [5, 10, 25, 50] as const;
export type AwayAuthorityBudgetPreset = (typeof AWAY_AUTHORITY_BUDGET_PRESETS)[number];

/** Read-write includes reads; write-only grants would block reads needed by the same turn. */
const AWAY_AUTHORITY_MODES = ["read-only", "read-write"] as const;
export type AwayAuthorityMode = (typeof AWAY_AUTHORITY_MODES)[number];

/** Bound payload size before sanitization; valid directory policy is enforced elsewhere. */
export const AWAY_AUTHORITY_MAX_DIRECTORIES = 16;
const MAX_DIRECTORY_CHARS = 4096;
/** Cross-boundary bound on the tile name, which main looks up and never parses. */
const MAX_CHAT_GROUP_ID_CHARS = 128;

const AWAY_AUTHORITY_ERROR_CODES = [
  "unauthorized",
  "unauthorized-frame",
  "away-authority-disabled",
  "user-keyboard-required",
  "away-authority-input-invalid",
  "away-authority-operation-rejected",
  "away-authority-unavailable",
] as const;
type AwayAuthorityErrorCode = (typeof AWAY_AUTHORITY_ERROR_CODES)[number];

export interface AwayAuthorityArmInputPayload {
  readonly intent: UserKeyboardIntent;
  /** Name a visible tile and resolve its conversation at execution; never assume the primary is the active conversation. */
  readonly chatGroupId: string;
  readonly mode: AwayAuthorityMode;
  readonly directories: readonly string[];
  readonly duration: AwayAuthorityDurationPreset;
  readonly budget: AwayAuthorityBudgetPreset;
}

export interface AwayAuthorityIntentOnlyInput {
  readonly intent: UserKeyboardIntent;
}

/** Project writable and remaining state, not raw categories or an invented original budget. */
export interface AwayAuthorityStatus {
  readonly writable: boolean;
  readonly directories: readonly string[];
  readonly expiresAt: number;
  readonly remaining: number;
}

type AwayAuthorityFailure = {
  readonly ok: false;
  readonly error: AwayAuthorityErrorCode;
};

export type AwayAuthorityMutationResult =
  | { readonly ok: true }
  | AwayAuthorityFailure;

/** Null reports nothing armed now, including expired grants. */
export type AwayAuthorityStatusResult =
  | { readonly ok: true; readonly status: AwayAuthorityStatus | null }
  | AwayAuthorityFailure;

/** Mutations require preload-minted keyboard intent; main resolves the named tile’s current conversation. */
export interface AwayAuthorityOwnerApi {
  status(): Promise<AwayAuthorityStatusResult>;
  arm(input: {
    chatGroupId: string;
    mode: AwayAuthorityMode;
    directories: readonly string[];
    duration: AwayAuthorityDurationPreset;
    budget: AwayAuthorityBudgetPreset;
  }): Promise<AwayAuthorityMutationResult>;
  disarm(): Promise<AwayAuthorityMutationResult>;
}

function isAwayAuthorityMode(value: unknown): value is AwayAuthorityMode {
  return typeof value === "string" && (AWAY_AUTHORITY_MODES as readonly string[]).includes(value);
}

function isAwayAuthorityDurationPreset(
  value: unknown,
): value is AwayAuthorityDurationPreset {
  return typeof value === "string"
    && (AWAY_AUTHORITY_DURATION_PRESETS as readonly string[]).includes(value);
}

function isAwayAuthorityBudgetPreset(value: unknown): value is AwayAuthorityBudgetPreset {
  return typeof value === "number"
    && (AWAY_AUTHORITY_BUDGET_PRESETS as readonly number[]).includes(value);
}

function isDirectoryList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= AWAY_AUTHORITY_MAX_DIRECTORIES
    && value.every((entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= MAX_DIRECTORY_CHARS);
}

/** Shape acceptance grants no authority; sanitizer and grant policy may still refuse it. */
export function isAwayAuthorityArmInput(value: unknown): value is AwayAuthorityArmInputPayload {
  return isRecord(value)
    && hasExactKeys(value, ["budget", "chatGroupId", "directories", "duration", "intent", "mode"])
    && hasUserKeyboardIntent(value.intent)
    && typeof value.chatGroupId === "string"
    && value.chatGroupId.trim().length > 0
    && value.chatGroupId.length <= MAX_CHAT_GROUP_ID_CHARS
    && isAwayAuthorityMode(value.mode)
    && isDirectoryList(value.directories)
    && isAwayAuthorityDurationPreset(value.duration)
    && isAwayAuthorityBudgetPreset(value.budget);
}

export function isAwayAuthorityIntentOnlyInput(
  value: unknown,
): value is AwayAuthorityIntentOnlyInput {
  return isRecord(value) && hasExactKeys(value, ["intent"]) && hasUserKeyboardIntent(value.intent);
}

function isAwayAuthorityErrorCode(value: unknown): value is AwayAuthorityErrorCode {
  return typeof value === "string"
    && (AWAY_AUTHORITY_ERROR_CODES as readonly string[]).includes(value);
}

export function parseAwayAuthorityStatus(value: unknown): AwayAuthorityStatus | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ["directories", "expiresAt", "remaining", "writable"])
    || typeof value.writable !== "boolean"
    || !Array.isArray(value.directories)
    || value.directories.length > AWAY_AUTHORITY_MAX_DIRECTORIES
    || !value.directories.every((entry) => typeof entry === "string" && entry.length > 0)
    || !isNonNegativeSafeInteger(value.expiresAt)
    || typeof value.remaining !== "number"
    || !Number.isSafeInteger(value.remaining)
    || value.remaining <= 0) {
    return null;
  }
  return Object.freeze({
    writable: value.writable,
    directories: Object.freeze([...value.directories] as string[]),
    expiresAt: value.expiresAt,
    remaining: value.remaining,
  });
}

function parseAwayAuthorityFailure(value: unknown): AwayAuthorityFailure | null {
  if (!isRecord(value) || !hasExactKeys(value, ["error", "ok"])
    || value.ok !== false || !isAwayAuthorityErrorCode(value.error)) {
    return null;
  }
  return Object.freeze({ ok: false, error: value.error });
}

/** Rebuild the result projection so unknown IPC fields never cross preload. */
export function parseAwayAuthorityMutationResult(
  value: unknown,
): AwayAuthorityMutationResult | null {
  const failure = parseAwayAuthorityFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok"]) || value.ok !== true) return null;
  return Object.freeze({ ok: true });
}

export function parseAwayAuthorityStatusResult(value: unknown): AwayAuthorityStatusResult | null {
  const failure = parseAwayAuthorityFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "status"]) || value.ok !== true) return null;
  if (value.status === null) return Object.freeze({ ok: true, status: null });
  const status = parseAwayAuthorityStatus(value.status);
  return status === null ? null : Object.freeze({ ok: true, status });
}
