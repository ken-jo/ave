import { readTailnetOwnerLogin } from "./tailnet-owner-identity.js";
// The actor key stays encrypted; persisted pairing records contain only digests and opaque IDs.
import type { SecretStore } from "../audit/hmac-chain.js";
import { createHostSecretStore } from "../audit/host-secret-store.js";
import type { SecretEncryption } from "../data/secret-document-store.js";
import {
  createTailnetPairedShareAuthorizer,
  ensureTailnetPairedShareActorSecret,
  type TailnetPairedShareAuthorizer,
} from "./tailnet-paired-share-authorizer.js";
import {
  createTailnetPairingShareStore,
  type CreateTailnetPairingShareStoreOptions,
  type TailnetPairingShareStore,
} from "./tailnet-pairing-share-store.js";

export interface TailnetPairedSharingRuntime {
  readonly store: TailnetPairingShareStore;
  readonly authorizer: TailnetPairedShareAuthorizer;
}

export interface CreateTailnetPairedSharingRuntimeOptions {
  readonly getOwnerLogin?: () => Promise<string | null> | string | null;
  readonly getCurrentConversationId: () => string;
  // Test-only injection; production uses the host's encrypted storage.
  readonly secretStore?: SecretStore;
  // Test-only store options; production uses the encrypted-feature namespace.
  readonly storeOptions?: CreateTailnetPairingShareStoreOptions;
  readonly encryption: SecretEncryption;
}

export async function createTailnetPairedSharingRuntime(
  options: CreateTailnetPairedSharingRuntimeOptions,
): Promise<TailnetPairedSharingRuntime> {
  if (typeof options.getCurrentConversationId !== "function") {
    throw new Error("tailnet-paired-sharing-current-conversation-unavailable");
  }
  const secretStore = options.secretStore
    ?? createHostSecretStore(options.encryption);
  const actorSecret = ensureTailnetPairedShareActorSecret(secretStore);
  const getOwnerLogin = options.getOwnerLogin ?? readTailnetOwnerLogin;
  const store = createTailnetPairingShareStore({ ...options.storeOptions, getOwnerActorId: () => {
    const login = authorizer.currentOwnerLogin();
    return login === null ? null : authorizer.actorIdFor(login);
  } });
  let opened = false;
  const authorizer = createTailnetPairedShareAuthorizer({
    getOwnerLogin,
    onOwnerIdentityChanged: () => { if (opened) store.notifyOwnerIdentityChanged(); },
    store,
    actorSecret,
    getCurrentConversationId: options.getCurrentConversationId,
  });
  await authorizer.probeOwnerIdentity();
  await store.open();
  opened = true;
  return Object.freeze({ store, authorizer });
}
