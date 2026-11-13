import { useConfigurationOwner as configureConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

configureConfigurationOwner();

import { createCipheriv, createDecipheriv, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretDocumentDecryptionError, SecretDocumentStore, SecretEncryptionUnavailableError, type SecretEncryption } from "../../data/secret-document-store.js";
import { DpopKey } from "../oauth-dpop.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function secretDocumentPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oauth-credential-storage-"));
  directories.push(directory);
  return join(directory, "secrets.json");
}

/** An authenticated adapter exercises the storage boundary without consulting a native credential service. */
function authenticatedEncryption(): SecretEncryption {
  const encryptionKey = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async plaintext => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptStringAsync: async envelope => {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, envelope.subarray(0, 12));
      decipher.setAuthTag(envelope.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]);
      return { result: plaintext.toString("utf8"), shouldReEncrypt: false };
    },
  };
}

function newDocument(path: string, encryption: SecretEncryption): SecretDocumentStore {
  return new SecretDocumentStore({ path, encryption, policy: "packaged" });
}

describe("encrypted proof credential persistence", () => {
  it("reopens the same private-key binding from ciphertext without persisting plaintext credentials", async () => {
    const path = await secretDocumentPath();
    const encryption = authenticatedEncryption();
    const original = await DpopKey.create();
    const serialized = original.serialize();
    const refreshToken = randomBytes(32).toString("base64url");
    const credential = JSON.stringify({ dpopKey: serialized, tokens: { refresh_token: refreshToken, token_type: "DPoP" } });
    const writer = newDocument(path, encryption);
    expect(await writer.canStoreEncrypted()).toBe(true);
    await writer.set("oauth.bound-credential", credential);

    const bytes = await readFile(path);
    const document = JSON.parse(bytes.toString("utf8")) as { entries: Record<string, { encoding: string; value: string }> };
    const entry = document.entries["oauth.bound-credential"];
    expect(entry.encoding).toBe("safe-storage");
    const pkcs8 = (JSON.parse(serialized) as { pkcs8: string }).pkcs8;
    for (const secret of [serialized, credential, refreshToken, pkcs8, "pkcs8", "refresh_token"]) {
      expect(bytes.toString("utf8")).not.toContain(secret);
      expect(Buffer.from(entry.value, "base64").includes(Buffer.from(secret))).toBe(false);
    }
    expect(bytes.includes(Buffer.from(pkcs8, "base64url"))).toBe(false);
    expect(Buffer.from(entry.value, "base64").includes(Buffer.from(pkcs8, "base64url"))).toBe(false);

    const reader = newDocument(path, encryption);
    const decrypted = await reader.getEncrypted("oauth.bound-credential");
    expect(decrypted).toBe(credential);
    if (decrypted === null) throw new Error("Encrypted credential missing");
    const restoredCredential = JSON.parse(decrypted) as { dpopKey: string; tokens: { refresh_token: string } };
    expect(restoredCredential.tokens.refresh_token).toBe(refreshToken);
    const restored = await DpopKey.restore(restoredCredential.dpopKey);
    expect(await restored.thumbprint()).toBe(await original.thumbprint());

    const [headerSegment, payloadSegment, signatureSegment] = (await restored.proof("https://resource.example.test/mcp", "POST", {
      accessToken: "restored-access-token",
    })).split(".");
    const header = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as { jwk: JsonWebKey };
    expect(verify("sha256", Buffer.from(`${headerSegment}.${payloadSegment}`), {
      key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
    }, Buffer.from(signatureSegment, "base64url"))).toBe(true);
  });

  it("refuses unavailable encryption without writing a plaintext key file", async () => {
    const path = await secretDocumentPath();
    const encrypt = vi.fn(async (): Promise<Buffer> => { throw new Error("Encryption must not run"); });
    const document = newDocument(path, {
      isAsyncEncryptionAvailable: async () => false,
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: encrypt,
      decryptStringAsync: async () => { throw new Error("Decryption must not run"); },
    });
    expect(await document.canStoreEncrypted()).toBe(false);
    await expect(document.set("oauth.bound-credential", (await DpopKey.create()).serialize())).rejects.toBeInstanceOf(SecretEncryptionUnavailableError);
    expect(encrypt).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directories[directories.length - 1])).toEqual([]);
  });

  it("rejects authenticated-ciphertext corruption instead of restoring another credential", async () => {
    const path = await secretDocumentPath();
    const encryption = authenticatedEncryption();
    await newDocument(path, encryption).set("oauth.bound-credential", (await DpopKey.create()).serialize());
    const document = JSON.parse(await readFile(path, "utf8")) as { entries: Record<string, { value: string }> };
    const ciphertext = Buffer.from(document.entries["oauth.bound-credential"].value, "base64");
    ciphertext[ciphertext.length - 1] ^= 1;
    document.entries["oauth.bound-credential"].value = ciphertext.toString("base64");
    await writeFile(path, JSON.stringify(document));
    await expect(newDocument(path, encryption).getEncrypted("oauth.bound-credential")).rejects.toBeInstanceOf(SecretDocumentDecryptionError);
  });
});
