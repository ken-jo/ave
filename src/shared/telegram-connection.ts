/** Pairing grants no access without a separate owner share. Snapshots and events expose only coarse state and opaque fingerprints, never secrets, remote chat IDs, message text, or pairing codes. The local owner may read their explicitly registered numeric user ID. */
import { hasUserKeyboardIntent, type UserKeyboardIntent } from "./chat-origin.js";
import { UUID_PATTERN } from "./uuid.js";
import { hasExactKeys, isRecord } from "./is-record.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "./safe-integer.js";

export const TELEGRAM_PAIRING_CODE_TTL_MS = 10 * 60 * 1_000;

export const TELEGRAM_APPROVAL_DURATION_PRESETS = ["1h", "8h", "24h"] as const;
export type TelegramApprovalDurationPreset = (typeof TELEGRAM_APPROVAL_DURATION_PRESETS)[number];

/** Main derives connection state; stale renderer state must not invent active. */
const TELEGRAM_CONNECTION_STATES = [
  /** This machine has no usable encrypted store, so no token may be saved. */
  "unsupported",
  /** Boot environment owns the bridge; the desktop surface is read-only. */
  "disconnected",
  "connected-unpaired",
  /** Lost digest keys require pairing again even when the bot connection is healthy. */
  "pairing-unrecognized",
  "pairing-pending",
  "paired-unapproved",
  /** Shares survive restart; the open-conversation check belongs to approval, not connection state. */
  "active",
  /** A deleted shared conversation requires sharing another one; do not tell the owner to reopen a missing conversation. */
  "shared-conversation-missing",
  "paused-by-owner",
  /** Reconnecting retries on backoff and wake/network recovery without owner action; error requires intervention. */
  "reconnecting",
  "error",
] as const;
export type TelegramConnectionState = (typeof TELEGRAM_CONNECTION_STATES)[number];

const TELEGRAM_CONNECTION_ERROR_CODES = [
  "unauthorized",
  "unauthorized-frame",
  "telegram-connection-disabled",
  "telegram-connection-unavailable",
  "telegram-connection-input-invalid",
  "telegram-owner-id-required",
  "telegram-connection-operation-rejected",
  "user-keyboard-required",
  "telegram-encryption-unavailable",
  "telegram-bot-token-rejected",
  /** Distinguish unreadable stored tokens from unavailable encryption and remotely rejected readable tokens. */
  "telegram-bot-token-unreadable",
  /** Stop receiving when durable state cannot be written; pairing, approval, and poll position must remain recordable. */
  "telegram-connection-state-unwritable",
  "telegram-provider-unreachable",
  "telegram-webhook-conflict",
  "telegram-poll-conflict",
] as const;
export type TelegramConnectionErrorCode = (typeof TELEGRAM_CONNECTION_ERROR_CODES)[number];

interface TelegramPairingSummary {
  readonly id: string;
  /** Opaque, shortened local digest. Never a Telegram user id or @username. */
  readonly accountFingerprint: string;
}

interface TelegramApprovalSummary {
  readonly id: string;
  readonly expiresAt: number;
  /** Main reports whether the durable share is currently open; renderer never receives IDs to compare. */
  readonly matchesCurrentConversation: boolean;
}

interface TelegramPendingCodeSummary {
  readonly id: string;
  readonly expiresAt: number;
  readonly attemptsRemaining: number;
}

export interface TelegramConnectionSnapshot {
  /** Explicitly registered by the local owner; never inferred from whoever redeems a code. */
  readonly ownerUserId: string | null;
  readonly state: TelegramConnectionState;
  /** Resolved in-memory from getMe; absent until the bot is verified. */
  readonly botUsername: string | null;
  readonly pairing: TelegramPairingSummary | null;
  readonly approval: TelegramApprovalSummary | null;
  readonly pendingCode: TelegramPendingCodeSummary | null;
  readonly lastErrorCode: TelegramConnectionErrorCode | null;
}

/** Returned exactly once by createPairingCode and never present in a snapshot. */
export interface TelegramCreatedPairingCode {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly botUsername: string;
}

export interface TelegramConnectInput {
  readonly intent: UserKeyboardIntent;
  readonly botToken: string;
}

export interface TelegramSetOwnerUserIdInput {
  readonly intent: UserKeyboardIntent;
  readonly ownerUserId: string;
}

export interface TelegramIntentOnlyInput {
  readonly intent: UserKeyboardIntent;
}

export interface TelegramApproveCurrentConversationInput {
  readonly intent: UserKeyboardIntent;
  readonly duration?: TelegramApprovalDurationPreset;
}

export interface TelegramRevokeInput {
  readonly intent: UserKeyboardIntent;
  readonly id: string;
}

export type TelegramConnectionFailure = {
  readonly ok: false;
  readonly error: TelegramConnectionErrorCode;
};

export type TelegramConnectionMutationResult =
  | { readonly ok: true }
  | TelegramConnectionFailure;

export type TelegramConnectionSnapshotResult =
  | { readonly ok: true; readonly snapshot: TelegramConnectionSnapshot }
  | TelegramConnectionFailure;

export type TelegramCreatePairingCodeResult =
  | { readonly ok: true; readonly pairingCode: TelegramCreatedPairingCode }
  | TelegramConnectionFailure;

/** Every mutation requires live preload keyboard intent; main resolves the open conversation. */
export interface TelegramConnectionOwnerApi {
  snapshot(): Promise<TelegramConnectionSnapshotResult>;
  connect(botToken: string): Promise<TelegramConnectionMutationResult>;
  setOwnerUserId(ownerUserId: string): Promise<TelegramConnectionMutationResult>;
  disconnect(): Promise<TelegramConnectionMutationResult>;
  pause(): Promise<TelegramConnectionMutationResult>;
  resume(): Promise<TelegramConnectionMutationResult>;
  createPairingCode(): Promise<TelegramCreatePairingCodeResult>;
  revokePairing(id: string): Promise<TelegramConnectionMutationResult>;
  approveCurrentConversation(
    duration?: TelegramApprovalDurationPreset,
  ): Promise<TelegramConnectionMutationResult>;
  revokeApproval(id: string): Promise<TelegramConnectionMutationResult>;
  /** Hint only: callers must pull a fresh snapshot; it carries no state. */
  onChanged(handler: () => void): () => void;
}

const ACCOUNT_FINGERPRINT = /^[a-f0-9]{12}$/;
/** Pairing codes must not start with slash because ingress unconditionally rejects slash commands. */
export const TELEGRAM_PAIRING_CODE = /^ave-tg-v1\.[A-Za-z0-9_-]{43}$/;
/** Bot handles require 5–32 total characters ending in bot; count the leading letter and suffix in the bound. */
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
const BOT_TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,220}$/;
/** URL-path safety is intentionally separate from paste plausibility; tokens must never alter the HTTPS endpoint. */
export const TELEGRAM_BOT_TOKEN_PATH_GRAMMAR = /^[A-Za-z0-9:_-]{1,256}$/;
const MAX_CONVERSATION_CHARS = 4_096;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Canonical positive numeric user identity within the provider integer range. */
export function isTelegramOwnerUserId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) <= 2 ** 52 - 1;
}

export function isTelegramConnectionId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Service, store, and routing runtime must share the conversation-ID grammar so persisted grants remain matchable. */
export function isTelegramConversationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CONVERSATION_CHARS
    && value.trim().length > 0
    && !UNSAFE_CONTROL_CHARACTERS.test(value);
}

function isTelegramConnectionState(value: unknown): value is TelegramConnectionState {
  return typeof value === "string"
    && (TELEGRAM_CONNECTION_STATES as readonly string[]).includes(value);
}

export function isTelegramConnectionErrorCode(
  value: unknown,
): value is TelegramConnectionErrorCode {
  return typeof value === "string"
    && (TELEGRAM_CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

export function isTelegramApprovalDurationPreset(
  value: unknown,
): value is TelegramApprovalDurationPreset {
  return typeof value === "string"
    && (TELEGRAM_APPROVAL_DURATION_PRESETS as readonly string[]).includes(value);
}

export function isTelegramBotToken(value: unknown): value is string {
  return typeof value === "string" && BOT_TOKEN.test(value);
}

export function isTelegramBotUsername(value: unknown): value is string {
  return typeof value === "string" && BOT_USERNAME.test(value);
}

export function isTelegramPairingCode(value: unknown): value is string {
  return typeof value === "string" && TELEGRAM_PAIRING_CODE.test(value);
}

function hasIntent(value: Record<string, unknown>): boolean {
  return hasUserKeyboardIntent(value.intent);
}

export function isTelegramConnectInput(value: unknown): value is TelegramConnectInput {
  return isRecord(value) && hasExactKeys(value, ["botToken", "intent"])
    && hasIntent(value) && isTelegramBotToken(value.botToken);
}

export function isTelegramSetOwnerUserIdInput(value: unknown): value is TelegramSetOwnerUserIdInput {
  return isRecord(value) && hasExactKeys(value, ["intent", "ownerUserId"])
    && hasIntent(value) && isTelegramOwnerUserId(value.ownerUserId);
}

export function isTelegramIntentOnlyInput(value: unknown): value is TelegramIntentOnlyInput {
  return isRecord(value) && hasExactKeys(value, ["intent"]) && hasIntent(value);
}

export function isTelegramApproveCurrentConversationInput(
  value: unknown,
): value is TelegramApproveCurrentConversationInput {
  if (!isRecord(value) || !hasIntent(value)) return false;
  if (hasExactKeys(value, ["intent"])) return true;
  return hasExactKeys(value, ["duration", "intent"])
    && isTelegramApprovalDurationPreset(value.duration);
}

export function isTelegramRevokeInput(value: unknown): value is TelegramRevokeInput {
  return isRecord(value) && hasExactKeys(value, ["id", "intent"])
    && hasIntent(value) && isTelegramConnectionId(value.id);
}

function parsePairingSummary(value: unknown): TelegramPairingSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, ["accountFingerprint", "id"])
    || !isTelegramConnectionId(value.id)
    || typeof value.accountFingerprint !== "string"
    || !ACCOUNT_FINGERPRINT.test(value.accountFingerprint)) {
    return null;
  }
  return Object.freeze({ id: value.id, accountFingerprint: value.accountFingerprint });
}

function parseApprovalSummary(value: unknown): TelegramApprovalSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, ["expiresAt", "id", "matchesCurrentConversation"])
    || !isTelegramConnectionId(value.id)
    || !isPositiveSafeInteger(value.expiresAt)
    || typeof value.matchesCurrentConversation !== "boolean") {
    return null;
  }
  return Object.freeze({
    id: value.id,
    expiresAt: value.expiresAt,
    matchesCurrentConversation: value.matchesCurrentConversation,
  });
}

function parsePendingCodeSummary(value: unknown): TelegramPendingCodeSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, ["attemptsRemaining", "expiresAt", "id"])
    || !isTelegramConnectionId(value.id)
    || !isPositiveSafeInteger(value.expiresAt)
    || !isNonNegativeSafeInteger(value.attemptsRemaining)) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    expiresAt: value.expiresAt,
    attemptsRemaining: value.attemptsRemaining,
  });
}

/** Rebuild safe fields rather than forwarding the wire object, preventing future producer additions from leaking. */
export function parseTelegramConnectionSnapshot(
  value: unknown,
): TelegramConnectionSnapshot | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ["approval", "botUsername", "lastErrorCode", "ownerUserId", "pairing", "pendingCode", "state"])
    || (value.ownerUserId !== null && !isTelegramOwnerUserId(value.ownerUserId))
    || !isTelegramConnectionState(value.state)
    || (value.botUsername !== null && !isTelegramBotUsername(value.botUsername))
    || (value.lastErrorCode !== null && !isTelegramConnectionErrorCode(value.lastErrorCode))) {
    return null;
  }
  const pairing = value.pairing === null ? null : parsePairingSummary(value.pairing);
  const approval = value.approval === null ? null : parseApprovalSummary(value.approval);
  const pendingCode = value.pendingCode === null ? null : parsePendingCodeSummary(value.pendingCode);
  if ((value.pairing !== null && pairing === null)
    || (value.approval !== null && approval === null)
    || (value.pendingCode !== null && pendingCode === null)) {
    return null;
  }
  return Object.freeze({
    state: value.state,
    ownerUserId: value.ownerUserId as string | null,
    botUsername: value.botUsername as string | null,
    pairing,
    approval,
    pendingCode,
    lastErrorCode: value.lastErrorCode as TelegramConnectionErrorCode | null,
  });
}

export function parseTelegramCreatedPairingCode(
  value: unknown,
): TelegramCreatedPairingCode | null {
  if (!isRecord(value) || !hasExactKeys(value, ["botUsername", "code", "expiresAt", "id"])
    || !isTelegramConnectionId(value.id)
    || !isTelegramPairingCode(value.code)
    || !isTelegramBotUsername(value.botUsername)
    || !isPositiveSafeInteger(value.expiresAt)) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    code: value.code,
    expiresAt: value.expiresAt,
    botUsername: value.botUsername,
  });
}

function parseFailure(value: unknown): TelegramConnectionFailure | null {
  if (!isRecord(value) || !hasExactKeys(value, ["error", "ok"])
    || value.ok !== false || !isTelegramConnectionErrorCode(value.error)) {
    return null;
  }
  return Object.freeze({ ok: false, error: value.error });
}

/** Rebuild a result projection too, so unknown IPC fields never cross preload. */
export function parseTelegramConnectionMutationResult(
  value: unknown,
): TelegramConnectionMutationResult | null {
  const failure = parseFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok"]) || value.ok !== true) return null;
  return Object.freeze({ ok: true });
}

export function parseTelegramConnectionSnapshotResult(
  value: unknown,
): TelegramConnectionSnapshotResult | null {
  const failure = parseFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "snapshot"]) || value.ok !== true) return null;
  const snapshot = parseTelegramConnectionSnapshot(value.snapshot);
  return snapshot === null ? null : Object.freeze({ ok: true, snapshot });
}

export function parseTelegramCreatePairingCodeResult(
  value: unknown,
): TelegramCreatePairingCodeResult | null {
  const failure = parseFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "pairingCode"]) || value.ok !== true) return null;
  const pairingCode = parseTelegramCreatedPairingCode(value.pairingCode);
  return pairingCode === null ? null : Object.freeze({ ok: true, pairingCode });
}
