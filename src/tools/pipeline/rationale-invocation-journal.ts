import { isRationaleHumanApprovalActive } from "./rationale-control.js";
import { createHmac } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SecretStore } from "../../lib/protected-secret-store.js";
import { readStableRegularFileUtf8 } from "../../lib/stable-regular-file.js";
import { logPermissionEvent } from "../../lib/permission-log.js";
import { preparePrivateFileDirectory } from "../../main/storage/feature-namespace.js";
import { writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { withFileLock } from "../../lib/with-file-lock.js";
import { canonicalJsonEqual, canonicalStringify } from "../../shared/canonical-json.js";
import {
  createHostInvocationStartLease,
  createInvocationAuditEvent,
  createInvocationStartedAudit,
  transitionInvocationAudit,
  validateHostInvocationStartLease,
  validateInvocationAuditRecord,
  validateInvocationTerminalForLease,
  validateHostInvocationStartAuthorization,
  type HostInvocationStartCas,
  type HostInvocationStartCommit,
  type HostInvocationStartLease,
  type InvocationAuditRecord,
} from "./rationale-ticket-lifecycle.js";
import type { RationaleRequiredControl } from "./rationale-control.js";
import { timingSafeEqualHexDigest, sha256Hex } from "../../lib/hex-digest-equal.js";
import { isRecord, hasExactKeys } from "../../shared/is-record.js";

const JOURNAL_SCHEMA_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const TERMINAL_TRANSITION_HEADROOM_BYTES = 2 * 1024;
const MAX_JOURNAL_ENTRIES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const JOURNAL_ENVELOPE_SCHEMA_VERSION = 1 as const;
const JOURNAL_ENVELOPE_KIND = "rationale-invocation-journal" as const;
const JOURNAL_KEY_DOMAIN = "ave:rationale-invocation-journal:v1";
const JOURNAL_GENESIS_DOMAIN = "ave:rationale-invocation-journal:genesis:v1";
const CHECKPOINT_SCHEMA_VERSION = 1 as const;
const CHECKPOINT_KIND = "rationale-invocation-journal-checkpoint" as const;
const CHECKPOINT_KEY_DOMAIN = "ave:rationale-invocation-journal:checkpoint:v1";
const CHECKPOINT_NAME_PREFIX = "invocation-execution-checkpoint-";
const HEAD_SCHEMA_VERSION = 1 as const;
const HEAD_KIND = "rationale-invocation-journal-head" as const;
const HEAD_KEY_DOMAIN = "ave:rationale-invocation-journal:head:v1";
const HEAD_NAME = "invocation-execution-head";
const MAX_CHECKPOINT_BYTES = 4 * 1024;

interface InvocationJournalEntry {
  authorized: InvocationAuditRecord;
  authorizationExpiresAt: number | null;
  controlDigest: string;
  sessionId: string;
  lease: HostInvocationStartLease;
  started: InvocationAuditRecord;
  terminal: InvocationAuditRecord | null;
  updatedAt: number;
}

interface InvocationJournalSnapshot {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  revision: number;
  entries: Record<string, InvocationJournalEntry>;
}

interface InvocationJournalEnvelopeUnsigned {
  readonly schemaVersion: typeof JOURNAL_ENVELOPE_SCHEMA_VERSION;
  readonly kind: typeof JOURNAL_ENVELOPE_KIND;
  readonly previousMac: string;
  readonly snapshot: InvocationJournalSnapshot;
}

type InvocationJournalEnvelope = InvocationJournalEnvelopeUnsigned & {
  readonly mac: string;
};

type InvocationJournalCheckpointSlot = "a" | "b";

interface InvocationJournalCheckpointUnsigned {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly kind: typeof CHECKPOINT_KIND;
  readonly slot: InvocationJournalCheckpointSlot;
  readonly generation: number;
  readonly journalRevision: number;
  readonly journalMac: string;
}

type InvocationJournalCheckpoint = InvocationJournalCheckpointUnsigned & {
  readonly seal: string;
};

interface InvocationJournalHeadUnsigned {
  readonly schemaVersion: typeof HEAD_SCHEMA_VERSION;
  readonly kind: typeof HEAD_KIND;
  readonly generation: number;
  readonly journalRevision: number;
  readonly journalMac: string;
}

type InvocationJournalHead = InvocationJournalHeadUnsigned & {
  readonly seal: string;
};

interface LoadedJournalState {
  readonly envelope: InvocationJournalEnvelope;
  readonly checkpoint: InvocationJournalCheckpoint;
  readonly head: InvocationJournalHead;
}

export interface DurableHostInvocationStartCasStoreOptions {
  filePath: string;
  executionKey: string;
  checkpointStore: SecretStore;
  writeFileAtomic?: typeof writeUtf8FileAtomicSync;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
}

export interface InvocationCrashRecoveryResult {
  recovered: number;
}

function stateMac(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (!hasExactKeys(value, keys)) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function readStableUtf8(filePath: string, maxBytes: number): string | null {
  const text = readStableRegularFileUtf8(filePath, maxBytes, "invocation journal");
  if (text === "") throw new Error("invocation journal size is invalid");
  return text;
}

function emptySnapshot(): InvocationJournalSnapshot {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, revision: 0, entries: {} };
}

function terminalEvent(
  terminal: InvocationAuditRecord,
): "complete" | "fail" | "crash-recovery" {
  if (terminal.state === "completed") return "complete";
  if (terminal.state === "failed") return "fail";
  if (terminal.state === "unknown-after-crash") return "crash-recovery";
  throw new Error("journal terminal record has a non-terminal state");
}

function validateEntry(
  invocationDigest: string,
  value: unknown,
): asserts value is InvocationJournalEntry {
  if (!isRecord(value)) throw new Error("invocation journal entry must be an object");
  assertExactKeys(value, [
    "authorized",
    "authorizationExpiresAt",
    "controlDigest",
    "sessionId",
    "lease",
    "started",
    "terminal",
    "updatedAt",
  ], "invocation journal entry");

  const entry = value as unknown as InvocationJournalEntry;
  validateInvocationAuditRecord(entry.authorized);
  if (typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0 || entry.sessionId.length > 256 ||
      entry.authorized.state !== "authorized" || entry.authorized.version !== 0 ||
      entry.authorized.invocationDigest !== invocationDigest ||
      !DIGEST_PATTERN.test(entry.controlDigest) ||
      (entry.authorizationExpiresAt !== null && !Number.isFinite(entry.authorizationExpiresAt))) {
    throw new Error("journal authorization or session binding mismatch");
  }

  validateHostInvocationStartLease(
    entry.lease,
    entry.authorized,
    Number.MAX_SAFE_INTEGER,
  );
  const expectedStarted = createInvocationStartedAudit({
    authorized: entry.authorized,
    startLease: entry.lease,
    now: Number.MAX_SAFE_INTEGER,
  });
  validateInvocationAuditRecord(entry.started);
  if (!canonicalJsonEqual(expectedStarted, entry.started)) {
    throw new Error("journal started record binding mismatch");
  }

  if (entry.terminal !== null) {
    validateInvocationTerminalForLease(entry.terminal, entry.lease);
    const expectedTerminal = transitionInvocationAudit(
      entry.started,
      createInvocationAuditEvent(entry.started, terminalEvent(entry.terminal)),
    );
    if (!canonicalJsonEqual(expectedTerminal, entry.terminal)) {
      throw new Error("journal terminal record is not a monotonic transition");
    }
  }

  if (!Number.isFinite(entry.updatedAt) ||
      entry.updatedAt < entry.lease.startedAt ||
      (entry.authorizationExpiresAt !== null && entry.authorizationExpiresAt <= entry.lease.startedAt)) {
    throw new Error("journal entry has an invalid update timestamp");
  }
}

function validateSnapshot(value: unknown): asserts value is InvocationJournalSnapshot {
  if (!isRecord(value)) throw new Error("invocation journal must be an object");
  assertExactKeys(value, ["schemaVersion", "revision", "entries"], "invocation journal");
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error("unsupported invocation journal schema");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("invocation journal revision is invalid");
  }
  if (!isRecord(value.entries)) {
    throw new Error("invocation journal entries must be an object");
  }
  const entries = Object.entries(value.entries);
  if (entries.length > MAX_JOURNAL_ENTRIES) {
    throw new Error("invocation journal entry limit exceeded");
  }
  for (const [digest, entry] of entries) {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error("invocation journal contains an invalid digest key");
    }
    validateEntry(digest, entry);
  }
}

function sealEnvelope(
  secret: string,
  snapshot: InvocationJournalSnapshot,
  previousMac: string,
): InvocationJournalEnvelope {
  validateSnapshot(snapshot);
  if (!DIGEST_PATTERN.test(previousMac)) {
    throw new Error("invocation journal previous MAC is invalid");
  }
  const unsigned: InvocationJournalEnvelopeUnsigned = {
    schemaVersion: JOURNAL_ENVELOPE_SCHEMA_VERSION,
    kind: JOURNAL_ENVELOPE_KIND,
    previousMac,
    snapshot,
  };
  return {
    ...unsigned,
    mac: stateMac(secret, canonicalStringify(unsigned)),
  };
}

function parseEnvelope(
  text: string,
  secret: string,
): InvocationJournalEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error("invocation journal JSON is corrupt", { cause: error });
  }
  if (!isRecord(decoded)) {
    throw new Error("invocation journal envelope must be an object");
  }
  assertExactKeys(decoded, [
    "schemaVersion",
    "kind",
    "previousMac",
    "snapshot",
    "mac",
  ], "invocation journal envelope");
  if (decoded.schemaVersion !== JOURNAL_ENVELOPE_SCHEMA_VERSION ||
      decoded.kind !== JOURNAL_ENVELOPE_KIND ||
      typeof decoded.previousMac !== "string" ||
      !DIGEST_PATTERN.test(decoded.previousMac) ||
      typeof decoded.mac !== "string" ||
      !DIGEST_PATTERN.test(decoded.mac)) {
    throw new Error("invocation journal envelope is invalid");
  }
  validateSnapshot(decoded.snapshot);
  const unsigned: InvocationJournalEnvelopeUnsigned = {
    schemaVersion: JOURNAL_ENVELOPE_SCHEMA_VERSION,
    kind: JOURNAL_ENVELOPE_KIND,
    previousMac: decoded.previousMac,
    snapshot: decoded.snapshot,
  };
  const expectedMac = stateMac(secret, canonicalStringify(unsigned));
  if (!timingSafeEqualHexDigest(decoded.mac, expectedMac)) {
    throw new Error("invocation journal HMAC mismatch");
  }
  const envelope: InvocationJournalEnvelope = {
    ...unsigned,
    mac: decoded.mac,
  };
  if (text !== canonicalStringify(envelope) + "\n") {
    throw new Error("invocation journal encoding is not canonical");
  }
  return envelope;
}

function checkpointName(slot: InvocationJournalCheckpointSlot): string {
  return `${CHECKPOINT_NAME_PREFIX}${slot}`;
}

function sealCheckpoint(
  secret: string,
  unsigned: InvocationJournalCheckpointUnsigned,
): InvocationJournalCheckpoint {
  return {
    ...unsigned,
    seal: stateMac(secret, canonicalStringify(unsigned)),
  };
}

function parseCheckpoint(
  raw: string,
  slot: InvocationJournalCheckpointSlot,
  secret: string,
): InvocationJournalCheckpoint {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("invocation journal checkpoint encoding is corrupt", {
      cause: error,
    });
  }
  if (!isRecord(decoded)) {
    throw new Error("invocation journal checkpoint must be an object");
  }
  assertExactKeys(decoded, [
    "schemaVersion",
    "kind",
    "slot",
    "generation",
    "journalRevision",
    "journalMac",
    "seal",
  ], "invocation journal checkpoint");
  if (decoded.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
      decoded.kind !== CHECKPOINT_KIND || decoded.slot !== slot ||
      !Number.isSafeInteger(decoded.generation) ||
      (decoded.generation as number) < 0 ||
      !Number.isSafeInteger(decoded.journalRevision) ||
      (decoded.journalRevision as number) < 0 ||
      decoded.generation !== decoded.journalRevision ||
      slot !== ((decoded.generation as number) % 2 === 0 ? "a" : "b") ||
      typeof decoded.journalMac !== "string" ||
      !DIGEST_PATTERN.test(decoded.journalMac) ||
      typeof decoded.seal !== "string" ||
      !DIGEST_PATTERN.test(decoded.seal)) {
    throw new Error("invocation journal checkpoint is invalid");
  }
  const unsigned: InvocationJournalCheckpointUnsigned = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    kind: CHECKPOINT_KIND,
    slot,
    generation: decoded.generation as number,
    journalRevision: decoded.journalRevision as number,
    journalMac: decoded.journalMac,
  };
  const expectedSeal = stateMac(secret, canonicalStringify(unsigned));
  if (!timingSafeEqualHexDigest(decoded.seal, expectedSeal)) {
    throw new Error("invocation journal checkpoint seal mismatch");
  }
  const checkpoint: InvocationJournalCheckpoint = {
    ...unsigned,
    seal: decoded.seal,
  };
  if (raw !== canonicalStringify(checkpoint)) {
    throw new Error("invocation journal checkpoint encoding is not canonical");
  }
  return checkpoint;
}

function sealHead(
  secret: string,
  unsigned: InvocationJournalHeadUnsigned,
): InvocationJournalHead {
  return {
    ...unsigned,
    seal: stateMac(secret, canonicalStringify(unsigned)),
  };
}

function parseHead(raw: string, secret: string): InvocationJournalHead {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("invocation journal head encoding is corrupt", {
      cause: error,
    });
  }
  if (!isRecord(decoded)) {
    throw new Error("invocation journal head must be an object");
  }
  assertExactKeys(decoded, [
    "schemaVersion",
    "kind",
    "generation",
    "journalRevision",
    "journalMac",
    "seal",
  ], "invocation journal head");
  if (decoded.schemaVersion !== HEAD_SCHEMA_VERSION ||
      decoded.kind !== HEAD_KIND ||
      !Number.isSafeInteger(decoded.generation) ||
      (decoded.generation as number) < 0 ||
      !Number.isSafeInteger(decoded.journalRevision) ||
      (decoded.journalRevision as number) < 0 ||
      decoded.generation !== decoded.journalRevision ||
      typeof decoded.journalMac !== "string" ||
      !DIGEST_PATTERN.test(decoded.journalMac) ||
      typeof decoded.seal !== "string" ||
      !DIGEST_PATTERN.test(decoded.seal)) {
    throw new Error("invocation journal head is invalid");
  }
  const unsigned: InvocationJournalHeadUnsigned = {
    schemaVersion: HEAD_SCHEMA_VERSION,
    kind: HEAD_KIND,
    generation: decoded.generation as number,
    journalRevision: decoded.journalRevision as number,
    journalMac: decoded.journalMac,
  };
  const expectedSeal = stateMac(secret, canonicalStringify(unsigned));
  if (!timingSafeEqualHexDigest(decoded.seal, expectedSeal)) {
    throw new Error("invocation journal head seal mismatch");
  }
  const head: InvocationJournalHead = {
    ...unsigned,
    seal: decoded.seal,
  };
  if (raw !== canonicalStringify(head)) {
    throw new Error("invocation journal head encoding is not canonical");
  }
  return head;
}

function envelopeByteLength(snapshot: InvocationJournalSnapshot): number {
  const placeholder: InvocationJournalEnvelope = {
    schemaVersion: JOURNAL_ENVELOPE_SCHEMA_VERSION,
    kind: JOURNAL_ENVELOPE_KIND,
    previousMac: "0".repeat(64),
    snapshot,
    mac: "0".repeat(64),
  };
  return Buffer.byteLength(canonicalStringify(placeholder) + "\n", "utf8");
}

function nextRevision(
  snapshot: InvocationJournalSnapshot,
  entries: Record<string, InvocationJournalEntry>,
): InvocationJournalSnapshot {
  if (snapshot.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("invocation journal revision exhausted");
  }
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    revision: snapshot.revision + 1,
    entries,
  };
}

function snapshotFitsByteLimit(
  snapshot: InvocationJournalSnapshot,
  maxBytes: number,
): boolean {
  const contentBytes = envelopeByteLength(snapshot);
  const activeEntryCount = Object.values(snapshot.entries)
    .filter((entry) => entry.terminal === null)
    .length;
  return contentBytes +
    (activeEntryCount * TERMINAL_TRANSITION_HEADROOM_BYTES) <= maxBytes;
}

function makeRoomForInvocation(input: {
  snapshot: InvocationJournalSnapshot;
  invocationDigest: string;
  entry: InvocationJournalEntry;
  maxEntries: number;
  maxBytes: number;
  now: number;
}): InvocationJournalSnapshot {
  const entries = { ...input.snapshot.entries };
  const retired = Object.entries(entries)
    .filter(([, entry]) =>
      entry.terminal !== null &&
      (entry.authorizationExpiresAt === null || entry.authorizationExpiresAt <= input.now))
    .sort(([leftDigest, left], [rightDigest, right]) =>
      left.updatedAt - right.updatedAt || leftDigest.localeCompare(rightDigest));

  let compactableIndex = 0;
  while (true) {
    const candidate = nextRevision(input.snapshot, {
      ...entries,
      [input.invocationDigest]: input.entry,
    });
    const exceedsEntryLimit = Object.keys(candidate.entries).length > input.maxEntries;
    const exceedsByteLimit = !snapshotFitsByteLimit(candidate, input.maxBytes);
    if (!exceedsEntryLimit && !exceedsByteLimit) return candidate;

    const compactable = retired[compactableIndex];
    if (!compactable) {
      if (exceedsEntryLimit) {
        throw new Error("invocation journal has no safely compactable terminal entry");
      }
      throw new Error("invocation journal size limit exceeded");
    }
    compactableIndex += 1;
    delete entries[compactable[0]];
  }
}

export class DurableHostInvocationStartCasStore implements HostInvocationStartCas {
  readonly #filePath: string;
  readonly #lockTargetPath: string;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #journalSecret: string;
  readonly #checkpointSecret: string;
  readonly #headSecret: string;
  readonly #genesisMac: string;
  readonly #checkpointStore: SecretStore;
  readonly #writeFileAtomic: typeof writeUtf8FileAtomicSync;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DurableHostInvocationStartCasStoreOptions) {
    if (!isRecord(options) || typeof options.filePath !== "string" ||
        !isAbsolute(options.filePath) ||
        typeof options.executionKey !== "string" || options.executionKey.length < 32 ||
        !options.checkpointStore || typeof options.checkpointStore.read !== "function" ||
        typeof options.checkpointStore.write !== "function" ||
        (options.writeFileAtomic !== undefined &&
          typeof options.writeFileAtomic !== "function") ||
        (options.now !== undefined && typeof options.now !== "function") ||
        (options.maxEntries !== undefined &&
          (!Number.isSafeInteger(options.maxEntries) ||
            options.maxEntries < 2 || options.maxEntries > MAX_JOURNAL_ENTRIES)) ||
        (options.maxBytes !== undefined &&
          (!Number.isSafeInteger(options.maxBytes) ||
            options.maxBytes < 1_024 || options.maxBytes > MAX_JOURNAL_BYTES))) {
      throw new TypeError("durable invocation journal options are invalid");
    }
    this.#filePath = options.filePath;
    this.#lockTargetPath = options.filePath;
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? MAX_JOURNAL_ENTRIES;
    this.#maxBytes = options.maxBytes ?? MAX_JOURNAL_BYTES;
    this.#journalSecret = stateMac(options.executionKey, JOURNAL_KEY_DOMAIN);
    this.#checkpointSecret = stateMac(
      options.executionKey,
      CHECKPOINT_KEY_DOMAIN,
    );
    this.#headSecret = stateMac(options.executionKey, HEAD_KEY_DOMAIN);
    this.#genesisMac = stateMac(
      this.#journalSecret,
      JOURNAL_GENESIS_DOMAIN,
    );
    this.#checkpointStore = options.checkpointStore;
    this.#writeFileAtomic = options.writeFileAtomic ?? writeUtf8FileAtomicSync;
  }

  async commitStart(input: {
    sessionId: string;
    control: RationaleRequiredControl;
    authorized: InvocationAuditRecord;
    expectedInvocationVersion: 0;
    now?: number;
  }): Promise<HostInvocationStartCommit | null> {
    const now = input.now ?? this.#now();
    validateHostInvocationStartAuthorization({ ...input, now });

    const committed = await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      const digest = input.authorized.invocationDigest;
      if (snapshot.entries[digest] !== undefined) return null;
      const lease = createHostInvocationStartLease({
        authorized: input.authorized,
        now,
      });
      const startedInvocationAudit = createInvocationStartedAudit({
        authorized: input.authorized,
        startLease: lease,
        now,
      });
      const entry: InvocationJournalEntry = {
        authorized: input.authorized,
        // Human consent is live and one-shot; model-only starts retain their original deadline.
        authorizationExpiresAt: isRationaleHumanApprovalActive(input.control, now) ? null : input.control.anchor.expiresAt,
        controlDigest: sha256Hex(canonicalStringify(input.control)),
        sessionId: input.sessionId,
        lease,
        started: startedInvocationAudit,
        terminal: null,
        updatedAt: now,
      };
      this.#writeSnapshot(state, makeRoomForInvocation({
        snapshot,
        invocationDigest: digest,
        entry,
        maxEntries: this.#maxEntries,
        maxBytes: this.#maxBytes,
        now,
      }));
      return { lease, startedInvocationAudit };
    });

    return committed;
  }

  async commitTerminal(input: {
    lease: HostInvocationStartLease;
    terminal: InvocationAuditRecord;
  }): Promise<boolean> {
    try {
      validateInvocationTerminalForLease(input.terminal, input.lease);
    } catch {
      return false;
    }

    const committed = await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      const digest = input.lease.invocationDigest;
      const entry = snapshot.entries[digest];
      if (!entry || !canonicalJsonEqual(entry.lease, input.lease)) return false;
      if (entry.terminal !== null) {
        return canonicalJsonEqual(entry.terminal, input.terminal);
      }
      const now = this.#now();
      if (!Number.isFinite(now) || now < 0) {
        throw new Error("invalid durable invocation terminal timestamp");
      }
      const updated: InvocationJournalEntry = {
        ...entry,
        terminal: input.terminal,
        updatedAt: Math.max(entry.updatedAt, entry.lease.startedAt, now),
      };
      this.#writeSnapshot(state, nextRevision(snapshot, {
        ...snapshot.entries,
        [digest]: updated,
      }));
      return true;
    });
    return committed;
  }

  async recoverAfterCrash(input: { now?: number } = {}): Promise<InvocationCrashRecoveryResult> {
    const now = input.now ?? this.#now();
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("invalid crash recovery timestamp");
    }

    const recovered = await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      let count = 0;
      const entries = { ...snapshot.entries };
      for (const digest of Object.keys(entries).sort()) {
        const entry = entries[digest];
        if (entry.terminal !== null) continue;
        const terminal = transitionInvocationAudit(
          entry.started,
          createInvocationAuditEvent(entry.started, "crash-recovery"),
        );
        entries[digest] = {
          ...entry,
          terminal,
          updatedAt: Math.max(entry.updatedAt, entry.lease.startedAt, now),
        };
        count += 1;
      }
      if (count > 0) this.#writeSnapshot(state, nextRevision(snapshot, entries));
      return count;
    });

    logPermissionEvent("rationale_recovery", { recovered });
    return { recovered };
  }

  #readEnvelope(): InvocationJournalEnvelope | null {
    const text = readStableUtf8(this.#filePath, this.#maxBytes);
    return text === null ? null : parseEnvelope(text, this.#journalSecret);
  }

  #readCheckpoint(): InvocationJournalCheckpoint | null {
    const candidates: InvocationJournalCheckpoint[] = [];
    for (const slot of ["a", "b"] as const) {
      const raw = this.#checkpointStore.read(
        checkpointName(slot),
        MAX_CHECKPOINT_BYTES,
      );
      if (raw === null) continue;
      if (Buffer.byteLength(raw, "utf8") > MAX_CHECKPOINT_BYTES) {
        throw new Error("invocation journal checkpoint exceeds size limit");
      }
      candidates.push(parseCheckpoint(raw, slot, this.#checkpointSecret));
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.generation - left.generation);
    if (candidates.length > 1 &&
        candidates[0]!.generation === candidates[1]!.generation) {
      throw new Error("invocation journal checkpoint generations conflict");
    }
    return candidates[0]!;
  }

  #readHead(): InvocationJournalHead | null {
    const raw = this.#checkpointStore.read(HEAD_NAME, MAX_CHECKPOINT_BYTES);
    if (raw === null) return null;
    if (Buffer.byteLength(raw, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new Error("invocation journal head exceeds size limit");
    }
    return parseHead(raw, this.#headSecret);
  }

  #loadState(): LoadedJournalState {
    const envelope = this.#readEnvelope();
    const checkpoint = this.#readCheckpoint();
    const head = this.#readHead();
    if (envelope === null && checkpoint === null && head === null) {
      return this.#initializeGenesis();
    }
    if (envelope === null) {
      throw new Error("invocation journal is missing behind its checkpoint");
    }
    if (checkpoint === null) {
      throw new Error(
        "invocation journal checkpoint is absent for an existing journal",
      );
    }
    if (head === null) {
      throw new Error("invocation journal head is absent for an existing journal");
    }

    const revision = envelope.snapshot.revision;
    if (revision === 0 &&
        (!timingSafeEqualHexDigest(envelope.previousMac, this.#genesisMac) ||
          Object.keys(envelope.snapshot.entries).length !== 0)) {
      throw new Error("invocation journal genesis root mismatch");
    }

    // The sealed head detects newest-slot deletion; preventing rollback of all local state requires external monotonic authority.
    if (checkpoint.generation < head.generation) {
      throw new Error("invocation journal head is ahead of available checkpoint");
    }
    if (checkpoint.generation > head.generation + 1) {
      throw new Error("invocation journal checkpoint is too far ahead of its head");
    }

    if (checkpoint.generation === head.generation + 1) {
      if (revision !== checkpoint.journalRevision ||
          !timingSafeEqualHexDigest(envelope.mac, checkpoint.journalMac) ||
          revision !== head.journalRevision + 1 ||
          !timingSafeEqualHexDigest(envelope.previousMac, head.journalMac)) {
        throw new Error("invocation journal checkpoint is not anchored to its head");
      }
      this.#persistEnvelope(envelope);
      const repairedHead = this.#writeHead(checkpoint);
      return { envelope, checkpoint, head: repairedHead };
    }

    if (checkpoint.journalRevision !== head.journalRevision ||
        !timingSafeEqualHexDigest(checkpoint.journalMac, head.journalMac)) {
      throw new Error("invocation journal checkpoint/head root mismatch");
    }
    if (revision === head.journalRevision) {
      if (!timingSafeEqualHexDigest(envelope.mac, head.journalMac)) {
        throw new Error("invocation journal/checkpoint root mismatch");
      }
      return { envelope, checkpoint, head };
    }
    if (revision < head.journalRevision) {
      throw new Error("invocation journal rollback detected");
    }
    if (revision === head.journalRevision + 1 &&
        timingSafeEqualHexDigest(envelope.previousMac, head.journalMac)) {
      this.#persistEnvelope(envelope);
      const repaired = this.#advanceCheckpoint(checkpoint, envelope);
      const repairedHead = this.#writeHead(repaired);
      return { envelope, checkpoint: repaired, head: repairedHead };
    }
    throw new Error("invocation journal is not anchored to its checkpoint");
  }

  #initializeGenesis(): LoadedJournalState {
    const snapshot = emptySnapshot();
    if (!snapshotFitsByteLimit(snapshot, this.#maxBytes)) {
      throw new Error("invocation journal size limit exceeded");
    }
    const envelope = sealEnvelope(
      this.#journalSecret,
      snapshot,
      this.#genesisMac,
    );
    this.#persistEnvelope(envelope);
    const checkpoint = this.#writeGenesisCheckpoint(envelope);
    const head = this.#writeHead(checkpoint);
    return { envelope, checkpoint, head };
  }

  #persistEnvelope(envelope: InvocationJournalEnvelope): void {
    const content = canonicalStringify(envelope) + "\n";
    if (!snapshotFitsByteLimit(envelope.snapshot, this.#maxBytes) ||
        Buffer.byteLength(content, "utf8") > this.#maxBytes) {
      throw new Error("invocation journal size limit exceeded");
    }
    try {
      this.#writeFileAtomic(this.#filePath, content, 0o600);
    } catch (error) {
      if (isRecord(error) && error.committed === true) {
        let persisted: InvocationJournalEnvelope | null;
        try {
          persisted = this.#readEnvelope();
        } catch {
          throw error;
        }
        if (persisted !== null && canonicalJsonEqual(persisted, envelope)) {
          // The second atomic replace is the durability barrier; propagate failure before checkpoint advancement.
          this.#writeFileAtomic(this.#filePath, content, 0o600);
          return;
        }
      }
      throw error;
    }
  }

  #writeSnapshot(
    previous: LoadedJournalState,
    snapshot: InvocationJournalSnapshot,
  ): void {
    validateSnapshot(snapshot);
    if (snapshot.revision !== previous.envelope.snapshot.revision + 1 ||
        previous.checkpoint.journalRevision !==
          previous.envelope.snapshot.revision ||
        !timingSafeEqualHexDigest(previous.checkpoint.journalMac, previous.envelope.mac) ||
        previous.head.journalRevision !== previous.envelope.snapshot.revision ||
        !timingSafeEqualHexDigest(previous.head.journalMac, previous.envelope.mac)) {
      throw new Error("invocation journal mutation skipped a revision");
    }
    if (!snapshotFitsByteLimit(snapshot, this.#maxBytes)) {
      throw new Error("invocation journal size limit exceeded");
    }
    const envelope = sealEnvelope(
      this.#journalSecret,
      snapshot,
      previous.envelope.mac,
    );
    this.#persistEnvelope(envelope);
    const checkpoint = this.#advanceCheckpoint(previous.checkpoint, envelope);
    this.#writeHead(checkpoint);
  }

  #writeGenesisCheckpoint(
    envelope: InvocationJournalEnvelope,
  ): InvocationJournalCheckpoint {
    if (envelope.snapshot.revision !== 0 ||
        Object.keys(envelope.snapshot.entries).length !== 0 ||
        !timingSafeEqualHexDigest(envelope.previousMac, this.#genesisMac)) {
      throw new Error("invalid invocation journal genesis envelope");
    }
    const checkpoint = sealCheckpoint(this.#checkpointSecret, {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      kind: CHECKPOINT_KIND,
      slot: "a",
      generation: 0,
      journalRevision: 0,
      journalMac: envelope.mac,
    });
    this.#checkpointStore.write(checkpointName("a"), canonicalStringify(checkpoint));
    return checkpoint;
  }

  #advanceCheckpoint(
    previous: InvocationJournalCheckpoint,
    envelope: InvocationJournalEnvelope,
  ): InvocationJournalCheckpoint {
    const revision = envelope.snapshot.revision;
    const generation = previous.generation + 1;
    if (!Number.isSafeInteger(generation) ||
        revision !== previous.journalRevision + 1 ||
        generation !== revision ||
        !timingSafeEqualHexDigest(envelope.previousMac, previous.journalMac)) {
      throw new Error("invocation journal checkpoint advance is invalid");
    }
    const slot: InvocationJournalCheckpointSlot =
      generation % 2 === 0 ? "a" : "b";
    const checkpoint = sealCheckpoint(this.#checkpointSecret, {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      kind: CHECKPOINT_KIND,
      slot,
      generation,
      journalRevision: revision,
      journalMac: envelope.mac,
    });
    this.#checkpointStore.write(checkpointName(slot), canonicalStringify(checkpoint));
    return checkpoint;
  }

  #writeHead(
    checkpoint: InvocationJournalCheckpoint,
  ): InvocationJournalHead {
    const head = sealHead(this.#headSecret, {
      schemaVersion: HEAD_SCHEMA_VERSION,
      kind: HEAD_KIND,
      generation: checkpoint.generation,
      journalRevision: checkpoint.journalRevision,
      journalMac: checkpoint.journalMac,
    });
    this.#checkpointStore.write(HEAD_NAME, canonicalStringify(head));
    return head;
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(async () => {
      await preparePrivateFileDirectory(this.#filePath);
      return withFileLock(
        this.#lockTargetPath,
        operation,
        { stale: 30_000, retries: 8, createTarget: false },
      );
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
