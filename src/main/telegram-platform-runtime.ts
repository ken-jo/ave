// Raw provider identities stay in this short-lived runtime; only the domain-specific HMAC key is durable and encrypted.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SecretStore } from "../audit/hmac-chain.js";
import { createHostSecretStore } from "../audit/host-secret-store.js";
import type { SecretEncryption } from "../data/secret-document-store.js";
import type {
  PlatformBridgeInboundAuthorization,
  PlatformBridgeInboundAuthorizer,
  PlatformBridgeVerifiedEnvelope,
} from "./platform-bridge-inbound.js";
import type { PlatformBridgeBinding, PlatformBridgeGuard } from "../shared/chat-origin.js";
import { isTelegramConversationId, isTelegramOwnerUserId } from "../shared/telegram-connection.js";
import { hasNonWhitespaceControlChars } from "../shared/display-safe-text.js";
import { isPositiveSafeInteger } from "../shared/safe-integer.js";
import { ACTOR_SECRET_BYTES, ACTOR_SECRET_PATTERN } from "./tailnet-paired-share-authorizer.js";

export const TELEGRAM_PLATFORM_ACTOR_SECRET_NAME = "telegram-platform-bridge-actor-v1.key";

const BOT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const MAX_DELIVERY_ID_CHARS = 256;
const MAX_TEXT_CHARS = 24_000;
const ACTOR_HMAC_DOMAIN = "ave/telegram-platform-bridge/actor/v1\0";
const ACTOR_KEY_HMAC_DOMAIN = "ave/telegram-platform-bridge/actor-key/v1\0";
const BINDING_HMAC_DOMAIN = "ave/telegram-platform-bridge/binding/v1\0";
const CONVERSATION_HASH_DOMAIN = "ave/telegram-platform-bridge/conversation/v1\0";

// A single static owner-configured private-DM route. `chatId` is intentionally runtime-only so the outbound Telegram transport can select its
// destination; it is never written to a receipt, feature namespace, log, or secret store.
export interface TelegramPlatformRoute {
  readonly chatId: string;
  // Main-process-only target for the safe projection delivery adapter.
  readonly conversationId: string;
  readonly actorDigest: string;
  // Preferred route binding field for new lifecycle composition.
  readonly binding: PlatformBridgeBinding;
  // Compatibility alias for the bridge core's authorization terminology.
  readonly bridgeBinding: PlatformBridgeBinding;
}

export interface TelegramPlatformRuntime {
  // Pass directly to `createPlatformBridgeInboundGateway({ authorize })`.
  readonly authorize: PlatformBridgeInboundAuthorizer;
  // Main-process-only target captured at start; never provider-visible or persisted.
  readonly conversationId: string;
  // Frozen, main-process-only routes for safe outbound delivery registration.
  readonly routes: readonly TelegramPlatformRoute[];
  // Resolve a verified private-DM envelope without mutating route authority.
  routeForEnvelope(envelope: Readonly<PlatformBridgeVerifiedEnvelope>): TelegramPlatformRoute | null;
  // Egress fence for a route before opening/sending on its delivery channel.
  isRouteCurrent(route: TelegramPlatformRoute): boolean;
  // Revoke every route and every already-admitted bridge guard.
  dispose(): void;
}

// Malformed decrypted key data throws; unreadable quarantined ciphertext mints a fresh key.
// Callers must reconcile actorKeyDigest so keychain reset or machine restore retires durable pairings.
export function ensureTelegramPlatformActorSecret(secretStore: SecretStore): string {
  if (!isSecretStore(secretStore)) {
    throw new Error("telegram-platform-runtime-secret-store-invalid");
  }
  const existing = secretStore.read(TELEGRAM_PLATFORM_ACTOR_SECRET_NAME, 128);
  if (existing !== null) {
    if (!ACTOR_SECRET_PATTERN.test(existing)) {
      throw new Error("telegram-platform-runtime-actor-secret-invalid");
    }
    return existing;
  }
  const generated = randomBytes(ACTOR_SECRET_BYTES).toString("base64url");
  if (!ACTOR_SECRET_PATTERN.test(generated)) {
    throw new Error("telegram-platform-runtime-actor-secret-generation-invalid");
  }
  secretStore.write(TELEGRAM_PLATFORM_ACTOR_SECRET_NAME, generated);
  return generated;
}

// resolveActiveApproval must stay synchronous: awaiting between authorization and delivery bind permits a conversation-switch race.
export interface TelegramPairedRouteAuthority {
  // Explicit identity registered on the desktop; pairing never chooses the owner.
  ownerUserId(): string | null;
  // Opaque digest of the currently paired Telegram account, if any.
  activePairingActorDigest(): string | null;
  // Non-null only while a live approval binds this actor to this conversation.
  resolveActiveApproval(
    actorDigest: string,
    conversationDigest: string,
  ): { readonly scope: string } | null;
  // The conversation this actor's share is bound to, or null. Durable: it answers the same after a restart. It authorizes nothing on its own — the caller
  // still has to clear `resolveActiveApproval` on its digest.
  resolveBoundConversation(actorDigest: string): string | null;
}

// Use one bot-scoped conversation digest for persistence and every egress check so approval cannot survive changing bots.
export function telegramConversationDigest(
  botFingerprint: string,
  conversationId: string,
): string {
  if (!BOT_FINGERPRINT_PATTERN.test(botFingerprint) || !isTelegramConversationId(conversationId)) {
    throw new Error("telegram-conversation-digest-invalid");
  }
  return hashConversation(botFingerprint, conversationId);
}

// One bot's account digester, plus the name of the key it derives from. The two travel together because a stored actor digest is only meaningful under
// the key that produced it. Handing back the digest function alone is what let a rotated key look like a working pairing.
export interface TelegramActorDigester {
  // Opaque name of the durable actor key currently loadable on this machine. Callers persist it next to the digests it produced and compare on every
  // activation; a mismatch means every digest this digester now yields names a different actor than the stored one.
  readonly actorKeyDigest: string;
  // Null for anything that is not a canonical Telegram id.
  digestFor(senderId: string): string | null;
}

// Derive the opaque account digest for a Telegram sender id. Pairing redemption stores this digest, and the paired runtime recomputes it on every
// inbound envelope. Exporting one derivation keeps those two from drifting; a second copy would make a correct pairing unresolvable.
export function createTelegramActorDigester(options: {
  readonly botFingerprint: string;
  readonly secretStore?: SecretStore;
  readonly encryption: SecretEncryption;
}): TelegramActorDigester {
  if (!options || !BOT_FINGERPRINT_PATTERN.test(options.botFingerprint)) {
    throw new Error("telegram-actor-digester-invalid");
  }
  const secretStore = options.secretStore
    ?? createHostSecretStore(options.encryption);
  const actorSecret = ensureTelegramPlatformActorSecret(secretStore);
  return Object.freeze({
    actorKeyDigest: actorKeyDigestFor(actorSecret),
    digestFor: (senderId: string): string | null =>
      isTelegramOwnerUserId(senderId)
        ? actorDigestFor(actorSecret, options.botFingerprint, senderId)
        : null,
  });
}

export interface CreateTelegramPairedPlatformRuntimeOptions {
  readonly botFingerprint: string;
  readonly authority: TelegramPairedRouteAuthority;
  readonly getCurrentConversationId: () => string;
  readonly activationEpoch: number;
  readonly secretStore?: SecretStore;
  readonly encryption: SecretEncryption;
}

// Mint routes lazily from verified inbound identity and the durable shared conversation, keeping raw chat IDs off disk.
// Require both live approval and that same bound conversation on screen; never follow the owner into an unapproved conversation.
export function createTelegramPairedPlatformRuntime(
  options: CreateTelegramPairedPlatformRuntimeOptions,
): TelegramPlatformRuntime {
  if (!options
    || typeof options !== "object"
    || !BOT_FINGERPRINT_PATTERN.test(options.botFingerprint)
    || typeof options.getCurrentConversationId !== "function"
    || !isPositiveSafeInteger(options.activationEpoch)
    || !isRouteAuthority(options.authority)) {
    throw new Error("telegram-paired-platform-runtime-invalid");
  }
  const { authority, botFingerprint, activationEpoch } = options;
  const secretStore = options.secretStore
    ?? createHostSecretStore(options.encryption);
  const actorSecret = ensureTelegramPlatformActorSecret(secretStore);
  const bridgeId = deterministicUuid(actorSecret, "bridge", [botFingerprint]);
  const routesByChatId = new Map<string, TelegramPlatformRoute>();
  const guardsByRoute = new Map<TelegramPlatformRoute, PlatformBridgeGuard>();
  let disposed = false;

  const currentConversationId = (): string | null => {
    try {
      const candidate = options.getCurrentConversationId();
      return isTelegramConversationId(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  const approvalFor = (
    actorDigest: string,
    conversationId: string,
  ): { readonly scope: string } | null => {
    try {
      return authority.resolveActiveApproval(
        actorDigest,
        hashConversation(botFingerprint, conversationId),
      );
    } catch {
      return null;
    }
  };

  // Reread shares per envelope so revoke/re-share takes effect immediately; rederive the returned conversation’s digest before approval lookup.
  const boundConversationId = (actorDigest: string): string | null => {
    try {
      const candidate = authority.resolveBoundConversation(actorDigest);
      return isTelegramConversationId(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  // The approval's own scope participates, so revoking and re-approving produces a binding the previous one cannot satisfy.
  const scopeUuid = (chatId: string, approvalScope: string): string =>
    deterministicUuid(actorSecret, "scope", [botFingerprint, chatId, approvalScope]);

  // Require a live bound approval, the same approval identity that minted the route, and the bound conversation on screen.
  // The screen check is the execution limit even for foreign documents with multiple grants; durable sharing never authorizes background execution.
  const isRouteCurrent = (route: TelegramPlatformRoute): boolean => {
    if (disposed || routesByChatId.get(route.chatId) !== route) return false;
    try {
      if (authority.ownerUserId() !== route.chatId) return false;
    } catch { return false; }
    const approval = approvalFor(route.actorDigest, route.conversationId);
    if (approval === null) return false;
    if (scopeUuid(route.chatId, approval.scope) !== route.binding.scope) return false;
    return currentConversationId() === route.conversationId;
  };

  const mintRoute = (chatId: string, conversationId: string, scope: string): TelegramPlatformRoute => {
    const bridgeBinding = Object.freeze({
      bridgeId,
      bridgeEpoch: activationEpoch,
      routeId: deterministicUuid(actorSecret, "route", [botFingerprint, chatId]),
      routeEpoch: 1,
      scope: scopeUuid(chatId, scope),
    } satisfies PlatformBridgeBinding);
    const route = Object.freeze({
      chatId,
      conversationId,
      actorDigest: actorDigestFor(actorSecret, botFingerprint, chatId),
      binding: bridgeBinding,
      bridgeBinding,
    } satisfies TelegramPlatformRoute);
    routesByChatId.set(chatId, route);
    guardsByRoute.set(route, Object.freeze({
      isCurrent(candidate: PlatformBridgeBinding): boolean {
        try {
          return isRouteCurrent(route) && sameBinding(candidate, route.binding);
        } catch {
          return false;
        }
      },
    }));
    return route;
  };

  const routeForEnvelope = (
    envelope: Readonly<PlatformBridgeVerifiedEnvelope>,
  ): TelegramPlatformRoute | null => {
    const verified = normalizeTelegramEnvelope(envelope);
    if (verified === null || disposed) return null;
    if (verified.channelId !== verified.senderId) return null;
    try {
      if (authority.ownerUserId() !== verified.senderId) return null;
    } catch { return null; }

    const actorDigest = actorDigestFor(actorSecret, botFingerprint, verified.senderId);
    let pairedDigest: string | null;
    try {
      pairedDigest = authority.activePairingActorDigest();
    } catch {
      return null;
    }
    if (pairedDigest === null || pairedDigest !== actorDigest) return null;

    // The share decides the conversation, not the screen. Reading the active id here instead is what made the surface follow the owner into conversations they never shared.
    const conversationId = boundConversationId(actorDigest);
    if (conversationId === null) return null;
    const approval = approvalFor(actorDigest, conversationId);
    if (approval === null) return null;

    const existing = routesByChatId.get(verified.senderId);
    // A different bound conversation or a superseded approval must never reuse the previous route object; the caller closes the stale channel.
    const route = existing !== undefined
      && existing.conversationId === conversationId
      && existing.binding.scope === scopeUuid(existing.chatId, approval.scope)
      ? existing
      : mintRoute(verified.senderId, conversationId, approval.scope);
    // Execution semantics are untouched: a durable binding still only runs while its conversation is on screen, so this answers null and the caller sends
    // the paired owner the control notice instead.
    return isRouteCurrent(route) ? route : null;
  };

  const authorize: PlatformBridgeInboundAuthorizer = (envelope) => {
    const route = routeForEnvelope(envelope);
    if (route === null) return null;
    const bridgeGuard = guardsByRoute.get(route);
    if (bridgeGuard === undefined) return null;
    return Object.freeze({
      actorDigest: route.actorDigest,
      conversationDigest: hashConversation(botFingerprint, route.conversationId),
      bridgeBinding: route.binding,
      bridgeGuard,
    } satisfies PlatformBridgeInboundAuthorization);
  };

  return Object.freeze({
    authorize,
    // No conversation is captured up front; the paired owner's first message decides it, and it is re-verified on every send.
    get conversationId(): string {
      return currentConversationId() ?? "";
    },
    get routes(): readonly TelegramPlatformRoute[] {
      return Object.freeze([...routesByChatId.values()]);
    },
    routeForEnvelope,
    isRouteCurrent,
    dispose: () => {
      disposed = true;
      routesByChatId.clear();
    },
  });
}

function isRouteAuthority(value: unknown): value is TelegramPairedRouteAuthority {
  return typeof value === "object"
    && value !== null
    && typeof (value as TelegramPairedRouteAuthority).ownerUserId === "function"
    && typeof (value as TelegramPairedRouteAuthority).activePairingActorDigest === "function"
    && typeof (value as TelegramPairedRouteAuthority).resolveActiveApproval === "function"
    && typeof (value as TelegramPairedRouteAuthority).resolveBoundConversation === "function";
}

function normalizeTelegramEnvelope(value: unknown): PlatformBridgeVerifiedEnvelope | null {
  const record = exactDataRecord(value, ["provider", "deliveryId", "channelId", "senderId", "text"]);
  if (record === null
    || record.provider !== "telegram"
    || !isOpaqueIdentifier(record.deliveryId)
    || !isTelegramOwnerUserId(record.channelId)
    || !isTelegramOwnerUserId(record.senderId)
    || !isSafeText(record.text)) {
    return null;
  }
  return Object.freeze({
    provider: "telegram",
    deliveryId: record.deliveryId,
    channelId: record.channelId,
    senderId: record.senderId,
    text: record.text,
  });
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || !expectedKeys.every((key) => ownKeys.includes(key))) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        return null;
      }
      normalized[key] = descriptor.value;
    }
    return Object.freeze(normalized);
  } catch {
    return null;
  }
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DELIVERY_ID_CHARS
    && value.trim().length > 0
    && !hasNonWhitespaceControlChars(value);
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT_CHARS
    && value.trim().length > 0
    && !hasNonWhitespaceControlChars(value);
}

// Name the actor key with a fixed-domain HMAC under itself; domain separation must prevent collisions with actor and binding derivations.
// Keep the key fingerprint bot-independent so switching bots cannot masquerade as key rotation.
function actorKeyDigestFor(actorSecret: string): string {
  return createHmac("sha256", actorSecret)
    .update(ACTOR_KEY_HMAC_DOMAIN, "utf8")
    .digest("hex");
}

function actorDigestFor(actorSecret: string, botFingerprint: string, userId: string): string {
  return createHmac("sha256", actorSecret)
    .update(ACTOR_HMAC_DOMAIN, "utf8")
    .update(botFingerprint, "utf8")
    .update("\0", "utf8")
    .update(userId, "utf8")
    .digest("hex");
}

function hashConversation(botFingerprint: string, conversationId: string): string {
  return createHash("sha256")
    .update(CONVERSATION_HASH_DOMAIN, "utf8")
    .update(botFingerprint, "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .digest("hex");
}

function deterministicUuid(actorSecret: string, purpose: string, fields: readonly string[]): string {
  const digest = createHmac("sha256", actorSecret)
    .update(BINDING_HMAC_DOMAIN, "utf8")
    .update(purpose, "utf8");
  for (const field of fields) {
    digest.update("\0", "utf8").update(field, "utf8");
  }
  const bytes = digest.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameBinding(left: PlatformBridgeBinding, right: PlatformBridgeBinding): boolean {
  return left.bridgeId === right.bridgeId
    && left.bridgeEpoch === right.bridgeEpoch
    && left.routeId === right.routeId
    && left.routeEpoch === right.routeEpoch
    && left.scope === right.scope;
}

function isSecretStore(value: unknown): value is SecretStore {
  return typeof value === "object"
    && value !== null
    && typeof (value as { read?: unknown }).read === "function"
    && typeof (value as { write?: unknown }).write === "function";
}
