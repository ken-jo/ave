import { createTailnetOwnerIdentityPolicy, type TailnetOwnerIdentityEvidence } from "./tailnet-owner-policy.js";
import type { TailnetOwnerIdentityErrorCode } from "../shared/tailnet-sharing.js";
// Derive actor IDs with a domain-separated HMAC using an OS-encrypted secret; pairing still requires a separate scoped share.
import { createHmac, randomBytes } from "node:crypto";
import type { SecretStore } from "../audit/hmac-chain.js";
import type {
  TailnetPairedShareGuard,
  TailnetPairingShareBinding,
} from "../shared/chat-origin.js";
import type {
  TailnetPairingShareAuthority,
  TailnetShareActorId,
  TailnetSharePermission,
} from "./tailnet-pairing-share-store.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { isPositiveSafeInteger } from "../shared/safe-integer.js";

export const TAILNET_PAIRED_SHARE_ACTOR_SECRET_NAME = "tailnet-paired-share-actor-v1.key";

// A remote-controller actor secret: 32 random bytes, stored base64url (43 chars, no padding).
export const ACTOR_SECRET_BYTES = 32;
export const ACTOR_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTOR_HMAC_DOMAIN = "ave/tailnet-paired-sharing/actor/v1\0";
const MAX_LOGIN_CHARS = 512;

export interface TailnetPairedShareStore {
  resolveActiveShare(
    actorId: TailnetShareActorId,
    currentConversationId: string,
    required: TailnetSharePermission,
  ): TailnetPairingShareAuthority | null;
  isAuthorityCurrent(
    authority: TailnetPairingShareAuthority,
    currentConversationId: string,
    required: TailnetSharePermission,
  ): boolean;
  subscribe(listener: () => void): () => void;
}

export interface TailnetPairedShareAuthorization {
  readonly actorId: TailnetShareActorId;
  readonly pairedShare: TailnetPairingShareBinding;
  readonly pairedShareGuard: TailnetPairedShareGuard;
  readonly permission: TailnetSharePermission;
  readonly expiresAt: number;
}

export interface TailnetPairedShareAuthorizer {
  probeOwnerIdentity(): Promise<TailnetOwnerIdentityEvidence>;
  currentOwnerLogin(): string | null;
  ownerIdentityError(login: string, evidence: TailnetOwnerIdentityEvidence): TailnetOwnerIdentityErrorCode | null;
  // Host-only, opaque actor derivation; returns no raw login value.
  actorIdFor(login: string): TailnetShareActorId | null;
  // Resolve the current owner-approved share for the current conversation.
  authorize(
    login: string,
    currentConversationId: string,
    required: TailnetSharePermission,
    evidence: TailnetOwnerIdentityEvidence,
  ): TailnetPairedShareAuthorization | null;
  subscribe(listener: () => void): () => void;
}

export interface CreateTailnetPairedShareAuthorizerOptions {
  readonly getOwnerLogin?: () => Promise<string | null> | string | null;
  readonly onOwnerIdentityChanged?: () => void;
  readonly store: TailnetPairedShareStore;
  // OS-encrypted, durable secret material supplied by main-process boot.
  readonly actorSecret: string;
  // The active owner conversation, re-read at every final-boundary check.
  readonly getCurrentConversationId: () => string;
}

// Load or mint the domain-specific HMAC key. Production must pass a SafeStorageSecretStore (not a plaintext file store); failure must prevent paired sharing from starting.
export function ensureTailnetPairedShareActorSecret(secretStore: SecretStore): string {
  const existing = secretStore.read(TAILNET_PAIRED_SHARE_ACTOR_SECRET_NAME, 128);
  if (existing !== null) {
    if (!ACTOR_SECRET_PATTERN.test(existing)) {
      throw new Error("tailnet-paired-share-actor-secret-invalid");
    }
    return existing;
  }
  const generated = randomBytes(ACTOR_SECRET_BYTES).toString("base64url");
  if (!ACTOR_SECRET_PATTERN.test(generated)) {
    throw new Error("tailnet-paired-share-actor-secret-generation-invalid");
  }
  secretStore.write(TAILNET_PAIRED_SHARE_ACTOR_SECRET_NAME, generated);
  return generated;
}

export function createTailnetPairedShareAuthorizer(
  options: CreateTailnetPairedShareAuthorizerOptions,
): TailnetPairedShareAuthorizer {
  if (!isPairedShareStore(options.store) || !ACTOR_SECRET_PATTERN.test(options.actorSecret)) {
    throw new Error("tailnet-paired-share-authorizer-invalid");
  }
  if (typeof options.getCurrentConversationId !== "function") {
    throw new Error("tailnet-paired-share-authorizer-invalid");
  }

  const actorIdFor = (login: string): TailnetShareActorId | null => {
    if (!safeTailnetLogin(login)) return null;
    const digest = createHmac("sha256", options.actorSecret)
      .update(ACTOR_HMAC_DOMAIN, "utf8")
      .update(login, "utf8")
      .digest("hex");
    return ("tailnet:" + digest) as TailnetShareActorId;
  };

  const identityPolicy = createTailnetOwnerIdentityPolicy({ getOwnerLogin: options.getOwnerLogin, onChanged: options.onOwnerIdentityChanged });
  const { probeOwnerIdentity, currentOwnerLogin, ownerIdentityError } = identityPolicy;

  const authorize = (
    login: string,
    currentConversation: string,
    required: TailnetSharePermission,
    evidence: TailnetOwnerIdentityEvidence,
  ): TailnetPairedShareAuthorization | null => {
    if (!permission(required) || ownerIdentityError(login, evidence) !== null) return null;
    const actorId = actorIdFor(login);
    const conversationId = validConversationId(currentConversation);
    if (actorId === null || conversationId === null) return null;
    const authority = options.store.resolveActiveShare(actorId, conversationId, required);
    if (authority === null || !sameActor(actorId, authority.actorId) || !validBinding(authority.pairing)) {
      return null;
    }
    let liveEvidence = evidence;
    const pairedShare = Object.freeze({ ...authority.pairing });
    let revoked = false;
    const pairedShareGuard: TailnetPairedShareGuard = Object.freeze({
      async refreshCurrent(candidate: TailnetPairingShareBinding): Promise<boolean> {
        if (revoked || !sameBinding(candidate, pairedShare)) return false;
        const fresh = await probeOwnerIdentity();
        if (revoked || ownerIdentityError(login, fresh) !== null) { revoked = true; return false; }
        liveEvidence = fresh;
        return pairedShareGuard.isCurrent(candidate);
      },
      isCurrent(candidate: TailnetPairingShareBinding): boolean {
        if (revoked || !sameBinding(candidate, pairedShare)) return false;
        if (ownerIdentityError(login, liveEvidence) !== null) { revoked = true; return false; }
        const latestConversationId = currentConversationId(options.getCurrentConversationId);
        if (latestConversationId === null) return false;
        try {
          return options.store.isAuthorityCurrent(authority, latestConversationId, required);
        } catch {
          return false;
        }
      },
    });
    return Object.freeze({
      actorId,
      pairedShare,
      pairedShareGuard,
      permission: authority.permission,
      expiresAt: authority.expiresAt,
    });
  };

  return Object.freeze({ actorIdFor, authorize, probeOwnerIdentity, currentOwnerLogin, ownerIdentityError, subscribe: (listener: () => void) => options.store.subscribe(listener) });
}

function safeTailnetLogin(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_LOGIN_CHARS
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function currentConversationId(reader: () => string): string | null {
  try {
    return validConversationId(reader());
  } catch {
    return null;
  }
}

function validConversationId(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;

}
function permission(value: unknown): value is TailnetSharePermission {
  return value === "observe" || value === "control";
}

function validBinding(value: unknown): value is TailnetPairingShareBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<TailnetPairingShareBinding>;
  return uuid(candidate.pairingId)
    && isPositiveSafeInteger(candidate.pairingEpoch)
    && uuid(candidate.shareId)
    && isPositiveSafeInteger(candidate.shareEpoch)
    && uuid(candidate.scope);
}

function sameBinding(left: TailnetPairingShareBinding, right: TailnetPairingShareBinding): boolean {
  return left.pairingId === right.pairingId
    && left.pairingEpoch === right.pairingEpoch
    && left.shareId === right.shareId
    && left.shareEpoch === right.shareEpoch
    && left.scope === right.scope;
}

function sameActor(left: TailnetShareActorId, right: TailnetShareActorId): boolean {
  return left === right && /^tailnet:[a-f0-9]{64}$/.test(left);
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && UUID_PATTERN.test(value);
}

function isPairedShareStore(value: unknown): value is TailnetPairedShareStore {
  return typeof value === "object"
    && value !== null
    && typeof (value as { subscribe?: unknown }).subscribe === "function"
    && typeof (value as { resolveActiveShare?: unknown }).resolveActiveShare === "function"
    && typeof (value as { isAuthorityCurrent?: unknown }).isAuthorityCurrent === "function";
}
