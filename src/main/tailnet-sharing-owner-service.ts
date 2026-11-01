import { probeTailnetOwnerIdentityGuard } from "./tailnet-owner-policy.js";
// Choose the active conversation in main at share creation; renderers receive only safe summaries and no durable store.
import {
  isTailnetInvitationDurationPreset,
  isTailnetShareDurationPreset,
  isTailnetSharePermission,
  isTailnetSharingId,
  parseTailnetSharingCreatedInvitation,
  parseTailnetSharingSnapshot,
  type TailnetInvitationDurationPreset,
  type TailnetShareDurationPreset,
  type TailnetSharePermission,
  type TailnetSharingCreatedInvitation,
  type TailnetSharingSnapshot,
} from "../shared/tailnet-sharing.js";
import type { TailnetPairedSharingRuntime } from "./tailnet-paired-sharing-runtime.js";

const INVITATION_DURATION_MS: Readonly<Record<TailnetInvitationDurationPreset, number>> = Object.freeze({
  "10m": 10 * 60 * 1_000,
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

const SHARE_DURATION_MS: Readonly<Record<TailnetShareDurationPreset, number>> = Object.freeze({
  "1h": 60 * 60 * 1_000,
  "8h": 8 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

export interface TailnetSharingOwnerService {
  snapshot(): Promise<TailnetSharingSnapshot>;
  createInvitation(
    duration?: TailnetInvitationDurationPreset,
  ): Promise<TailnetSharingCreatedInvitation>;
  activatePairing(id: string): Promise<boolean>;
  createCurrentConversationShare(
    pairingId: string,
    permission: TailnetSharePermission,
    duration?: TailnetShareDurationPreset,
  ): Promise<boolean>;
  revokeShare(id: string): Promise<boolean>;
  revokePairing(id: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

export interface CreateTailnetSharingOwnerServiceOptions {
  readonly runtime: TailnetPairedSharingRuntime;
  // Read immediately before a mutation; a renderer can never choose this id.
  readonly getCurrentConversationId: () => string;
}

// Keep local-owner mutation logic at one main-process boundary. The public Tailnet listener receives only runtime.authorizer and store.claimInvitation;
// it never receives this facade or a renderer payload.
export function createTailnetSharingOwnerService(
  options: CreateTailnetSharingOwnerServiceOptions,
): TailnetSharingOwnerService {
  if (
    !options
    || typeof options !== "object"
    || !isRuntime(options.runtime)
    || typeof options.getCurrentConversationId !== "function"
  ) {
    throw new Error("tailnet-sharing-owner-service-invalid");
  }

  const currentConversationId = (): string | null => {
    try {
      const candidate = options.getCurrentConversationId();
      return validCurrentConversationId(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  const ownerGuard = async (): Promise<() => void> => (await probeTailnetOwnerIdentityGuard(options.runtime.authorizer)).assertCurrent;

  return Object.freeze({
    async snapshot(): Promise<TailnetSharingSnapshot> {
      await options.runtime.authorizer.probeOwnerIdentity();
      const snapshot = parseTailnetSharingSnapshot(options.runtime.store.ownerSnapshot());
      if (snapshot === null) throw new Error("tailnet-sharing-owner-snapshot-invalid");
      return snapshot;
    },

    async createInvitation(
      duration?: TailnetInvitationDurationPreset,
    ): Promise<TailnetSharingCreatedInvitation> {
      if (duration !== undefined && !isTailnetInvitationDurationPreset(duration)) {
        throw new Error("tailnet-sharing-owner-input-invalid");
      }
      const guard = await ownerGuard();
      const invitation = await options.runtime.store.withOwnerIdentityGuard(guard, () => options.runtime.store.createInvitation(
        duration === undefined ? undefined : INVITATION_DURATION_MS[duration],
      ));
      guard();
      const projection = parseTailnetSharingCreatedInvitation(invitation);
      if (projection === null) throw new Error("tailnet-sharing-owner-invitation-invalid");
      return projection;
    },

    async activatePairing(id: string): Promise<boolean> {
      const guard = await ownerGuard();
      const result = isTailnetSharingId(id) ? await options.runtime.store.withOwnerIdentityGuard(guard, () => options.runtime.store.activatePairing(id)) : false;
      guard();
      return result;
    },

    async createCurrentConversationShare(
      pairingId: string,
      permission: TailnetSharePermission,
      duration?: TailnetShareDurationPreset,
    ): Promise<boolean> {
      if (
        !isTailnetSharingId(pairingId)
        || !isTailnetSharePermission(permission)
        || (duration !== undefined && !isTailnetShareDurationPreset(duration))
      ) {
        return false;
      }
      const guard = await ownerGuard();
      const conversationId = currentConversationId();
      if (conversationId === null) return false;
      const authority = await options.runtime.store.withOwnerIdentityGuard(guard, () => options.runtime.store.createShare({
        pairingId,
        conversationId,
        permission,
        ...(duration === undefined ? {} : { ttlMs: SHARE_DURATION_MS[duration] }),
      }));
      guard();
      return authority !== null;
    },

    revokeShare(id: string): Promise<boolean> {
      return isTailnetSharingId(id)
        ? options.runtime.store.revokeShare(id)
        : Promise.resolve(false);
    },

    revokePairing(id: string): Promise<boolean> {
      return isTailnetSharingId(id)
        ? options.runtime.store.revokePairing(id)
        : Promise.resolve(false);
    },

    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") throw new Error("tailnet-sharing-owner-listener-invalid");
      return options.runtime.store.subscribe(listener);
    },
  });
}

function isRuntime(value: unknown): value is TailnetPairedSharingRuntime {
  return typeof value === "object"
    && value !== null
    && typeof (value as TailnetPairedSharingRuntime).store?.ownerSnapshot === "function"
    && typeof (value as TailnetPairedSharingRuntime).store?.createInvitation === "function"
    && typeof (value as TailnetPairedSharingRuntime).store?.createShare === "function"
    && typeof (value as TailnetPairedSharingRuntime).store?.subscribe === "function"
    && typeof (value as TailnetPairedSharingRuntime).authorizer?.authorize === "function";
}

function validCurrentConversationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}
