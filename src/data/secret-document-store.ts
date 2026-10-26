import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { writeUtf8FileAtomicSync, isMissingPathError, PRIVATE_FILE_MODE } from "../lib/atomic-file.js";
import { fileIdentityKey, sameFileIdentity } from "../lib/file-identity.js";
import { createLogger } from "../lib/logger.js";
import { FileLockReleaseError, withInProcessFileQueue } from "../lib/with-file-lock.js";
import { isRecord, hasOnlyKeys } from "../shared/is-record.js";
import { readAveHomeConfigurationFile, resolveConfigurationFile, withAveHomeConfigurationWrite } from "../shared/ave-home-configuration-access.js";

const DOCUMENT_VERSION = 1;
const MAX_SECRET_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_SECRET_KEY_LENGTH = 1_024;
const log = createLogger("secret-document-store");

export type SecretPolicy = "packaged" | "development";

export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend():
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "external_key"
    | "unknown";
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type SecretEntry =
  | { encoding: "safe-storage" | "external-key"; value: string }
  | { encoding: "plain-development"; value: string };

interface SecretDocument {
  version: typeof DOCUMENT_VERSION;
  mutation?: number;
  entries: Record<string, SecretEntry>;
}

export interface SecretDocumentIdentity {
  fingerprint: string;
  mutation: number | null;
}

interface SecretStoreRuntime {
  read(path: string): string;
  exists(path: string): boolean;
  repairMode(path: string, mode: number): boolean;
  writeAtomic(path: string, content: string, mode: number): void;
  lock<T>(anchorPath: string, callback: () => Promise<T>): Promise<T>;
  warn(event: SecretStoreReconciliationWarning): void;
}

export interface SecretStoreReconciliationWarning {
  reason: "atomic-directory-sync-unconfirmed" | "lock-release-failed-after-commit";
  path: string;
  error: unknown;
}

function isSameRegularFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && sameFileIdentity(left, right)
    && left.size === right.size;
}

function openSecretFileNoFollow(path: string): number {
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  return openSync(path, constants.O_RDONLY | noFollow);
}

function documentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function repairSecretFileMode(path: string, mode: number): boolean {
  if (process.platform === "win32") return false;
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SecretDocumentValidationError("Secret document must be a regular file");
    }
    fd = openSecretFileNoFollow(path);
    const opened = fstatSync(fd, { bigint: true });
    if (!isSameRegularFile(before, opened)) {
      throw new SecretDocumentValidationError("Secret document changed during mode repair");
    }
    const changed = (opened.mode & 0o777n) !== BigInt(mode);
    if (changed) fchmodSync(fd, mode);
    if (!isSameRegularFile(opened, lstatSync(path, { bigint: true }))) {
      throw new SecretDocumentValidationError("Secret document changed during mode repair");
    }
    return changed;
  } catch (error) {
    if (error instanceof SecretDocumentValidationError) throw error;
    throw new SecretDocumentValidationError("Secret document mode could not be repaired", error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const DEFAULT_RUNTIME: SecretStoreRuntime = {
  read: (path) => {
    const bytes = readAveHomeConfigurationFile(path);
    if (bytes === undefined) throw new SecretDocumentValidationError("Secret document does not exist");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) { throw new SecretDocumentValidationError("Secret document is not valid UTF-8", error); }
  },
  exists: (path) => readAveHomeConfigurationFile(path) !== undefined,
  repairMode: repairSecretFileMode,
  writeAtomic: writeUtf8FileAtomicSync,
  lock: withInProcessFileQueue,
  warn: (event) => {
    log.warn(
      { err: event.error, path: event.path, reason: event.reason },
      event.reason === "atomic-directory-sync-unconfirmed"
        ? "secret document rename committed; exact bytes verified after parent directory sync failure"
        : "secret document commit completed but lock release failed; exact bytes verified and stale-lock recovery may be required",
    );
  },
};

interface StoredState {
  kind: "absent" | "canonical" | "legacy";
  document: SecretDocument;
  raw: string | null;
}

interface ExpectedState {
  exists: boolean;
  bytes: string | null;
}

interface MutationResult<T> {
  value: T;
  expected: ExpectedState;
}

const mutationQueues = new Map<string, Promise<void>>();

export class SecretDocumentValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SecretDocumentValidationError";
  }
}

export class SecretDocumentDecryptionError extends Error {
  constructor() {
    super("Stored secret could not be decrypted");
    this.name = "SecretDocumentDecryptionError";
  }
}

export class SecretEncryptionUnavailableError extends Error {
  constructor() {
    super("Host encryption is unavailable for encrypted secret storage");
    this.name = "SecretEncryptionUnavailableError";
  }
}

function validateSecretKey(key: string): void {
  if (typeof key !== "string"
    || key.length === 0
    || key.length > MAX_SECRET_KEY_LENGTH
    || key.includes("\0")) {
    throw new SecretDocumentValidationError("Secret document contains an invalid key");
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function cloneDocument(document: SecretDocument): SecretDocument {
  const entries = Object.create(null) as Record<string, SecretEntry>;
  for (const [key, entry] of Object.entries(document.entries)) {
    entries[key] = { ...entry };
  }
  return {
    version: DOCUMENT_VERSION,
    ...(document.mutation === undefined ? {} : { mutation: document.mutation }),
    entries,
  };
}

function emptyDocument(): SecretDocument {
  return { version: DOCUMENT_VERSION, entries: Object.create(null) as Record<string, SecretEntry> };
}

function validateCanonicalDocument(value: unknown): SecretDocument {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["version", "mutation", "entries"])
    || value.version !== DOCUMENT_VERSION
    || !isRecord(value.entries)) {
    throw new SecretDocumentValidationError("Invalid versioned secret document");
  }
  if (value.mutation !== undefined
    && (!Number.isSafeInteger(value.mutation) || (value.mutation as number) < 1)) {
    throw new SecretDocumentValidationError("Invalid secret document mutation counter");
  }
  const entries = Object.create(null) as Record<string, SecretEntry>;
  for (const [key, candidate] of Object.entries(value.entries)) {
    validateSecretKey(key);
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ["encoding", "value"])
      || typeof candidate.value !== "string") {
      throw new SecretDocumentValidationError("Secret document contains an invalid entry");
    }
    if (candidate.encoding === "safe-storage" || candidate.encoding === "external-key") {
      if (!isCanonicalBase64(candidate.value)) {
        throw new SecretDocumentValidationError("Secret document contains invalid ciphertext encoding");
      }
      entries[key] = { encoding: candidate.encoding, value: candidate.value };
    } else if (candidate.encoding === "plain-development") {
      entries[key] = { encoding: "plain-development", value: candidate.value };
    } else {
      throw new SecretDocumentValidationError("Secret document contains an invalid entry encoding");
    }
  }
  return { version: DOCUMENT_VERSION, ...(value.mutation === undefined ? {} : { mutation: value.mutation as number }), entries };
}

function validateLegacyDocument(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new SecretDocumentValidationError("Invalid legacy secret document");
  const entries = Object.entries(value);
  for (const [key, stored] of entries) {
    validateSecretKey(key);
    if (typeof stored !== "string") {
      throw new SecretDocumentValidationError("Legacy secret document must be a flat string map");
    }
    if (!stored.startsWith("plain:") && !isCanonicalBase64(stored)) {
      throw new SecretDocumentValidationError("Legacy secret document contains invalid ciphertext encoding");
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function validateSecretDocument(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > MAX_SECRET_DOCUMENT_BYTES) {
    throw new SecretDocumentValidationError("Secret document exceeds the size limit");
  }
  parseStoredState(raw, true);
}

function parseStoredState(raw: string, allowLegacy: boolean): StoredState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SecretDocumentValidationError("Secret document contains invalid JSON");
  }
  const hasVersionedMarker = isRecord(parsed)
    && (Object.hasOwn(parsed, "version") || Object.hasOwn(parsed, "entries"));
  if (hasVersionedMarker) {
    return { kind: "canonical", document: validateCanonicalDocument(parsed), raw };
  }
  try {
    return { kind: "canonical", document: validateCanonicalDocument(parsed), raw };
  } catch (canonicalError) {
    if (!allowLegacy) throw canonicalError;
  }
  const legacy = validateLegacyDocument(parsed);
  return {
    kind: "legacy",
    document: {
      version: DOCUMENT_VERSION,
      entries: Object.fromEntries(
        Object.entries(legacy).map(([key, value]) => [
          key,
          value.startsWith("plain:")
            ? { encoding: "plain-development" as const, value: value.slice(6) }
            : { encoding: "safe-storage" as const, value },
        ]),
      ),
    },
    raw,
  };
}

function canonicalBytes(document: SecretDocument): string {
  const entries = Object.fromEntries(
    Object.keys(document.entries).sort().map((key) => [key, document.entries[key]]),
  );
  return `${JSON.stringify({ version: DOCUMENT_VERSION, ...(document.mutation === undefined ? {} : { mutation: document.mutation }), entries }, null, 2)}\n`;
}

async function enqueueMutation<T>(path: string, callback: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
  const tail = previous.catch(() => undefined).then(() => pending);
  mutationQueues.set(path, tail);
  await previous.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (mutationQueues.get(path) === tail) mutationQueues.delete(path);
  }
}

export interface SecretDocumentStoreOptions {
  path: string;
  policy: SecretPolicy;
  encryption: SecretEncryption;
  onCommittedSecretsChanged?: (keys: readonly string[], before: SecretDocumentIdentity | null, after: SecretDocumentIdentity) => void;
  platform?: NodeJS.Platform;
  runtime?: Partial<SecretStoreRuntime>;
}

export class SecretDocumentStore {
  private readonly originalPath: string;
  get path(): string { return resolveConfigurationFile(this.originalPath); }
  get lockAnchorPath(): string { return resolve(dirname(this.path), `${basename(this.path)}.lock-anchor`); }
  private readonly policy: SecretPolicy;
  private readonly encryption: SecretEncryption;
  private readonly externalKey: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly runtime: SecretStoreRuntime;
  private readonly onCommittedSecretsChanged?: (keys: readonly string[], before: SecretDocumentIdentity | null, after: SecretDocumentIdentity) => void;
  private cachedIdentity?: { stamp: string; identity: SecretDocumentIdentity | null };

  constructor(options: SecretDocumentStoreOptions) {
    this.originalPath = resolve(options.path);
    this.encryption = options.encryption;
    this.externalKey = this.encryption.getSelectedStorageBackend() === "external_key";
    this.policy = this.externalKey ? "packaged" : options.policy;
    this.platform = options.platform ?? process.platform;
    this.runtime = { ...DEFAULT_RUNTIME, ...options.runtime };
    this.onCommittedSecretsChanged = options.onCommittedSecretsChanged;
  }

  identity(): SecretDocumentIdentity | null {
    if (this.runtime.read !== DEFAULT_RUNTIME.read || this.runtime.exists !== DEFAULT_RUNTIME.exists) {
      return this.readIdentity();
    }
    const stamp = this.statStamp();
    if (stamp === "missing") return this.readIdentity();
    if (this.cachedIdentity?.stamp === stamp) return this.cachedIdentity.identity;
    const identity = this.readIdentity();
    // Do not reuse samples across metadata changes observed by the stable reader.
    const after = this.statStamp();
    if (after === stamp) this.cachedIdentity = { stamp, identity };
    return identity;
  }

  private statStamp(): string {
    try {
      const stat = lstatSync(this.path, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(MAX_SECRET_DOCUMENT_BYTES)) {
        throw new SecretDocumentValidationError("Secret document must be a bounded regular file");
      }
      return `${fileIdentityKey(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (isMissingPathError(error)) return "missing";
      throw error;
    }
  }

  private readIdentity(): SecretDocumentIdentity | null {
    if (this.runtime.read === DEFAULT_RUNTIME.read && this.runtime.exists === DEFAULT_RUNTIME.exists) {
      const bytes = readAveHomeConfigurationFile(this.path);
      if (bytes === undefined) return null;
      const raw = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      const state = parseStoredState(raw, false);
      return { fingerprint: documentFingerprint(raw), mutation: state.document.mutation ?? null };
    }
    if (!this.runtime.exists(this.path)) return null;
    const raw = this.runtime.read(this.path);
    const state = parseStoredState(raw, false);
    return { fingerprint: documentFingerprint(raw), mutation: state.document.mutation ?? null };
  }

  has(key: string): boolean {
    validateSecretKey(key);
    const state = this.readState(false);
    this.assertCompatibleBackend(state);
    if (!Object.hasOwn(state.document.entries, key)) return false;
    if (state.document.entries[key].encoding === "plain-development") {
      if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
    } else if (!this.isEncryptionUsable()) {
      throw new SecretEncryptionUnavailableError();
    }
    return true;
  }

  get(key: string): string | null {
    validateSecretKey(key);
    const state = this.readState(false);
    this.assertCompatibleDocument(state);
    if (!Object.hasOwn(state.document.entries, key)) return null;
    const entry = state.document.entries[key];
    if (entry.encoding === "plain-development") {
      if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
      return entry.value;
    }
    if (!this.isEncryptionUsable()) throw new SecretEncryptionUnavailableError();
    return this.decrypt(entry.value);
  }

  getEncrypted(key: string): string | null {
    validateSecretKey(key);
    const state = this.readState(false);
    this.assertCompatibleDocument(state);
    if (!Object.hasOwn(state.document.entries, key)) return null;
    const entry = state.document.entries[key];
    if (entry.encoding === "plain-development") {
      if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
      return null;
    }
    if (!this.isEncryptionUsable()) throw new SecretEncryptionUnavailableError();
    return this.decrypt(entry.value);
  }

  async set(key: string, value: string): Promise<void> {
    validateSecretKey(key);
    await this.mutate(false, (document) => {
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      document.entries[key] = this.encode(value);
    }, { forceWrite: true, forceChangedKeys: [key] });
  }

  async delete(key: string): Promise<boolean> {
    validateSecretKey(key);
    return this.mutate(false, (document) => {
      if (!Object.hasOwn(document.entries, key)) return false;
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      delete document.entries[key];
      return true;
    });
  }

  async deleteMany(keys: Iterable<string>): Promise<number> {
    const requested = [...keys];
    for (const key of requested) validateSecretKey(key);
    return this.mutate(false, (document) => {
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      let deleted = 0;
      for (const key of requested) {
        if (!Object.hasOwn(document.entries, key)) continue;
        delete document.entries[key];
        deleted += 1;
      }
      return deleted;
    });
  }

  /** Move stored ciphertext without decryption; the destination wins, and absent sources cause no write. */
  async move(from: string, to: string): Promise<boolean> {
    validateSecretKey(from);
    validateSecretKey(to);
    return this.mutate(false, (document) => {
      if (!Object.hasOwn(document.entries, from)) return false;
      this.assertWritesAvailable();
      this.upgradePlainEntries(document);
      if (!Object.hasOwn(document.entries, to)) document.entries[to] = document.entries[from];
      delete document.entries[from];
      return true;
    });
  }

  async migrate(): Promise<boolean> {
    if (!this.runtime.exists(this.path)) return false;
    return this.mutate(true, (document, source, modeWasRepaired) => {
      const encryptionAvailable = this.isEncryptionUsable();
      const hasPlain = Object.values(document.entries)
        .some((entry) => entry.encoding === "plain-development");
      const hasStoredSecrets = Object.keys(document.entries).length > 0;
      const needsWrite = source === "legacy" || hasPlain && encryptionAvailable;
      if (this.policy === "packaged" && !encryptionAvailable && hasStoredSecrets) {
        throw new SecretEncryptionUnavailableError();
      }
      if (source === "legacy" && encryptionAvailable) this.reencryptLegacyEntries(document);
      this.upgradePlainEntries(document);
      if (source === "legacy" && !encryptionAvailable) {
        for (const [key, entry] of Object.entries(document.entries)) {
          if (entry.encoding === "safe-storage") {
            throw new SecretEncryptionUnavailableError();
          }
          document.entries[key] = { ...entry };
        }
      }
      return needsWrite || modeWasRepaired;
    }, { repairModeBeforeRead: true, rewriteLegacy: true });
  }

  private readState(allowLegacy: boolean): StoredState {
    if (this.runtime.read === DEFAULT_RUNTIME.read && this.runtime.exists === DEFAULT_RUNTIME.exists) {
      const bytes = readAveHomeConfigurationFile(this.path);
      if (bytes === undefined) return { kind: "absent", document: emptyDocument(), raw: null };
      return parseStoredState(new TextDecoder("utf8", { fatal: true }).decode(bytes), allowLegacy);
    }
    if (!this.runtime.exists(this.path)) {
      return { kind: "absent", document: emptyDocument(), raw: null };
    }
    try {
      return parseStoredState(this.runtime.read(this.path), allowLegacy);
    } catch (error) {
      if (error instanceof SecretDocumentValidationError) throw error;
      throw new SecretDocumentValidationError("Secret document could not be read safely", error);
    }
  }

  private encode(value: string): SecretEntry {
    if (this.isEncryptionUsable()) {
      return {
        encoding: this.externalKey ? "external-key" : "safe-storage",
        value: this.encryption.encryptString(value).toString("base64"),
      };
    }
    if (this.policy === "packaged") throw new SecretEncryptionUnavailableError();
    return { encoding: "plain-development", value };
  }

  private assertWritesAvailable(): void {
    if (this.policy === "packaged" && !this.isEncryptionUsable()) {
      throw new SecretEncryptionUnavailableError();
    }
  }

  /** Check encrypted-at-rest availability before offering credential storage. */
  canStoreEncrypted(): boolean {
    return this.isEncryptionUsable();
  }

  private isEncryptionUsable(): boolean {
    if (!this.encryption.isEncryptionAvailable()) return false;
    if (this.policy !== "packaged" || this.platform !== "linux") return true;
    try {
      const backend = this.encryption.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return false;
    }
  }

  private decrypt(value: string): string {
    try {
      return this.encryption.decryptString(Buffer.from(value, "base64"));
    } catch {
      throw new SecretDocumentDecryptionError();
    }
  }

  private assertCompatibleBackend(state: StoredState): void {
    if (this.externalKey && state.kind === "legacy") {
      throw new SecretDocumentValidationError("External-key storage cannot migrate a legacy secret document");
    }
    for (const entry of Object.values(state.document.entries)) {
      if (this.externalKey ? entry.encoding !== "external-key" : entry.encoding === "external-key") {
        throw new SecretDocumentValidationError("Secret document requires a different encryption backend");
      }
    }
  }

  private assertCompatibleDocument(state: StoredState): void {
    this.assertCompatibleBackend(state);
    // Authenticate the whole document before reads or mutations so wrong keys cannot destroy unreadable credentials.
    if (this.externalKey) {
      for (const entry of Object.values(state.document.entries)) {
        if (!this.isEncryptionUsable()) throw new SecretEncryptionUnavailableError();
        this.decrypt(entry.value);
      }
    }
  }

  private reencryptLegacyEntries(document: SecretDocument): void {
    const replacements: Array<[string, SecretEntry]> = [];
    for (const [key, entry] of Object.entries(document.entries)) {
      const plaintext = entry.encoding === "safe-storage"
        ? this.decrypt(entry.value)
        : entry.value;
      replacements.push([key, this.encode(plaintext)]);
    }
    for (const [key, entry] of replacements) document.entries[key] = entry;
  }

  private upgradePlainEntries(document: SecretDocument): void {
    if (!this.isEncryptionUsable()) {
      if (this.policy === "packaged"
        && Object.values(document.entries).some((entry) => entry.encoding === "plain-development")) {
        throw new SecretEncryptionUnavailableError();
      }
      return;
    }
    const upgrades: Array<[string, SecretEntry]> = [];
    for (const [key, entry] of Object.entries(document.entries)) {
      if (entry.encoding !== "plain-development") continue;
      upgrades.push([key, this.encode(entry.value)]);
    }
    for (const [key, entry] of upgrades) document.entries[key] = entry;
  }

  private matchesExpected(expected: ExpectedState): boolean {
    if (!expected.exists) return !this.runtime.exists(this.path);
    return this.runtime.exists(this.path) && this.runtime.read(this.path) === expected.bytes;
  }

  private async mutate<T>(
    allowLegacy: boolean,
    callback: (
      document: SecretDocument,
      source: StoredState["kind"],
      modeWasRepaired: boolean,
    ) => T,
    options: { repairModeBeforeRead?: boolean; rewriteLegacy?: boolean; forceWrite?: boolean; forceChangedKeys?: readonly string[] } = {},
  ): Promise<T> {
    return enqueueMutation(this.originalPath, () => withAveHomeConfigurationWrite(this.originalPath, async () => {
      let completed: MutationResult<T>;
      try {
        completed = await this.runtime.lock(this.lockAnchorPath, async () => {
          if (this.externalKey) this.assertCompatibleDocument(this.readState(allowLegacy));
          const modeWasRepaired = options.repairModeBeforeRead === true
            && this.platform !== "win32"
            && this.runtime.exists(this.path)
            ? this.runtime.repairMode(this.path, PRIVATE_FILE_MODE)
            : false;
          const state = this.readState(allowLegacy);
          this.assertCompatibleDocument(state);
          const document = cloneDocument(state.document);
          const before = canonicalBytes(state.document);
          const value = callback(document, state.kind, modeWasRepaired);
          const contentChanged = canonicalBytes(document) !== before
            || (options.rewriteLegacy === true && state.kind === "legacy");
          const shouldWrite = (contentChanged || options.forceWrite === true)
            && (state.kind !== "absent" || Object.keys(document.entries).length > 0);
          if (shouldWrite) {
            const previousMutation = state.document.mutation ?? 0;
            if (previousMutation >= Number.MAX_SAFE_INTEGER) {
              throw new SecretDocumentValidationError("Secret document mutation counter exhausted");
            }
            document.mutation = previousMutation + 1;
            const intended = canonicalBytes(document);
            try {
              this.runtime.writeAtomic(this.path, intended, PRIVATE_FILE_MODE);
            } catch (error) {
              if ((error as { committed?: unknown }).committed !== true
                || this.runtime.read(this.path) !== intended) {
                throw error;
              }
              this.runtime.warn({
                reason: "atomic-directory-sync-unconfirmed",
                path: this.path,
                error,
              });
            }
            const changedKeys = new Set([...Object.keys(state.document.entries), ...Object.keys(document.entries)]);
            const changed = [...changedKeys].filter((key) => {
              const beforeEntry = state.document.entries[key];
              const afterEntry = document.entries[key];
              return beforeEntry?.encoding !== afterEntry?.encoding || beforeEntry?.value !== afterEntry?.value;
            });
            if (changed.length === 0) changed.push(...(options.forceChangedKeys ?? Object.keys(document.entries)));
            this.cachedIdentity = undefined;
            this.onCommittedSecretsChanged?.(
              changed,
              state.raw === null ? null : { fingerprint: documentFingerprint(state.raw), mutation: state.document.mutation ?? null },
              { fingerprint: documentFingerprint(intended), mutation: document.mutation },
            );
          }
          const intended = canonicalBytes(document);
          return {
            value,
            expected: shouldWrite
              ? { exists: true, bytes: intended }
              : { exists: state.kind !== "absent", bytes: state.raw },
          };
        });
      } catch (error) {
        if (!(error instanceof FileLockReleaseError)) throw error;
        const result = error.result as MutationResult<T>;
        if (!this.matchesExpected(result.expected)) throw error;
        this.runtime.warn({
          reason: "lock-release-failed-after-commit",
          path: this.path,
          error: error.releaseError,
        });
        completed = result;
      }
      return completed.value;
    }));
  }
}
