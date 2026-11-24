import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createNodeSecretEncryption } from "../../data/node-secret-encryption.js";
import { ensureTailnetPairedShareActorSecret } from "../../main/tailnet-paired-share-authorizer.js";
import { ELECTRON_DECRYPT_FAILED_MESSAGE } from "../hmac-chain.js";
import { createHostSecretStore } from "../host-secret-store.js";

let root: string;
let keyFile: string;
let directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-host-encrypted-secrets-"));
  keyFile = join(root, "external-key");
  directory = join(root, "secrets");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
});
afterEach(async () => cleanupTmpDir(root));

describe("host authority secret store", () => {
  // Reject external keys on Windows when POSIX owner-only protection cannot be proven.
  const withExternalKey = it.skipIf(process.platform === "win32");

  withExternalKey("preserves identity across restart and never regenerates it after wrong-key decryption", async () => {
    const secretStore = await createHostSecretStore(createNodeSecretEncryption(keyFile), directory);
    const identity = ensureTailnetPairedShareActorSecret(secretStore);
    expect(ensureTailnetPairedShareActorSecret(
      await createHostSecretStore(createNodeSecretEncryption(keyFile), directory),
    )).toBe(identity);
    const files = readdirSync(directory);
    const originals = files.map((name) => readFileSync(join(directory, name)));
    writeFileSync(keyFile, randomBytes(32));
    await expect(createHostSecretStore(createNodeSecretEncryption(keyFile), directory)).rejects.toThrow(/could not be decrypted/);
    expect(readdirSync(directory)).toEqual(files);
    expect(files.map((name) => readFileSync(join(directory, name)))).toEqual(originals);
  });

  withExternalKey("refuses legacy formats and tampering without quarantine or overwrite", async () => {
    const encryption = createNodeSecretEncryption(keyFile);
    const store = await createHostSecretStore(encryption, directory);
    store.write("authority", "retained-value");
    const path = join(directory, "authority.safe-storage");
    const valid = readFileSync(path, "utf8");
    for (const bytes of ["legacy-plaintext", "safe:v1:" + Buffer.from("v10legacy-ciphertext").toString("base64"), valid.slice(0, -4) + "AAAA", valid + "!"]) {
      writeFileSync(path, bytes);
      expect(() => store.read("authority", 256)).toThrow();
      expect(() => store.write("authority", "replacement")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readdirSync(directory)).toEqual(["authority.safe-storage", "store-data.safe-storage-key"]);
    }
  });

  it("refuses an unconfigured external key without writing or quarantining", async () => {
    await expect(createHostSecretStore(createNodeSecretEncryption(), directory)).rejects.toThrow(/not available/);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("preserves existing desktop quarantine and replacement behavior", async () => {
    let unavailableCiphertext = false;
    // Electron's removed synchronous methods throw, so any use of them fails the test.
    const desktopEncryption = {
      isEncryptionAvailable: () => { throw new Error("deprecated isEncryptionAvailable called"); },
      encryptString: () => { throw new Error("deprecated encryptString called"); },
      decryptString: () => { throw new Error("deprecated decryptString called"); },
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "gnome_libsecret" as const,
      encryptStringAsync: async (value: string) => Buffer.from(`sealed:${value}`),
      decryptStringAsync: async (value: Buffer) => {
        if (unavailableCiphertext) throw new Error(ELECTRON_DECRYPT_FAILED_MESSAGE);
        return { shouldReEncrypt: false, result: value.toString("utf8").slice("sealed:".length) };
      },
    };
    const first = ensureTailnetPairedShareActorSecret(await createHostSecretStore(desktopEncryption, directory));
    unavailableCiphertext = true;
    // The data key is unwrapped at open, so the unreadable ciphertext surfaces on the next open.
    expect(ensureTailnetPairedShareActorSecret(await createHostSecretStore(desktopEncryption, directory))).not.toBe(first);
    expect(readdirSync(directory).some((name) => name.includes("quarantined"))).toBe(true);
  });
});
