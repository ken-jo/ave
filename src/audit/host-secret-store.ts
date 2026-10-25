import type { SecretEncryption } from "../data/secret-document-store.js";
import { SafeStorageSecretStore, type SecretStore } from "./hmac-chain.js";

/** Unreadable external authority must never mint a new identity. */
export function createHostSecretStore(encryption: SecretEncryption, dir?: string): SecretStore {
  return new SafeStorageSecretStore(
    encryption,
    dir,
    encryption.getSelectedStorageBackend() === "external_key" ? "reject" : "quarantine",
  );
}
