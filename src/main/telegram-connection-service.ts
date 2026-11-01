// Renderers receive connection summaries and the locally registered owner ID, never tokens or conversation IDs. Only stable error codes leave this module because fetch
// errors can embed tokens in URLs.
import { createHash } from "node:crypto";
import { SecretEncryptionUnavailableError } from "../data/secret-document-store.js";
import { AveHomeConfigurationUntrustedError } from "../shared/ave-home.js";
import {
  TELEGRAM_PAIRING_CODE_TTL_MS,
  isTelegramApprovalDurationPreset,
  isTelegramBotToken,
  isTelegramBotUsername,
  isTelegramConnectionId,
  isTelegramConversationId,
  isTelegramOwnerUserId,
  parseTelegramConnectionSnapshot,
  parseTelegramCreatedPairingCode,
  type TelegramApprovalDurationPreset,
  type TelegramConnectionErrorCode,
  type TelegramConnectionFailure,
  type TelegramConnectionMutationResult,
  type TelegramConnectionSnapshotResult,
  type TelegramConnectionState,
  type TelegramCreatePairingCodeResult,
} from "../shared/telegram-connection.js";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
  type TelegramBotApiFailureReason,
  type TelegramBotApiResult,
  type TelegramBotIdentity,
  type TelegramWebhookStatus,
} from "./telegram-bot-api-client.js";
import type {
  TelegramConnectionStore,
  TelegramDesiredState,
  TelegramOwnerApprovalSummary,
  TelegramOwnerConnectionSnapshot,
} from "./telegram-connection-store.js";
import { mintTelegramPairingCode, telegramPairingCodeDigest } from "./telegram-pairing-code.js";
import type { TelegramPollHealth } from "./telegram-bridge-server.js";
import { createSerialQueue } from "../lib/with-file-lock.js";

// Sole storage key for the owner bot token; activation reads the same one. Security-sensitive: read it only through `getEncryptedSecret`.
export const TELEGRAM_BOT_TOKEN_SECRET_KEY = "telegram.botToken.v1";
const SECRET_KEY = TELEGRAM_BOT_TOKEN_SECRET_KEY;
// Must stay byte-identical to `botFingerprint()` in telegram-bridge-server.ts: the platform runtime derives every actor digest from this value, so a
// second grammar would silently invalidate stored pairings.
const BOT_FINGERPRINT_DOMAIN = "ave/telegram-bridge/bot-fingerprint/v1\0";
const PAIRING_CODE_MAX_ATTEMPTS = 5;

const APPROVAL_DURATION_MS: Readonly<Record<TelegramApprovalDurationPreset, number>> = Object.freeze({
  "1h": 60 * 60 * 1_000,
  "8h": 8 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

// What the facade hands an activation so it can report how polling is going.
export interface TelegramBridgeStartHooks {
  readonly onPollHealth: (health: TelegramPollHealth) => void;
}

// Lifecycle hooks owned by main composition; this facade only sequences them.
interface TelegramConnectionBridgeControl {
  start(hooks: TelegramBridgeStartHooks): Promise<void>;
  stop(reason: "shutdown" | "user"): Promise<void>;
  // Poll again now if an activation is running; a no-op otherwise.
  nudge?(): void;
}

// Wait before the next automatic resume after `attempt` failed ones in a row: 5 s, 10 s, 20 s ... capped at five minutes. Slower than the poll loop's
// own backoff because each attempt is a full bot verification, not one poll; a wake or a network coming back skips the wait entirely.
export function telegramResumeRetryDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 16);
  return Math.min(RESUME_RETRY_BASE_MS * 2 ** exponent, RESUME_RETRY_MAX_MS);
}
const RESUME_RETRY_BASE_MS = 5_000;
const RESUME_RETRY_MAX_MS = 5 * 60 * 1_000;

// Automatically retry only unreachable-provider failures; invalid tokens, conflicts, unreadable credentials, and storage failures require owner action.
export function isTransientTelegramResumeFailure(code: TelegramConnectionErrorCode): boolean {
  return code === "telegram-provider-unreachable";
}

// Subscribe to an event; returns the unsubscribe.
export type TelegramWakeSource = (listener: () => void) => () => void;

// How often {@link createNetworkOnlineSource} looks, while it is subscribed.
const NETWORK_ONLINE_CHECK_MS = 5_000;

// Poll connectivity only while reconnecting; false is reliable and a false-to-true edge permits retry without claiming reachability.
export function createNetworkOnlineSource(
  isOnline: () => boolean,
  intervalMs: number = NETWORK_ONLINE_CHECK_MS,
): TelegramWakeSource {
  return (listener) => {
    const read = (): boolean => {
      try {
        return isOnline();
      } catch {
        return false;
      }
    };
    let wasOnline = read();
    const timer = setInterval(() => {
      const online = read();
      if (online && !wasOnline) listener();
      wasOnline = online;
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  };
}

// The narrow slice of the settings store this facade may use. `getSecret` is deliberately absent: it can return a value stored under the development
// plain-text encoding, which must never be sent to an external cloud provider.
interface TelegramConnectionSecretService {
  setSecret(key: string, value: string): Promise<void>;
  getEncryptedSecret(key: string): string | null;
  deleteSecret(key: string): Promise<void>;
  isSecretStorageEncrypted(): boolean;
}

export interface CreateTelegramConnectionServiceOptions {
  readonly store: TelegramConnectionStore;
  readonly settingsService: TelegramConnectionSecretService;
  readonly bridgeControl: TelegramConnectionBridgeControl;
  // Actor-key reconciliation is required and precedes credential access so stale pairing cannot appear healthy.
  readonly reconcileActorKey: () => Promise<void>;
  // Read at the moment of an approval; a renderer can never choose this id.
  readonly getCurrentConversationId: () => string;
  readonly conversationDigestFor: (conversationId: string) => string;
  // Whether a conversation still exists. Required rather than optional: an absent check would silently make every deleted share look healthy, which is the
  // exact failure this dependency exists to end.
  readonly conversationExists: (conversationId: string) => boolean;
  // Require the composed OS-aware transport for verification; ambient fetch ignores machine proxy and trust.
  readonly networkFetch: typeof fetch;
  // The machine woke from sleep. Subscribed for the service's lifetime: a long poll in flight across a sleep usually sits on a dead socket, so the wake is
  // the moment to poll again whether or not anything has failed yet.
  readonly onSystemResume?: TelegramWakeSource;
  // The machine came back online. Subscribed only while reconnecting, so a source that has to watch for it costs nothing while Telegram is answering.
  readonly onNetworkOnline?: TelegramWakeSource;
  // Test seam for the resume retry timer; production uses an unref'd timeout.
  readonly scheduleRetry?: (run: () => void, delayMs: number) => () => void;
  // Test-only injection; production builds a real Bot API client.
  readonly createBotApiClient?: (botToken: string) => TelegramBotApiClient;
}

export interface TelegramConnectionService {
  setOwnerUserId(ownerUserId: string): Promise<TelegramConnectionMutationResult>;
  snapshot(): TelegramConnectionSnapshotResult;
  connect(botToken: string): Promise<TelegramConnectionMutationResult>;
  disconnect(): Promise<TelegramConnectionMutationResult>;
  pause(): Promise<TelegramConnectionMutationResult>;
  resume(): Promise<TelegramConnectionMutationResult>;
  // Boot-time continuation only; never a user action.
  resumeStoredConnection(): Promise<void>;
  createPairingCode(): Promise<TelegramCreatePairingCodeResult>;
  revokePairing(id: string): Promise<TelegramConnectionMutationResult>;
  approveCurrentConversation(
    duration?: TelegramApprovalDurationPreset,
  ): Promise<TelegramConnectionMutationResult>;
  revokeApproval(id: string): Promise<TelegramConnectionMutationResult>;
  subscribe(listener: () => void): () => void;
  // Cancel a pending automatic resume and drop the wake subscriptions.
  dispose(): void;
}

// Same digest the platform runtime is handed as `botFingerprint`.
function telegramBotFingerprint(botToken: string): string {
  return createHash("sha256")
    .update(BOT_FINGERPRINT_DOMAIN, "utf8")
    .update(botToken, "utf8")
    .digest("hex");
}

const OK: TelegramConnectionMutationResult = Object.freeze({ ok: true as const });

function failure(error: TelegramConnectionErrorCode): TelegramConnectionFailure {
  return Object.freeze({ ok: false as const, error });
}

const UNAVAILABLE = failure("telegram-connection-unavailable");
const ENCRYPTION_UNAVAILABLE = failure("telegram-encryption-unavailable");
const INPUT_INVALID = failure("telegram-connection-input-invalid");
const REJECTED = failure("telegram-connection-operation-rejected");
const TOKEN_UNREADABLE = failure("telegram-bot-token-unreadable");

// Classify a Bot API failure. A 401 is the token itself; a 409 means another receiver already owns this bot's updates. Everything else is reported as an
// unreachable provider rather than guessed at.
function providerFailure(reason: TelegramBotApiFailureReason): TelegramConnectionFailure {
  if (reason === "unauthorized") return failure("telegram-bot-token-rejected");
  if (reason === "conflict") return failure("telegram-poll-conflict");
  return failure("telegram-provider-unreachable");
}

function isFailure(value: { readonly ok: boolean }): value is TelegramConnectionFailure {
  return value.ok === false;
}

// A verified bot carries its handle; a failure carries only a stable code.
type VerifiedBot =
  | { readonly ok: true; readonly username: string }
  | TelegramConnectionFailure;

function isBridgeControl(value: unknown): value is TelegramConnectionBridgeControl {
  return typeof value === "object"
    && value !== null
    && typeof (value as TelegramConnectionBridgeControl).start === "function"
    && typeof (value as TelegramConnectionBridgeControl).stop === "function";
}

function isSecretService(value: unknown): value is TelegramConnectionSecretService {
  const candidate = value as TelegramConnectionSecretService | null;
  return typeof value === "object"
    && value !== null
    && typeof candidate?.setSecret === "function"
    && typeof candidate.getEncryptedSecret === "function"
    && typeof candidate.deleteSecret === "function"
    && typeof candidate.isSecretStorageEncrypted === "function";
}

function isStore(value: unknown): value is TelegramConnectionStore {
  const candidate = value as TelegramConnectionStore | null;
  return typeof value === "object"
    && value !== null
    && typeof candidate?.ownerSnapshot === "function"
    && typeof candidate.setConnected === "function"
    && typeof candidate.createPendingCode === "function"
    && typeof candidate.createApproval === "function"
    && typeof candidate.subscribe === "function";
}

interface ApprovalProjection {
  readonly id: string;
  readonly expiresAt: number;
  readonly matchesCurrentConversation: boolean;
}

// Keep missing separate from none and resolved so deleted shared conversations cannot appear healthy or never shared.
type BoundConversation =
  | { readonly kind: "none" }
  | { readonly kind: "missing" }
  | { readonly kind: "resolved"; readonly id: string };

const NO_BOUND_CONVERSATION: BoundConversation = Object.freeze({ kind: "none" as const });
const MISSING_BOUND_CONVERSATION: BoundConversation = Object.freeze({ kind: "missing" as const });

// A durable share survives conversation switches, but execution still requires the shared conversation to be on screen.
function projectApproval(
  approval: TelegramOwnerApprovalSummary | null,
  currentDigest: string | null,
): ApprovalProjection | null {
  if (approval === null) return null;
  return Object.freeze({
    id: approval.id,
    expiresAt: approval.expiresAt,
    matchesCurrentConversation: currentDigest !== null
      && approval.conversationDigest === currentDigest,
  });
}

// Evaluate host capability, pause, and approval before active state; a durable share stays active while viewed elsewhere.
// Key loss and deleted conversations are persistent owner-repair states, not transient provider errors.
function deriveState(
  owner: TelegramOwnerConnectionSnapshot,
  bound: BoundConversation,
  reconnecting: boolean,
): TelegramConnectionState {
  if (owner.desiredState === "disconnected") return "disconnected";
  if (owner.desiredState === "paused") return "paused-by-owner";
  // Show reconnecting before saved provider errors or share state so unreachable service cannot appear active.
  if (reconnecting) return "reconnecting";
  if (owner.lastErrorCode !== null) return "error";
  if (owner.pairing === null) {
    // A code already minted is the repair in progress; say so rather than repeating the loss the owner is in the middle of fixing.
    if (owner.pendingCode !== null) return "pairing-pending";
    return owner.pairingUnrecognized ? "pairing-unrecognized" : "connected-unpaired";
  }
  // The resolver is the single authority for all three of these. Deciding "is anything shared" from `approval` and "does it resolve" from `bound` would be
  // two sources for one question, and the case where they disagree is exactly the one that has to be reported rather than averaged.
  switch (bound.kind) {
    case "none": return "paired-unapproved";
    case "missing": return "shared-conversation-missing";
    case "resolved": return "active";
  }
}

export function createTelegramConnectionService(
  options: CreateTelegramConnectionServiceOptions,
): TelegramConnectionService {
  if (
    !options
    || typeof options !== "object"
    || !isStore(options.store)
    || !isSecretService(options.settingsService)
    || !isBridgeControl(options.bridgeControl)
    || typeof options.reconcileActorKey !== "function"
    || typeof options.getCurrentConversationId !== "function"
    || typeof options.conversationDigestFor !== "function"
  ) {
    throw new Error("telegram-connection-service-invalid");
  }
  const { store, settingsService, bridgeControl } = options;
  const makeClient = options.createBotApiClient
    ?? ((botToken: string) =>
      createTelegramBotApiClient({ botToken, fetchImplementation: options.networkFetch }));
  const listeners = new Set<() => void>();
  // Serialize multi-step lifecycle work so two connects cannot interleave.
  const runExclusive = createSerialQueue();

  // Resolved from getMe and never persisted; a restart re-verifies it.
  let botUsername: string | null = null;

  const emitChange = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A surface refresh failure must not abort a completed lifecycle step.
      }
    }
  };

  store.subscribe(emitChange);

  // Keep retry timer and failure reason in memory; restart re-derives them from durable desired state.
  let pollRetrying = false;
  // An automatic resume is scheduled after a resume Telegram did not answer.
  let resumeRetry: { readonly attempt: number; readonly cancel: () => void } | null = null;
  let disposed = false;
  let stopNetworkWatch: (() => void) | null = null;
  const scheduleRetry = options.scheduleRetry ?? ((run: () => void, delayMs: number) => {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  });

  const reconnecting = (): boolean => pollRetrying || resumeRetry !== null;

  // Watch for the network only while there is something to reconnect.
  const syncNetworkWatch = (): void => {
    const want = !disposed && reconnecting() && options.onNetworkOnline !== undefined;
    if (want && stopNetworkWatch === null) {
      try {
        stopNetworkWatch = options.onNetworkOnline!(() => wake());
      } catch {
        stopNetworkWatch = null;
      }
    } else if (!want && stopNetworkWatch !== null) {
      const stop = stopNetworkWatch;
      stopNetworkWatch = null;
      try {
        stop();
      } catch {
        // nothing to keep
      }
    }
  };

  const cancelResumeRetry = (): void => {
    if (resumeRetry === null) return;
    resumeRetry.cancel();
    resumeRetry = null;
    syncNetworkWatch();
  };

  const notePollHealth = (health: TelegramPollHealth): void => {
    const next = health === "retrying";
    if (next === pollRetrying) return;
    pollRetrying = next;
    syncNetworkWatch();
    emitChange();
  };

  // Try again after a resume Telegram did not answer, and keep trying — the reference remote surfaces reconnect on their own after sleep or a network loss
  // rather than leaving a dead connection for the owner to notice.
  const scheduleResumeRetry = (attempt: number): void => {
    if (disposed) return;
    resumeRetry?.cancel();
    const cancel = scheduleRetry(() => {
      if (resumeRetry?.cancel !== cancel) return;
      void runResumeRetry(attempt);
    }, telegramResumeRetryDelayMs(attempt));
    resumeRetry = Object.freeze({ attempt, cancel });
    syncNetworkWatch();
  };

  const runResumeRetry = async (attempt: number): Promise<void> => {
    // Keep the slot (and with it the `reconnecting` state) while the attempt runs; the attempt's own outcome decides whether another is scheduled.
    if (disposed || readDesiredState() !== "connected") {
      cancelResumeRetry();
      emitChange();
      return;
    }
    await resumeWithRetry(attempt + 1, "automatic");
  };

  // The machine woke or came back online: retry a pending resume now, from the bottom of its backoff, or tell a running activation to poll now.
  const wake = (): void => {
    if (disposed) return;
    if (resumeRetry !== null) {
      resumeRetry.cancel();
      // Same slot, no timer: the attempt below either clears it or reschedules.
      resumeRetry = Object.freeze({ attempt: 0, cancel: () => undefined });
      void runResumeRetry(0);
      return;
    }
    try {
      bridgeControl.nudge?.();
    } catch {
      // the next scheduled poll still runs
    }
  };

  let stopResumeWatch: (() => void) | null = null;
  if (options.onSystemResume !== undefined) {
    try {
      stopResumeWatch = options.onSystemResume(() => wake());
    } catch {
      stopResumeWatch = null;
    }
  }

  const bridgeHooks: TelegramBridgeStartHooks = Object.freeze({ onPollHealth: notePollHealth });

  // The conversation on screen, named both ways. The store persists the id so the share survives a restart and re-derives the digest to check it, so a
  // caller that produced one without the other could not be verified.
  const currentConversation = (): { readonly id: string; readonly digest: string } | null => {
    try {
      const id = options.getCurrentConversationId();
      if (!isTelegramConversationId(id)) return null;
      const digest = options.conversationDigestFor(id);
      return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? { id, digest } : null;
    } catch {
      return null;
    }
  };

  // Use the same digest-validated durable binding as egress, never a default conversation.
  // Treat failed existence checks as missing rather than claiming a healthy share.
  const boundConversation = (): BoundConversation => {
    try {
      const actorDigest = store.activePairingActorDigest();
      if (actorDigest === null) return NO_BOUND_CONVERSATION;
      const id = store.resolveBoundConversation(actorDigest);
      if (id === null) return NO_BOUND_CONVERSATION;
      // A newly opened current conversation exists before its first saved transcript; check current identity before disk existence.
      if (id === currentConversation()?.id) {
        return Object.freeze({ kind: "resolved" as const, id });
      }
      return options.conversationExists(id)
        ? Object.freeze({ kind: "resolved" as const, id })
        : MISSING_BOUND_CONVERSATION;
    } catch {
      return MISSING_BOUND_CONVERSATION;
    }
  };

  const inertSnapshot = (state: TelegramConnectionState): TelegramConnectionSnapshotResult => {
    const snapshot = parseTelegramConnectionSnapshot({
      ownerUserId: null,
      state,
      botUsername: null,
      pairing: null,
      approval: null,
      pendingCode: null,
      lastErrorCode: null,
    });
    return snapshot === null ? UNAVAILABLE : Object.freeze({ ok: true as const, snapshot });
  };

  // Best-effort: never let a persisted note about a failure mask the failure.
  const noteError = async (error: TelegramConnectionErrorCode): Promise<void> => {
    try {
      await store.setLastError(error);
    } catch {
      // the returned code is the authority; the stored note is a convenience
    }
  };

  // Reconcile before resume reads credentials, and after first connect stores bot identity; return stable failure codes instead of throws.
  const reconcileActorKeyFailure = async (): Promise<TelegramConnectionFailure | null> => {
    try {
      await options.reconcileActorKey();
      return null;
    } catch {
      return UNAVAILABLE;
    }
  };

  const readDesiredState = (): TelegramDesiredState | null => {
    try {
      return store.desiredState();
    } catch {
      return null;
    }
  };

  // Rollback to disconnected only if the attempt began there; setDisconnected erases pairing and approvals, so preserve all other or unreadable states.
  const restorePreviousDesiredState = async (
    previous: TelegramDesiredState | null,
  ): Promise<void> => {
    if (previous !== "disconnected") return;
    try {
      await store.setDisconnected();
    } catch {
      // the bridge is not running either way
    }
  };

  const readStoredToken = (): string | null => {
    try {
      const value = settingsService.getEncryptedSecret(SECRET_KEY);
      return isTelegramBotToken(value) ? value : null;
    } catch (error) {
      if (error instanceof AveHomeConfigurationUntrustedError) throw error;
      return null;
    }
  };

  // Put the credential back the way it was. A connect attempt with a new token must not destroy the working one it failed to replace.
  const restoreSecret = async (previous: string | null): Promise<void> => {
    try {
      if (previous === null) await settingsService.deleteSecret(SECRET_KEY);
      else await settingsService.setSecret(SECRET_KEY, previous);
    } catch {
      // rollback is best effort; the caller already has its failure code
    }
  };

  // Verify identity and webhook ownership before durable activation; never take over another deployment’s webhook.
  const verifyBot = async (botToken: string): Promise<VerifiedBot> => {
    let client: TelegramBotApiClient;
    try {
      client = makeClient(botToken);
    } catch {
      return INPUT_INVALID;
    }
    let identity: TelegramBotApiResult<TelegramBotIdentity>;
    try {
      identity = await client.getMe();
    } catch {
      return failure("telegram-provider-unreachable");
    }
    if (!identity.ok) return providerFailure(identity.reason);
    if (!isTelegramBotUsername(identity.value.username)) {
      return failure("telegram-provider-unreachable");
    }
    let webhook: TelegramBotApiResult<TelegramWebhookStatus>;
    try {
      webhook = await client.getWebhookInfo();
    } catch {
      return failure("telegram-provider-unreachable");
    }
    if (!webhook.ok) return providerFailure(webhook.reason);
    // Fail closed: an already-registered webhook belongs to someone else, and removing it is not Ave's call to make.
    if (webhook.value.hasWebhook) return failure("telegram-webhook-conflict");
    return Object.freeze({ ok: true as const, username: identity.value.username });
  };

  // Failed activation preserves stored pairing, shares, codes, and offsets; record an error instead of using destructive disconnect as rollback.
  const activate = async (
    botToken: string,
    username: string,
  ): Promise<TelegramConnectionMutationResult> => {
    if (store.ownerUserId() === null) return failure("telegram-owner-id-required");
    try {
      await store.setConnected(telegramBotFingerprint(botToken));
    } catch {
      return UNAVAILABLE;
    }
    // The document now names a bot, which is what a first connect needs before the actor key can be adopted for it.
    const reconciled = await reconcileActorKeyFailure();
    if (reconciled !== null) return reconciled;
    try {
      await bridgeControl.start(bridgeHooks);
    } catch {
      return UNAVAILABLE;
    }
    botUsername = username;
    emitChange();
    return OK;
  };

  const snapshot = (): TelegramConnectionSnapshotResult => {
    try {
      if (!settingsService.isSecretStorageEncrypted()) return inertSnapshot("unsupported");
      const owner = store.ownerSnapshot();
      const approval = projectApproval(owner.approval, currentConversation()?.digest ?? null);
      const projected = parseTelegramConnectionSnapshot({
        ownerUserId: owner.ownerUserId,
        state: deriveState(owner, boundConversation(), reconnecting()),
        botUsername,
        pairing: owner.pairing === null
          ? null
          : { id: owner.pairing.id, accountFingerprint: owner.pairing.accountFingerprint },
        approval,
        pendingCode: owner.pendingCode === null
          ? null
          : {
              id: owner.pendingCode.id,
              expiresAt: owner.pendingCode.expiresAt,
              attemptsRemaining: owner.pendingCode.attemptsRemaining,
            },
        // A poll loop that is retrying records nothing durable, so the reason shown next to "reconnecting" is projected here, from memory.
        lastErrorCode: owner.lastErrorCode ?? (pollRetrying ? "telegram-provider-unreachable" : null),
      });
      return projected === null ? UNAVAILABLE : Object.freeze({ ok: true as const, snapshot: projected });
    } catch {
      return UNAVAILABLE;
    }
  };

  const connect = async (botToken: string): Promise<TelegramConnectionMutationResult> => {
    if (!isTelegramBotToken(botToken)) return INPUT_INVALID;
    return await runExclusive(async () => {
      // Probed before any write: an unencryptable host must not receive the token even briefly.
      let encrypted: boolean;
      try {
        encrypted = settingsService.isSecretStorageEncrypted();
      } catch {
        return ENCRYPTION_UNAVAILABLE;
      }
      if (!encrypted) return ENCRYPTION_UNAVAILABLE;
      // A new token supersedes any automatic resume of the old one.
      cancelResumeRetry();

      // Both halves of "put it back the way it was", read before the first write so a failed attempt can restore the credential and the state it replaced.
      const previous = readStoredToken();
      const previousDesired = readDesiredState();
      try {
        await settingsService.setSecret(SECRET_KEY, botToken);
      } catch (error) {
        return error instanceof SecretEncryptionUnavailableError
          ? ENCRYPTION_UNAVAILABLE
          : UNAVAILABLE;
      }

      const verified = await verifyBot(botToken);
      if (!verified.ok) {
        await restoreSecret(previous);
        await noteError(verified.error);
        return verified;
      }
      const activated = await activate(botToken, verified.username);
      if (isFailure(activated)) {
        await restoreSecret(previous);
        await restorePreviousDesiredState(previousDesired);
        await noteError(activated.error);
      }
      return activated;
    });
  };

  const setOwnerUserId = async (ownerUserId: string): Promise<TelegramConnectionMutationResult> => {
    if (!isTelegramOwnerUserId(ownerUserId)) return INPUT_INVALID;
    return runExclusive(async () => {
      try {
        if (store.ownerUserId() === ownerUserId) return OK;
        // Persist revocation before teardown so already-bound turns lose authority even if shutdown fails.
        await store.setOwnerUserId(ownerUserId);
        cancelResumeRetry();
        await bridgeControl.stop("user");
        botUsername = null;
        emitChange();
        return OK;
      } catch { return UNAVAILABLE; }
    });
  };

  const disconnect = async (): Promise<TelegramConnectionMutationResult> => {
    return await runExclusive(async () => {
      let secretFailure: TelegramConnectionMutationResult | null = null;
      try {
        await settingsService.deleteSecret(SECRET_KEY);
      } catch (error) {
        // Still tear the rest down: a token that survives is worse when the bridge is also left running.
        secretFailure = error instanceof SecretEncryptionUnavailableError
          ? ENCRYPTION_UNAVAILABLE
          : UNAVAILABLE;
      }
      try {
        await store.setDisconnected();
      } catch {
        return UNAVAILABLE;
      }
      botUsername = null;
      cancelResumeRetry();
      try {
        await bridgeControl.stop("user");
      } catch {
        return UNAVAILABLE;
      }
      emitChange();
      return secretFailure ?? OK;
    });
  };

  const pause = async (): Promise<TelegramConnectionMutationResult> => {
    return await runExclusive(async () => {
      let paused: boolean;
      try {
        paused = await store.setPaused();
      } catch {
        return UNAVAILABLE;
      }
      if (!paused) return REJECTED;
      // Paused means nothing reaches Telegram, including an automatic retry.
      cancelResumeRetry();
      try {
        await bridgeControl.stop("user");
      } catch {
        return UNAVAILABLE;
      }
      emitChange();
      return OK;
    });
  };

  // Automatic resume rechecks desired state inside the queue so it cannot undo a pending pause; explicit owner resume may proceed from any state.
  const resume = async (origin: "owner" | "automatic"): Promise<TelegramConnectionMutationResult> => {
    return await runExclusive(async () => {
      if (origin === "automatic" && (disposed || readDesiredState() !== "connected")) return OK;
      let encrypted: boolean;
      try {
        encrypted = settingsService.isSecretStorageEncrypted();
      } catch {
        return ENCRYPTION_UNAVAILABLE;
      }
      if (!encrypted) return ENCRYPTION_UNAVAILABLE;
      // Ahead of the credential read on purpose; `reconcileActorKeyFailure` records why the order is the whole point of this call.
      const reconciled = await reconcileActorKeyFailure();
      if (reconciled !== null) {
        await noteError(reconciled.error);
        return reconciled;
      }
      // Require stored credentials for resume and persist failure codes so unattended boot cannot report an active share without a poll loop.
      const botToken = readStoredToken();
      if (botToken === null) {
        await noteError(TOKEN_UNREADABLE.error);
        return TOKEN_UNREADABLE;
      }
      const verified = await verifyBot(botToken);
      if (!verified.ok) {
        await noteError(verified.error);
        return verified;
      }
      const activated = await activate(botToken, verified.username);
      if (isFailure(activated)) {
        await noteError(activated.error);
        return activated;
      }
      // An activation that was already running keeps its own poll schedule; a resume the owner asked for means "try now", so say so to the loop.
      try {
        bridgeControl.nudge?.();
      } catch {
        // its next scheduled poll still runs
      }
      return activated;
    });
  };

  // Resume, and if Telegram simply could not be reached, keep trying on a backoff and on every wake — while the owner still wants the connection. Any
  // other outcome ends the retrying: success needs none, and every other failure is a stop the owner has to see.
  const resumeWithRetry = async (
    nextAttempt: number,
    origin: "owner" | "automatic",
  ): Promise<TelegramConnectionMutationResult> => {
    const result = await resume(origin);
    if (!result.ok
      && isTransientTelegramResumeFailure(result.error)
      && !disposed
      && readDesiredState() === "connected") {
      scheduleResumeRetry(nextAttempt);
    } else {
      cancelResumeRetry();
    }
    emitChange();
    return result;
  };

  // Boot-time continuation of whatever the owner left connected. A paused, disconnected, or environment-managed store is a no-op, so app start never
  // reaches Telegram on its own. Failures are recorded as the connection's last error rather than surfaced: nobody is at the keyboard.
  const resumeStoredConnection = async (): Promise<void> => {
    let desired: TelegramDesiredState;
    try {
      desired = store.desiredState();
    } catch {
      return;
    }
    if (desired !== "connected") return;
    await resumeWithRetry(1, "automatic");
  };

  const createPairingCode = async (): Promise<TelegramCreatePairingCodeResult> => {
    return await runExclusive(async () => {
      if (store.ownerUserId() === null) return failure("telegram-owner-id-required");
      // The bot handle is in-memory only, so a code cannot be minted before this activation verified the bot it would point the owner at.
      if (botUsername === null) return UNAVAILABLE;
      const handle = botUsername;
      let connected: boolean;
      try {
        connected = store.desiredState() === "connected";
      } catch {
        return UNAVAILABLE;
      }
      if (!connected) return REJECTED;
      // Mint and digest through the shared pairing-code authority; a freshly minted code that cannot digest violates an internal invariant.
      let code: string;
      let codeDigest: string | null;
      try {
        code = mintTelegramPairingCode();
        codeDigest = telegramPairingCodeDigest(code);
      } catch {
        return REJECTED;
      }
      if (codeDigest === null) return REJECTED;
      let minted;
      try {
        minted = await store.createPendingCode({
          codeDigest,
          ttlMs: TELEGRAM_PAIRING_CODE_TTL_MS,
          maxAttempts: PAIRING_CODE_MAX_ATTEMPTS,
        });
      } catch {
        return REJECTED;
      }
      const pairingCode = parseTelegramCreatedPairingCode({
        id: minted.id,
        code,
        expiresAt: minted.expiresAt,
        botUsername: handle,
      });
      if (pairingCode === null) return UNAVAILABLE;
      return Object.freeze({ ok: true as const, pairingCode });
    });
  };

  const revokePairing = async (id: string): Promise<TelegramConnectionMutationResult> => {
    if (!isTelegramConnectionId(id)) return INPUT_INVALID;
    return await runExclusive(async () => {
      try {
        return await store.revokePairing(id) ? OK : REJECTED;
      } catch {
        return UNAVAILABLE;
      }
    });
  };

  const approveCurrentConversation = async (
    duration?: TelegramApprovalDurationPreset,
  ): Promise<TelegramConnectionMutationResult> => {
    if (duration !== undefined && !isTelegramApprovalDurationPreset(duration)) return INPUT_INVALID;
    return await runExclusive(async () => {
      // Resolved here, never received: the renderer cannot name a conversation.
      const conversation = currentConversation();
      if (conversation === null) return REJECTED;
      try {
        const approval = await store.createApproval({
          conversationId: conversation.id,
          conversationDigest: conversation.digest,
          ...(duration === undefined ? {} : { ttlMs: APPROVAL_DURATION_MS[duration] }),
        });
        return approval === null ? REJECTED : OK;
      } catch {
        return UNAVAILABLE;
      }
    });
  };

  const revokeApproval = async (id: string): Promise<TelegramConnectionMutationResult> => {
    if (!isTelegramConnectionId(id)) return INPUT_INVALID;
    return await runExclusive(async () => {
      try {
        return await store.revokeApproval(id) ? OK : REJECTED;
      } catch {
        return UNAVAILABLE;
      }
    });
  };

  return Object.freeze({
    snapshot,
    setOwnerUserId,
    connect,
    disconnect,
    pause,
    resume: () => resumeWithRetry(1, "owner"),
    resumeStoredConnection,
    createPairingCode,
    revokePairing,
    approveCurrentConversation,
    revokeApproval,
    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") throw new Error("telegram-connection-service-invalid");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      disposed = true;
      cancelResumeRetry();
      syncNetworkWatch();
      const stop = stopResumeWatch;
      stopResumeWatch = null;
      try {
        stop?.();
      } catch {
        // nothing to keep
      }
    },
  });
}
