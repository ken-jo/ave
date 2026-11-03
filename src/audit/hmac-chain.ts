/** Hash exact serialized rows without newlines; prevHash links predecessors and entryHash authenticates the tail. Store daily seals separately from their chains. */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";
import { aveHome } from "../shared/ave-home.js";
import { isMissingPathError, PRIVATE_FILE_MODE, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { SHA256_HEX } from "../lib/hex-digest-equal.js";
import { parseJsonlLines } from "./jsonl-reader.js";

export const GENESIS_MARKER = "genesis";
const AUDIT_HMAC_SECRET_NAME = "audit-hmac.key";
// `safe:v1:` is OS safeStorage ciphertext: the data key file, and entries written before the envelope format.
const SAFE_STORAGE_SECRET_PREFIX = "safe:v1:";
// `safe:v2:` is AES-256-GCM under the store data key, bound to the entry name.
const SAFE_STORAGE_ENVELOPE_PREFIX = "safe:v2:";
const SAFE_STORAGE_ENTRY_SUFFIX = ".safe-storage";
// A distinct suffix, so no entry name can address the data key file.
const SAFE_STORAGE_DATA_KEY_FILE = "store-data.safe-storage-key";
const SAFE_STORAGE_DATA_KEY_FILE_BYTES = 64 * 1024;
const DATA_KEY_BYTES = 32;
const ENVELOPE_NONCE_BYTES = 12;
const ENVELOPE_TAG_BYTES = 16;
const DEFAULT_SECRET_READ_MAX_BYTES = 1024 * 1024;
const MAX_SECRET_READ_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_STORAGE_FILE_BYTES = 32 * 1024 * 1024;
const SECRET_AUTHORITY_MAX_BYTES = 4 * 1024;

function envelopeAad(name: string): Buffer {
  return Buffer.from(`ave-secret-store:v2\0${name}`, "utf8");
}

function hardenSecretDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") chmodSync(dir, 0o700);
}

/** Atomic secret replacement uses exclusive 0600 staging, fsync, retried rename, and directory fsync; no post-rename chmod. */
function atomicWriteSecretFile(dir: string, path: string, value: string): void {
  hardenSecretDirectory(dir);
  writeUtf8FileAtomicSync(path, value, PRIVATE_FILE_MODE);
}

function assertSecretReadLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > MAX_SECRET_READ_LIMIT_BYTES) {
    throw new TypeError("secret read byte limit is invalid");
  }
}

function assertStoredSecretReadLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > MAX_SAFE_STORAGE_FILE_BYTES) {
    throw new TypeError("stored secret read byte limit is invalid");
  }
}

function sameSecretFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Reject links and special files without blocking; require matching path/descriptor identity before and after reading, with unchanged size and timestamps. Null means absent only. */
export function readStableRegularFileUtf8(
  filePath: string,
  maxBytes: number,
  label: string,
  requirePrivateOwnerFile = false,
): string | null {
  const flags = constants.O_RDONLY |
    (platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, flags);
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
    const before = fstatSync(fd, { bigint: true });
    const pathAtOpen = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || pathAtOpen.isSymbolicLink() ||
        !pathAtOpen.isFile() || !sameSecretFileIdentity(pathAtOpen, before)) {
      throw new Error(`${label} path is not a stable regular file`);
    }
    if (requirePrivateOwnerFile) {
      if (platform === "win32" || typeof process.geteuid !== "function") {
        throw new Error(`${label} private ownership cannot be verified on this platform`);
      }
      const mode = Number(before.mode & 0o7777n);
      if (before.uid !== BigInt(process.geteuid()) || before.nlink !== 1n || mode !== 0o600) {
        throw new Error(`${label} must be an owner-only single-link file`);
      }
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error(`${label} exceeds read byte limit`);
    }
    const buffer = Buffer.alloc(size);
    let completed = 0;
    while (completed < size) {
      const read = readSync(fd, buffer, completed, size - completed, completed);
      if (read === 0) {
        throw new Error(`${label} was truncated during read`);
      }
      completed += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        !sameSecretFileIdentity(before, after) ||
        !sameSecretFileIdentity(after, pathAfter) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label} changed during read`);
    }
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
      throw new Error(`${label} is not valid UTF-8`);
    }
    return text;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Stable-read an existing POSIX owner-only 0600 authority file. */
function readStablePrivateRegularFileUtf8(
  filePath: string,
  maxBytes: number,
  label: string,
): string | null {
  return readStableRegularFileUtf8(filePath, maxBytes, label, true);
}

function readSecretFileUtf8Bounded(
  filePath: string,
  maxStoredBytes: number,
): string | null {
  assertStoredSecretReadLimit(maxStoredBytes);
  const text = readStableRegularFileUtf8(filePath, maxStoredBytes, "secret authority");
  return text === null ? null : text.replace(/\n$/, "");
}

function assertSecretValueWithinLimit(value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("secret authority value exceeds read byte limit");
  }
}

function safeStorageFileLimit(maxValueBytes: number): number {
  return Math.min(
    MAX_SAFE_STORAGE_FILE_BYTES,
    maxValueBytes * 16 + 4 * 1024,
  );
}

export interface SecretStore {
  /** Limit decoded UTF-8 reads to maxBytes; return null only when absent. */
  read(name: string, maxBytes: number): string | null;
  write(name: string, value: string): void;
}

/** The async half of Electron's safeStorage; the deprecated sync methods are never used. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

/** Use single-line mode-0600 files when OS-backed secret encryption is unavailable. */
export class FileSecretStore implements SecretStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(aveHome(), "secrets");
    hardenSecretDirectory(this.dir);
  }

  private path(name: string): string {
    // Reject traversal characters to keep the keystore flat.
    if (/[\/\\]|\.\./.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
    return join(this.dir, name);
  }

  read(
    name: string,
    maxBytes = DEFAULT_SECRET_READ_MAX_BYTES,
  ): string | null {
    assertSecretReadLimit(maxBytes);
    const p = this.path(name);
    const value = readSecretFileUtf8Bounded(p, maxBytes + 1);
    if (value === null) return null;
    assertSecretValueWithinLimit(value, maxBytes);
    return value;
  }

  write(name: string, value: string): void {
    const p = this.path(name);
    atomicWriteSecretFile(this.dir, p, value);
  }
}

/** Encrypt under a store data key that OS-backed storage wraps; entries stay mode-0600 files. */
export class SafeStorageSecretStore implements SecretStore {
  private readonly dir: string;
  private dataKey: KeyObject | null = null;
  // Only `existing-read-only` stores keep decrypted pre-envelope values: they cannot rewrite them.
  private readonly legacyValues = new Map<string, string>();
  private opened = false;

  private constructor(
    private readonly safeStorage: SafeStorageLike,
    dir: string | undefined,
    private readonly unreadablePolicy: "quarantine" | "reject",
    private readonly access: "read-write" | "existing-read-only",
  ) {
    this.dir = dir ?? join(aveHome(), "secrets");
  }

  /**
   * Async safeStorage cannot serve the synchronous audit sinks, so opening unwraps (or mints) the store's own
   * data key once; reads and writes then stay synchronous. Pre-envelope `safe:v1:` entries are re-encrypted here.
   */
  static async open(
    safeStorage: SafeStorageLike,
    dir?: string,
    unreadablePolicy: "quarantine" | "reject" = "quarantine",
    access: "read-write" | "existing-read-only" = "read-write",
  ): Promise<SafeStorageSecretStore> {
    const store = new SafeStorageSecretStore(safeStorage, dir, unreadablePolicy, access);
    if (access === "read-write") hardenSecretDirectory(store.dir);
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is not available");
    }
    await store.loadDataKey();
    await store.migrateLegacyEntries();
    store.opened = true;
    return store;
  }

  private path(name: string): string {
    if (/[\/\\]|\.\./.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
    return join(this.dir, `${name}${SAFE_STORAGE_ENTRY_SUFFIX}`);
  }

  private get keyPath(): string {
    return join(this.dir, SAFE_STORAGE_DATA_KEY_FILE);
  }

  private readStored(path: string, maxFileBytes: number): string | null {
    return this.access === "existing-read-only"
      ? readStablePrivateRegularFileUtf8(path, maxFileBytes, "secret authority")?.replace(/\n$/, "") ?? null
      : readSecretFileUtf8Bounded(path, maxFileBytes);
  }

  private async unwrap(stored: string): Promise<{ value: string; shouldReEncrypt: boolean }> {
    if (!stored.startsWith(SAFE_STORAGE_SECRET_PREFIX)) {
      throw new Error("Secret ciphertext has an unsupported encryption format");
    }
    const encoded = stored.slice(SAFE_STORAGE_SECRET_PREFIX.length);
    const ciphertext = Buffer.from(encoded, "base64");
    if (this.unreadablePolicy === "reject"
      && (ciphertext.length === 0 || ciphertext.toString("base64") !== encoded)) {
      throw new Error("Secret ciphertext encoding is invalid");
    }
    const decrypted = await this.safeStorage.decryptStringAsync(ciphertext);
    if (typeof decrypted?.result !== "string") throw new Error("Stored secret could not be decrypted");
    return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt === true };
  }

  private async wrap(value: string): Promise<string> {
    return SAFE_STORAGE_SECRET_PREFIX + (await this.safeStorage.encryptStringAsync(value)).toString("base64");
  }

  private async loadDataKey(): Promise<void> {
    const stored = this.readStored(this.keyPath, SAFE_STORAGE_DATA_KEY_FILE_BYTES);
    if (stored !== null) {
      let unwrapped: { value: string; shouldReEncrypt: boolean };
      try {
        unwrapped = await this.unwrap(stored);
      } catch (err) {
        if (this.unreadablePolicy === "reject") throw new Error("Stored secret could not be decrypted");
        if (this.access === "existing-read-only") throw new Error("Stored secret could not be decrypted");
        // Same as an unreadable entry: keep the forensic copy and start over, so every entry it wrapped is quarantined on read.
        this.quarantineUnreadableSecret(SAFE_STORAGE_DATA_KEY_FILE, this.keyPath, "decrypt-failed", err);
        await this.mintDataKey();
        return;
      }
      const key = Buffer.from(unwrapped.value, "base64");
      if (key.length !== DATA_KEY_BYTES || key.toString("base64") !== unwrapped.value) {
        key.fill(0);
        throw new Error("secret store data key is invalid");
      }
      this.dataKey = createSecretKey(key);
      key.fill(0);
      if (unwrapped.shouldReEncrypt && this.access === "read-write") {
        // The OS key rotated: rewrap the same data key; entries need no change.
        const rewrapped = await this.wrap(unwrapped.value);
        if (this.readStored(this.keyPath, SAFE_STORAGE_DATA_KEY_FILE_BYTES) === stored) {
          atomicWriteSecretFile(this.dir, this.keyPath, rewrapped);
        }
      }
      return;
    }
    if (this.access === "read-write") await this.mintDataKey();
  }

  private async mintDataKey(): Promise<void> {
    const key = randomBytes(DATA_KEY_BYTES);
    const encoded = key.toString("base64");
    const wrapped = await this.wrap(encoded);
    // Publish with link(2) so a concurrent opener never sees a partial key and exactly one minted key wins.
    const staging = `${this.keyPath}.staging-${randomBytes(8).toString("hex")}`;
    atomicWriteSecretFile(this.dir, staging, wrapped);
    try {
      linkSync(staging, this.keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      key.fill(0);
      unlinkSync(staging);
      await this.loadDataKey();
      return;
    }
    unlinkSync(staging);
    this.dataKey = createSecretKey(key);
    key.fill(0);
  }

  private async migrateLegacyEntries(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    for (const file of names) {
      if (!file.endsWith(SAFE_STORAGE_ENTRY_SUFFIX)) continue;
      const name = file.slice(0, -SAFE_STORAGE_ENTRY_SUFFIX.length);
      const p = join(this.dir, file);
      const stored = this.readStored(p, MAX_SAFE_STORAGE_FILE_BYTES);
      if (stored === null || !stored.startsWith(SAFE_STORAGE_SECRET_PREFIX)) continue;
      let value: string;
      try {
        value = (await this.unwrap(stored)).value;
      } catch (err) {
        // Reject stores leave unreadable entries in place; reading them fails closed.
        if (this.unreadablePolicy === "quarantine" && this.access === "read-write"
          && this.readStored(p, MAX_SAFE_STORAGE_FILE_BYTES) === stored) {
          this.quarantineUnreadableSecret(name, p, "decrypt-failed", err);
        }
        continue;
      }
      if (this.access === "existing-read-only") {
        this.legacyValues.set(name, value);
      } else if (this.readStored(p, MAX_SAFE_STORAGE_FILE_BYTES) === stored) {
        atomicWriteSecretFile(this.dir, p, this.seal(name, value));
      }
    }
  }

  private requireOpen(): void {
    if (!this.opened) throw new Error("secret store is not open");
  }

  private requireDataKey(): KeyObject {
    if (this.dataKey === null) throw new Error("Electron safeStorage encryption is not available");
    return this.dataKey;
  }

  private seal(name: string, value: string): string {
    const nonce = randomBytes(ENVELOPE_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.requireDataKey(), nonce, { authTagLength: ENVELOPE_TAG_BYTES });
    cipher.setAAD(envelopeAad(name));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return SAFE_STORAGE_ENVELOPE_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
  }

  private openSealed(name: string, stored: string): string {
    const encoded = stored.slice(SAFE_STORAGE_ENVELOPE_PREFIX.length);
    const sealed = Buffer.from(encoded, "base64");
    if (sealed.toString("base64") !== encoded || sealed.length < ENVELOPE_NONCE_BYTES + ENVELOPE_TAG_BYTES) {
      throw new Error("Secret ciphertext encoding is invalid");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.requireDataKey(),
      sealed.subarray(0, ENVELOPE_NONCE_BYTES),
      { authTagLength: ENVELOPE_TAG_BYTES },
    );
    decipher.setAAD(envelopeAad(name));
    decipher.setAuthTag(sealed.subarray(ENVELOPE_NONCE_BYTES, ENVELOPE_NONCE_BYTES + ENVELOPE_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(ENVELOPE_NONCE_BYTES + ENVELOPE_TAG_BYTES)),
      decipher.final(),
    ]);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  private quarantinePath(path: string, createdAt: string): string {
    const stamp = createdAt.replace(/[:.]/g, "-");
    for (let i = 0; i < 100; i++) {
      const suffix = i === 0 ? "" : `-${i}`;
      const candidate = `${path}.quarantined-${stamp}${suffix}`;
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error(`could not allocate quarantine path for ${path}`);
  }

  private quarantineUnreadableSecret(
    name: string,
    path: string,
    reason: "invalid-prefix" | "decrypt-failed",
    cause?: unknown,
  ): void {
    const createdAt = new Date().toISOString();
    const quarantinedPath = this.quarantinePath(path, createdAt);
    renameSync(path, quarantinedPath);
    try { chmodSync(quarantinedPath, 0o600); } catch {  }

    const marker = {
      schemaVersion: 1,
      type: "safe-storage-secret-quarantined",
      secretName: name,
      reason,
      createdAt,
      originalPath: path,
      quarantinedPath,
      cause: cause instanceof Error ? cause.message : undefined,
    };
    try {
      const markerPath = `${path}.recovery-${createdAt.replace(/[:.]/g, "-")}.json`;
      writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      try { chmodSync(markerPath, 0o600); } catch {  }
    } catch {
      /* The quarantined ciphertext is the critical forensic artifact. */
    }
  }

  read(
    name: string,
    maxBytes = DEFAULT_SECRET_READ_MAX_BYTES,
  ): string | null {
    this.requireOpen();
    assertSecretReadLimit(maxBytes);
    const p = this.path(name);
    const legacy = this.legacyValues.get(name);
    const stored = this.readStored(p, safeStorageFileLimit(maxBytes));
    if (stored === null) return null;
    if (legacy !== undefined && stored.startsWith(SAFE_STORAGE_SECRET_PREFIX)) {
      assertSecretValueWithinLimit(legacy, maxBytes);
      return legacy;
    }
    if (stored.startsWith(SAFE_STORAGE_SECRET_PREFIX)) {
      // Pre-envelope entries are re-encrypted at open; one appearing later is never destroyed.
      throw new Error("Stored secret could not be decrypted");
    }
    if (!stored.startsWith(SAFE_STORAGE_ENVELOPE_PREFIX)) {
      if (this.unreadablePolicy === "reject") throw new Error("Secret ciphertext has an unsupported encryption format");
      this.quarantineUnreadableSecret(name, p, "invalid-prefix");
      return null;
    }
    let value: string;
    try {
      value = this.openSealed(name, stored);
    } catch (err) {
      if (this.unreadablePolicy === "reject" || this.access === "existing-read-only") {
        throw new Error("Stored secret could not be decrypted");
      }
      this.quarantineUnreadableSecret(name, p, "decrypt-failed", err);
      return null;
    }
    assertSecretValueWithinLimit(value, maxBytes);
    return value;
  }

  write(name: string, value: string): void {
    if (this.access === "existing-read-only") {
      throw new Error("secret authority store is read-only");
    }
    this.requireOpen();
    const p = this.path(name);
    if (this.unreadablePolicy === "reject") this.read(name);
    atomicWriteSecretFile(this.dir, p, this.seal(name, value));
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  read(
    name: string,
    maxBytes = DEFAULT_SECRET_READ_MAX_BYTES,
  ): string | null {
    assertSecretReadLimit(maxBytes);
    const value = this.map.get(name);
    if (value === undefined) return null;
    assertSecretValueWithinLimit(value, maxBytes);
    return value;
  }
  write(name: string, value: string): void {
    this.map.set(name, value);
  }
}

/** Reuse the persisted HMAC secret; failed storage must refuse chain startup rather than downgrade integrity. */
export function ensureAuditSecret(store: SecretStore): string {
  const existing = store.read(AUDIT_HMAC_SECRET_NAME, SECRET_AUTHORITY_MAX_BYTES);
  if (existing && existing.length >= 32) {
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  store.write(AUDIT_HMAC_SECRET_NAME, generated);
  return generated;
}

export function readExistingAuditSecret(store: SecretStore): string {
  const existing = store.read(AUDIT_HMAC_SECRET_NAME, SECRET_AUTHORITY_MAX_BYTES);
  if (!existing || existing.length < 32) {
    throw new Error("existing audit HMAC secret is unavailable");
  }
  return existing;
}

export function computeLineHmac(secret: string, line: string): string {
  return createHmac("sha256", secret).update(line).digest("hex");
}

/** Compare chain HMACs in constant time; the first row uses the genesis marker. */
export function verifyLineHmac(
  secret: string,
  previousLine: string,
  expectedPrevHash: string,
): boolean {
  const computed = computeLineHmac(secret, previousLine);
  if (!SHA256_HEX.test(expectedPrevHash) || computed.length !== expectedPrevHash.length) return false;
  return timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(expectedPrevHash, "hex"),
  );
}

export function buildChainedEntries<T extends Record<string, unknown>>(
  secret: string,
  entries: T[],
): Array<T & { prevHash: string; entryHash: string }> {
  const out: Array<T & { prevHash: string; entryHash: string }> = [];
  let prevSerialized = GENESIS_MARKER;
  for (const e of entries) {
    const linked = { ...e, prevHash: computeLineHmac(secret, prevSerialized) };
    const withHash = {
      ...linked,
      entryHash: computeLineHmac(secret, JSON.stringify(linked)),
    };
    out.push(withHash as T & { prevHash: string; entryHash: string });
    // Hash exactly the serialized form written to disk for the next predecessor link.
    prevSerialized = JSON.stringify(withHash);
  }
  return out;
}

export type ChainLineVerification =
  | { ok: true; selfAuthenticated: boolean }
  | { ok: false; reason: string };

export function verifyEntryHmac(secret: string, raw: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof parsed.entryHash !== "string") return false;
  const { entryHash, ...unsigned } = parsed;
  return verifyLineHmac(secret, JSON.stringify(unsigned), entryHash);
}

export function verifyChainLine(
  secret: string,
  raw: string,
  previousSerialized: string,
  requireEntryHash: boolean,
): ChainLineVerification {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "json-parse-error" };
  }
  if (typeof parsed.prevHash !== "string") {
    return { ok: false, reason: "missing-prevHash" };
  }
  if (!verifyLineHmac(secret, previousSerialized, parsed.prevHash)) {
    return { ok: false, reason: "hmac-mismatch" };
  }
  if (parsed.entryHash === undefined) {
    return requireEntryHash
      ? { ok: false, reason: "missing-entryHash-after-migration" }
      : { ok: true, selfAuthenticated: false };
  }
  if (typeof parsed.entryHash !== "string") {
    return { ok: false, reason: "invalid-entryHash" };
  }
  if (!verifyEntryHmac(secret, raw)) {
    return { ok: false, reason: "entry-hmac-mismatch" };
  }
  return { ok: true, selfAuthenticated: true };
}

/** Return the first invalid JSON or broken predecessor link, or null for an intact chain. */
export function verifyChain(
  secret: string,
  lines: string[],
): { ok: true } | { ok: false; firstBrokenLineIndex: number; reason: string } {
  let prevSerialized = GENESIS_MARKER;
  let authenticatedRowsStarted = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const result = verifyChainLine(secret, raw, prevSerialized, authenticatedRowsStarted);
    if (!result.ok) {
      return { ok: false, firstBrokenLineIndex: i, reason: result.reason };
    }
    authenticatedRowsStarted ||= result.selfAuthenticated;
    prevSerialized = raw;
  }
  return { ok: true };
}

/** Seal the final serialized row separately so tampering cannot mint a matching seal. */
export function computeDailySeal(secret: string, lastLine: string): string {
  return computeLineHmac(secret, lastLine);
}

export function sealKeyName(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`invalid ISO date for seal name: ${isoDate}`);
  }
  return `audit-seal-${isoDate}`;
}

/** Do not create a seal for a missing or empty file. */
export function sealDayFromFile(
  secret: string,
  store: SecretStore,
  filePath: string,
  isoDate: string,
): string | null {
  if (!existsSync(filePath)) return null;
  const lines = parseJsonlLines(readFileSync(filePath, "utf-8"));
  if (lines.length === 0) return null;
  const seal = computeDailySeal(secret, lines[lines.length - 1]);
  store.write(sealKeyName(isoDate), seal);
  return seal;
}

/** Verify the entire chain before comparing its final seal; distinguish absent seals, broken links, and mismatches. */
export function verifyDailySeal(
  secret: string,
  store: SecretStore,
  filePath: string,
  isoDate: string,
):
  | { ok: true }
  | { ok: false; reason: "no-seal" }
  | { ok: false; reason: "chain-broken"; firstBrokenLineIndex: number }
  | { ok: false; reason: "seal-mismatch" }
  | { ok: false; reason: "no-file" } {
  if (!existsSync(filePath)) return { ok: false, reason: "no-file" };
  const stored = store.read(sealKeyName(isoDate), SECRET_AUTHORITY_MAX_BYTES);
  if (!stored) return { ok: false, reason: "no-seal" };
  const lines = parseJsonlLines(readFileSync(filePath, "utf-8"));
  const chain = verifyChain(secret, lines);
  if (!chain.ok) {
    return {
      ok: false,
      reason: "chain-broken",
      firstBrokenLineIndex: chain.firstBrokenLineIndex,
    };
  }
  const computed = computeDailySeal(secret, lines[lines.length - 1]);
  if (computed.length !== stored.length) return { ok: false, reason: "seal-mismatch" };
  const same = timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(stored, "hex"),
  );
  return same ? { ok: true } : { ok: false, reason: "seal-mismatch" };
}

/** Filter permission rows from mixed forensic logs; the hot path uses a dedicated permission channel. */
export function filterPermissionAuditLines(lines: string[]): string[] {
  return lines.filter((l) => {
    try {
      const parsed = JSON.parse(l);
      return typeof parsed.decision === "string" && typeof parsed.auditId === "string";
    } catch {
      return false;
    }
  });
}
