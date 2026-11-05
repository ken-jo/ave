/** HMAC chains follow docs/architecture/permission-policy-design.md, Layer 7. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  buildChainedEntries,
  computeDailySeal,
  computeLineHmac,
  ELECTRON_DECRYPT_FAILED_MESSAGE,
  ensureAuditSecret,
  FileSecretStore,
  filterPermissionAuditLines,
  GENESIS_MARKER,
  MemorySecretStore,
  readStableRegularFileUtf8,
  SafeStorageSecretStore,
  SafeStorageTemporarilyUnavailableError,
  type SafeStorageLike,
  sealDayFromFile,
  sealKeyName,
  verifyChain,
  verifyDailySeal,
  verifyLineHmac,
} from "../hmac-chain.js";

let workDir: string;
const SAFE_STORAGE_TEST_PREFIX = "safe:v1:";

function buildDecisionEntries(secret: string, decisions: string[]) {
  return buildChainedEntries(secret, decisions.map((decision, index) => ({ decision, n: index + 1 })));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ave-hmac-chain-"));
});

afterEach(async () => {
  if (existsSync(workDir)) await cleanupTmpDir(workDir);
});

describe("ensureAuditSecret", () => {
  it("generates a fresh hex secret on first call", () => {
    const store = new MemorySecretStore();
    const secret = ensureAuditSecret(store);
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
  });

  it("returns the same secret on subsequent calls (idempotent)", () => {
    const store = new MemorySecretStore();
    const a = ensureAuditSecret(store);
    const b = ensureAuditSecret(store);
    expect(a).toBe(b);
  });

  it("regenerates when stored secret is too short", () => {
    const store = new MemorySecretStore();
    store.write("audit-hmac.key", "short");
    const secret = ensureAuditSecret(store);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });
});

describe("FileSecretStore", () => {
  it.skipIf(process.platform === "win32")("writes secrets with 0o600 mode", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    store.write("audit-hmac.key", "deadbeef");
    const filePath = join(workDir, "secrets", "audit-hmac.key");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reads back what was written", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    store.write("audit-hmac.key", "hello-secret");
    expect(store.read("audit-hmac.key")).toBe("hello-secret");
  });

  it("atomically replaces an existing value without leaving temp files", () => {
    const dir = join(workDir, "secrets");
    const store = new FileSecretStore(dir);
    store.write("audit-hmac.key", "first");
    store.write("audit-hmac.key", "second");
    expect(store.read("audit-hmac.key")).toBe("second");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("re-hardens a pre-existing secret directory", () => {
    const dir = join(workDir, "secrets");
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    const store = new FileSecretStore(dir);
    store.write("audit-hmac.key", "secret");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects path-traversal in secret name", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    expect(() => store.write("../escape", "x")).toThrow(/invalid secret name/);
  });

  it("read returns null for absent secret", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    expect(store.read("missing")).toBe(null);
  });

  it("rejects an oversized secret before reading it into a string", () => {
    const dir = join(workDir, "secrets");
    const store = new FileSecretStore(dir);
    writeFileSync(join(dir, "oversized"), "x".repeat(65));
    expect(() => store.read("oversized", 64)).toThrow(/read byte limit/);
  });

  it("stages the secret under the shared atomic writer's hidden name, with the file mode it declares", () => {
    // Atomic secret writes must leave no random staging files behind.
    const dir = join(workDir, "secrets");
    const store = new FileSecretStore(dir);
    store.write("audit-hmac.key", "value");
    expect(readdirSync(dir)).toEqual(["audit-hmac.key"]);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "audit-hmac.key")).mode & 0o777).toBe(0o600);
    }
  });
});

describe("readStableRegularFileUtf8", () => {
  // Windows uses junctions and identity checks without O_NOFOLLOW; POSIX also exercises file symlinks.
  it.each(process.platform === "win32" ? ["directory link"] : ["file symlink", "directory link"])(
    "refuses a %s path — the check the journal and the secret store share",
    (linkKind) => {
    const target = join(workDir, "real.txt");
    writeFileSync(target, "real");
    if (linkKind === "file symlink") {
      symlinkSync(target, join(workDir, "link.txt"));
    } else {
      // Keep junction targets inside the fixture root so cleanup cannot delete unrelated files.
      mkdirSync(join(workDir, "real-dir"));
      symlinkSync(join(workDir, "real-dir"), join(workDir, "link.txt"), "junction");
    }
    // O_NOFOLLOW rejects links at open; identity checks also catch later swaps and protect Windows.
    expect(() => readStableRegularFileUtf8(join(workDir, "link.txt"), 1024, "fixture"))
      .toThrow(/ELOOP|fixture path is not a stable regular file/);
    expect(readStableRegularFileUtf8(target, 1024, "fixture")).toBe("real");
  });

  it("returns null only for an absent path", () => {
    expect(readStableRegularFileUtf8(join(workDir, "absent"), 1024, "fixture")).toBe(null);
  });

  it.skipIf(process.platform === "win32").each([
    { ownership: "ordinary", requirePrivateOwnerFile: false },
    { ownership: "owner-only", requirePrivateOwnerFile: true },
  ])("rejects an $ownership FIFO without blocking", ({ requirePrivateOwnerFile }) => {
    const fifoPath = join(workDir, `authority-${requirePrivateOwnerFile ? "private" : "ordinary"}`);
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);
    const moduleUrl = new URL("../hmac-chain.ts", import.meta.url).href;
    const child = `
      const [moduleUrl, fifoPath, privateFlag] = process.argv.slice(1);
      const { readStableRegularFileUtf8 } = await import(moduleUrl);
      try {
        readStableRegularFileUtf8(fifoPath, 1024, "fixture", privateFlag === "true");
        process.stderr.write("FIFO was accepted");
        process.exit(2);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("fixture path is not a stable regular file")) {
          process.stderr.write(message);
          process.exit(3);
        }
      }
    `;
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", child,
      moduleUrl, fifoPath, String(requirePrivateOwnerFile),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 2_000,
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  });
});

describe("SafeStorageSecretStore", () => {
  interface FakeSafeStorage extends SafeStorageLike {
    decryptCalls: number;
    encryptCalls: number;
  }
  // The removed synchronous methods throw, so any use of them fails the test.
  function makeSafeStorage(options: {
    available?: boolean;
    shouldReEncrypt?: boolean;
    decrypt?: (raw: string) => string;
  } = {}): FakeSafeStorage {
    const fake = {
      decryptCalls: 0,
      encryptCalls: 0,
      isEncryptionAvailable: () => { throw new Error("deprecated isEncryptionAvailable called"); },
      encryptString: () => { throw new Error("deprecated encryptString called"); },
      decryptString: () => { throw new Error("deprecated decryptString called"); },
      isAsyncEncryptionAvailable: async () => options.available ?? true,
      encryptStringAsync: async (value: string) => {
        fake.encryptCalls += 1;
        return Buffer.from(`enc:${value}`, "utf-8");
      },
      decryptStringAsync: async (value: Buffer) => {
        fake.decryptCalls += 1;
        const raw = value.toString("utf-8");
        const result = options.decrypt ? options.decrypt(raw) : raw.replace(/^enc:/, "");
        return { shouldReEncrypt: options.shouldReEncrypt ?? false, result };
      },
    };
    return fake;
  }
  const secretsDir = () => join(workDir, "secrets");
  const entryPath = (name: string) => join(secretsDir(), `${name}.safe-storage`);
  const keyPath = () => join(secretsDir(), "store-data.safe-storage-key");
  const legacyEntry = (value: string) => SAFE_STORAGE_TEST_PREFIX + Buffer.from(`enc:${value}`).toString("base64");

  it.skipIf(process.platform === "win32")("persists encrypted ciphertext with 0o600 mode", async () => {
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    store.write("audit-hmac.key", "hello-secret");
    expect(statSync(entryPath("audit-hmac.key")).mode & 0o777).toBe(0o600);
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(store.read("audit-hmac.key")).toBe("hello-secret");
  });

  it("seals entries under a wrapped data key and never stores the value in plaintext", async () => {
    const safeStorage = makeSafeStorage();
    const store = await SafeStorageSecretStore.open(safeStorage, secretsDir());
    store.write("audit-hmac.key", "hello-secret");
    const stored = readFileSync(entryPath("audit-hmac.key"), "utf-8");
    expect(stored.startsWith("safe:v2:")).toBe(true);
    expect(stored).not.toContain("hello-secret");
    expect(Buffer.from(stored.slice("safe:v2:".length), "base64").includes(Buffer.from("hello-secret"))).toBe(false);
    expect(readFileSync(keyPath(), "utf-8").startsWith(SAFE_STORAGE_TEST_PREFIX)).toBe(true);
    expect(safeStorage.encryptCalls).toBe(1);

    const reopened = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    expect(reopened.read("audit-hmac.key")).toBe("hello-secret");
  });

  it("binds each sealed entry to its name", async () => {
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir(), "reject");
    store.write("first", "value-one");
    writeFileSync(entryPath("second"), readFileSync(entryPath("first"), "utf-8"));
    expect(() => store.read("second")).toThrow(/could not be decrypted/);
  });

  it("refuses to open when safeStorage is unavailable", async () => {
    await expect(SafeStorageSecretStore.open(makeSafeStorage({ available: false }), secretsDir()))
      .rejects.toThrow(/safeStorage/);
  });

  it("re-encrypts pre-envelope entries when it opens", async () => {
    mkdirSync(secretsDir(), { recursive: true });
    writeFileSync(entryPath("audit-hmac.key"), legacyEntry("legacy-secret"));
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    expect(readFileSync(entryPath("audit-hmac.key"), "utf-8").startsWith("safe:v2:")).toBe(true);
    expect(store.read("audit-hmac.key")).toBe("legacy-secret");
  });

  it.skipIf(process.platform === "win32")("serves pre-envelope entries to a read-only opener without rewriting them", async () => {
    mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(entryPath("authority"), legacyEntry("legacy-authority"), { mode: 0o600 });
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir(), "reject", "existing-read-only");
    expect(store.read("authority")).toBe("legacy-authority");
    expect(readFileSync(entryPath("authority"), "utf-8")).toBe(legacyEntry("legacy-authority"));
    expect(existsSync(keyPath())).toBe(false);
    expect(() => store.write("authority", "x")).toThrow(/read-only/);
  });

  it("rewraps the data key when safeStorage asks for re-encryption", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "kept-secret");
    const before = readFileSync(keyPath(), "utf-8");
    const rotated = makeSafeStorage({ shouldReEncrypt: true });
    const reopened = await SafeStorageSecretStore.open(rotated, secretsDir());
    expect(rotated.encryptCalls).toBe(1);
    expect(readFileSync(keyPath(), "utf-8")).toBe(before);
    expect(reopened.read("audit-hmac.key")).toBe("kept-secret");
  });

  it("agrees on one data key when two openers race to mint it", async () => {
    const [left, right] = await Promise.all([
      SafeStorageSecretStore.open(makeSafeStorage(), secretsDir()),
      SafeStorageSecretStore.open(makeSafeStorage(), secretsDir()),
    ]);
    left.write("shared", "from-left");
    expect(right.read("shared")).toBe("from-left");
    expect(readdirSync(secretsDir()).filter((file) => file.includes(".staging-"))).toEqual([]);
  });

  it("quarantines an undecryptable data key and every entry it sealed", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "old-secret");
    const broken = makeSafeStorage({ decrypt: () => { throw new Error(ELECTRON_DECRYPT_FAILED_MESSAGE); } });
    await expect(SafeStorageSecretStore.open(broken, secretsDir(), "reject")).rejects.toThrow(/could not be decrypted/);
    const store = await SafeStorageSecretStore.open(broken, secretsDir());
    expect(store.read("audit-hmac.key")).toBe(null);
    const files = readdirSync(secretsDir());
    expect(files.some((file) => file.startsWith("store-data.safe-storage-key.quarantined-"))).toBe(true);
    expect(files.some((file) => file.startsWith("audit-hmac.key.safe-storage.quarantined-"))).toBe(true);
  });

  // Electron 45 rejects with this while the keychain is briefly unreachable.
  const transient = () => makeSafeStorage({
    decrypt: () => { throw new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again."); },
  });

  it("fails open on a transient data-key decrypt failure, quarantines nothing, and keeps every entry", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "kept-secret");
    const before = readdirSync(secretsDir()).sort();
    await expect(SafeStorageSecretStore.open(transient(), secretsDir())).rejects.toThrow(SafeStorageTemporarilyUnavailableError);
    expect(readdirSync(secretsDir()).sort()).toEqual(before);
    const recovered = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    expect(recovered.read("audit-hmac.key")).toBe("kept-secret");
  });

  it("fails open on a transient pre-envelope decrypt failure and leaves the entry in place", async () => {
    mkdirSync(secretsDir(), { recursive: true });
    writeFileSync(entryPath("audit-hmac.key"), legacyEntry("legacy-secret"));
    await expect(SafeStorageSecretStore.open(transient(), secretsDir())).rejects.toThrow(SafeStorageTemporarilyUnavailableError);
    expect(readFileSync(entryPath("audit-hmac.key"), "utf8")).toBe(legacyEntry("legacy-secret"));
    expect(readdirSync(secretsDir()).some((file) => file.includes(".quarantined-"))).toBe(false);
  });

  // Only known permanent failures quarantine: a message Electron has not used before (a new release, a locked keychain) moves nothing.
  const unknownReject = () => makeSafeStorage({ decrypt: () => { throw new Error("keychain locked during boot"); } });

  it("rethrows an unknown data-key decrypt failure and quarantines nothing", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "kept-secret");
    const before = readdirSync(secretsDir()).sort();
    await expect(SafeStorageSecretStore.open(unknownReject(), secretsDir())).rejects.toThrow("keychain locked during boot");
    expect(readdirSync(secretsDir()).sort()).toEqual(before);
    const recovered = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    expect(recovered.read("audit-hmac.key")).toBe("kept-secret");
  });

  it("rethrows an unknown pre-envelope decrypt failure and leaves the entry in place", async () => {
    mkdirSync(secretsDir(), { recursive: true });
    writeFileSync(entryPath("audit-hmac.key"), legacyEntry("legacy-secret"));
    await expect(SafeStorageSecretStore.open(unknownReject(), secretsDir())).rejects.toThrow("keychain locked during boot");
    expect(readFileSync(entryPath("audit-hmac.key"), "utf8")).toBe(legacyEntry("legacy-secret"));
    expect(readdirSync(secretsDir()).some((file) => file.includes(".quarantined-"))).toBe(false);
  });

  it("rethrows a near miss of Electron's decrypt failure and quarantines nothing", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "kept-secret");
    const before = readdirSync(secretsDir()).sort();
    const syncMessage = "Error while decrypting the ciphertext provided to safeStorage.decryptString.";
    const nearMiss = makeSafeStorage({ decrypt: () => { throw new Error(syncMessage); } });
    await expect(SafeStorageSecretStore.open(nearMiss, secretsDir())).rejects.toThrow(syncMessage);
    expect(readdirSync(secretsDir()).sort()).toEqual(before);
  });

  it("fails closed when decrypt resolves without a string and quarantines nothing", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "kept-secret");
    const before = readdirSync(secretsDir()).sort();
    const contractBreak = makeSafeStorage({ decrypt: () => undefined as unknown as string });
    await expect(SafeStorageSecretStore.open(contractBreak, secretsDir())).rejects.toThrow(/without a string result/);
    expect(readdirSync(secretsDir()).sort()).toEqual(before);
    const recovered = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    expect(recovered.read("audit-hmac.key")).toBe("kept-secret");
  });

  it("leaves an unreadable data key in place when wrapping its replacement fails", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "old-secret");
    const before = readdirSync(secretsDir()).sort();
    const keyBefore = readFileSync(keyPath(), "utf-8");
    const broken = makeSafeStorage({ decrypt: () => { throw new Error(ELECTRON_DECRYPT_FAILED_MESSAGE); } });
    broken.encryptStringAsync = async () => { throw new Error("encrypt refused"); };
    await expect(SafeStorageSecretStore.open(broken, secretsDir())).rejects.toThrow("encrypt refused");
    expect(readdirSync(secretsDir()).sort()).toEqual(before);
    expect(readFileSync(keyPath(), "utf-8")).toBe(keyBefore);
  });

  it("adopts the key another opener published while it was wrapping a replacement, and quarantines nothing", async () => {
    const first = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    first.write("audit-hmac.key", "old-secret");
    const otherDir = join(workDir, "other-secrets");
    const other = await SafeStorageSecretStore.open(makeSafeStorage(), otherDir);
    other.write("theirs", "from-the-other-opener");
    const theirKey = readFileSync(join(otherDir, "store-data.safe-storage-key"), "utf-8");
    writeFileSync(entryPath("theirs"), readFileSync(join(otherDir, "theirs.safe-storage"), "utf-8"));

    // The stored key is unreadable until the other opener replaces it, which happens while this one encrypts.
    let swapped = false;
    const racing = makeSafeStorage({
      decrypt: (raw) => {
        if (!swapped) throw new Error(ELECTRON_DECRYPT_FAILED_MESSAGE);
        return raw.replace(/^enc:/, "");
      },
    });
    const encrypt = racing.encryptStringAsync;
    racing.encryptStringAsync = async (value: string) => {
      writeFileSync(keyPath(), theirKey);
      swapped = true;
      return encrypt(value);
    };
    const store = await SafeStorageSecretStore.open(racing, secretsDir());
    expect(readdirSync(secretsDir()).some((file) => file.includes(".quarantined-"))).toBe(false);
    expect(readFileSync(keyPath(), "utf-8")).toBe(theirKey);
    expect(store.read("theirs")).toBe("from-the-other-opener");
  });

  it("quarantines undecryptable pre-envelope ciphertext before boot rotates the secret", async () => {
    mkdirSync(secretsDir(), { recursive: true });
    writeFileSync(entryPath("audit-hmac.key"), "safe:v1:YmFkLWNpcGhlcnRleHQ=");
    const store = await SafeStorageSecretStore.open(makeSafeStorage({
      decrypt: (raw) => {
        if (raw === "bad-ciphertext") throw new Error(ELECTRON_DECRYPT_FAILED_MESSAGE);
        return raw.replace(/^enc:/, "");
      },
    }), secretsDir());

    const secret = ensureAuditSecret(store);

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.read("audit-hmac.key")).toBe(secret);
    const files = readdirSync(secretsDir());
    expect(files.some((file) => file.startsWith("audit-hmac.key.safe-storage.quarantined-"))).toBe(true);
    expect(files.some((file) => file.startsWith("audit-hmac.key.safe-storage.recovery-"))).toBe(true);
  });

  it("quarantines malformed safeStorage files as missing", async () => {
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    writeFileSync(entryPath("audit-hmac.key"), "plain-secret");
    expect(store.read("audit-hmac.key")).toBe(null);
    const files = readdirSync(secretsDir());
    expect(files.some((file) => file.startsWith("audit-hmac.key.safe-storage.quarantined-"))).toBe(true);
    expect(files.some((file) => file.startsWith("audit-hmac.key.safe-storage.recovery-"))).toBe(true);
  });

  it("never destroys a pre-envelope entry that appears after open", async () => {
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    writeFileSync(entryPath("late"), legacyEntry("late-secret"));
    expect(() => store.read("late")).toThrow(/could not be decrypted/);
    expect(readFileSync(entryPath("late"), "utf-8")).toBe(legacyEntry("late-secret"));
  });

  it("rejects oversized ciphertext before opening it", async () => {
    const safeStorage = makeSafeStorage();
    const store = await SafeStorageSecretStore.open(safeStorage, secretsDir());
    writeFileSync(entryPath("oversized"), "safe:v2:" + "A".repeat(6_000));
    expect(() => store.read("oversized", 64)).toThrow(/read byte limit/);
    expect(safeStorage.decryptCalls).toBe(0);
  });

  it("rejects an oversized decrypted value", async () => {
    const store = await SafeStorageSecretStore.open(makeSafeStorage(), secretsDir());
    store.write("oversized-plain", "x".repeat(65));
    expect(() => store.read("oversized-plain", 64)).toThrow(/value exceeds/);
  });
});

describe("computeLineHmac + verifyLineHmac", () => {
  it("verifies a valid hash", () => {
    const secret = "00".repeat(32);
    const line = '{"decision":"allow"}';
    const hash = computeLineHmac(secret, line);
    expect(verifyLineHmac(secret, line, hash)).toBe(true);
  });

  it("rejects tampered hash", () => {
    const secret = "00".repeat(32);
    const line = '{"decision":"allow"}';
    const hash = computeLineHmac(secret, line);
    const tampered = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    expect(verifyLineHmac(secret, line, tampered)).toBe(false);
  });

  it("rejects mismatched length without throwing", () => {
    const secret = "00".repeat(32);
    expect(verifyLineHmac(secret, "x", "deadbeef")).toBe(false);
  });

  it("rejects an uppercase hash: every hash this chain mints is lowercase, so anything else is not ours", () => {
    const secret = "00".repeat(32);
    const line = '{"decision":"allow"}';
    const hash = computeLineHmac(secret, line);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLineHmac(secret, line, hash.toUpperCase())).toBe(false);
  });
});

describe("buildChainedEntries", () => {
  it("first entry hashes against the genesis marker", () => {
    const secret = "aa".repeat(32);
    const out = buildChainedEntries(secret, [{ decision: "allow", n: 1 }]);
    expect(out[0].prevHash).toBe(computeLineHmac(secret, GENESIS_MARKER));
  });

  it("each subsequent entry hashes against the previous serialized line", () => {
    const secret = "aa".repeat(32);
    const out = buildDecisionEntries(secret, ["allow", "deny", "ask"]);
    const line0 = JSON.stringify(out[0]);
    const line1 = JSON.stringify(out[1]);
    expect(out[1].prevHash).toBe(computeLineHmac(secret, line0));
    expect(out[2].prevHash).toBe(computeLineHmac(secret, line1));
  });
});

describe("verifyChain", () => {
  function buildFixture(secret: string, n = 12): { entries: Array<Record<string, unknown>>; lines: string[] } {
    const raw = Array.from({ length: n }, (_, i) => ({
      decision: i % 2 === 0 ? "allow" : "deny",
      auditId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      ts: `2026-05-09T00:00:${String(i).padStart(2, "0")}.000Z`,
      tool: `tool-${i}`,
    }));
    const entries = buildChainedEntries(secret, raw);
    const lines = entries.map((e) => JSON.stringify(e));
    return { entries, lines };
  }

  it("accepts a 12-entry round-trip chain", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 12);
    expect(verifyChain(secret, lines)).toEqual({ ok: true });
  });

  it("detects a tampered MIDDLE line at that row's entry hash", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 12);
    const obj = JSON.parse(lines[5]) as { tool: string };
    obj.tool = "TAMPERED";
    lines[5] = JSON.stringify(obj);
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstBrokenLineIndex).toBe(5);
      expect(result.reason).toBe("entry-hmac-mismatch");
    }
  });

  it("detects when the FIRST line is tampered (its own prevHash will mismatch)", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 12);
    const obj = JSON.parse(lines[0]) as { prevHash: string };
    obj.prevHash = computeLineHmac(secret, "wrong-genesis");
    lines[0] = JSON.stringify(obj);
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstBrokenLineIndex).toBe(0);
    }
  });

  it("detects unparseable lines", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 5);
    lines[2] = "<<not-json>>";
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstBrokenLineIndex).toBe(2);
      expect(result.reason).toBe("json-parse-error");
    }
  });

  it("detects missing prevHash field", () => {
    const secret = "bb".repeat(32);
    const out = buildDecisionEntries(secret, ["allow", "deny"]);
    const lines = out.map((e) => JSON.stringify(e));
    const corrupted = JSON.parse(lines[1]) as Record<string, unknown>;
    delete corrupted.prevHash;
    lines[1] = JSON.stringify(corrupted);
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-prevHash");
    }
  });

  it("accepts an empty input as trivially valid", () => {
    const secret = "cc".repeat(32);
    expect(verifyChain(secret, [])).toEqual({ ok: true });
  });
});

describe("daily seal lifecycle", () => {
  it("sealDayFromFile writes the seal to the store and returns it", () => {
    const secret = "dd".repeat(32);
    const store = new MemorySecretStore();
    const date = "2026-05-09";
    const filePath = join(workDir, `${date}.permission-audit.jsonl`);

    const entries = buildDecisionEntries(secret, ["allow", "deny"]);
    writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const seal = sealDayFromFile(secret, store, filePath, date);
    expect(seal).not.toBe(null);
    expect(store.read(sealKeyName(date))).toBe(seal);
  });

  it("sealDayFromFile returns null on empty file", () => {
    const secret = "dd".repeat(32);
    const store = new MemorySecretStore();
    const filePath = join(workDir, "empty.permission-audit.jsonl");
    writeFileSync(filePath, "");
    expect(sealDayFromFile(secret, store, filePath, "2026-05-09")).toBe(null);
  });

  it("sealDayFromFile returns null when the file does not exist", () => {
    const secret = "dd".repeat(32);
    const store = new MemorySecretStore();
    expect(sealDayFromFile(secret, store, join(workDir, "nope"), "2026-05-09")).toBe(null);
  });

  it("verifyDailySeal — ok on intact chain + matching seal", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const date = "2026-05-09";
    const filePath = join(workDir, `${date}.permission-audit.jsonl`);
    const entries = buildDecisionEntries(secret, ["allow", "deny", "ask"]);
    writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    sealDayFromFile(secret, store, filePath, date);
    expect(verifyDailySeal(secret, store, filePath, date)).toEqual({ ok: true });
  });

  it("verifyDailySeal — chain-broken when a line is tampered", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const date = "2026-05-09";
    const filePath = join(workDir, `${date}.permission-audit.jsonl`);
    const entries = buildDecisionEntries(secret, ["allow", "deny", "ask", "allow"]);
    const lines = entries.map((e) => JSON.stringify(e));
    writeFileSync(filePath, lines.join("\n") + "\n");
    sealDayFromFile(secret, store, filePath, date);

    const obj = JSON.parse(lines[1]) as { decision: string };
    obj.decision = "allow";
    lines[1] = JSON.stringify(obj);
    writeFileSync(filePath, lines.join("\n") + "\n");

    const result = verifyDailySeal(secret, store, filePath, date);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "chain-broken") {
      expect(result.firstBrokenLineIndex).toBe(1);
    } else {
      throw new Error(`expected chain-broken, got ${JSON.stringify(result)}`);
    }
  });

  it("verifyDailySeal — no-seal when seal was never written", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const filePath = join(workDir, "2026-05-09.permission-audit.jsonl");
    writeFileSync(filePath, JSON.stringify({ decision: "allow", prevHash: "x" }) + "\n");
    const result = verifyDailySeal(secret, store, filePath, "2026-05-09");
    expect(result).toEqual({ ok: false, reason: "no-seal" });
  });

  it("verifyDailySeal — no-file when the file is missing", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const result = verifyDailySeal(secret, store, join(workDir, "nope"), "2026-05-09");
    expect(result).toEqual({ ok: false, reason: "no-file" });
  });

  it("sealKeyName format", () => {
    expect(sealKeyName("2026-05-09")).toBe("audit-seal-2026-05-09");
    expect(() => sealKeyName("2026/05/09")).toThrow();
  });

  it("computeDailySeal is deterministic for same secret+line", () => {
    const a = computeDailySeal("aa".repeat(32), "abc");
    const b = computeDailySeal("aa".repeat(32), "abc");
    expect(a).toBe(b);
    expect(a).not.toBe(computeDailySeal("bb".repeat(32), "abc"));
  });

  it("seal verification works end-to-end with a fresh secret rotation", () => {
    // Rotating the secret must invalidate old seals; stolen files cannot be resealed without the new key.
    const oldSecret = "11".repeat(32);
    const newSecret = "22".repeat(32);
    const store = new MemorySecretStore();
    const filePath = join(workDir, "2026-05-09.permission-audit.jsonl");
    const entries = buildChainedEntries(oldSecret, [{ decision: "allow", n: 1 }]);
    writeFileSync(filePath, JSON.stringify(entries[0]) + "\n");
    sealDayFromFile(oldSecret, store, filePath, "2026-05-09");
    const result = verifyDailySeal(newSecret, store, filePath, "2026-05-09");
    expect(result.ok).toBe(false);
  });
});

describe("filterPermissionAuditLines", () => {
  it("filters mixed legacy + permission audit lines", () => {
    const legacy = JSON.stringify({ type: "turn", sessionId: "s1" });
    const permissionAudit = JSON.stringify({ decision: "allow", auditId: "id-1" });
    const broken = "<<not-json>>";
    expect(filterPermissionAuditLines([legacy, permissionAudit, broken])).toEqual([permissionAudit]);
  });
});
