/** History controls timing and attempts, never install authority; unreadable history may reset safely.
 * Failed discovery retries hourly; successful apply checks are due daily. */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { errorMessage } from "../../shared/error-message.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { UPDATE_PACKAGE_STATES, type UpdateDiscoveryResult, type UpdatePackageState } from "../../shared/git-marketplace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { PACKAGE_KINDS, type PackageKind } from "../catalog/types.js";
import { MARKETPLACE_ERROR_CODES, parseMarketplaceErrorDetail, type MarketplaceErrorCode, type MarketplaceErrorDetail } from "../errors.js";
import { fsErrorCode } from "../sources/registry.js";
import { SOURCE_ID_RE } from "../sources/official.js";

export const HOUR_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = HOUR_MS;
const APPLY_CHECK_INTERVAL_MS = 24 * HOUR_MS;

export interface SyncDiscovery {
  result: Exclude<UpdateDiscoveryResult, "error">;
  /** Partial discovery classifies only reached sources. */
  reached: string[];
}

export interface DiscoveryRecord {
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  result: UpdateDiscoveryResult;
}

/** Unexpected apply failures use unavailable with scrubbed details behind Copy details. */
export interface UpdateFailureRecord {
  code: MarketplaceErrorCode | "unavailable";
  detail?: MarketplaceErrorDetail;
  message?: string;
  at: string;
}

export interface PackageUpdateRecord {
  to: string;
  state: UpdatePackageState;
  attempts: number;
  lastError?: UpdateFailureRecord;
  appliedAt?: string;
  /** Applied entries retain labels and source versions after their offers disappear. */
  from?: string;
  displayName?: string;
  commits?: { from: string | null; to: string };
}

export interface UpdateHistory {
  version: 1;
  discovery: DiscoveryRecord | null;
  applyCheckAt: string | null;
  packages: Record<string, PackageUpdateRecord>;
}

export function emptyUpdateHistory(): UpdateHistory {
  return { version: 1, discovery: null, applyCheckAt: null, packages: Object.create(null) as Record<string, PackageUpdateRecord> };
}

export function updateRecordKey(key: { sourceId: string; kind: PackageKind; name: string }): string {
  return `${key.sourceId}:${key.kind}:${key.name}`;
}

export function updateRecordSource(recordKey: string): string {
  return recordKey.slice(0, recordKey.indexOf(":"));
}

export function parseUpdateRecordKey(recordKey: string): { sourceId: string; kind: PackageKind; name: string } {
  const [sourceId, kind, ...name] = recordKey.split(":");
  if (!sourceId || !kind || !KINDS.has(kind) || name.length !== 1 || !name[0]) throw new Error(`${recordKey} is not <sourceId>:<kind>:<name>`);
  return { sourceId, kind: kind as PackageKind, name: name[0] };
}

const RESULTS = new Set<string>(["ok", "partial", "offline", "error"]);
const STATES = new Set<string>(UPDATE_PACKAGE_STATES);
const CODES = new Set<string>([...MARKETPLACE_ERROR_CODES, "unavailable"]);
const KINDS = new Set<string>(PACKAGE_KINDS);

class InvalidHistory extends Error {}

function invalid(why: string): never {
  throw new InvalidHistory(why);
}

function object(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${what} is not an object`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) invalid(`${what} has the unknown field ${unknown}`);
  return value as Record<string, unknown>;
}

function time(value: unknown, what: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(`${what} is not a time`);
  return value;
}

function timeOrNull(value: unknown, what: string): string | null {
  return value === null ? null : time(value, what);
}

function packageKey(key: string): void {
  const [sourceId, kind, name, ...rest] = key.split(":");
  if (rest.length > 0 || !sourceId || !SOURCE_ID_RE.test(sourceId) || !kind || !KINDS.has(kind) || !name) invalid(`packages key ${key} is not <sourceId>:<kind>:<name>`);
}

function packageRecord(value: unknown, what: string): PackageUpdateRecord {
  const entry = object(value, what, ["to", "state", "attempts", "lastError", "appliedAt", "from", "displayName", "commits"]);
  if (typeof entry.to !== "string" || entry.to.length === 0) invalid(`${what}.to is not a version`);
  if (typeof entry.state !== "string" || !STATES.has(entry.state)) invalid(`${what}.state is not an update state`);
  if (typeof entry.attempts !== "number" || !Number.isInteger(entry.attempts) || entry.attempts < 0) invalid(`${what}.attempts is not a count`);
  const record: PackageUpdateRecord = { to: entry.to, state: entry.state as UpdatePackageState, attempts: entry.attempts };
  if (entry.lastError !== undefined) {
    const error = object(entry.lastError, `${what}.lastError`, ["code", "detail", "message", "at"]);
    if (typeof error.code !== "string" || !CODES.has(error.code)) invalid(`${what}.lastError.code is not an error code`);
    const code = error.code as UpdateFailureRecord["code"];
    // Unknown details are dropped without discarding the failure code.
    const detail = error.detail === undefined || code === "unavailable" ? undefined : parseMarketplaceErrorDetail(code, error.detail);
    if (error.message !== undefined && typeof error.message !== "string") invalid(`${what}.lastError.message is not text`);
    record.lastError = { code, ...(detail ? { detail } : {}), ...(typeof error.message === "string" ? { message: error.message } : {}), at: time(error.at, `${what}.lastError.at`) };
  }
  if (entry.appliedAt !== undefined) record.appliedAt = time(entry.appliedAt, `${what}.appliedAt`);
  for (const field of ["from", "displayName"] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) invalid(`${what}.${field} is not text`);
    record[field] = value;
  }
  if (entry.commits !== undefined) {
    const commits = object(entry.commits, `${what}.commits`, ["from", "to"]);
    if (commits.from !== null && (typeof commits.from !== "string" || commits.from.length === 0)) invalid(`${what}.commits.from is not a commit`);
    if (typeof commits.to !== "string" || commits.to.length === 0) invalid(`${what}.commits.to is not a commit`);
    record.commits = { from: commits.from as string | null, to: commits.to };
  }
  if ((record.state === "applied" || record.state === "applied-not-running" || record.state === "approval-pending")
    && (record.from === undefined || record.displayName === undefined || record.commits === undefined)) {
    invalid(`${what} is ${record.state} without from, displayName and commits`);
  }
  return record;
}

export function parseUpdateHistory(text: string): UpdateHistory {
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    invalid(errorMessage(error));
  }
  const file = object(value, "updates.json", ["version", "discovery", "applyCheckAt", "packages"]);
  if (file.version !== 1) invalid("version must be 1");
  let discovery: DiscoveryRecord | null = null;
  if (file.discovery !== null) {
    const record = object(file.discovery, "discovery", ["lastAttemptAt", "lastSuccessAt", "result"]);
    if (typeof record.result !== "string" || !RESULTS.has(record.result)) invalid("discovery.result is not a result");
    discovery = {
      lastAttemptAt: time(record.lastAttemptAt, "discovery.lastAttemptAt"),
      lastSuccessAt: timeOrNull(record.lastSuccessAt, "discovery.lastSuccessAt"),
      result: record.result as UpdateDiscoveryResult,
    };
    if (discovery.result === "ok" && discovery.lastSuccessAt === null) invalid("a successful discovery has no lastSuccessAt");
  }
  const packages = Object.create(null) as Record<string, PackageUpdateRecord>;
  const entries = file.packages;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) invalid("packages is not an object");
  for (const [key, entry] of Object.entries(entries)) {
    packageKey(key);
    packages[key] = packageRecord(entry, `packages[${key}]`);
  }
  return { version: 1, discovery, applyCheckAt: timeOrNull(file.applyCheckAt, "applyCheckAt"), packages };
}

/** Loading reports unreadable history without writing; the running scheduler owns reset and notification. */
type LoadedUpdateHistory = { history: UpdateHistory; reset: false } | { history: UpdateHistory; reset: true; reason: string };

export interface UpdateHistoryStore {
  load(): Promise<LoadedUpdateHistory>;
  save(history: UpdateHistory): Promise<void>;
}

export function updateHistoryStore(path: string): UpdateHistoryStore {
  const save = async (history: UpdateHistory) => {
    await writeFileAtomicAtPath(path, `${JSON.stringify(history, null, 2)}\n`);
  };
  return {
    save,
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isMissingPathError(error)) return { history: emptyUpdateHistory(), reset: false };
        return { history: emptyUpdateHistory(), reset: true, reason: `cannot be read (${fsErrorCode(error)})` };
      }
      try {
        return { history: parseUpdateHistory(text), reset: false };
      } catch (error) {
        if (!(error instanceof InvalidHistory)) throw error;
        return { history: emptyUpdateHistory(), reset: true, reason: `is not in the format Ave writes (${error.message})` };
      }
    },
  };
}

/** Never-run discovery is due immediately; disabled intervals allow only boot and explicit checks. */
export function discoveryDueAt(discovery: DiscoveryRecord | null, intervalMs: number): number {
  if (discovery === null) return Number.NEGATIVE_INFINITY;
  if (discovery.result !== "ok") return Date.parse(discovery.lastAttemptAt) + RETRY_AFTER_FAILURE_MS;
  if (intervalMs === 0) return Number.POSITIVE_INFINITY;
  return Date.parse(discovery.lastSuccessAt!) + intervalMs;
}

/** Failed discovery holds daily apply checks to the hourly retry floor. */
export function applyCheckDueAt(history: Pick<UpdateHistory, "discovery" | "applyCheckAt">): number {
  const daily = history.applyCheckAt === null ? Number.NEGATIVE_INFINITY : Date.parse(history.applyCheckAt) + APPLY_CHECK_INTERVAL_MS;
  const retry = history.discovery !== null && history.discovery.result !== "ok"
    ? Date.parse(history.discovery.lastAttemptAt) + RETRY_AFTER_FAILURE_MS
    : Number.NEGATIVE_INFINITY;
  return Math.max(daily, retry);
}
