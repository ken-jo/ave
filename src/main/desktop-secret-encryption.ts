import { safeStorage } from "electron";
import type { SecretEncryption } from "../data/secret-document-store.js";

// Only Electron's async safeStorage API is used; the sync methods are deprecated.
// Electron exposes its backend name only on Linux; other hosts report it as unknown.
export const desktopSecretEncryption: SecretEncryption = {
  isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  getSelectedStorageBackend: () => process.platform === "linux"
    ? safeStorage.getSelectedStorageBackend() : "unknown",
  encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
  decryptStringAsync: async (value) => {
    const { shouldReEncrypt, result } = await safeStorage.decryptStringAsync(value);
    return { shouldReEncrypt, result };
  },
};
