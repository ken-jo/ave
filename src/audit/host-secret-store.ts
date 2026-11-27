import type { SecretEncryption } from "../data/secret-document-store.js";
import { SafeStorageSecretStore, type SecretStore } from "../lib/protected-secret-store.js";

/** Unreadable external authority must never mint a new identity. */
export async function createHostSecretStore(encryption: SecretEncryption, dir?: string, migrateEntry: (name: string) => boolean = isLiveSecret): Promise<SecretStore> {
  return SafeStorageSecretStore.open(
    encryption,
    dir,
    encryption.getSelectedStorageBackend() === "external_key" ? "reject" : "quarantine",
    "read-write",
    migrateEntry,
  );
}

function isLiveSecret(name: string): boolean {
  return name !== "audit-hmac.key" &&
    name !== "rationale-invocation-journal-head-v1" &&
    !name.startsWith("audit-seal-") &&
    !name.startsWith("rationale-audit-checkpoint-") &&
    !name.startsWith("rationale-invocation-journal-checkpoint-v1-");
}
