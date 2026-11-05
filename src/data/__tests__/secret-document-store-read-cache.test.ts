import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../shared/ave-home-configuration-access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ave-home-configuration-access.js")>();
  return {
    ...actual,
    readAveHomeConfigurationFile: (path: string) => {
      reads.count += 1;
      return actual.readAveHomeConfigurationFile(path);
    },
  };
});

const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { cleanupTmpDir } = await import("../../__tests__/support/tmp-dir-teardown.js");
const { SecretDocumentStore } = await import("../secret-document-store.js");
type SecretEncryption = import("../secret-document-store.js").SecretEncryption;

function encryption(): SecretEncryption & { decryptStringAsync: ReturnType<typeof vi.fn> } {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (value) => Buffer.from(`sealed:${value}`, "utf-8"),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({ shouldReEncrypt: false, result: value.toString("utf-8").slice(7) })),
  };
}

describe("SecretDocumentStore committed-document reads", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-secret-read-cache-"));
    path = join(root, "ave-secrets.json");
    reads.count = 0;
  });

  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  it("parses an unchanged document once across repeated reads", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: encryption() });
    await store.set("alpha", "fixture-value");
    reads.count = 0;
    expect(await store.get("alpha")).toBe("fixture-value");
    expect(await store.has("alpha")).toBe(true);
    expect(await store.get("alpha")).toBe("fixture-value");
    expect(await store.get("missing")).toBeNull();
    expect(reads.count).toBe(1);
  });

  it("still decrypts on every get rather than retaining plaintext", async () => {
    const enc = encryption();
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: enc });
    await store.set("alpha", "fixture-value");
    await store.get("alpha");
    await store.get("alpha");
    expect(enc.decryptStringAsync).toHaveBeenCalledTimes(2);
  });

  it("observes its own writes and another writer's committed document", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: encryption() });
    const other = new SecretDocumentStore({ path, policy: "packaged", encryption: encryption() });
    await store.set("alpha", "first");
    expect(await store.get("alpha")).toBe("first");
    await store.set("alpha", "second");
    expect(await store.get("alpha")).toBe("second");
    await other.set("alpha", "third");
    expect(await store.get("alpha")).toBe("third");
    await other.delete("alpha");
    expect(await store.get("alpha")).toBeNull();
    expect(await store.has("alpha")).toBe(false);
  });
});
