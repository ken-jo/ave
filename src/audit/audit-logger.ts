

import { randomUUID } from "node:crypto";
import type { RunModelSettings } from "../shared/run-model-settings.js";
import type { ModelUsageSegment } from "../shared/model-pricing.js";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  existsSync,
  openSync,
  readdirSync,
  createReadStream,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { chmod, open as openFile, unlink, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  localDateKey,
  localDayRange,
  shiftLocalDateKey,
  utcDateKey,
  UTC_DATE_KEY_LENGTH,
} from "../shared/local-date.js";
import {
  computeDailySeal,
  computeLineHmac,
  GENESIS_MARKER,
  sealKeyName,
  verifyChainLine,
  verifyEntryHmac,
  type SecretStore,
} from "./hmac-chain.js";
import { isPermissionAuditEntry, type PermissionAuditEntry, type PermissionAuditEntryInput } from "./audit-schema.js";
import { aveHome } from "../shared/ave-home.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import {
  iterateJsonlLines,
  iterateJsonlLinesFromFd,
  withAuditSnapshotLock,
} from "./jsonl-reader.js";
import { isMissingPathError } from "../lib/atomic-file.js";

const MAX_PERMISSION_AUDIT_LINE_BYTES = 1024 * 1024;

function fsyncDirectorySync(dir: string): void {
  if (platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function copyOpenFileSync(sourceFd: number, destinationFd: number, size: number): void {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const bytesRead = readSync(
      sourceFd,
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error("permission audit archive source ended unexpectedly");
    }
    let written = 0;
    while (written < bytesRead) {
      const bytesWritten = writeSync(
        destinationFd,
        chunk,
        written,
        bytesRead - written,
      );
      if (bytesWritten === 0) {
        throw new Error("permission audit archive write made no progress");
      }
      written += bytesWritten;
    }
    position += bytesRead;
  }
}

function publishOpenFileArchiveSync(
  sourceFd: number,
  size: number,
  archivePath: string,
  auditDir: string,
  noFollow: number,
): void {
  const stagedPath = `${archivePath}.${randomUUID()}.tmp`;
  let stagedFd: number | undefined;
  let operationError: unknown;
  try {
    stagedFd = openSync(
      stagedPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    copyOpenFileSync(sourceFd, stagedFd, size);
    fsyncSync(stagedFd);
    closeSync(stagedFd);
    stagedFd = undefined;

    // Publish the synced inode by hard link; existing forensic evidence must fail closed with EEXIST.
    try {
      linkSync(stagedPath, archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("permission audit archive already exists");
      }
      throw error;
    }
    unlinkSync(stagedPath);
    // Persist both publication of the final name and removal of the staging name before the caller truncates the canonical descriptor.
    fsyncDirectorySync(auditDir);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (stagedFd !== undefined) {
      try {
        closeSync(stagedFd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      unlinkSync(stagedPath);
    } catch (error) {
      if (!isMissingPathError(error)) cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "permission audit archive publication and cleanup both failed",
        );
      }
      throw cleanupErrors[0];
    }
  }
}

function readLastNonEmptyLineSync(filePath: string): string {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (err) {
    if (isMissingPathError(err)) return GENESIS_MARKER;
    throw err;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return GENESIS_MARKER;
    const one = Buffer.allocUnsafe(1);
    let end = size;
    while (end > 0) {
      readSync(fd, one, 0, 1, end - 1);
      if (one[0] !== 0x0a && one[0] !== 0x0d) break;
      end -= 1;
    }
    if (end === 0) return GENESIS_MARKER;

    const chunk = Buffer.allocUnsafe(64 * 1024);
    let start = end;
    while (start > 0) {
      const readLen = Math.min(chunk.length, start);
      const position = start - readLen;
      const bytesRead = readSync(fd, chunk, 0, readLen, position);
      for (let i = bytesRead - 1; i >= 0; i -= 1) {
        if (chunk[i] === 0x0a) {
          const lineStart = position + i + 1;
          const lineLen = end - lineStart;
          if (lineLen > MAX_PERMISSION_AUDIT_LINE_BYTES) {
            throw new Error("permission audit line exceeds the maximum size");
          }
          const line = Buffer.allocUnsafe(lineLen);
          readSync(fd, line, 0, lineLen, lineStart);
          return line.toString("utf-8");
        }
      }
      start = position;
    }

    if (end > MAX_PERMISSION_AUDIT_LINE_BYTES) {
      throw new Error("permission audit line exceeds the maximum size");
    }
    const line = Buffer.allocUnsafe(end);
    readSync(fd, line, 0, end, 0);
    return line.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function findLastCompleteJsonlBoundarySync(fd: number, size: number): number {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let cursor = size;
  while (cursor > 0) {
    const readLen = Math.min(chunk.length, cursor);
    const position = cursor - readLen;
    const bytesRead = readSync(fd, chunk, 0, readLen, position);
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) return position + index + 1;
    }
    cursor = position;
  }
  return 0;
}

function readLastCompleteLineSync(fd: number, boundary: number): string {
  if (boundary === 0) return GENESIS_MARKER;
  const one = Buffer.allocUnsafe(1);
  let end = boundary;
  while (end > 0) {
    readSync(fd, one, 0, 1, end - 1);
    if (one[0] !== 0x0a && one[0] !== 0x0d) break;
    end -= 1;
  }
  if (end === 0) return GENESIS_MARKER;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let cursor = end;
  while (cursor > 0) {
    const readLen = Math.min(chunk.length, cursor);
    const position = cursor - readLen;
    const bytesRead = readSync(fd, chunk, 0, readLen, position);
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const lineStart = position + index + 1;
      const lineLength = end - lineStart;
      if (lineLength > MAX_PERMISSION_AUDIT_LINE_BYTES) {
        throw new Error("permission audit line exceeds the maximum size");
      }
      const line = Buffer.allocUnsafe(lineLength);
      readSync(fd, line, 0, lineLength, lineStart);
      return line.toString("utf-8");
    }
    cursor = position;
  }
  if (end > MAX_PERMISSION_AUDIT_LINE_BYTES) {
    throw new Error("permission audit line exceeds the maximum size");
  }
  const line = Buffer.allocUnsafe(end);
  readSync(fd, line, 0, end, 0);
  return line.toString("utf-8");
}

/** The anthropic route stores fresh input with separate cache counts; other routes retain cache-inclusive prompt totals, per usage-stats.ts. */
export interface AuditTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** The reasoning part of `outputTokens`, when the provider reported it. */
  reasoningTokens?: number;
}

/** One provider request segment of a turn's usage, kept unmerged for tiered pricing. */
export type AuditUsageByModelSegment = ModelUsageSegment;

export interface AuditEntry {

  timestamp: string;
  sessionId: string;
  type: "turn" | "tool_call" | "approval" | "warn" | "error" | "mcp_connect" | "mcp_apikey_set" | "kill_switch" | "dlp" | "info" | "diagnostics-export" | "plugin_hostapi_denied";
  /** DLP hit payload; populated when type === "dlp" */
  dlp?: {
    byKind: Record<string, number>;
    totalRedactions: number;
    turnId: string;
  };
  input?: string;
  output?: string;
  toolCalls?: Array<{
    name: string;
    isError: boolean;

    source?: string;
    trust?: string;
    executionTimeMs?: number;
    /** Host tool-use correlation, when an execution pipeline supplied one. */
    toolUseId?: string;
    /** Public shell telemetry must exclude arguments, paths, permits, and approval integrity material. */
    executionPlan?: import("../permissions/host-shell-execution-plan.js").HostShellExecutionPlanAuditProjection;

    permissionDecision?: string;
    permissionReason?: string;
    rateLimitRemaining?: number;
    /** Distinguish policy timeout, caller cancellation, and other failures for incident analysis. */
    terminationReason?: "ok" | "ceiling" | "user-abort" | "error" | "indeterminate";
  }>;
  tokenUsage?: AuditTokenUsage;
  usageByModel?: AuditUsageByModelSegment[];

  /** Non-billable subscription telemetry, persisted separately from API usage. */
  subscriptionUsage?: SubscriptionUsageTelemetry[];
  toolExposure?: {
    loadedToolCount: number;
    loadedToolSourceCounts: { builtin: number; plugin: number; mcp: number };
    deferredCatalogCount: number;
    deferredCatalogSourceCounts: { plugin: number; mcp: number };
    promotedToolNames: string[];
    loadedPluginIds: string[];
    loadedMcpServerIds: string[];
    deferredPluginIds: string[];
    deferredMcpServerIds: string[];
    toolSchemaTokens: number;
    projectedRequestInputTokens: number | null;
    deferralEligibleLoadedCount: number;
    deferredLoadedRatio: number | null;
  };
  route?: string;
  /** On a `turn` row: what the turn's API route resolved about its model. */
  modelSettings?: RunModelSettings;
}

export interface AuditSearchFilter {
  dateFrom?: string;
  dateTo?: string;
  type?: string;
  textSearch?: string;
  limit?: number;
  offset?: number;
}

/** One boot record in the dedicated sandbox-gate channel; plain JSONL, outside the HMAC chain. */
export interface SandboxGateAuditEntry {
  /** ISO 8601; stamped by {@link AuditLogger.logSandboxGate}. */
  timestamp: string;
  type: "sandbox_gate";
  /** `process.platform` at boot. */
  platform: NodeJS.Platform;
  /** Explicit environment activation fails closed; settings/default activation may degrade; off skips the gate. */
  onSignal: "explicit-env" | "default-settings" | "off";
  /** Terminal gate outcome; mirrors decideSandboxGate's action. */
  outcome: "activate" | "degrade" | "abort" | "skip";
  /** Stable gate reason; absent when the off path skips decision computation. */
  reason?: string;
}

export interface AuditRotationOptions {
  /** Rotate active .jsonl when it exceeds this size in bytes. Default: 10 MB. */
  maxBytes?: number;
  /** Delete .jsonl.*.gz archives older than this many days. Default: 30. */
  retentionDays?: number;
  /** Age in days at which the active file is force-rotated. Default: 7. */
  rotationAgeDays?: number;
}

export interface AuditLoggerOptions {
  /** Maximum queued/in-flight writes per plain channel before that channel drops telemetry. */
  maxPendingWrites?: number;
  /** Maximum serialized bytes retained by each plain-channel writer queue. */
  maxPendingBytes?: number;
  /** Injectable UTC clock for deterministic epoch-rollover tests. */
  now?: () => Date;
}

export interface AuditWriterStats {
  pendingWrites: number;
  pendingBytes: number;
  droppedWrites: number;
  acceptingWrites: boolean;
}

const DEFAULT_MAX_PENDING_WRITES = 1_024;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/** Both quarantine writers use this infix; readers rely on it to exclude unauthenticated evidence. */
const UNVERIFIED_QUARANTINE_MARKER = "-unverified-";

/** Telemetry uses timestamp; chained permission rows use ts. Unparseable instants return NaN. */
function entryInstant(entry: AuditEntry): number {
  const row = entry as { timestamp?: unknown; ts?: unknown };
  const raw = row.timestamp ?? row.ts;
  return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
}

/** Unparseable timestamps appear last only in unbounded searches; any bound excludes them, including statistics. */
function instantWithin(at: number, start?: Date, end?: Date): boolean {
  if (start !== undefined && !(at >= start.getTime())) return false;
  if (end !== undefined && !(at < end.getTime())) return false;
  return true;
}

/** Count telemetry by type and permission rows by decision; rows with neither are corrupt and excluded. */
function auditRowKind(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const type = (entry as { type?: unknown }).type;
  if (typeof type === "string" && type.length > 0) return type;
  return isPermissionAuditEntry(entry) ? entry.decision : undefined;
}

/** A matched row plus the two keys that order it: its instant, then read order. */
interface RankedAuditRow {
  at: number;
  seq: number;
  entry: AuditEntry;
}

function ranksAhead(a: RankedAuditRow, b: RankedAuditRow): boolean {
  if (a.at !== b.at) return a.at > b.at;
  return a.seq < b.seq;
}

/** Retain only offset + limit newest rows across all channels; equal timestamps preserve read order and unknown times rank last. */
class NewestFirstRows {
  /** Min-heap by rank: the root is the row that would be dropped first. */
  private readonly heap: RankedAuditRow[] = [];
  private seq = 0;

  constructor(private readonly capacity: number) {}

  offer(entry: AuditEntry, instant: number): void {
    if (this.capacity <= 0) return;
    const row: RankedAuditRow = {
      at: Number.isNaN(instant) ? Number.NEGATIVE_INFINITY : instant,
      seq: this.seq,
      entry,
    };
    this.seq += 1;
    if (this.heap.length < this.capacity) {
      this.heap.push(row);
      this.siftUp(this.heap.length - 1);
      return;
    }
    if (ranksAhead(row, this.heap[0])) {
      this.heap[0] = row;
      this.siftDown(0);
    }
  }

  /** The retained rows, newest first. */
  drain(): AuditEntry[] {
    return this.heap
      .sort((a, b) => (a.at === b.at ? a.seq - b.seq : b.at - a.at))
      .map((row) => row.entry);
  }

  private siftUp(from: number): void {
    let index = from;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!ranksAhead(this.heap[parent], this.heap[index])) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  private siftDown(from: number): void {
    let index = from;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let lowest = index;
      if (left < this.heap.length && ranksAhead(this.heap[lowest], this.heap[left])) lowest = left;
      if (right < this.heap.length && ranksAhead(this.heap[lowest], this.heap[right])) lowest = right;
      if (lowest === index) break;
      this.swap(lowest, index);
      index = lowest;
    }
  }

  private swap(a: number, b: number): void {
    const held = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = held;
  }
}

function archiveDateStampFromFileName(fileName: string): string | undefined {
  const match = /\.jsonl\.(\d{8})(?:\d{9})?(?:\.[0-9a-f-]{36})?\.gz$/i.exec(fileName);
  return match?.[1];
}

interface PlainWriterState {
  tail: Promise<void>;
  pendingWrites: number;
  pendingBytes: number;
}

export class AuditLogger {
  private readonly auditDir: string;
  /** Keep HMAC-chained permission rows in a separate file so verification never filters mixed schemas. */
  private permissionAuditLogFile: string;
  private permissionAuditDate: string;

  /** HMAC chain state; null until setupPermissionAuditChain. */
  private permissionAuditSecret: string | null = null;
  private permissionAuditChainBootstrapped = false;
  /** Daily-seal store wired with the chain. */
  private permissionAuditSealStore: SecretStore | null = null;
  private readonly plainWriters = new Map<string, PlainWriterState>();
  private droppedPlainWrites = 0;
  private acceptingPlainWrites = true;
  private readonly maxPendingWrites: number;
  private readonly maxPendingBytes: number;
  private readonly hardenedPlainFiles = new Set<string>();
  private readonly now: () => Date;
  private permissionAuditEpochTransition: Promise<void> | null = null;
  private permissionAuditAppendTail: Promise<void> = Promise.resolve();
  private permissionAuditAppendActive = 0;
  private acceptingPermissionAuditWrites = true;

  constructor(auditDirOverride?: string, options: AuditLoggerOptions = {}) {
    this.auditDir = auditDirOverride ?? join(aveHome(), "audit");
    if (!existsSync(this.auditDir)) {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    }

    this.now = options.now ?? (() => new Date());
    const date = this.currentUtcDate();
    this.permissionAuditDate = date;
    this.permissionAuditLogFile = join(this.auditDir, `${date}.permission-audit.jsonl`);
    this.maxPendingWrites = normalizePositiveInteger(
      options.maxPendingWrites,
      DEFAULT_MAX_PENDING_WRITES,
    );
    this.maxPendingBytes = normalizePositiveInteger(
      options.maxPendingBytes,
      DEFAULT_MAX_PENDING_BYTES,
    );
  }

  private currentUtcDate(): string {
    return utcDateKey(this.now());
  }

  private telemetryPath(date = this.currentUtcDate()): string {
    return join(this.auditDir, `${date}.jsonl`);
  }

  private permissionShadowPath(date = this.currentUtcDate()): string {
    return join(this.auditDir, `${date}.permission-shadow.jsonl`);
  }

  private sandboxGatePath(date = this.currentUtcDate()): string {
    return join(this.auditDir, `${date}.sandbox-gate.jsonl`);
  }

  private permissionAuditPath(date: string): string {
    return join(this.auditDir, `${date}.permission-audit.jsonl`);
  }

  /** Synchronous rollover accepts only an empty new UTC epoch; existing rows require asynchronous re-verification. */
  private ensurePermissionAuditEpochForPreflight(): void {
    if (this.permissionAuditAppendActive > 0) {
      throw new Error("permission audit append is already in progress");
    }
    const date = this.currentUtcDate();
    if (date === this.permissionAuditDate) return;
    const nextPath = this.permissionAuditPath(date);
    const nextTail = readLastNonEmptyLineSync(nextPath);
    const nextSeal = this.permissionAuditSealStore?.read(sealKeyName(date), 4 * 1024) ?? null;
    if (nextTail !== GENESIS_MARKER || nextSeal !== null) {
      throw new Error("permission audit UTC epoch requires chain re-verification");
    }
    this.permissionAuditDate = date;
    this.permissionAuditLogFile = nextPath;
  }

  private async ensurePermissionAuditEpochForAppend(): Promise<void> {
    if (this.permissionAuditEpochTransition) {
      await this.permissionAuditEpochTransition;
    }
    const date = this.currentUtcDate();
    if (date === this.permissionAuditDate) return;
    const secret = this.permissionAuditSecret;
    if (!secret) throw new Error("permission audit chain not initialized");
    const sealStore = this.permissionAuditSealStore ?? undefined;
    const transition = (async () => {
      this.permissionAuditDate = date;
      this.permissionAuditLogFile = this.permissionAuditPath(date);
      await this.setupPermissionAuditChain(secret, sealStore);
    })();
    this.permissionAuditEpochTransition = transition;
    try {
      await transition;
    } finally {
      // Every contender awaits the one published transition before it can create another, so the owner can clear the slot unconditionally.
      this.permissionAuditEpochTransition = null;
    }
  }

  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      this.enqueuePlainWrite(this.telemetryPath(), line);
    } catch {
      // Audit failures must not block app behavior.
    }
  }

  /** Shadow reconciliation uses a separate plain-JSONL channel with mode 0o600; failures must never break tool calls. */
  logShadow(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      this.enqueuePlainWrite(this.permissionShadowPath(), line);
    } catch {
      // Shadow logging must never break a tool invocation.
    }
  }

  getPermissionShadowLogFile(): string {
    return this.permissionShadowPath();
  }

  /** Stamp boot telemetry centrally in its separate mode-0o600 JSONL channel; failures must never prevent fail-closed boot handling. */
  logSandboxGate(event: Omit<SandboxGateAuditEntry, "timestamp" | "type">): void {
    try {
      const entry: SandboxGateAuditEntry = {
        timestamp: this.now().toISOString(),
        type: "sandbox_gate",
        ...event,
      };
      const line = JSON.stringify(entry) + "\n";
      this.enqueuePlainWrite(this.sandboxGatePath(), line);
    } catch {
      // Activation telemetry must never break boot.
    }
  }

  /** Wait until every plain-channel write accepted before this call has settled. */
  async flush(): Promise<void> {
    const tails = [...this.plainWriters.values()].map((writer) => writer.tail);
    await Promise.all(tails);
  }

  /** Stop accepting plain telemetry and drain the bounded writer queue. */
  async close(): Promise<void> {
    this.acceptingPlainWrites = false;
    this.acceptingPermissionAuditWrites = false;
    await Promise.all([this.flush(), this.permissionAuditAppendTail]);
    if (this.permissionAuditEpochTransition) await this.permissionAuditEpochTransition;
  }

  getWriterStats(): AuditWriterStats {
    let pendingWrites = 0;
    let pendingBytes = 0;
    for (const writer of this.plainWriters.values()) {
      pendingWrites += writer.pendingWrites;
      pendingBytes += writer.pendingBytes;
    }
    return {
      pendingWrites,
      pendingBytes,
      droppedWrites: this.droppedPlainWrites,
      acceptingWrites: this.acceptingPlainWrites,
    };
  }

  private enqueuePlainWrite(filePath: string, line: string): void {
    const bytes = Buffer.byteLength(line, "utf-8");
    if (!this.acceptingPlainWrites) {
      this.droppedPlainWrites += 1;
      return;
    }
    let writer = this.plainWriters.get(filePath);
    if (!writer) {
      writer = { tail: Promise.resolve(), pendingWrites: 0, pendingBytes: 0 };
      this.plainWriters.set(filePath, writer);
    }
    if (
      writer.pendingWrites >= this.maxPendingWrites ||
      bytes > this.maxPendingBytes - writer.pendingBytes
    ) {
      this.droppedPlainWrites += 1;
      return;
    }

    writer.pendingWrites += 1;
    writer.pendingBytes += bytes;
    const write = writer.tail.then(() => this.appendPlainLine(filePath, line));
    writer.tail = write
      .catch(() => {
        this.droppedPlainWrites += 1;
      })
      .finally(() => {
        writer.pendingWrites -= 1;
        writer.pendingBytes -= bytes;
      });
  }

  private async appendPlainLine(filePath: string, line: string): Promise<void> {
    await withFileLock(filePath, async () => {
      const handle = await openFile(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
        0o600,
      );
      try {
        if (!this.hardenedPlainFiles.has(filePath)) {
          try {
            await handle.chmod(0o600);
            this.hardenedPlainFiles.add(filePath);
          } catch {
            // Best-effort hardening: creation already requested mode 0o600. Retry chmod on the next accepted write instead of caching failure.
          }
        }
        await handle.writeFile(line, { encoding: "utf-8" });
      } finally {
        await handle.close();
      }
    });
  }

  getSandboxGateLogFile(): string {
    return this.sandboxGatePath();
  }

  /** Probe shadow-channel writability without throwing; swallowed logging failures must remain observable to the executor. */
  isShadowChannelWritable(): boolean {
    try {
      const shadowLogFile = this.permissionShadowPath();
      const probeTarget = existsSync(shadowLogFile)
        ? shadowLogFile
        : this.auditDir;
      accessSync(probeTarget, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Unwired chains reject appends; load the keychain secret at boot.
   * A seal store is required for legacy-tail migration and daily-seal verification. */
  async setupPermissionAuditChain(secret: string, sealStore?: SecretStore): Promise<void> {
    this.permissionAuditDate = this.currentUtcDate();
    this.permissionAuditLogFile = this.permissionAuditPath(this.permissionAuditDate);
    // A failed re-bootstrap must never inherit a prior ready state.
    this.permissionAuditSecret = null;
    this.permissionAuditSealStore = null;
    this.permissionAuditChainBootstrapped = false;
    let previousSerialized = GENESIS_MARKER;
    let penultimateSerialized = GENESIS_MARKER;
    let lastRowSelfAuthenticated = false;
    let lineIndex = 0;
    let authenticatedRowsStarted = false;
    await withFileLock(this.permissionAuditLogFile, async () => {
      const noFollow = platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
      // Verify and publish through one descriptor; pathname replacement must not archive unauthenticated bytes.
      let fd: number | undefined;
      try {
        fd = openSync(
          this.permissionAuditLogFile,
          fsConstants.O_RDWR | fsConstants.O_CREAT | noFollow,
          0o600,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      try {
        // The authenticated descriptor prefix must be archived byte for byte.
        let verifiedSize = 0;
        if (fd !== undefined) {
          const { size } = fstatSync(fd);
          verifiedSize = size;
          if (size > 0) {
            const lastByte = Buffer.allocUnsafe(1);
            readSync(fd, lastByte, 0, 1, size - 1);
            if (lastByte[0] !== 0x0a) {
              const boundary = findLastCompleteJsonlBoundarySync(fd, size);
              const completeTail = readLastCompleteLineSync(fd, boundary);
              const storedSeal = sealStore?.read(
                sealKeyName(this.permissionAuditDate),
                4 * 1024,
              ) ?? null;
              const expectedSeal = completeTail === GENESIS_MARKER
                ? null
                : computeDailySeal(secret, completeTail);
              if (!sealStore || storedSeal !== expectedSeal) {
                throw new Error("permission audit chain has an unterminated tail");
              }
              const archivePath = join(
                this.auditDir,
                `${this.permissionAuditDate}.permission-audit.torn${UNVERIFIED_QUARANTINE_MARKER}${size}-${this.now().getTime()}.jsonl`,
              );
              publishOpenFileArchiveSync(
                fd,
                size,
                archivePath,
                this.auditDir,
                noFollow,
              );
              ftruncateSync(fd, boundary);
              fsyncSync(fd);
              verifiedSize = boundary;
            }
          }
          for await (const line of iterateJsonlLinesFromFd(
            fd,
            verifiedSize,
            MAX_PERMISSION_AUDIT_LINE_BYTES,
          )) {
            if (line.length === 0) continue;
            if (Buffer.byteLength(line, "utf-8") > MAX_PERMISSION_AUDIT_LINE_BYTES) {
              throw new Error(
                `permission audit chain invalid at line ${lineIndex + 1}: line-too-large`,
              );
            }
            const verification = verifyChainLine(
              secret,
              line,
              previousSerialized,
              authenticatedRowsStarted,
            );
            if (!verification.ok) {
              throw new Error(
                `permission audit chain invalid at line ${lineIndex + 1}: ${verification.reason}`,
              );
            }
            penultimateSerialized = previousSerialized;
            lastRowSelfAuthenticated = verification.selfAuthenticated;
            authenticatedRowsStarted ||= verification.selfAuthenticated;
            previousSerialized = line;
            lineIndex += 1;
            if (lineIndex % 1_024 === 0) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
        }
        const sealName = sealKeyName(this.permissionAuditDate);
        const storedSeal = sealStore?.read(sealName, 4 * 1024) ?? null;
        if (previousSerialized === GENESIS_MARKER) {
          if (storedSeal !== null) {
            throw new Error("permission audit seal exists for an empty active file");
          }
        } else if (!authenticatedRowsStarted) {
          const computedSeal = computeDailySeal(secret, previousSerialized);
          if (storedSeal !== null) {
            if (storedSeal !== computedSeal) {
              throw new Error("permission audit active-tail seal mismatch");
            }
          } else {
            // Never trust-on-first-use a mutable legacy tail. Preserve it as unverified evidence and begin a fresh self-authenticated epoch.
            if (fd === undefined) {
              throw new Error("permission audit legacy tail lost its open descriptor");
            }
            const archivePath = join(
              this.auditDir,
              `${this.permissionAuditDate}.permission-audit.legacy${UNVERIFIED_QUARANTINE_MARKER}${computedSeal.slice(0, 12)}.jsonl`,
            );
            // Publish the verified inode and empty it in place; pathname replacement and existing archives must fail closed.
            publishOpenFileArchiveSync(
              fd,
              verifiedSize,
              archivePath,
              this.auditDir,
              noFollow,
            );
            try { chmodSync(archivePath, 0o600); } catch { /* best effort */ }
            ftruncateSync(fd, 0);
            fsyncSync(fd);
            // The fresh epoch may only begin on the file that was just emptied. A non-empty active name
            // means something replaced it during archival: refuse to start a chain over unauthenticated bytes.
            if (statSync(this.permissionAuditLogFile).size !== 0) {
              throw new Error(
                "permission audit active file was replaced during legacy archival",
              );
            }
            previousSerialized = GENESIS_MARKER;
            penultimateSerialized = GENESIS_MARKER;
            lastRowSelfAuthenticated = false;
            lineIndex = 0;
          }
        } else if (sealStore) {
          const computedSeal = computeDailySeal(secret, previousSerialized);
          if (storedSeal !== computedSeal) {
            const predecessorSeal = penultimateSerialized === GENESIS_MARKER
              ? null
              : computeDailySeal(secret, penultimateSerialized);
            const interruptedCommit =
              lastRowSelfAuthenticated && storedSeal === predecessorSeal;
            if (!interruptedCommit) {
              throw new Error("permission audit active-tail seal mismatch");
            }
            // The row is fsynced/self-authenticated and the stored checkpoint names its exact predecessor: finish the interrupted seal commit.
            sealStore.write(sealName, computedSeal);
          }
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    });
    this.permissionAuditSecret = secret;
    this.permissionAuditSealStore = sealStore ?? null;
    this.permissionAuditChainBootstrapped = true;
  }

  getPermissionAuditLogFile(): string {
    return this.permissionAuditLogFile;
  }

  isPermissionAuditChainReady(): boolean {
    return this.permissionAuditChainBootstrapped && this.permissionAuditSecret !== null;
  }

  /** Before side effects, require an initialized HMAC chain and an appendable audit file. */
  assertPermissionAuditWritable(): void {
    if (!this.isPermissionAuditChainReady()) {
      throw new Error("permission audit chain not initialized");
    }
    this.ensurePermissionAuditEpochForPreflight();
    const secret = this.permissionAuditSecret!;
    const tail = readLastNonEmptyLineSync(this.permissionAuditLogFile);
    if (this.permissionAuditSealStore) {
      const sealName = sealKeyName(this.permissionAuditDate);
      const storedSeal = this.permissionAuditSealStore.read(sealName, 4 * 1024);
      if (tail === GENESIS_MARKER) {
        if (storedSeal !== null) {
          throw new Error("permission audit seal does not match the empty active file");
        }
      } else {
        if (storedSeal !== computeDailySeal(secret, tail)) {
          throw new Error("permission audit active-tail seal mismatch");
        }
      }
    } else if (tail !== GENESIS_MARKER && !verifyEntryHmac(secret, tail)) {
      throw new Error("permission audit active tail is not self-authenticated");
    }
    const fd = openSync(this.permissionAuditLogFile, "a", 0o600);
    try {
      chmodSync(this.permissionAuditLogFile, 0o600);
    } finally {
      closeSync(fd);
    }
  }

  /** Null until the secret is bootstrapped. */
  getPermissionAuditSecret(): string | null {
    return this.permissionAuditSecret;
  }

  /** Null when the seal store is unwired or omitted. */
  getPermissionAuditSealStore(): SecretStore | null {
    return this.permissionAuditSealStore;
  }

  getAuditDir(): string {
    return this.auditDir;
  }

  /** Reject unwired chains; the boot boundary reports failures.
   * Serialize cross-process writers with withFileLock and link to the on-disk tail without scanning the full file. */
  appendPermissionAuditEntry(entry: PermissionAuditEntryInput): Promise<PermissionAuditEntry> {
    if (!this.acceptingPermissionAuditWrites) {
      return Promise.reject(new Error("permission audit logger is closed"));
    }
    this.permissionAuditAppendActive += 1;
    const operation = this.permissionAuditAppendTail.then(
      () => this.appendPermissionAuditEntrySerialized(entry),
    );
    this.permissionAuditAppendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendPermissionAuditEntrySerialized(
    entry: PermissionAuditEntryInput,
  ): Promise<PermissionAuditEntry> {
    try {
      await this.ensurePermissionAuditEpochForAppend();
      if (!this.permissionAuditSecret || !this.permissionAuditChainBootstrapped) {
        throw new Error("permission audit chain not initialized — call setupPermissionAuditChain() at boot");
      }
      const secret = this.permissionAuditSecret;
      const epoch = {
        date: this.permissionAuditDate,
        path: this.permissionAuditLogFile,
        sealStore: this.permissionAuditSealStore,
      } as const;
      return await withFileLock(epoch.path, async () => {
        const lastSerialized = readLastNonEmptyLineSync(epoch.path);
        const sealStore = epoch.sealStore;
        const sealName = sealKeyName(epoch.date);
        if (sealStore) {
          const storedSeal = sealStore.read(sealName, 4 * 1024);
          if (lastSerialized === GENESIS_MARKER) {
            if (storedSeal !== null) {
              throw new Error("permission audit seal does not match the empty active file");
            }
          } else {
            const currentSeal = computeDailySeal(secret, lastSerialized);
            if (storedSeal !== currentSeal) {
              throw new Error("permission audit active-tail seal mismatch before append");
            }
          }
        }
        if (
          lastSerialized !== GENESIS_MARKER
          && !verifyEntryHmac(secret, lastSerialized)
          && !sealStore
        ) {
          throw new Error("permission audit active tail is not self-authenticated");
        }
        const prevHash = computeLineHmac(secret, lastSerialized);
        const linked = { ...entry, prevHash };
        const full = {
          ...linked,
          entryHash: computeLineHmac(secret, JSON.stringify(linked)),
        } as PermissionAuditEntry;
        const serialized = JSON.stringify(full);
        if (Buffer.byteLength(serialized, "utf-8") > MAX_PERMISSION_AUDIT_LINE_BYTES) {
          throw new Error("permission audit entry exceeds the maximum size");
        }
        const auditFd = openSync(epoch.path, "a", 0o600);
        try {
          writeFileSync(auditFd, serialized + "\n", { encoding: "utf-8" });
          // Persist the row before the external seal; setup can finish an interrupted seal commit only over durable bytes.
          fsyncSync(auditFd);
        } finally {
          closeSync(auditFd);
        }
        try {
          chmodSync(epoch.path, 0o600);
        } catch {
          // Non-fatal; chmod failure must not block audit writes.
        }
        if (sealStore) {
          try {
            sealStore.write(sealName, computeDailySeal(secret, serialized));
          } catch (err) {
            this.permissionAuditChainBootstrapped = false;
            this.permissionAuditSecret = null;
            throw err;
          }
        }
        return full;
      });
    } finally {
      this.permissionAuditAppendActive -= 1;
    }
  }

  /** Rotate on size or age and prune expired archives under per-file locks. */
  async rotateAndPrune(opts: AuditRotationOptions = {}): Promise<void> {
    await withAuditSnapshotLock(this.auditDir, async () => this.rotateAndPruneUnlocked(opts));
  }

  private async rotateAndPruneUnlocked(opts: AuditRotationOptions): Promise<void> {
    await this.flush();
    const {
      maxBytes = 10 * 1024 * 1024,
      retentionDays = 30,
      rotationAgeDays = 7,
    } = opts;

    const currentTime = this.now();
    const now = currentTime.getTime();
    const rotationAgeMs = rotationAgeDays * 86_400_000;
    const retentionAgeMs = retentionDays * 86_400_000;
    const archiveDateStamp = currentTime.toISOString().replace(/\D/g, "");

    let entries: string[];
    try {
      entries = readdirSync(this.auditDir);
    } catch {
      return;
    }

    // HMAC chains may age-rotate only after their UTC day closes; size rotation would sever active links.
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    for (const fname of jsonlFiles) {
      const filePath = join(this.auditDir, fname);
      const isHmacChain =
        fname.endsWith(".permission-audit.jsonl") || fname.endsWith(".sandbox.jsonl");
      let shouldRotate = false;
      try {
        const st = statSync(filePath);
        // Size rotation must never split an active HMAC chain.
        if (!isHmacChain && st.size >= maxBytes) {
          shouldRotate = true;
        }
        // Age rotation covers every channel suffix but only closed prior-day chains.
        const dateMatch = fname.match(/^(\d{4}-\d{2}-\d{2})\./);
        if (dateMatch) {
          const fileDate = new Date(dateMatch[1]).getTime();
          if (!isNaN(fileDate) && now - fileDate >= rotationAgeMs) {
            shouldRotate = true;
          }
        }
      } catch {
        continue;
      }

      if (!shouldRotate) continue;

      const archivePath = `${filePath}.${archiveDateStamp}.${randomUUID()}.gz`;

      try {
        await withFileLock(filePath, async () => {
          // Re-stat under the lock; another writer may have rotated the file.
          const st2 = await fsStat(filePath).catch(() => null);
          if (!st2 || st2.size === 0) return;

          await pipeline(
            createReadStream(filePath),
            createGzip(),
            createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
          );
          await chmod(archivePath, 0o600);
          await unlink(filePath);
          this.hardenedPlainFiles.delete(filePath);
        });
      } catch {
        // Rotation failures are non-fatal.
      }
    }

    // Re-read the directory after rotation before pruning archives.
    let entries2: string[];
    try {
      entries2 = readdirSync(this.auditDir);
    } catch {
      return;
    }

    const archiveFiles = entries2
      .map((name) => ({ name, archiveDate: archiveDateStampFromFileName(name) }))
      .filter((entry): entry is { name: string; archiveDate: string } => entry.archiveDate !== undefined);
    for (const { name: fname, archiveDate: ds } of archiveFiles) {
      const archiveDate = new Date(
        `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`,
      ).getTime();
      if (isNaN(archiveDate)) continue;
      if (now - archiveDate >= retentionAgeMs) {
        try {
          await unlink(join(this.auditDir, fname));
        } catch {
        }
      }
    }
  }

  /** Interpret date bounds as inclusive host-local days and filter each row by its instant across overlapping UTC partitions.
   * Paginate newest first with read-order ties; total counts all matches. */
  async search(filter: AuditSearchFilter): Promise<{ entries: AuditEntry[]; total: number }> {
    await this.flush();
    const { dateFrom, dateTo, type, textSearch, limit = 100, offset = 0 } = filter;

    const range = localDayRange(dateFrom, dateTo);
    if (range === null) {
      throw new TypeError("audit search dateFrom/dateTo must be YYYY-MM-DD day keys");
    }
    const files = this._filesOverlapping(range.start, range.end);

    const ranked = new NewestFirstRows(offset + limit);
    let total = 0;
    const normalizedNeedle = textSearch?.toLowerCase();

    for (const file of files) {
      const filePath = join(this.auditDir, file);
      if (!existsSync(filePath)) continue;
      for await (const line of iterateJsonlLines(filePath)) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }
        const at = entryInstant(entry);
        if (!instantWithin(at, range.start, range.end)) continue;
        if (type && entry.type !== type) continue;
        if (normalizedNeedle) {
          const haystack = JSON.stringify(entry).toLowerCase();
          if (!haystack.includes(normalizedNeedle)) continue;
        }
        ranked.offer(entry, at);
        total += 1;
      }
    }

    return { entries: ranked.drain().slice(offset), total };
  }

  /** Bucket statistics by host-local civil day, matching the Audit picker. */
  async getStats(lastDays: number): Promise<{
    totalByType: Record<string, number>;
    totalByDay: Record<string, number>;
    sensitiveOps: number;
  }> {
    await this.flush();
    const range = localDayRange(shiftLocalDateKey(localDateKey(this.now()), -lastDays));
    if (range === null) {
      throw new TypeError("audit stats window must start on a YYYY-MM-DD day key");
    }
    const files = this._filesOverlapping(range.start, range.end);

    const totalByType: Record<string, number> = {};
    const totalByDay: Record<string, number> = {};
    let sensitiveOps = 0;

    const SENSITIVE_TYPES = new Set<string>(["approval", "kill_switch"] satisfies AuditEntry["type"][]);

    for (const file of files) {
      const filePath = join(this.auditDir, file);
      if (!existsSync(filePath)) continue;
      for await (const line of iterateJsonlLines(filePath)) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }
        const at = entryInstant(entry);
        if (!instantWithin(at, range.start, range.end)) continue;
        const kind = auditRowKind(entry);
        if (kind === undefined) continue;
        const day = localDateKey(new Date(at));
        totalByType[kind] = (totalByType[kind] ?? 0) + 1;
        totalByDay[day] = (totalByDay[day] ?? 0) + 1;
        if (SENSITIVE_TYPES.has(kind)) sensitiveOps += 1;
      }
    }

    return { totalByType, totalByDay, sensitiveOps };
  }

  /** Read overlapping UTC partitions, then filter individual instants.
   * Exclude quarantined rows: forged or replayed bytes must never appear as authenticated search results or statistics. */
  private _filesOverlapping(start?: Date, end?: Date): string[] {
    let files: string[];
    try {
      files = readdirSync(this.auditDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(UNVERIFIED_QUARANTINE_MARKER))
        .sort();
    } catch {
      return [];
    }
    const firstPartition = start === undefined ? undefined : utcDateKey(start);
    const lastPartition = end === undefined ? undefined : utcDateKey(new Date(end.getTime() - 1));
    return files.filter((f) => {
      const partition = f.slice(0, UTC_DATE_KEY_LENGTH);
      if (firstPartition !== undefined && partition < firstPartition) return false;
      if (lastPartition !== undefined && partition > lastPartition) return false;
      return true;
    });
  }

  logTurn(params: {
    sessionId: string;
    input: string;
    output: string;
    toolCalls: Array<{ name: string; isError: boolean }>;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    usageByModel?: AuditUsageByModelSegment[];
    /** Non-billable subscription telemetry; sanitized again before write. */
    subscriptionUsage?: SubscriptionUsageTelemetry[];
    toolExposure?: {
      loadedToolCount: number;
      loadedToolSourceCounts: { builtin: number; plugin: number; mcp: number };
      deferredCatalogCount: number;
      deferredCatalogSourceCounts: { plugin: number; mcp: number };
      promotedToolNames: string[];
      loadedPluginIds: string[];
      loadedMcpServerIds: string[];
      deferredPluginIds: string[];
      deferredMcpServerIds: string[];
      toolSchemaTokens: number;
      projectedRequestInputTokens: number | null;
      deferralEligibleLoadedCount: number;
      deferredLoadedRatio: number | null;
    };
    route: string;
    /** What the turn's API route resolved about its model (catalog, window, output, reasoning). */
    modelSettings?: RunModelSettings;
  }): void {
    const subscriptionUsage = params.subscriptionUsage
      ?.map((segment) => normalizeSubscriptionUsageTelemetry(segment))
      .filter((segment): segment is SubscriptionUsageTelemetry => segment !== undefined);
    this.log({
      timestamp: this.now().toISOString(),
      sessionId: params.sessionId,
      type: "turn",
      input: params.input.slice(0, 500),
      output: params.output.slice(0, 500),
      toolCalls: params.toolCalls,
      tokenUsage: params.tokenUsage,
      usageByModel: params.usageByModel,
      ...(subscriptionUsage && subscriptionUsage.length > 0 ? { subscriptionUsage } : {}),
      toolExposure: params.toolExposure,
      route: params.route,
      ...(params.modelSettings ? { modelSettings: params.modelSettings } : {}),
    });
  }
}
