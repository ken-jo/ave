/** Hash exact serialized rows without newlines; prevHash links predecessors and entryHash authenticates the tail. Store daily seals separately from their chains. */
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
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
const SAFE_STORAGE_SECRET_PREFIX = "safe:v1:";
const DEFAULT_SECRET_READ_MAX_BYTES = 1024 * 1024;
const MAX_SECRET_READ_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_STORAGE_FILE_BYTES = 32 * 1024 * 1024;
const SECRET_AUTHORITY_MAX_BYTES = 4 * 1024;

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

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
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

/** Encrypt with OS-backed storage before persisting mode-0600 ciphertext. */
export class SafeStorageSecretStore implements SecretStore {
  private readonly dir: string;

  constructor(
    private readonly safeStorage: SafeStorageLike,
    dir?: string,
    private readonly unreadablePolicy: "quarantine" | "reject" = "quarantine",
    private readonly access: "read-write" | "existing-read-only" = "read-write",
  ) {
    this.dir = dir ?? join(aveHome(), "secrets");
    if (this.access === "read-write") hardenSecretDirectory(this.dir);
  }

  private path(name: string): string {
    if (/[\/\\]|\.\./.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
    return join(this.dir, `${name}.safe-storage`);
  }

  private assertAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is not available");
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
    this.assertAvailable();
    assertSecretReadLimit(maxBytes);
    const p = this.path(name);
    const encrypted = this.access === "existing-read-only"
      ? readStablePrivateRegularFileUtf8(
        p,
        safeStorageFileLimit(maxBytes),
        "secret authority",
      )?.replace(/\n$/, "") ?? null
      : readSecretFileUtf8Bounded(p, safeStorageFileLimit(maxBytes));
    if (encrypted === null) return null;
    if (!encrypted.startsWith(SAFE_STORAGE_SECRET_PREFIX)) {
      if (this.unreadablePolicy === "reject") throw new Error("Secret ciphertext has an unsupported encryption format");
      this.quarantineUnreadableSecret(name, p, "invalid-prefix");
      return null;
    }
    let value: string;
    try {
      const encoded = encrypted.slice(SAFE_STORAGE_SECRET_PREFIX.length);
      const ciphertext = Buffer.from(encoded, "base64");
      if (this.unreadablePolicy === "reject"
        && (ciphertext.length === 0 || ciphertext.toString("base64") !== encoded)) {
        throw new Error("Secret ciphertext encoding is invalid");
      }
      value = this.safeStorage.decryptString(ciphertext);
    } catch (err) {
      if (this.unreadablePolicy === "reject") throw new Error("Stored secret could not be decrypted");
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
    this.assertAvailable();
    const p = this.path(name);
    if (this.unreadablePolicy === "reject") this.read(name);
    const encrypted = SAFE_STORAGE_SECRET_PREFIX + this.safeStorage.encryptString(value).toString("base64");
    atomicWriteSecretFile(this.dir, p, encrypted);
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
