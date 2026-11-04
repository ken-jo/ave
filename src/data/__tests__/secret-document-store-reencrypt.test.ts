import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { SecretDocumentStore, type SecretEncryption } from "../secret-document-store.js";

// Electron's removed synchronous methods throw, so any use of them fails the test.
function rotatingEncryption(prefix: string, staleOn: string | null): SecretEncryption & Record<string, unknown> {
  return {
    isEncryptionAvailable: () => { throw new Error("deprecated isEncryptionAvailable called"); },
    encryptString: () => { throw new Error("deprecated encryptString called"); },
    decryptString: () => { throw new Error("deprecated decryptString called"); },
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (value) => Buffer.from(`${prefix}${value}`, "utf-8"),
    decryptStringAsync: async (value) => {
      const decoded = value.toString("utf-8");
      const separator = decoded.indexOf(":");
      return {
        shouldReEncrypt: staleOn !== null && decoded.startsWith(staleOn),
        result: decoded.slice(separator + 1),
      };
    },
  };
}

function storedPlaintextFor(path: string, key: string): string {
  const document = JSON.parse(readFileSync(path, "utf-8")) as { entries: Record<string, { value: string }> };
  return Buffer.from(document.entries[key]!.value, "base64").toString("utf-8");
}

describe("SecretDocumentStore shouldReEncrypt", () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-secret-reencrypt-"));
    path = join(root, "ave-secrets.json");
    const writer = new SecretDocumentStore({ path, policy: "packaged", encryption: rotatingEncryption("old:", null) });
    await writer.set("alpha", "alpha-value");
    await writer.set("beta", "beta-value");
  });

  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  it("does not rewrite the document on read", async () => {
    const before = readFileSync(path, "utf-8");
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: rotatingEncryption("new:", "old:") });
    await expect(store.get("alpha")).resolves.toBe("alpha-value");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("re-encrypts a flagged entry with the next mutation", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: rotatingEncryption("new:", "old:") });
    await expect(store.get("alpha")).resolves.toBe("alpha-value");
    await store.set("gamma", "gamma-value");
    expect(storedPlaintextFor(path, "alpha")).toBe("new:alpha-value");
    expect(storedPlaintextFor(path, "beta")).toBe("old:beta-value");
    await expect(store.get("alpha")).resolves.toBe("alpha-value");
  });

  it("lands the mutation when a flagged entry cannot be re-encrypted, and retries that entry later", async () => {
    let failing = true;
    const base = rotatingEncryption("new:", "old:");
    const encryption = {
      ...base,
      encryptStringAsync: async (value: string) => {
        if (failing && value === "alpha-value") throw new Error("keychain busy");
        return base.encryptStringAsync(value);
      },
    };
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption });
    await store.get("alpha");
    await expect(store.set("gamma", "gamma-value")).resolves.toBeUndefined();
    expect(storedPlaintextFor(path, "gamma")).toBe("new:gamma-value");
    expect(storedPlaintextFor(path, "alpha")).toBe("old:alpha-value");
    failing = false;
    await store.set("delta", "delta-value");
    expect(storedPlaintextFor(path, "alpha")).toBe("new:alpha-value");
  });

  it("leaves an entry alone when it changed after the flagging read", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: rotatingEncryption("new:", "old:") });
    await store.get("alpha");
    const other = new SecretDocumentStore({ path, policy: "packaged", encryption: rotatingEncryption("other:", null) });
    await other.set("alpha", "replaced-value");
    await store.set("gamma", "gamma-value");
    expect(storedPlaintextFor(path, "alpha")).toBe("other:replaced-value");
  });
});
