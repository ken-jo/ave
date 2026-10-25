/**
 * RoutinesStore v2 — persistent backing for the `routine_schedule` LLM tool.
 *
 * Persists routines to `~/.ave/routine/routines.json`. Mutations are serialized
 * by `withInProcessFileQueue`, which orders read-modify-write against other
 * writers IN THIS PROCESS only -- see its docstring. (The mirrored store this
 * comment used to name, `RemindersStore`, is not in the tree.) Concurrent add/dismiss operations
 * cannot corrupt the file.
 *
 * The store is intentionally pure — it does not own a timer. The
 * {@link RoutinesScheduler} (separate module) drives the polling loop and
 * fires execution events when a scheduled routine's next-fire time arrives.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidCronExpression } from "../routines/cron-evaluator.js";
import { readJsonFileOrEmpty, writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { createLogger } from "../lib/logger.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import { isStringArray } from "../shared/is-record.js";
import { isValidPluginId } from "../plugins/public-contract.js";
const log = createLogger("ave");

// Re-export from shared so callers that import from routines-store continue
// to work unchanged, while the renderer imports from shared/ (no Node built-ins).
export {
  MAX_PERSISTED_ROUTINES,
  MAX_LLM_SESSION_ROUTINES,
  MAX_ROUTINE_SOURCE_LENGTH,
  type RoutineExecution,
  type RoutineRepeat,
  type RoutineSchedule,
  type RoutineRecord,
  type AddRoutineInput,
} from "../shared/routines-types.js";

import type {
  InvalidRoutine,
  RoutineListResult,
  RoutineRecord,
  RoutineScope,
  AddRoutineInput,
} from "../shared/routines-types.js";
import { MAX_PERSISTED_ROUTINES, MAX_LLM_SESSION_ROUTINES, MAX_ROUTINE_SOURCE_LENGTH } from "../shared/routines-types.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";

/**
 * Routine validation bounds. The store validates every routine it persists;
 * the `routine_schedule` tool validates the same fields before it calls the
 * store, and imports these so the two cannot disagree about a limit.
 */

/** Maximum allowed distance into the future for schedule.at (parity with RemindersStore). */
export const MAX_FUTURE_OFFSET_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

/** Maximum cron expression length (prevents regex DoS). */
export const MAX_CRON_EXPR_LENGTH = 256;

/** Minimum interval in ms (1 minute — prevents sub-minute polling spam). */
export const MIN_INTERVAL_MS = 60_000;

/** The plugin-id-bearing fields of one stored routine, by field path. */
function storedRoutinePluginIds(record: Record<string, unknown>): Array<[string, unknown[]]> {
  const fields: Array<[string, unknown[]]> = [];
  const attention = record.needsAttention;
  if (attention && typeof attention === "object" && Array.isArray((attention as Record<string, unknown>).missingPluginIds)) {
    fields.push(["needsAttention.missingPluginIds", (attention as Record<string, unknown>).missingPluginIds as unknown[]]);
  }
  const scope = record.scope;
  if (scope && typeof scope === "object") {
    const { pluginIds, forcedPluginIds } = scope as Record<string, unknown>;
    if (pluginIds && typeof pluginIds === "object" && Array.isArray((pluginIds as Record<string, unknown>).ids)) {
      fields.push(["scope.pluginIds.ids", (pluginIds as Record<string, unknown>).ids as unknown[]]);
    }
    if (Array.isArray(forcedPluginIds)) fields.push(["scope.forcedPluginIds", forcedPluginIds]);
  }
  return fields;
}

/**
 * The first stored plugin id of `record` the plugin contract rejects, or
 * null. Such a routine was written by a build with a looser grammar: it is
 * held back (never run, never rewritten) and reported, not dropped, so one
 * legacy record cannot hide the others or vanish from disk.
 */
function invalidStoredRoutine(record: unknown): StoredInvalidRoutine | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const routine = record as Record<string, unknown>;
  for (const [field, ids] of storedRoutinePluginIds(routine)) {
    for (const id of ids) {
      if (typeof id === "string" && !isValidPluginId(id)) {
        return { id: String(routine.id), field, value: id, reason: "invalid-plugin-id", raw: record };
      }
    }
  }
  return null;
}
/**
 * Validate a record loaded from disk. Rejects tampered / corrupted entries
 * so a single bad record cannot infect the scheduler tick.
 */
function isValidRecord(r: unknown): r is RoutineRecord {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (typeof x.id !== "string" || x.id.length > 128) return false;
  if (x.trigger !== "schedule" && x.trigger !== "shutdown") return false;
  if (x.execution !== "llm-session" && x.execution !== "notification-only") return false;
  if (x.lastFiredMinuteUTC !== undefined && typeof x.lastFiredMinuteUTC !== "string") return false;
  if (x.lastFiredAt !== undefined && typeof x.lastFiredAt !== "string") return false;
  if (x.lastSkippedReason !== undefined && x.lastSkippedReason !== "plugins-missing") return false;
  if (x.lastSkippedMinuteUTC !== undefined && typeof x.lastSkippedMinuteUTC !== "string") return false;
  if (x.needsAttention !== undefined) {
    if (!x.needsAttention || typeof x.needsAttention !== "object" || Array.isArray(x.needsAttention)) return false;
    const ids = (x.needsAttention as Record<string, unknown>).missingPluginIds;
    if (!isStringArray(ids) || ids.length === 0 || ids.some((id) => !isValidPluginId(id))) return false;
  }
  if (x.lastResultAcknowledgedAt !== undefined && typeof x.lastResultAcknowledgedAt !== "string") return false;
  if (x.lastRoutineSessionId !== undefined && typeof x.lastRoutineSessionId !== "string") return false;
  if (x.dismissedAt !== undefined && typeof x.dismissedAt !== "string") return false;
  if (x.source !== undefined && (typeof x.source !== "string" || x.source.length > MAX_ROUTINE_SOURCE_LENGTH)) return false;
  if (x.scope !== undefined && !isValidRoutineScope(x.scope)) return false;
  return true;
}

function isValidRoutinePluginScope(value: unknown): value is RoutineScope["pluginIds"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope.mode === "deny-all" || scope.mode === "inherit") {
    return true;
  }
  return scope.mode === "allow" && isStringArray(scope.ids);
}

function isValidRoutineScope(value: unknown): value is RoutineScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    isValidRoutinePluginScope(scope.pluginIds) &&
    isStringArray(scope.forcedPluginIds) &&
    isStringArray(scope.directories)
  );
}

function isCanonicalRecord(r: unknown): r is RoutineRecord {
  if (!isValidRecord(r)) return false;
  if ("allowedPlugins" in r) {
    log.warn(
      "[routines-store] rejecting non-canonical routine record with allowedPlugins (id=%s)",
      r.id,
    );
    return false;
  }
  return true;
}

function validateScheduleAt(at: string): { ok: true } | { ok: false; error: string } {
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) return { ok: false, error: "invalid-date" };
  const offset = ts - Date.now();
  if (offset > MAX_FUTURE_OFFSET_MS) {
    return { ok: false, error: "future-too-far" };
  }
  // Past timestamps are allowed — past-due routines fire immediately on next poll.
  return { ok: true };
}

/** An invalid routine plus the exact stored value it is carried through writes with. */
interface StoredInvalidRoutine extends InvalidRoutine {
  readonly raw: unknown;
}

interface RoutinesFile {
  version: 2;
  routines: RoutineRecord[];
  /** Held-back records, written back unchanged after the valid ones. */
  invalid: StoredInvalidRoutine[];
}

// Consolidated under ~/.ave/routine/ namespace (single directory for all
// routine data). Resolved through the feature-namespace helper so the
// `~/.ave/<feature>/` location stays the single source of truth.
const defaultPath = (): string => join(openFeatureNamespace("routine").dir, "routines.json");

function workspaceRootKey(root: string): string | null {
  try {
    const key = caseFoldForMatch(canonicalizePathForMatch(root)).replace(/\/+$/g, "");
    return key || "/";
  } catch {
    return null;
  }
}

function isWorkspaceKeyAtOrBelow(rootKey: string, candidate: string): boolean {
  return candidate === rootKey || (rootKey === "/"
    ? candidate.startsWith("/")
    : candidate.startsWith(`${rootKey}/`));
}

function isDirectoryAtOrBelow(rootKey: string, directory: string): boolean {
  const candidate = workspaceRootKey(directory);
  if (!candidate) return false;
  return isWorkspaceKeyAtOrBelow(rootKey, candidate);
}

function emptyRoutinesFile(): RoutinesFile {
  return { version: 2, routines: [], invalid: [] };
}

function readFileOrEmpty(filePath: string): Promise<RoutinesFile> {
  return readJsonFileOrEmpty(filePath, emptyRoutinesFile, (parsed) => {
    const file = parsed as RoutinesFile;
    if (!Array.isArray(file.routines)) return emptyRoutinesFile();
    const routines: RoutineRecord[] = [];
    const invalid: StoredInvalidRoutine[] = [];
    for (const record of file.routines as unknown[]) {
      const held = invalidStoredRoutine(record);
      if (held) invalid.push(held);
      // Filter out tampered/corrupted or non-canonical records so a single bad
      // entry cannot cause the scheduler tick to throw and stall all routines.
      else if (isCanonicalRecord(record)) routines.push(record);
    }
    return { version: 2, routines, invalid };
  });
}

async function writeFileAtomic(filePath: string, data: RoutinesFile): Promise<void> {
  // Delegates the 0o700-dir / 0o600-file / tmpfile+rename contract to the
  // feature-namespace SOT helper. The injectable `filePath` (tests pass a
  // temp path) is preserved — the helper enforces the permission boundary on
  // whatever parent directory the path resolves to.
  const stored = { version: data.version, routines: [...data.routines, ...data.invalid.map((held) => held.raw)] };
  await writeFileAtomicAtPath(filePath, `${JSON.stringify(stored, null, 2)}\n`);
}

/** Deep clone a RoutineRecord to prevent callers from mutating shared cache refs. */
function cloneRecord(r: RoutineRecord): RoutineRecord {
  return {
    ...r,
    needsAttention: r.needsAttention
      ? { missingPluginIds: [...r.needsAttention.missingPluginIds] }
      : undefined,
    schedule: r.schedule
      ? {
          ...r.schedule,
          repeat: r.schedule.repeat ? { ...r.schedule.repeat } : undefined,
        }
      : undefined,
    scope: r.scope
      ? {
          pluginIds:
            r.scope.pluginIds.mode === "allow"
              ? { mode: "allow", ids: [...r.scope.pluginIds.ids] }
              : { ...r.scope.pluginIds },
          forcedPluginIds: [...r.scope.forcedPluginIds],
          directories: [...r.scope.directories],
        }
      : undefined,
  };
}

export class RoutinesStore {
  private cache: RoutineRecord[] = [];
  private invalidCache: StoredInvalidRoutine[] = [];
  private loaded = false;
  private readonly filePath: string;

  constructor(filePath: string = defaultPath()) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const file = await readFileOrEmpty(this.filePath);
    this.cache = file.routines;
    this.invalidCache = file.invalid;
    for (const held of file.invalid) {
      log.warn(
        "[routines-store] holding back routine %s: %s %s is not a valid plugin id",
        held.id,
        held.field,
        JSON.stringify(held.value),
      );
    }
    this.loaded = true;
  }

  list(): RoutineRecord[] {
    // M5: deep clone to prevent callers from mutating shared cache refs
    return this.cache.map(cloneRecord);
  }

  /** Active routines = not dismissed. */
  listActive(): RoutineRecord[] {
    return this.cache.filter((r) => !r.dismissedAt).map(cloneRecord);
  }

  /** Stored routines held back because they name a plugin id the contract rejects. */
  listInvalid(): InvalidRoutine[] {
    return this.invalidCache.map(({ id, field, value, reason }) => ({ id, field, value, reason }));
  }

  /** What the routine list shows: the active routines and the invalid ones to repair. */
  listForDisplay(): RoutineListResult {
    return { routines: this.listActive(), invalid: this.listInvalid() };
  }

  async add(input: AddRoutineInput): Promise<RoutineRecord> {
    if (!this.loaded) await this.load();

    // Validate and normalize `at` to canonical ISO string when provided.
    let normalizedAt: string | undefined;
    if (input.schedule?.at !== undefined) {
      const validation = validateScheduleAt(input.schedule.at);
      if (!validation.ok) {
        throw new Error(
          `RoutinesStore.add: invalid schedule.at (${validation.error}): ${input.schedule.at}`,
        );
      }
      normalizedAt = new Date(input.schedule.at).toISOString();
    }

    // Validate that non-cron repeats always have schedule.at.
    // Without it, RoutinesScheduler.isDue() can never match and the routine
    // silently never fires — a hard error is strictly better than silent failure.
    if (input.schedule?.repeat) {
      const kind = input.schedule.repeat.kind;
      if (kind !== "cron" && !input.schedule.at) {
        throw new Error(
          `RoutinesStore.add: schedule.at is required for repeat.kind="${kind}" (non-cron repeats fire on a fixed instant)`,
        );
      }
    }

    // Validate cron expression when repeat.kind === 'cron'.
    if (input.schedule?.repeat?.kind === "cron") {
      const expr = (input.schedule.repeat as { kind: "cron"; expression: string }).expression;
      if (typeof expr !== "string" || expr.length > MAX_CRON_EXPR_LENGTH) {
        throw new Error(
          `RoutinesStore.add: cron expression too long or invalid type (max ${MAX_CRON_EXPR_LENGTH} chars)`,
        );
      }
      if (!expr.trim() || !isValidCronExpression(expr)) {
        throw new Error(
          `RoutinesStore.add: invalid cron expression: ${String(expr)}`,
        );
      }
    }

    // Validate intervalMs bounds when repeat.kind === 'interval'.
    if (input.schedule?.repeat?.kind === "interval") {
      const intervalMs = (input.schedule.repeat as { kind: "interval"; intervalMs: number }).intervalMs;
      if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_FUTURE_OFFSET_MS) {
        throw new Error(
          `RoutinesStore.add: intervalMs out of range (min ${MIN_INTERVAL_MS}ms, max ${MAX_FUTURE_OFFSET_MS}ms): ${String(intervalMs)}`,
        );
      }
    }

    // Validate execution-mode-specific required fields.
    if (input.execution === "llm-session") {
      if (!input.prePrompt || input.prePrompt.trim().length === 0) {
        throw new Error(
          "RoutinesStore.add: prePrompt is required and must be non-empty for execution='llm-session'",
        );
      }
    }
    if (input.execution === "notification-only") {
      if (!input.notificationTitle || input.notificationTitle.trim().length === 0) {
        throw new Error(
          "RoutinesStore.add: notificationTitle is required and must be non-empty for execution='notification-only'",
        );
      }
    }

    // Idempotency identity — validate the optional `source` marker length cap
    // (SOT). Empty/whitespace-only collapses to unset so it never matches a
    // real suggestion marker in hasRoutineBySource.
    let normalizedSource: string | undefined;
    if (input.source !== undefined) {
      if (typeof input.source !== "string" || input.source.length > MAX_ROUTINE_SOURCE_LENGTH) {
        throw new Error(
          `RoutinesStore.add: source must be a string of at most ${MAX_ROUTINE_SOURCE_LENGTH} characters`,
        );
      }
      const trimmedSource = input.source.trim();
      normalizedSource = trimmedSource.length > 0 ? trimmedSource : undefined;
    }
    // Permission policy Layer 4 — `scope` is the canonical shape. When omitted, default
    // to deny-all so new call sites cannot accidentally expose plugins.
    const inputScope = input.scope;
    let normalizedPluginIds: RoutineScope["pluginIds"] =
      inputScope?.pluginIds ?? { mode: "deny-all" };
    let normalizedForcedPluginIds: string[] = [];

    if (inputScope?.pluginIds.mode === "allow") {
      const trimmed = inputScope.pluginIds.ids.map((p) => p.trim()).filter(Boolean);
      if (trimmed.some((p) => !isValidPluginId(p))) {
        throw new Error(
          "RoutinesStore.add: scope.pluginIds.ids entries must be valid plugin ids",
        );
      }
      normalizedPluginIds = { mode: "allow", ids: [...new Set(trimmed)] };
    }
    if (inputScope?.forcedPluginIds) {
      const trimmedForced = inputScope.forcedPluginIds.map((p) => p.trim()).filter(Boolean);
      if (trimmedForced.some((p) => !isValidPluginId(p))) {
        throw new Error(
          "RoutinesStore.add: scope.forcedPluginIds entries must be valid plugin ids",
        );
      }
      normalizedForcedPluginIds = [...new Set(trimmedForced)];
    }
    const normalizedScope: RoutineScope = {
      pluginIds: normalizedPluginIds,
      forcedPluginIds: normalizedForcedPluginIds,
      directories: inputScope?.directories ? [...inputScope.directories] : [],
    };

    // Build schedule with normalized `at`.
    const normalizedSchedule: typeof input.schedule = input.schedule
      ? {
          ...input.schedule,
          ...(normalizedAt !== undefined ? { at: normalizedAt } : {}),
        }
      : undefined;

    const record: RoutineRecord = {
      id: randomUUID(),
      trigger: input.trigger,
      schedule: normalizedSchedule,
      execution: input.execution,
      prePrompt: input.prePrompt,
      title: input.title,
      notificationTitle: input.notificationTitle,
      notificationBody: input.notificationBody,
      scope: normalizedScope,
      createdAt: new Date().toISOString(),
      ...(normalizedSource !== undefined ? { source: normalizedSource } : {}),
    };

    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      // llm-session sub-cap check (before total cap to give a specific error).
      if (record.execution === "llm-session") {
        const llmCount = file.routines.filter(
          (r) => r.execution === "llm-session" && !r.dismissedAt,
        ).length;
        if (llmCount >= MAX_LLM_SESSION_ROUTINES) {
          throw new Error(
            `RoutinesStore.add: LLM session routine cap reached (${MAX_LLM_SESSION_ROUTINES}); dismiss/remove old LLM routines first`,
          );
        }
      }
      if (file.routines.length >= MAX_PERSISTED_ROUTINES) {
        throw new Error(
          `RoutinesStore.add: routine cap reached (${MAX_PERSISTED_ROUTINES}); dismiss/remove old routines first`,
        );
      }
      file.routines.push(record);
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return record;
    });
  }

  async dismiss(id: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      if (!r) {
        this.cache = file.routines;
      this.invalidCache = file.invalid;
        return false;
      }
      r.dismissedAt = new Date().toISOString();
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return true;
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const before = file.routines.length + file.invalid.length;
      file.routines = file.routines.filter((r) => r.id !== id);
      file.invalid = file.invalid.filter((held) => held.id !== id);
      const removed = file.routines.length + file.invalid.length !== before;
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return removed;
    });
  }

  /**
   * Permanently remove a deleted workspace root from every persisted routine
   * scope. The whole read/mutate/write transaction shares the store file lock,
   * so a concurrent routine mutation cannot resurrect a stale directory.
   */
  async revokeWorkspaceRoot(
    root: string,
    options?: { preserveRoots?: readonly string[] },
  ): Promise<{
    routinesUpdated: number;
    directoriesRemoved: number;
  }> {
    if (!this.loaded) await this.load();
    const rootKey = workspaceRootKey(root);
    if (!rootKey) return { routinesUpdated: 0, directoriesRemoved: 0 };
    const preservedRootKeys = (options?.preserveRoots ?? [])
      .map(workspaceRootKey)
      .filter((key): key is string =>
        key !== null
        && key !== rootKey
        && isWorkspaceKeyAtOrBelow(rootKey, key),
      );
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      let routinesUpdated = 0;
      let directoriesRemoved = 0;
      for (const routine of file.routines) {
        if (!routine.scope) continue;
        const retained = routine.scope.directories.filter(
          (directory) => {
            if (!isDirectoryAtOrBelow(rootKey, directory)) return true;
            return preservedRootKeys.some(
              (preservedRootKey) => isDirectoryAtOrBelow(preservedRootKey, directory),
            );
          },
        );
        const removed = routine.scope.directories.length - retained.length;
        if (removed === 0) continue;
        routine.scope.directories = retained;
        routinesUpdated += 1;
        directoriesRemoved += removed;
      }
      if (directoriesRemoved > 0) {
        await writeFileAtomic(this.filePath, file);
      }
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return { routinesUpdated, directoriesRemoved };
    });
  }

  /**
   * Patch a subset of mutable fields on a routine record.
   * Only the fields present in `patch` are written; undefined values are ignored.
   * Returns the updated record, or null if not found.
   */
  async update(
    id: string,
    patch: Partial<Pick<RoutineRecord, "lastFiredMinuteUTC" | "lastFiredAt" | "lastResultAcknowledgedAt" | "lastRoutineSessionId" | "dismissedAt">>,
  ): Promise<RoutineRecord | null> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      if (!r) {
        this.cache = file.routines;
      this.invalidCache = file.invalid;
        return null;
      }
      if (patch.lastFiredMinuteUTC !== undefined) r.lastFiredMinuteUTC = patch.lastFiredMinuteUTC;
      if (patch.lastFiredAt !== undefined) r.lastFiredAt = patch.lastFiredAt;
      if (patch.lastResultAcknowledgedAt !== undefined) r.lastResultAcknowledgedAt = patch.lastResultAcknowledgedAt;
      if (patch.lastRoutineSessionId !== undefined) r.lastRoutineSessionId = patch.lastRoutineSessionId;
      if (patch.dismissedAt !== undefined) r.dismissedAt = patch.dismissedAt;
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return r;
    });
  }

  /**
   * Mark a routine as fired. Completed one-shots without attention are dismissed.
   * For repeating routines, advances the next-fire time using the cron evaluator.
   * Returns the updated record.
   */
  async markFired(id: string, missingPluginIds: string[] = []): Promise<RoutineRecord | null> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      if (!r) {
        this.cache = file.routines;
      this.invalidCache = file.invalid;
        return null;
      }
      const firedAt = new Date().toISOString();
      r.lastFiredAt = firedAt;
      delete r.lastSkippedReason;
      delete r.lastSkippedMinuteUTC;
      if (missingPluginIds.length > 0) r.needsAttention = { missingPluginIds: [...missingPluginIds] };
      else delete r.needsAttention;
      delete r.lastRoutineSessionId;
      const repeat = r.schedule?.repeat;
      if (!repeat || repeat.kind === "none") {
        // A partial run stays visible for review and removal, but is not due again.
        if (missingPluginIds.length === 0) r.dismissedAt = firedAt;
      } else advanceRepeatingSchedule(r, firedAt);
      // cron routines: next-fire is re-computed by the scheduler each tick —
      // no need to advance `at` here.
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return r;
    });
  }

  /** Keep a skipped routine visible without creating a result or consuming a one-shot. */
  async markPluginsMissing(id: string, missingPluginIds: string[], minuteUTC?: string): Promise<void> {
    if (!this.loaded) await this.load();
    await withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((record) => record.id === id && !record.dismissedAt);
      if (!r) return;
      const previous = JSON.stringify(r);
      r.lastSkippedReason = "plugins-missing";
      r.needsAttention = { missingPluginIds: [...missingPluginIds] };
      if (minuteUTC !== undefined) r.lastSkippedMinuteUTC = minuteUTC;
      advanceRepeatingSchedule(r, new Date().toISOString());
      if (JSON.stringify(r) !== previous) await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
    });
  }
}

// ─── Next-fire helpers ────────────────────────────────────────────────────────

function advanceRepeatingSchedule(routine: RoutineRecord, now: string): void {
  const schedule = routine.schedule;
  if (!schedule) return;
  const at = schedule.at ?? now;
  switch (schedule.repeat?.kind) {
    case "daily": schedule.at = advanceDaily(at); break;
    case "weekly": schedule.at = advanceWeekly(at); break;
    case "monthly": schedule.at = advanceMonthly(at); break;
    case "interval": schedule.at = advanceInterval(at, schedule.repeat.intervalMs); break;
  }
}

function advanceDaily(atIso: string): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  if (d.getTime() <= nowMs) {
    const intervalMs = 24 * 60 * 60 * 1000;
    const elapsed = nowMs - d.getTime();
    const skips = Math.floor(elapsed / intervalMs) + 1;
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}

function advanceWeekly(atIso: string): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  if (d.getTime() <= nowMs) {
    const intervalMs = 7 * 24 * 60 * 60 * 1000;
    const elapsed = nowMs - d.getTime();
    const skips = Math.floor(elapsed / intervalMs) + 1;
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}

/**
 * Advance by one calendar month, clamping to the last day of the target month
 * so 31-day routines don't skip February.
 *
 * originalDay is captured once before the loop so that multi-month advances
 * (e.g. Jan 31 skipped while app was offline) correctly restore the original
 * day each month rather than drifting toward 28 after a Feb clamp.
 */
function advanceMonthly(atIso: string): string {
  const d = new Date(atIso);
  const originalDay = d.getUTCDate(); // capture once — never re-read from d
  const nowMs = Date.now();
  while (d.getTime() <= nowMs) {
    // Set day=1 first to avoid month-overflow when current day > target-month days.
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    // Clamp to last day of the new month, then restore originalDay.
    const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, maxDay));
  }
  return d.toISOString();
}

function advanceInterval(atIso: string, intervalMs: number): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  if (intervalMs <= 0) return d.toISOString();
  if (d.getTime() <= nowMs) {
    const elapsed = nowMs - d.getTime();
    const skips = Math.floor(elapsed / intervalMs) + 1;
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}
