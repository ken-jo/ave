/**
 * `~/.ave/marketplaces/updates.json` and the due rules of the update
 * scheduler (design §18.7.1).
 *
 * The file remembers when a discovery was last attempted and last
 * succeeded, how it ended, when the last apply check succeeded, and what the
 * apply checks classified. It moves only timing and retry counts, never what
 * applies, so a file that cannot be read is replaced by an empty one and the
 * Updates card says so (`historyReset`); a missing file is an empty history.
 *
 * Discovery is due after a failed attempt (`partial`, `offline`, `error`)
 * once `lastAttemptAt` is an hour old, whatever `lastSuccessAt` says, and
 * after a success once `lastSuccessAt` is `updateCheckIntervalMs` old (never
 * by the interval when it is 0). The apply check is due 24 hours after the
 * last successful one, and a failed discovery holds it to the same hourly
 * retry, so a partial or offline apply check never runs back to back.
 */
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
/** A failed discovery is retried this long after its attempt (§18.7.1). */
const RETRY_AFTER_FAILURE_MS = HOUR_MS;
/** The owner's "once a day" for updates (§18.1). Not a setting. */
const APPLY_CHECK_INTERVAL_MS = 24 * HOUR_MS;

/** How a sync pass ended, before the scheduler adds `error` for a pass that threw. */
export interface SyncDiscovery {
  result: Exclude<UpdateDiscoveryResult, "error">;
  /** The sources that synced; a `partial` pass classifies only their updates. */
  reached: string[];
}

export interface DiscoveryRecord {
  lastAttemptAt: string;
  /** Null until a discovery has succeeded. */
  lastSuccessAt: string | null;
  result: UpdateDiscoveryResult;
}

export interface PackageUpdateRecord {
  to: string;
  state: UpdatePackageState;
  attempts: number;
  lastError?: { code: MarketplaceErrorCode; detail?: MarketplaceErrorDetail; at: string };
  appliedAt?: string;
}

export interface UpdateHistory {
  version: 1;
  discovery: DiscoveryRecord | null;
  applyCheckAt: string | null;
  /** Keyed by {@link updateRecordKey}. */
  packages: Record<string, PackageUpdateRecord>;
}

export function emptyUpdateHistory(): UpdateHistory {
  return { version: 1, discovery: null, applyCheckAt: null, packages: Object.create(null) as Record<string, PackageUpdateRecord> };
}

/** `<sourceId>:<kind>:<name>`, the key of `packages`. */
export function updateRecordKey(key: { sourceId: string; kind: PackageKind; name: string }): string {
  return `${key.sourceId}:${key.kind}:${key.name}`;
}

/** The source of a `packages` key; the key was checked when the file was read or written. */
export function updateRecordSource(recordKey: string): string {
  return recordKey.slice(0, recordKey.indexOf(":"));
}

const RESULTS = new Set<string>(["ok", "partial", "offline", "error"]);
const STATES = new Set<string>(UPDATE_PACKAGE_STATES);
const CODES = new Set<string>(MARKETPLACE_ERROR_CODES);
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
  const entry = object(value, what, ["to", "state", "attempts", "lastError", "appliedAt"]);
  if (typeof entry.to !== "string" || entry.to.length === 0) invalid(`${what}.to is not a version`);
  if (typeof entry.state !== "string" || !STATES.has(entry.state)) invalid(`${what}.state is not an update state`);
  if (typeof entry.attempts !== "number" || !Number.isInteger(entry.attempts) || entry.attempts < 0) invalid(`${what}.attempts is not a count`);
  const record: PackageUpdateRecord = { to: entry.to, state: entry.state as UpdatePackageState, attempts: entry.attempts };
  if (entry.lastError !== undefined) {
    const error = object(entry.lastError, `${what}.lastError`, ["code", "detail", "at"]);
    if (typeof error.code !== "string" || !CODES.has(error.code)) invalid(`${what}.lastError.code is not an error code`);
    const code = error.code as MarketplaceErrorCode;
    // As the source state does (§18.8): a detail that does not belong to its code is dropped, the code kept.
    const detail = error.detail === undefined ? undefined : parseMarketplaceErrorDetail(code, error.detail);
    record.lastError = { code, ...(detail ? { detail } : {}), at: time(error.at, `${what}.lastError.at`) };
  }
  if (entry.appliedAt !== undefined) record.appliedAt = time(entry.appliedAt, `${what}.appliedAt`);
  return record;
}

/** Parse the file's text; throws on anything but the version-1 shape. */
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

/**
 * What a load found. `reset`: the file existed but could not be read or
 * parsed, and `reason` says why; `history` is empty. The loader neither
 * writes nor logs: the scheduler says so and writes the empty history in the
 * file's place while it runs (so not after a stop).
 */
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

/** When discovery is next due, in epoch ms: `-Infinity` when it never ran, `Infinity` when only boot and *Check now* run it. */
export function discoveryDueAt(discovery: DiscoveryRecord | null, intervalMs: number): number {
  if (discovery === null) return Number.NEGATIVE_INFINITY;
  if (discovery.result !== "ok") return Date.parse(discovery.lastAttemptAt) + RETRY_AFTER_FAILURE_MS;
  if (intervalMs === 0) return Number.POSITIVE_INFINITY;
  return Date.parse(discovery.lastSuccessAt!) + intervalMs;
}

/** When the apply check is next due, in epoch ms; a failed discovery holds it to the hourly retry. */
export function applyCheckDueAt(history: Pick<UpdateHistory, "discovery" | "applyCheckAt">): number {
  const daily = history.applyCheckAt === null ? Number.NEGATIVE_INFINITY : Date.parse(history.applyCheckAt) + APPLY_CHECK_INTERVAL_MS;
  const retry = history.discovery !== null && history.discovery.result !== "ok"
    ? Date.parse(history.discovery.lastAttemptAt) + RETRY_AFTER_FAILURE_MS
    : Number.NEGATIVE_INFINITY;
  return Math.max(daily, retry);
}
