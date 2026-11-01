// Persist the desktop-registered owner ID and local conversation routing hint; the latter's unkeyed digest detects inconsistency, not malicious rewriting. Actor
// HMAC and the current-conversation check enforce authority; pairing alone grants nothing and shares bind to its epoch.
import { randomUUID as nodeRandomUuid } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SHA256_HEX, timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";
import {
  TELEGRAM_PAIRING_CODE_TTL_MS,
  isTelegramConnectionErrorCode,
  isTelegramConnectionId,
  isTelegramConversationId,
  isTelegramOwnerUserId,
  type TelegramConnectionErrorCode,
} from "../shared/telegram-connection.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";
import { hasExactKeys, isRecord } from "../shared/is-record.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "../shared/safe-integer.js";
import { createSerialQueue } from "../lib/with-file-lock.js";

const STORE_VERSION = 2;
// Feature namespace shared by the connection store and the bridge server (`command-receipts.json`).
export const TELEGRAM_BRIDGE_FEATURE = "telegram-bridge";
const DEFAULT_FILE_NAME = "connection.json";
const DEFAULT_PENDING_CODE_ATTEMPTS = 5;
const MAX_PENDING_CODE_ATTEMPTS = 16;
const MAX_PENDING_CODE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_APPROVAL_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
// Cap untrusted input documents; normal writes retain only one active grant so this is not an owner-exhaustible capacity.
const MAX_APPROVALS = 32;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}\.json$/i;
const ACCOUNT_FINGERPRINT_CHARS = 12;

export type TelegramDesiredState = "disconnected" | "connected" | "paused";

// A minted-but-unredeemed pairing code, described without its secret.
interface TelegramPendingCodeRecord {
  readonly id: string;
  readonly expiresAt: number;
  readonly attemptsRemaining: number;
}

interface TelegramPairingRecord {
  readonly id: string;
  readonly actorDigest: string;
  readonly epoch: number;
  readonly createdAt: number;
}

// What an egress fence needs to decide that one inbound actor may act on one conversation right now. `scope` names this exact approval generation.
interface TelegramApprovalAuthority {
  readonly approvalId: string;
  readonly approvalEpoch: number;
  readonly pairingId: string;
  readonly pairingEpoch: number;
  readonly actorDigest: string;
  readonly conversationDigest: string;
  readonly scope: string;
  readonly expiresAt: number;
}

interface TelegramOwnerPairingSummary {
  readonly id: string;
  // Shortened local digest. Never a Telegram user id or a bot handle.
  readonly accountFingerprint: string;
}

export interface TelegramOwnerApprovalSummary {
  readonly id: string;
  readonly expiresAt: number;
  // Main-process-only. The renderer contract carries a boolean `matchesCurrentConversation` instead; never forward this field to a renderer snapshot.
  readonly conversationDigest: string;
}

// Durable projection the owner surface builds its renderer snapshot from. It reports only what survived the lazy prune, so an expired approval or code
// is never visible here.
export interface TelegramOwnerConnectionSnapshot {
  readonly ownerUserId: string | null;
  readonly desiredState: TelegramDesiredState;
  readonly activationEpoch: number;
  readonly botFingerprint: string | null;
  readonly pairing: TelegramOwnerPairingSummary | null;
  // Distinguish lost actor-key identity from never paired so the owner receives a re-pair explanation.
  readonly pairingUnrecognized: boolean;
  // The one shared conversation, or null when nothing is shared.
  readonly approval: TelegramOwnerApprovalSummary | null;
  readonly pendingCode: TelegramPendingCodeRecord | null;
  readonly lastErrorCode: TelegramConnectionErrorCode | null;
}

export interface CreateTelegramConnectionStoreOptions {
  readonly namespace?: FeatureNamespaceHandle;
  readonly fileName?: string;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  // Require an injected bot-scoped derivation and recheck plaintext bindings at read time; defaults must not silently decide authorization.
  readonly conversationDigestFor: (botFingerprint: string, conversationId: string) => string;
}

interface CreateTelegramPendingCodeInput {
  // Digest of the raw code. The raw code never reaches this store.
  readonly codeDigest: string;
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
}

interface CompleteTelegramPairingInput {
  readonly senderId: string;
  readonly codeDigest: string;
  readonly actorDigest: string;
}

interface CreateTelegramApprovalInput {
  // Local, never provider-visible. Persisted so the share survives a restart.
  readonly conversationId: string;
  // The caller's own derivation of the same conversation. Supplying both lets this store reject a grant whose two derivations disagree, which would
  // otherwise be written once and be unresolvable forever after.
  readonly conversationDigest: string;
  readonly ttlMs?: number;
}

export interface TelegramConnectionStore {
  ownerUserId(): string | null;
  setOwnerUserId(ownerUserId: string): Promise<void>;
  // Load durable state. A corrupt file fails closed to a disconnected store.
  open(): Promise<void>;
  subscribe(listener: () => void): () => void;

  ownerSnapshot(): TelegramOwnerConnectionSnapshot;
  receiptOwnerId(): string;
  activationEpoch(): number;
  desiredState(): TelegramDesiredState;
  botFingerprint(): string | null;
  // Full opaque digest of the paired account, for the egress authority only. `ownerSnapshot()` deliberately carries the shortened fingerprint instead,
  // because that one is projected to a renderer.
  activePairingActorDigest(): string | null;
  pollOffset(): number | null;

  // Reconcile the actor key before credentials or bridge activation; changed or missing key identity retires stale pairing and records why.
  reconcileActorKey(actorKeyDigest: string): Promise<boolean>;

  setConnected(botFingerprint: string): Promise<void>;
  // No-op returning false unless the bridge is currently connected.
  setPaused(): Promise<boolean>;
  setDisconnected(): Promise<void>;
  recordPollOffset(offset: number): Promise<void>;
  setLastError(code: TelegramConnectionErrorCode | null): Promise<void>;

  createPendingCode(input: CreateTelegramPendingCodeInput): Promise<TelegramPendingCodeRecord>;
  // Charge one attempt for a candidate rejected before digest comparison.
  consumePendingCodeAttempt(): Promise<TelegramPendingCodeRecord | null>;
  completePairing(input: CompleteTelegramPairingInput): Promise<TelegramPairingRecord | null>;
  revokePairing(id: string): Promise<boolean>;

  createApproval(input: CreateTelegramApprovalInput): Promise<TelegramApprovalAuthority | null>;
  revokeApproval(id: string): Promise<boolean>;
  // Synchronous in-memory egress fence. It never awaits, never persists, and never throws: an unusable store answers "no authority".
  resolveActiveApproval(
    actorDigest: string,
    conversationDigest: string,
  ): TelegramApprovalAuthority | null;
  // Durable plaintext is a routing hint only; resolveActiveApproval on its digest remains the authorization gate.
  resolveBoundConversation(actorDigest: string): string | null;
}

interface StoredPendingCode {
  readonly id: string;
  readonly codeDigest: string;
  readonly expiresAt: number;
  readonly attemptsRemaining: number;
}

// Unrecognized and revoked both deny access; the distinct state explains machine key loss without implying owner distrust.
interface StoredPairing {
  readonly ownerUserId: string | null;
  readonly id: string;
  readonly actorDigest: string;
  readonly state: "active" | "revoked" | "unrecognized";
  readonly epoch: number;
  readonly createdAt: number;
}

interface StoredApproval {
  readonly id: string;
  readonly pairingId: string;
  readonly pairingEpoch: number;
  // Routing hint, discarded unless it re-hashes to the digest beside it. That rejects a record edited in one place, not one edited consistently — the file header says why.
  readonly conversationId: string;
  readonly conversationDigest: string;
  readonly scope: string;
  readonly state: "active" | "revoked" | "expired";
  readonly epoch: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface StoreDocument {
  readonly ownerUserId: string | null;
  readonly version: typeof STORE_VERSION;
  readonly receiptOwnerId: string;
  readonly activationEpoch: number;
  readonly desiredState: TelegramDesiredState;
  readonly botFingerprint: string | null;
  // Opaque name of the actor key every stored `actorDigest` was derived under. A digest of the key, never the key: it is safe here for the same reason the
  // actor digest is, and it is what makes a silent key rotation detectable.
  readonly actorKeyDigest: string | null;
  readonly pollOffset: number | null;
  readonly pendingCode: StoredPendingCode | null;
  readonly pairing: StoredPairing | null;
  readonly approvals: readonly StoredApproval[];
  readonly lastErrorCode: TelegramConnectionErrorCode | null;
}

type ChangeListener = () => void;

function invalid(): Error {
  return new Error("telegram-connection-store-invalid");
}

function inputInvalid(): Error {
  return new Error("telegram-connection-store-input-invalid");
}

function notOpen(): Error {
  return new Error("telegram-connection-store-not-open");
}

function epochValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function desiredState(value: unknown): value is TelegramDesiredState {
  return value === "disconnected" || value === "connected" || value === "paused";
}

function validDuration(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function addDuration(now: number, duration: number): number {
  if (now > Number.MAX_SAFE_INTEGER - duration) throw invalid();
  return now + duration;
}

function nextEpoch(value: number): number {
  if (!epochValue(value) || value === Number.MAX_SAFE_INTEGER) throw invalid();
  return value + 1;
}

function validPendingCode(value: unknown): value is StoredPendingCode {
  return isRecord(value)
    && hasExactKeys(value, ["id", "codeDigest", "expiresAt", "attemptsRemaining"])
    && isTelegramConnectionId(value.id)
    && digest(value.codeDigest)
    && isPositiveSafeInteger(value.expiresAt)
    && typeof value.attemptsRemaining === "number"
    && Number.isSafeInteger(value.attemptsRemaining)
    // A budget of zero destroys the code, so a persisted zero is a bug, not a state: validating it here makes the destroy-at-zero rule unskippable.
    && value.attemptsRemaining >= 1
    && value.attemptsRemaining <= MAX_PENDING_CODE_ATTEMPTS;
}

function validPairing(value: unknown): value is StoredPairing {
  return isRecord(value)
    && hasExactKeys(value, ["id", "actorDigest", "state", "epoch", "createdAt", "ownerUserId"])
    && (value.ownerUserId === null || isTelegramOwnerUserId(value.ownerUserId))
    && isTelegramConnectionId(value.id)
    && digest(value.actorDigest)
    && (value.state === "active" || value.state === "revoked" || value.state === "unrecognized")
    && epochValue(value.epoch)
    && isPositiveSafeInteger(value.createdAt);
}

function validApproval(value: unknown): value is StoredApproval {
  return isRecord(value)
    && hasExactKeys(value, [
      "id", "pairingId", "pairingEpoch", "conversationId", "conversationDigest", "scope",
      "state", "epoch", "createdAt", "expiresAt",
    ])
    && isTelegramConnectionId(value.id)
    && isTelegramConnectionId(value.pairingId)
    && epochValue(value.pairingEpoch)
    // Shape only. Whether this plaintext is the conversation the digest was granted for is decided per read, against the current bot identity.
    && isTelegramConversationId(value.conversationId)
    && digest(value.conversationDigest)
    && isTelegramConnectionId(value.scope)
    && (value.state === "active" || value.state === "revoked" || value.state === "expired")
    && epochValue(value.epoch)
    && isPositiveSafeInteger(value.createdAt)
    && isPositiveSafeInteger(value.expiresAt)
    && value.expiresAt > value.createdAt;
}

// Shape and referential integrity only. Liveness (expiry, revocation, a superseded pairing epoch) is owned by {@link prune} alone, so a document that
// merely became stale is neutralized entry by entry instead of discarding the whole connection.
function validDocument(value: unknown): value is StoreDocument {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "version", "receiptOwnerId", "activationEpoch", "desiredState", "botFingerprint",
      "actorKeyDigest", "pollOffset", "pendingCode", "pairing", "approvals", "lastErrorCode", "ownerUserId",
    ])
    || value.version !== STORE_VERSION
    || !(value.ownerUserId === null || isTelegramOwnerUserId(value.ownerUserId))
    || !isTelegramConnectionId(value.receiptOwnerId)
    || !epochValue(value.activationEpoch)
    || !desiredState(value.desiredState)
    || !(value.botFingerprint === null || digest(value.botFingerprint))
    || !(value.actorKeyDigest === null || digest(value.actorKeyDigest))
    || !(value.pollOffset === null || isNonNegativeSafeInteger(value.pollOffset))
    || !(value.pendingCode === null || validPendingCode(value.pendingCode))
    || !(value.pairing === null || validPairing(value.pairing))
    || !Array.isArray(value.approvals)
    || value.approvals.length > MAX_APPROVALS
    || !value.approvals.every(validApproval)
    || !(value.lastErrorCode === null || isTelegramConnectionErrorCode(value.lastErrorCode))
    // Connected without a verified bot would let a snapshot claim an identity the runtime cannot derive actor digests for.
    || (value.desiredState === "connected" && value.botFingerprint === null)
  ) {
    return false;
  }
  const pairingId = value.pairing === null ? null : (value.pairing as StoredPairing).id;
  const ids = new Set<string>();
  for (const approval of value.approvals as readonly StoredApproval[]) {
    if (ids.has(approval.id) || approval.pairingId !== pairingId) return false;
    ids.add(approval.id);
  }
  return true;
}

function initialDocument(receiptOwnerId: string): StoreDocument {
  return {
    version: STORE_VERSION,
    ownerUserId: null,
    receiptOwnerId,
    activationEpoch: 1,
    desiredState: "disconnected",
    botFingerprint: null,
    actorKeyDigest: null,
    pollOffset: null,
    pendingCode: null,
    pairing: null,
    approvals: [],
    lastErrorCode: null,
  };
}

// Sole authority on what is still live. Every read and every mutation goes through it first, so nothing expired, revoked, orphaned, or minted under a
// superseded pairing epoch is ever observable as active.
function prune(
  document: StoreDocument,
  now: number,
): { readonly document: StoreDocument; readonly changed: boolean } {
  let changed = false;
  const pendingCode = document.pendingCode !== null
    && document.pendingCode.expiresAt > now
    && document.pendingCode.attemptsRemaining >= 1
    ? document.pendingCode
    : null;
  if (pendingCode !== document.pendingCode) changed = true;

  const originalPairing = document.pairing;
  const ownerMismatch = originalPairing !== null && originalPairing.state === "active"
    && (document.ownerUserId === null || originalPairing.ownerUserId !== document.ownerUserId);
  const pairing = ownerMismatch
    ? { ...originalPairing, state: "unrecognized" as const, epoch: nextEpoch(originalPairing.epoch) }
    : originalPairing;
  if (ownerMismatch) changed = true;
  const approvals: StoredApproval[] = [];
  for (const approval of document.approvals) {
    if (pairing === null || approval.pairingId !== pairing.id) {
      changed = true;
      continue;
    }
    const stale = approval.expiresAt <= now
      || pairing.state !== "active"
      || pairing.epoch !== approval.pairingEpoch;
    const entry: StoredApproval = approval.state === "active" && stale
      ? { ...approval, state: "expired", epoch: nextEpoch(approval.epoch) }
      : approval;
    if (entry !== approval) changed = true;
    // Prune retired grants immediately so unreachable records cannot retain ended conversation IDs or consume the bounded document.
    if (entry.state !== "active") {
      changed = true;
      continue;
    }
    approvals.push(entry);
  }
  return {
    document: changed ? { ...document, pairing, pendingCode, approvals } : document,
    changed,
  };
}

// Choose the newest active grant deterministically for foreign or legacy documents so screen and remote routing cannot diverge.
function newestApproval(approvals: readonly StoredApproval[]): StoredApproval | null {
  let newest: StoredApproval | null = null;
  for (const approval of approvals) {
    if (newest === null || approval.createdAt >= newest.createdAt) newest = approval;
  }
  return newest;
}

function authority(pairing: StoredPairing, approval: StoredApproval): TelegramApprovalAuthority {
  return Object.freeze({
    approvalId: approval.id,
    approvalEpoch: approval.epoch,
    pairingId: approval.pairingId,
    pairingEpoch: approval.pairingEpoch,
    actorDigest: pairing.actorDigest,
    conversationDigest: approval.conversationDigest,
    scope: approval.scope,
    expiresAt: approval.expiresAt,
  });
}

function pendingCodeRecord(value: StoredPendingCode): TelegramPendingCodeRecord {
  return Object.freeze({
    id: value.id,
    expiresAt: value.expiresAt,
    attemptsRemaining: value.attemptsRemaining,
  });
}

function pairingRecord(value: StoredPairing): TelegramPairingRecord {
  return Object.freeze({
    id: value.id,
    actorDigest: value.actorDigest,
    epoch: value.epoch,
    createdAt: value.createdAt,
  });
}

// Call `open()` before any read. State is held in memory so the egress fence can resolve an approval synchronously.
export function createTelegramConnectionStore(
  options: CreateTelegramConnectionStoreOptions,
): TelegramConnectionStore {
  const namespace = options.namespace ?? openFeatureNamespace(TELEGRAM_BRIDGE_FEATURE);
  const fileName = options.fileName ?? DEFAULT_FILE_NAME;
  const clock = options.now ?? Date.now;
  const randomUuid = options.randomUuid ?? nodeRandomUuid;
  const deriveConversationDigest = options.conversationDigestFor;
  const listeners = new Set<ChangeListener>();
  // Serialize mutations so a read-modify-write pair can never interleave with another one and drop a persisted epoch bump.
  const runExclusive = createSerialQueue();

  let document: StoreDocument | undefined;

  if (!FILE_NAME.test(fileName)) throw invalid();
  if (typeof deriveConversationDigest !== "function") throw invalid();

  const checkedNow = (): number => {
    const value = clock();
    if (!isPositiveSafeInteger(value)) throw invalid();
    return value;
  };

  const nextUuid = (): string => {
    const value = randomUuid();
    if (!isTelegramConnectionId(value)) throw invalid();
    return value;
  };

  const requireDocument = (): StoreDocument => {
    if (document === undefined) throw notOpen();
    return document;
  };

  // Pruned view for reads. Reads never persist; the next mutation converges.
  const currentView = (): StoreDocument => prune(requireDocument(), checkedNow()).document;

  // Null rather than a throw, so one bad derivation cannot break a read path.
  const conversationDigestOf = (
    botFingerprint: string | null,
    conversationId: string,
  ): string | null => {
    if (botFingerprint === null || !isTelegramConversationId(conversationId)) return null;
    try {
      const derived = deriveConversationDigest(botFingerprint, conversationId);
      return digest(derived) ? derived : null;
    } catch {
      return null;
    }
  };

  // Every reader uses the same active-and-digest-consistent filter; fail closed on mismatches and preserve disk evidence instead of rewriting during reads.
  const liveApprovals = (value: StoreDocument): readonly StoredApproval[] =>
    value.approvals.filter((approval) => approval.state === "active"
      && timingSafeEqualHexDigest(
        conversationDigestOf(value.botFingerprint, approval.conversationId),
        approval.conversationDigest,
      ));

  const persist = async (value: StoreDocument): Promise<void> => {
    if (!validDocument(value)) throw invalid();
    try {
      await namespace.writeJson(fileName, value);
    } catch {
      throw invalid();
    }
  };

  const emitChange = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A subscriber failure must not roll back already-persisted state.
      }
    }
  };

  const mutate = async <T>(
    operation: (current: StoreDocument, now: number) => {
      readonly document: StoreDocument;
      readonly value: T;
      readonly changed: boolean;
    },
  ): Promise<T> => await runExclusive(async () => {
    const now = checkedNow();
    const pruned = prune(requireDocument(), now);
    const outcome = operation(pruned.document, now);
    if (pruned.changed || outcome.changed) {
      await persist(outcome.document);
      document = outcome.document;
      emitChange();
    }
    return outcome.value;
  });

  const open = async (): Promise<void> => await runExclusive(async () => {
    if (document !== undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(namespace.dir, fileName), "utf8")) as unknown;
    } catch {
      // Missing, unreadable, or non-JSON: the only safe reading of an unreadable Telegram connection is that there is no connection. The fresh document is not
      // written until the first real mutation, so a machine that never uses Telegram never gains a file.
      document = initialDocument(nextUuid());
      return;
    }
    // Records from before owner registration never carry authority into the new identity contract.
    const legacy = isRecord(parsed) && parsed.version === 1;
    if (legacy && isRecord(parsed)) {
      parsed = {
        ...parsed, version: STORE_VERSION, ownerUserId: null, pendingCode: null,
        pairing: isRecord(parsed.pairing) ? { ...parsed.pairing, ownerUserId: null } : parsed.pairing,
        lastErrorCode: "telegram-owner-id-required",
      };
    }
    if (!validDocument(parsed)) {
      document = initialDocument(nextUuid());
      return;
    }
    const pruned = prune(parsed, checkedNow());
    document = pruned.document;
    if (pruned.changed || legacy) await persist(pruned.document);
  });

  // Adopt key identity only when nothing is paired; active pairing with changed or absent identity becomes unrecognized and loses its approvals.
  const reconcileActorKey = async (actorKeyDigest: string): Promise<boolean> => {
    if (!digest(actorKeyDigest)) throw inputInvalid();
    return await mutate((current, now) => {
      if (current.actorKeyDigest !== null && timingSafeEqualHexDigest(current.actorKeyDigest, actorKeyDigest)) {
        return { document: current, value: false, changed: false };
      }
      const pairing = current.pairing;
      if (pairing === null || pairing.state !== "active") {
        return { document: { ...current, actorKeyDigest }, value: false, changed: true };
      }
      const unrecognized: StoredPairing = {
        ...pairing,
        state: "unrecognized",
        epoch: nextEpoch(pairing.epoch),
      };
      return {
        document: prune({ ...current, actorKeyDigest, pairing: unrecognized }, now).document,
        value: true,
        changed: true,
      };
    });
  };

  const setConnected = async (fingerprint: string): Promise<void> => {
    if (!digest(fingerprint)) throw inputInvalid();
    await mutate((current) => {
      // Actor digests are derived from the bot identity, so a different bot makes every stored digest meaningless rather than merely stale.
      const sameBot = current.botFingerprint !== null
        && timingSafeEqualHexDigest(current.botFingerprint, fingerprint);
      return {
        document: {
          ...current,
          activationEpoch: nextEpoch(current.activationEpoch),
          desiredState: "connected",
          botFingerprint: fingerprint,
          pollOffset: sameBot ? current.pollOffset : null,
          pendingCode: sameBot ? current.pendingCode : null,
          pairing: sameBot ? current.pairing : null,
          approvals: sameBot ? current.approvals : [],
          lastErrorCode: null,
        },
        value: undefined,
        changed: true,
      };
    });
  };

  const setOwnerUserId = async (ownerUserId: string): Promise<void> => {
    if (!isTelegramOwnerUserId(ownerUserId)) throw inputInvalid();
    await mutate((current, now) => {
      if (current.ownerUserId === ownerUserId) return { document: current, value: undefined, changed: false };
      return {
        document: prune({
          ...current, ownerUserId, activationEpoch: nextEpoch(current.activationEpoch), pendingCode: null,
          desiredState: current.desiredState === "connected" ? "paused" : current.desiredState,
          pairing: current.pairing === null ? null : {
            ...current.pairing, state: "unrecognized", epoch: nextEpoch(current.pairing.epoch),
          },
          lastErrorCode: null,
        }, now).document,
        value: undefined, changed: true,
      };
    });
  };

  const setPaused = async (): Promise<boolean> => await mutate((current) => {
    if (current.desiredState === "paused") return { document: current, value: true, changed: false };
    if (current.desiredState !== "connected") {
      return { document: current, value: false, changed: false };
    }
    return {
      document: { ...current, desiredState: "paused" },
      value: true,
      changed: true,
    };
  });

  const setDisconnected = async (): Promise<void> => await mutate((current) => ({
    document: {
      ...current,
      activationEpoch: nextEpoch(current.activationEpoch),
      desiredState: "disconnected",
      pollOffset: null,
      pendingCode: null,
      pairing: null,
      approvals: [],
    },
    value: undefined,
    changed: true,
  }));

  const recordPollOffset = async (offset: number): Promise<void> => {
    if (!isNonNegativeSafeInteger(offset)) throw inputInvalid();
    await mutate((current) => (
      current.pollOffset !== null && offset <= current.pollOffset
        ? { document: current, value: undefined, changed: false }
        : { document: { ...current, pollOffset: offset }, value: undefined, changed: true }
    ));
  };

  const setLastError = async (code: TelegramConnectionErrorCode | null): Promise<void> => {
    if (code !== null && !isTelegramConnectionErrorCode(code)) throw inputInvalid();
    await mutate((current) => (
      current.lastErrorCode === code
        ? { document: current, value: undefined, changed: false }
        : { document: { ...current, lastErrorCode: code }, value: undefined, changed: true }
    ));
  };

  const createPendingCode = async (
    input: CreateTelegramPendingCodeInput,
  ): Promise<TelegramPendingCodeRecord> => {
    if (!isRecord(input) || !digest(input.codeDigest)) throw inputInvalid();
    const ttlMs = input.ttlMs ?? TELEGRAM_PAIRING_CODE_TTL_MS;
    const maxAttempts = input.maxAttempts ?? DEFAULT_PENDING_CODE_ATTEMPTS;
    if (
      !validDuration(ttlMs, MAX_PENDING_CODE_TTL_MS)
      || !validDuration(maxAttempts, MAX_PENDING_CODE_ATTEMPTS)
    ) {
      throw inputInvalid();
    }
    return await mutate((current, now) => {
      if (current.ownerUserId === null) throw inputInvalid();
      const pendingCode: StoredPendingCode = {
        id: nextUuid(),
        codeDigest: input.codeDigest,
        expiresAt: addDuration(now, ttlMs),
        attemptsRemaining: maxAttempts,
      };
      return {
        document: { ...current, pendingCode },
        value: pendingCodeRecord(pendingCode),
        changed: true,
      };
    });
  };

  const chargeAttempt = (
    current: StoreDocument,
  ): { readonly document: StoreDocument; readonly value: TelegramPendingCodeRecord | null } => {
    if (current.pendingCode === null) return { document: current, value: null };
    const attemptsRemaining = current.pendingCode.attemptsRemaining - 1;
    if (attemptsRemaining < 1) {
      return { document: { ...current, pendingCode: null }, value: null };
    }
    const pendingCode: StoredPendingCode = { ...current.pendingCode, attemptsRemaining };
    return {
      document: { ...current, pendingCode },
      value: pendingCodeRecord(pendingCode),
    };
  };

  const consumePendingCodeAttempt = async (): Promise<TelegramPendingCodeRecord | null> =>
    await mutate((current) => {
      if (current.pendingCode === null) {
        return { document: current, value: null, changed: false };
      }
      const charged = chargeAttempt(current);
      return { document: charged.document, value: charged.value, changed: true };
    });

  const completePairing = async (
    input: CompleteTelegramPairingInput,
  ): Promise<TelegramPairingRecord | null> => {
    if (!isRecord(input) || !isTelegramOwnerUserId(input.senderId) || !digest(input.codeDigest) || !digest(input.actorDigest)) {
      throw inputInvalid();
    }
    return await mutate((current, now) => {
      if (current.ownerUserId === null || current.ownerUserId !== input.senderId) {
        return { document: current, value: null, changed: false };
      }
      if (current.pendingCode === null) {
        return { document: current, value: null, changed: false };
      }
      if (!timingSafeEqualHexDigest(current.pendingCode.codeDigest, input.codeDigest)) {
        const charged = chargeAttempt(current);
        return { document: charged.document, value: null, changed: true };
      }
      const previous = current.pairing;
      const pairing: StoredPairing = {
        ownerUserId: current.ownerUserId,
        // A fresh id, so a stale owner surface cannot revoke the pairing that replaced the one it is still displaying.
        id: nextUuid(),
        actorDigest: input.actorDigest,
        state: "active",
        epoch: previous === null ? 1 : nextEpoch(previous.epoch),
        createdAt: now,
      };
      return {
        document: { ...current, pendingCode: null, pairing, approvals: [] },
        value: pairingRecord(pairing),
        changed: true,
      };
    });
  };

  const revokePairing = async (id: string): Promise<boolean> => {
    if (!isTelegramConnectionId(id)) return false;
    return await mutate((current, now) => {
      const pairing = current.pairing;
      if (pairing === null || pairing.id !== id || pairing.state !== "active") {
        return { document: current, value: false, changed: false };
      }
      const revoked: StoredPairing = {
        ...pairing,
        state: "revoked",
        epoch: nextEpoch(pairing.epoch),
      };
      // prune() turns the now-superseded approvals terminal on the same pass.
      return {
        document: prune({ ...current, pairing: revoked }, now).document,
        value: true,
        changed: true,
      };
    });
  };

  const createApproval = async (
    input: CreateTelegramApprovalInput,
  ): Promise<TelegramApprovalAuthority | null> => {
    if (!isRecord(input)
      || !isTelegramConversationId(input.conversationId)
      || !digest(input.conversationDigest)) {
      throw inputInvalid();
    }
    const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!validDuration(ttlMs, MAX_APPROVAL_TTL_MS)) throw inputInvalid();
    return await mutate((current, now) => {
      const pairing = current.pairing;
      if (pairing === null || pairing.state !== "active") {
        return { document: current, value: null, changed: false };
      }
      // The seam check. The caller derived the digest from its own injection; if that disagrees with this store's, the grant would be written and then be
      // unresolvable forever, which is far harder to diagnose than a refusal.
      if (!timingSafeEqualHexDigest(
        conversationDigestOf(current.botFingerprint, input.conversationId),
        input.conversationDigest,
      )) {
        throw inputInvalid();
      }
      // Keep one live share visible and revocable; retire and prune old grants on the same mutation.
      const retired = prune({
        ...current,
        approvals: current.approvals.map((approval): StoredApproval => (
          approval.state === "active"
            ? { ...approval, state: "revoked", epoch: nextEpoch(approval.epoch) }
            : approval
        )),
      }, now).document;
      const approval: StoredApproval = {
        id: nextUuid(),
        pairingId: pairing.id,
        pairingEpoch: pairing.epoch,
        conversationId: input.conversationId,
        conversationDigest: input.conversationDigest,
        scope: nextUuid(),
        state: "active",
        epoch: 1,
        createdAt: now,
        expiresAt: addDuration(now, ttlMs),
      };
      return {
        document: { ...retired, approvals: [...retired.approvals, approval] },
        value: authority(pairing, approval),
        changed: true,
      };
    });
  };

  const revokeApproval = async (id: string): Promise<boolean> => {
    if (!isTelegramConnectionId(id)) return false;
    return await mutate((current, now) => {
      const index = current.approvals.findIndex((approval) => approval.id === id);
      const approval = current.approvals[index];
      if (approval === undefined || approval.state !== "active") {
        return { document: current, value: false, changed: false };
      }
      const approvals = [...current.approvals];
      approvals[index] = { ...approval, state: "revoked", epoch: nextEpoch(approval.epoch) };
      // prune() drops the record it just retired, so the plaintext conversation id of an ended share does not outlive the share on disk.
      return {
        document: prune({ ...current, approvals }, now).document,
        value: true,
        changed: true,
      };
    });
  };

  // The one gate on "is this actor allowed to be asking at all". Both the egress fence and the durable binding read it, so a paused or re-paired
  // connection cannot answer one of them while denying the other.
  const livePairingFor = (actorDigest: string, current: StoreDocument): StoredPairing | null => {
    const pairing = current.pairing;
    return current.desiredState !== "connected"
      || pairing === null
      || current.ownerUserId === null
      || pairing.ownerUserId !== current.ownerUserId
      || pairing.state !== "active"
      || !timingSafeEqualHexDigest(pairing.actorDigest, actorDigest)
      ? null
      : pairing;
  };

  const resolveActiveApproval = (
    actorDigest: string,
    conversationDigest: string,
  ): TelegramApprovalAuthority | null => {
    try {
      if (!digest(actorDigest) || !digest(conversationDigest)) return null;
      const current = currentView();
      const pairing = livePairingFor(actorDigest, current);
      if (pairing === null) return null;
      // Only the conversation is matched here: prune() is the single authority on liveness, so an approval that is still "active" in this view is already
      // known to be unexpired and bound to this pairing at this epoch.
      const approval = liveApprovals(current).find((entry) => (
        timingSafeEqualHexDigest(entry.conversationDigest, conversationDigest)
      ));
      return approval === undefined ? null : authority(pairing, approval);
    } catch {
      // An egress fence answers "no authority" rather than throwing into the delivery path.
      return null;
    }
  };

  const resolveBoundConversation = (actorDigest: string): string | null => {
    try {
      if (!digest(actorDigest)) return null;
      const current = currentView();
      if (livePairingFor(actorDigest, current) === null) return null;
      // liveApprovals() already rejected any record whose plaintext does not re-hash to its digest, so a file edited in one place cannot be followed here. A
      // consistently edited one can; see the file header.
      return newestApproval(liveApprovals(current))?.conversationId ?? null;
    } catch {
      return null;
    }
  };

  const ownerSnapshot = (): TelegramOwnerConnectionSnapshot => {
    const current = currentView();
    const pairing = current.pairing;
    const approval = newestApproval(liveApprovals(current));
    return Object.freeze({
      ownerUserId: current.ownerUserId,
      desiredState: current.desiredState,
      activationEpoch: current.activationEpoch,
      botFingerprint: current.botFingerprint,
      pairing: pairing === null || pairing.state !== "active"
        ? null
        : Object.freeze({
            id: pairing.id,
            accountFingerprint: pairing.actorDigest.slice(0, ACCOUNT_FINGERPRINT_CHARS),
          }),
      pairingUnrecognized: pairing !== null && pairing.state === "unrecognized",
      approval: approval === null ? null : Object.freeze({
        id: approval.id,
        expiresAt: approval.expiresAt,
        conversationDigest: approval.conversationDigest,
      }),
      pendingCode: current.pendingCode === null ? null : pendingCodeRecord(current.pendingCode),
      lastErrorCode: current.lastErrorCode,
    });
  };

  return Object.freeze({
    open,
    subscribe: (listener: ChangeListener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ownerSnapshot,
    ownerUserId: () => requireDocument().ownerUserId,
    setOwnerUserId,
    receiptOwnerId: () => requireDocument().receiptOwnerId,
    activationEpoch: () => requireDocument().activationEpoch,
    desiredState: () => requireDocument().desiredState,
    botFingerprint: () => requireDocument().botFingerprint,
    activePairingActorDigest: () => {
      const pairing = currentView().pairing;
      return pairing !== null && pairing.state === "active" ? pairing.actorDigest : null;
    },
    pollOffset: () => requireDocument().pollOffset,
    reconcileActorKey,
    setConnected,
    setPaused,
    setDisconnected,
    recordPollOffset,
    setLastError,
    createPendingCode,
    consumePendingCodeAttempt,
    completePairing,
    revokePairing,
    createApproval,
    revokeApproval,
    resolveActiveApproval,
    resolveBoundConversation,
  });
}
