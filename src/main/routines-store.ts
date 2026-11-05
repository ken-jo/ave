// Serialize read-modify-write operations within this process only; the scheduler owns timers and dispatch.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidCronExpression } from "../routines/cron-evaluator.js";
import { readJsonFileOrEmpty, writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { createLogger } from "../lib/logger.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import { isStringArray } from "../shared/is-record.js";
import { isValidPluginId } from "../plugins/public-contract.js";
import { advanceRepeatAt, isMissedWhilePaused, isRoutineScheduleShape, scheduleIdentity } from "../routines/schedule-advance.js";
import { projectRootEquals } from "../shared/project-identity.js";
import { isValidSessionId } from "../shared/session-id.js";
const log = createLogger("ave");

// Re-export from shared so callers that import from routines-store continue to work unchanged, while the renderer imports from shared/ (no Node built-ins).
export {
  MAX_PERSISTED_ROUTINES,
  MAX_LLM_SESSION_ROUTINES,
  MAX_ROUTINE_SOURCE_LENGTH,
  MAX_ROUTINE_FAILURE_REASON_LENGTH,
  type RoutineExecution,
  type RoutineRepeat,
  type RoutineSchedule,
  type RoutineRecord,
  type AddRoutineInput,
} from "../shared/routines-types.js";

import { MAX_ROUTINE_FAILURE_REASON_LENGTH } from "../shared/routines-types.js";
import { maskSensitiveData } from "../shared/dlp.js";
import { redactHomePathsInText } from "../audit/dlp-filter.js";
import type {
  RoutineActor,
  RoutineEditPatch,
  RoutineSchedule,
  RoutineFailure,
  RoutineRunOutcome,
  InvalidRoutine,
  RoutineListResult,
  RoutineRecord,
  RoutineScope,
  AddRoutineInput,
} from "../shared/routines-types.js";
import { MAX_PERSISTED_ROUTINES, MAX_LLM_SESSION_ROUTINES, MAX_ROUTINE_SOURCE_LENGTH } from "../shared/routines-types.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { ChangeSignal } from "../lib/change-signal.js";
import type { MemoryManager } from "../memory/memory-manager.js";

// Routine validation bounds. The store validates every routine it persists; the `routine_schedule` tool validates the same fields before it calls the
// store, and imports these so the two cannot disagree about a limit.

// Maximum allowed distance into the future for schedule.at (parity with RemindersStore).
export const MAX_FUTURE_OFFSET_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

// Maximum cron expression length (prevents regex DoS).
export const MAX_CRON_EXPR_LENGTH = 256;

// Minimum interval in ms (1 minute — prevents sub-minute polling spam).
export const MIN_INTERVAL_MS = 60_000;

// Same bound as session metadata's projectRoot.
const MAX_PROJECT_ROOT_LENGTH = 2_048;

function isActor(value: unknown): value is RoutineActor {
  return value === "user" || value === "agent";
}

export function isRoutineTrigger(value: unknown): value is RoutineRecord["trigger"] {
  return value === "schedule" || value === "shutdown";
}

export function isRoutineExecution(value: unknown): value is RoutineRecord["execution"] {
  return value === "llm-session" || value === "notification-only";
}

// The plugin-id-bearing fields of one stored routine, by field path.
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

// The first stored plugin id of `record` the plugin contract rejects, or null. Such a routine was written by a build with a looser grammar: it is held
// back (never run, never rewritten) and reported, not dropped, so one legacy record cannot hide the others or vanish from disk.
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
// Validate a record loaded from disk. Rejects tampered / corrupted entries so a single bad record cannot infect the scheduler tick.
function isValidRecord(r: unknown): r is RoutineRecord {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (typeof x.id !== "string" || x.id.length > 128) return false;
  if (!isRoutineTrigger(x.trigger) || !isRoutineExecution(x.execution)) return false;
  if (x.lastFiredMinuteUTC !== undefined && typeof x.lastFiredMinuteUTC !== "string") return false;
  if (x.lastFiredAt !== undefined && typeof x.lastFiredAt !== "string") return false;
  if (x.lastSkippedReason !== undefined && x.lastSkippedReason !== "plugins-missing" && x.lastSkippedReason !== "chat-busy") return false;
  if (x.lastSkippedMinuteUTC !== undefined && typeof x.lastSkippedMinuteUTC !== "string") return false;
  if (x.needsAttention !== undefined) {
    if (!x.needsAttention || typeof x.needsAttention !== "object" || Array.isArray(x.needsAttention)) return false;
    const ids = (x.needsAttention as Record<string, unknown>).missingPluginIds;
    if (!isStringArray(ids) || ids.length === 0 || ids.some((id) => !isValidPluginId(id))) return false;
  }
  if (x.lastResultAcknowledgedAt !== undefined && typeof x.lastResultAcknowledgedAt !== "string") return false;
  if (x.lastRoutineSessionId !== undefined && typeof x.lastRoutineSessionId !== "string") return false;
  if (x.lastFailure !== undefined && !isValidRoutineFailure(x.lastFailure)) return false;
  if (x.dismissedAt !== undefined && typeof x.dismissedAt !== "string") return false;
  if (x.source !== undefined && (typeof x.source !== "string" || x.source.length > MAX_ROUTINE_SOURCE_LENGTH)) return false;
  if (x.scope !== undefined && !isValidRoutineScope(x.scope)) return false;
  if (x.projectRoot !== undefined && (typeof x.projectRoot !== "string" || x.projectRoot.length === 0 || x.projectRoot.length > MAX_PROJECT_ROOT_LENGTH)) return false;
  if (x.createdBy !== undefined && !isActor(x.createdBy)) return false;
  if (x.pausedAt !== undefined && typeof x.pausedAt !== "string") return false;
  if ((x.pausedAt === undefined) !== (x.pausedBy === undefined) || (x.pausedBy !== undefined && !isActor(x.pausedBy))) return false;
  if (x.resumedAt !== undefined && typeof x.resumedAt !== "string") return false;
  for (const field of ["title", "prePrompt", "notificationTitle", "notificationBody"] as const) {
    if (x[field] !== undefined && typeof x[field] !== "string") return false;
  }
  if (x.schedule !== undefined && !isRoutineScheduleShape(x.schedule)) return false;
  if (x.targetSessionId !== undefined && !canConnect(x.targetSessionId, x.trigger, x.execution)) return false;
  if (x.orphanedAt !== undefined && (typeof x.orphanedAt !== "string" || x.targetSessionId === undefined)) return false;
  return true;
}

// Only an LLM item on a schedule can enter a chat: a notification has no turn, and a quit-time run has no one to read it.
function canConnect(targetSessionId: unknown, trigger: unknown, execution: unknown): boolean {
  return isValidSessionId(targetSessionId) && trigger === "schedule" && execution === "llm-session";
}

function isValidRoutineFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  const kindValid = failure.kind === "shutdown-timeout"
    ? failure.reason === undefined
    : failure.kind === "error"
      && typeof failure.reason === "string"
      && failure.reason.length <= MAX_ROUTINE_FAILURE_REASON_LENGTH;
  return kindValid
    && typeof failure.firedAt === "string"
    && typeof failure.at === "string"
    && (failure.acknowledgedAt === undefined || typeof failure.acknowledgedAt === "string");
}

/** Error text from a run is stored and broadcast: mask secrets and PII and redact home paths first, then bound it. */
export function sanitizeRoutineFailureReason(raw: string): string {
  return redactHomePathsInText(maskSensitiveData(raw).masked).slice(0, MAX_ROUTINE_FAILURE_REASON_LENGTH);
}

// lastFailure is a derived attention field. An unreadable one is dropped with a warning so the user's routine itself still loads.
function repairStoredFailure(record: unknown): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const routine = record as Record<string, unknown>;
  if (routine.lastFailure === undefined || isValidRoutineFailure(routine.lastFailure)) return;
  log.warn("[routines-store] dropping an unreadable lastFailure on routine %s; the routine itself is kept", String(routine.id));
  delete routine.lastFailure;
}

function isValidRoutinePluginScope(value: unknown): value is RoutineScope["pluginIds"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope.mode === "deny-all" || scope.mode === "inherit") {
    return true;
  }
  return scope.mode === "allow" && isStringArray(scope.ids);
}

export function isValidRoutineScope(value: unknown): value is RoutineScope {
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

// An invalid routine plus the exact stored value it is carried through writes with.
interface StoredInvalidRoutine extends InvalidRoutine {
  readonly raw: unknown;
}

interface RoutinesFile {
  version: 2;
  routines: RoutineRecord[];
  // Held-back records, written back unchanged after the valid ones.
  invalid: StoredInvalidRoutine[];
}

// Consolidated under ~/.ave/routine/ namespace (single directory for all routine data). Resolved through the feature-namespace helper so the
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
      repairStoredFailure(record);
      const held = invalidStoredRoutine(record);
      if (held) invalid.push(held);
      // Filter out tampered/corrupted or non-canonical records so a single bad entry cannot cause the scheduler tick to throw and stall all routines.
      else if (isCanonicalRecord(record)) routines.push(record);
    }
    return { version: 2, routines, invalid };
  });
}

async function writeFileAtomic(filePath: string, data: RoutinesFile): Promise<void> {
  // Delegates the 0o700-dir / 0o600-file / tmpfile+rename contract to the feature-namespace SOT helper. The injectable `filePath` (tests pass a temp path)
  // is preserved — the helper enforces the permission boundary on whatever parent directory the path resolves to.
  const stored = { version: data.version, routines: [...data.routines, ...data.invalid.map((held) => held.raw)] };
  await writeFileAtomicAtPath(filePath, `${JSON.stringify(stored, null, 2)}\n`);
}

// Deep clone a RoutineRecord to prevent callers from mutating shared cache refs.
function cloneRecord(r: RoutineRecord): RoutineRecord {
  return {
    ...r,
    needsAttention: r.needsAttention
      ? { missingPluginIds: [...r.needsAttention.missingPluginIds] }
      : undefined,
    lastFailure: r.lastFailure ? { ...r.lastFailure } : undefined,
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

/** The scope directories a routine keeps once `root` is removed, sparing separately registered descendant roots; null for an unreadable root. */
function routineScopeRetention(
  root: string,
  preserveRoots: readonly string[] = [],
): ((directories: readonly string[]) => string[]) | null {
  const rootKey = workspaceRootKey(root);
  if (!rootKey) return null;
  const preservedRootKeys = preserveRoots
    .map(workspaceRootKey)
    .filter((key): key is string =>
      key !== null
      && key !== rootKey
      && isWorkspaceKeyAtOrBelow(rootKey, key),
    );
  return (directories) => directories.filter((directory) => {
    if (!isDirectoryAtOrBelow(rootKey, directory)) return true;
    return preservedRootKeys.some(
      (preservedRootKey) => isDirectoryAtOrBelow(preservedRootKey, directory),
    );
  });
}

export class RoutinesStore {
  private cache: RoutineRecord[] = [];
  private invalidCache: StoredInvalidRoutine[] = [];
  private loaded = false;
  private readonly filePath: string;

  // Fires after every successful write so projections (the work-approvals list) re-read instead of polling.
  readonly changed = new ChangeSignal((err) => log.warn("[routines-store] change listener threw: %s", (err as Error).message));

  constructor(filePath: string = defaultPath()) {
    this.filePath = filePath;
  }

  // The cache is refreshed before the signal so a listener that re-reads synchronously sees the write.
  private async persist(file: RoutinesFile): Promise<void> {
    await writeFileAtomic(this.filePath, file);
    this.cache = file.routines;
    this.invalidCache = file.invalid;
    this.changed.emit();
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

  // With a project, only that project's items and the unscoped ones stored before projects existed. The filter is for display only;
  // it is not an authorization boundary.
  list(filter?: { projectRoot?: string }): RoutineRecord[] {
    // Clone deeply so callers cannot mutate the cached state.
    return this.cache.filter((r) => inProject(r, filter?.projectRoot)).map(cloneRecord);
  }

  // Active routines = not dismissed.
  listActive(filter?: { projectRoot?: string }): RoutineRecord[] {
    return this.cache.filter((r) => !r.dismissedAt && inProject(r, filter?.projectRoot)).map(cloneRecord);
  }

  // Stored routines held back because they name a plugin id the contract rejects.
  listInvalid(): InvalidRoutine[] {
    return this.invalidCache.map(({ id, field, value, reason }) => ({ id, field, value, reason }));
  }

  // What the routine list shows: the active routines and the invalid ones to repair.
  listForDisplay(filter?: { projectRoot?: string }): RoutineListResult {
    return { routines: this.listActive(filter), invalid: this.listInvalid() };
  }

  async add(input: AddRoutineInput): Promise<RoutineRecord> {
    if (!this.loaded) await this.load();

    // An unknown trigger or execution would be dropped as a bad record on the next read, so refuse it here.
    if (!isRoutineTrigger(input.trigger)) throw new Error(`RoutinesStore.add: trigger must be 'schedule' or 'shutdown': ${String(input.trigger)}`);
    if (!isRoutineExecution(input.execution)) {
      throw new Error(`RoutinesStore.add: execution must be 'llm-session' or 'notification-only': ${String(input.execution)}`);
    }
    const normalizedSchedule = validateRoutineContent("add", input);
    if (input.targetSessionId !== undefined && !canConnect(input.targetSessionId, input.trigger, input.execution)) {
      throw new Error("RoutinesStore.add: targetSessionId must be a valid chat id on a scheduled llm-session item");
    }
    const normalizedProjectRoot = typeof input.projectRoot === "string" ? input.projectRoot.trim() : "";
    if (!normalizedProjectRoot || normalizedProjectRoot.length > MAX_PROJECT_ROOT_LENGTH) {
      throw new Error(`RoutinesStore.add: projectRoot is required (a non-empty string of at most ${MAX_PROJECT_ROOT_LENGTH} characters)`);
    }
    if (!isActor(input.createdBy)) {
      throw new Error("RoutinesStore.add: createdBy is required and must be 'user' or 'agent'");
    }

    // Idempotency identity — validate the optional `source` marker length cap (SOT). Empty/whitespace-only collapses to unset so it never matches a real
    // suggestion marker in hasRoutineBySource.
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
    // Permission policy Layer 4 — `scope` is the canonical shape. When omitted, default to deny-all so new call sites cannot accidentally expose plugins.
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
      projectRoot: normalizedProjectRoot,
      createdBy: input.createdBy,
      ...(input.targetSessionId !== undefined ? { targetSessionId: input.targetSessionId } : {}),
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
      await this.persist(file);
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
      await this.persist(file);
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
      await this.persist(file);
      return removed;
    });
  }

  // Permanently remove a deleted workspace root from every persisted routine scope. The whole read/mutate/write transaction shares the store file lock, so
  // a concurrent routine mutation cannot resurrect a stale directory.
  async revokeWorkspaceRoot(
    root: string,
    options?: { preserveRoots?: readonly string[] },
  ): Promise<{
    routinesUpdated: number;
    directoriesRemoved: number;
  }> {
    if (!this.loaded) await this.load();
    const retainedOf = routineScopeRetention(root, options?.preserveRoots);
    if (!retainedOf) return { routinesUpdated: 0, directoriesRemoved: 0 };
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      let routinesUpdated = 0;
      let directoriesRemoved = 0;
      for (const routine of file.routines) {
        if (!routine.scope) continue;
        const retained = retainedOf(routine.scope.directories);
        const removed = routine.scope.directories.length - retained.length;
        if (removed === 0) continue;
        routine.scope.directories = retained;
        routinesUpdated += 1;
        directoriesRemoved += removed;
      }
      if (directoriesRemoved > 0) {
        await this.persist(file);
      }
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      return { routinesUpdated, directoriesRemoved };
    });
  }

  // The removal preview: how many routines `revokeWorkspaceRoot` would narrow now, by the same predicate, writing nothing.
  async countRoutinesScopedToWorkspaceRoot(
    root: string,
    options?: { preserveRoots?: readonly string[] },
  ): Promise<number> {
    if (!this.loaded) await this.load();
    const retainedOf = routineScopeRetention(root, options?.preserveRoots);
    if (!retainedOf) return 0;
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      return file.routines.filter((routine) =>
        routine.scope ? retainedOf(routine.scope.directories).length !== routine.scope.directories.length : false,
      ).length;
    });
  }

  // Patch a subset of mutable fields on a routine record. Only the fields present in `patch` are written; undefined values are ignored. Returns the
  // updated record, or null if not found.
  async update(
    id: string,
    patch: Partial<Pick<RoutineRecord, "lastFiredMinuteUTC" | "lastFiredAt" | "lastRoutineSessionId" | "dismissedAt">>,
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
      if (patch.lastRoutineSessionId !== undefined) r.lastRoutineSessionId = patch.lastRoutineSessionId;
      if (patch.dismissedAt !== undefined) r.dismissedAt = patch.dismissedAt;
      await this.persist(file);
      return r;
    });
  }

  // The user saw the result of the fire at `firedAt`. Only the current fire can be acknowledged: an acknowledgement for an older fire
  // would mark a newer result or failure seen that the user never saw, so it changes nothing.
  async acknowledgeResult(id: string, firedAt: string): Promise<RoutineRecord | null> {
    return this.mutate(id, (r) => {
      if (r.lastFiredAt !== firedAt) return false;
      r.lastResultAcknowledgedAt = firedAt;
      if (r.lastFailure && r.lastFailure.firedAt === firedAt && !r.lastFailure.acknowledgedAt) {
        r.lastFailure.acknowledgedAt = new Date().toISOString();
      }
      return true;
    });
  }

  // The user acknowledged the failure of the fire at `failureFiredAt` from 확인 필요. Only that failure is cleared: when a newer fire has
  // failed (or a success cleared it) since the user saw the card, the acknowledgement is stale and changes nothing.
  async acknowledgeFailure(id: string, failureFiredAt: string): Promise<"acknowledged" | "stale" | "not-found"> {
    let stale = false;
    const updated = await this.mutate(id, (r) => {
      if (r.lastFailure?.firedAt !== failureFiredAt) {
        stale = true;
        return false;
      }
      delete r.lastFailure;
      return true;
    });
    if (!updated) return "not-found";
    return stale ? "stale" : "acknowledged";
  }

  // Record how the run of the fire at `firedAt` ended. Runs overlap (dispatch does not await, and a manual trigger can start during a
  // scheduled run), so an outcome for anything but the current fire is stale and changes nothing: it must not clear or overwrite the newer
  // fire's state. Success clears the failure. A failed scheduled one-shot was dismissed by markFired; it is restored so the failure stays
  // reviewable, and it is not due again because lastFiredAt is set. Shutdown routines are not restored: they would run again at every quit.
  async recordRunOutcome(id: string, firedAt: string, outcome: RoutineRunOutcome): Promise<RoutineRecord | null> {
    return this.mutate(id, (r) => {
      if (r.lastFiredAt !== firedAt) return false;
      if (outcome.ok) {
        if (r.lastFailure === undefined) return false;
        delete r.lastFailure;
        return true;
      }
      const at = new Date().toISOString();
      const failure: RoutineFailure = outcome.kind === "error"
        ? { kind: "error", firedAt, at, reason: sanitizeRoutineFailureReason(outcome.reason) }
        : { kind: "shutdown-timeout", firedAt, at };
      r.lastFailure = failure;
      const repeat = r.schedule?.repeat;
      if (r.trigger === "schedule" && (!repeat || repeat.kind === "none") && r.dismissedAt === r.lastFiredAt) delete r.dismissedAt;
      return true;
    });
  }

  // The fire at `firedAt` did not run because its connected chat was busy. A one-shot stays listed as skipped instead of done; it is not
  // fired again by itself. A later fire is left as it is; null when the item is gone.
  async markChatBusy(id: string, firedAt: string): Promise<RoutineRecord | null> {
    return this.mutate(id, (r) => {
      if (r.lastFiredAt !== firedAt) return false;
      r.lastSkippedReason = "chat-busy";
      if (isOneShot(r) && r.dismissedAt === r.lastFiredAt) delete r.dismissedAt;
      return true;
    });
  }

  // A user edit from the schedule panel, validated exactly as add validates. Null for an unknown or dismissed item.
  async edit(id: string, patch: RoutineEditPatch): Promise<RoutineRecord | null> {
    return this.mutate(id, (r) => {
      if (r.dismissedAt) return false;
      if (patch.schedule !== undefined && r.trigger !== "schedule") {
        throw new Error("RoutinesStore.edit: a shutdown item has no schedule");
      }
      const next: RoutineRecord = {
        ...r,
        ...(patch.prePrompt !== undefined ? { prePrompt: patch.prePrompt } : {}),
        ...(patch.notificationTitle !== undefined ? { notificationTitle: patch.notificationTitle } : {}),
        ...(patch.notificationBody !== undefined ? { notificationBody: patch.notificationBody } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      };
      const schedule = validateRoutineContent("edit", next);
      if (typeof patch.targetSessionId === "string" && !canConnect(patch.targetSessionId, r.trigger, r.execution)) {
        throw new Error("RoutinesStore.edit: targetSessionId must be a valid chat id on a scheduled llm-session item");
      }
      if (patch.title === null) delete r.title;
      else if (patch.title !== undefined) r.title = patch.title;
      if (patch.prePrompt !== undefined) r.prePrompt = patch.prePrompt;
      if (patch.notificationTitle !== undefined) r.notificationTitle = patch.notificationTitle;
      if (patch.notificationBody !== undefined) r.notificationBody = patch.notificationBody;
      // A new schedule is a new series: the previous cron minute keys and skip markers belong to the old one, and a one-shot given
      // a new time is due again and no longer missed. A re-save that fires at the same times (key order, `{at}` vs a "none" repeat,
      // an offset spelling of the same instant, a padded cron) is not new, so a fired one-shot or a cron minute cannot fire twice.
      if (patch.schedule !== undefined && scheduleIdentity(schedule) !== scheduleIdentity(r.schedule)) {
        r.schedule = schedule;
        delete r.lastFiredMinuteUTC;
        delete r.lastSkippedMinuteUTC;
        if (isOneShot(r)) {
          delete r.lastFiredAt;
          delete r.resumedAt;
        }
      }
      if (patch.targetSessionId !== undefined) {
        if (patch.targetSessionId === null) delete r.targetSessionId;
        else r.targetSessionId = patch.targetSessionId;
        // Relinking or unlinking a 대화 없음 item works like resume: what it missed is not replayed.
        if (r.orphanedAt) {
          const now = new Date().toISOString();
          delete r.orphanedAt;
          r.resumedAt = now;
          advanceRepeatingSchedule(r, now);
        }
      }
      return true;
    }, { skipDismissed: true });
  }

  // The connected chat was deleted: every item that enters it becomes 대화 없음. Returns how many items changed.
  async markOrphaned(sessionId: string): Promise<number> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const now = new Date().toISOString();
      let changed = 0;
      for (const r of file.routines) {
        if (r.targetSessionId !== sessionId || r.orphanedAt || r.dismissedAt) continue;
        r.orphanedAt = now;
        changed += 1;
      }
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      if (changed > 0) await this.persist(file);
      return changed;
    });
  }

  async pause(id: string, by: RoutineActor): Promise<RoutineRecord | null> {
    return this.mutate(id, (r) => {
      if (r.pausedAt) return false;
      r.pausedAt = new Date().toISOString();
      r.pausedBy = by;
      return true;
    }, { skipDismissed: true });
  }

  // Resuming does not replay what was paused: a repeating item's next fire moves past now, and a one-shot whose time passed is
  // missed (isMissedWhilePaused) until the user runs it now or gives it a new time.
  async resume(id: string): Promise<RoutineRecord | null> {
    return this.mutate(id, (r) => {
      if (!r.pausedAt) return false;
      const now = new Date().toISOString();
      delete r.pausedAt;
      delete r.pausedBy;
      r.resumedAt = now;
      advanceRepeatingSchedule(r, now);
      return true;
    }, { skipDismissed: true });
  }

  // `apply` returns whether it changed the record; an unchanged record is not rewritten. Null only when the routine does not exist.
  private async mutate(
    id: string,
    apply: (record: RoutineRecord) => boolean,
    options?: { skipDismissed?: boolean },
  ): Promise<RoutineRecord | null> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      this.cache = file.routines;
      this.invalidCache = file.invalid;
      if (!r || (options?.skipDismissed && r.dismissedAt)) return null;
      if (apply(r)) await this.persist(file);
      return cloneRecord(r);
    });
  }

  // Mark a routine as fired. Completed one-shots without attention are dismissed. For repeating routines, advances the next-fire time using the cron
  // evaluator. Returns the updated record.
  // `scheduled` marks a scheduler pass: the scan decided due-ness from a snapshot taken before an await, so the item is re-checked
  // here inside the file queue. A paused item never fires, on either path.
  async markFired(id: string, missingPluginIds: string[] = [], options?: { scheduled?: boolean }): Promise<RoutineRecord | null> {
    if (!this.loaded) await this.load();
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      const nowMs = Date.now();
      // Dismissed applies to every path: run-now and quit read their item before an await, too.
      const stale = r !== undefined && (Boolean(r.dismissedAt) || (options?.scheduled === true && (
        (isOneShot(r) && Boolean(r.lastFiredAt))
        || isMissedWhilePaused(r)
        || (r.schedule?.repeat?.kind !== "cron" && r.schedule?.at !== undefined && Date.parse(r.schedule.at) > nowMs)
      )));
      if (!r || r.pausedAt || r.orphanedAt || stale) {
        this.cache = file.routines;
        this.invalidCache = file.invalid;
        return null;
      }
      const firedAt = new Date(nowMs).toISOString();
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
      // cron routines: next-fire is re-computed by the scheduler each tick — no need to advance `at` here.
      await this.persist(file);
      return r;
    });
  }

  // Keep a skipped routine visible without creating a result or consuming a one-shot.
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
      if (JSON.stringify(r) !== previous) await this.persist(file);
    });
  }
}

function inProject(record: RoutineRecord, projectRoot: string | undefined): boolean {
  return projectRoot === undefined || record.projectRoot === undefined || projectRootEquals(record.projectRoot, projectRoot);
}

function isOneShot(record: RoutineRecord): boolean {
  const repeat = record.schedule?.repeat;
  return !repeat || repeat.kind === "none";
}

function advanceRepeatingSchedule(routine: RoutineRecord, now: string): void {
  const schedule = routine.schedule;
  if (!schedule) return;
  const next = advanceRepeatAt(schedule.at ?? now, schedule.repeat, Date.parse(now));
  // cron routines: next-fire is re-computed by the scheduler each tick — no `at` to advance.
  if (next !== null) schedule.at = next;
}

// Shared by add and edit so the two cannot disagree about a limit. Returns the schedule with `at` normalized to UTC ISO.
function validateRoutineContent(
  op: "add" | "edit",
  input: Pick<AddRoutineInput, "schedule" | "execution" | "prePrompt" | "notificationTitle">,
): RoutineSchedule | undefined {
  const label = `RoutinesStore.${op}`;
  let normalizedAt: string | undefined;
  if (input.schedule?.at !== undefined) {
    const validation = validateScheduleAt(input.schedule.at);
    if (!validation.ok) {
      throw new Error(`${label}: invalid schedule.at (${validation.error}): ${input.schedule.at}`);
    }
    normalizedAt = new Date(input.schedule.at).toISOString();
  }
  // Non-cron repeats require schedule.at or the scheduler can never fire them.
  if (input.schedule?.repeat) {
    const kind = input.schedule.repeat.kind;
    if (kind !== "cron" && !input.schedule.at) {
      throw new Error(
        `${label}: schedule.at is required for repeat.kind="${kind}" (non-cron repeats fire on a fixed instant)`,
      );
    }
  }
  if (input.schedule?.repeat?.kind === "cron") {
    const expr = (input.schedule.repeat as { kind: "cron"; expression: string }).expression;
    if (typeof expr !== "string" || expr.length > MAX_CRON_EXPR_LENGTH) {
      throw new Error(`${label}: cron expression too long or invalid type (max ${MAX_CRON_EXPR_LENGTH} chars)`);
    }
    if (!expr.trim() || !isValidCronExpression(expr)) {
      throw new Error(`${label}: invalid cron expression: ${String(expr)}`);
    }
  }
  if (input.schedule?.repeat?.kind === "interval") {
    const intervalMs = (input.schedule.repeat as { kind: "interval"; intervalMs: number }).intervalMs;
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_FUTURE_OFFSET_MS) {
      throw new Error(
        `${label}: intervalMs out of range (min ${MIN_INTERVAL_MS}ms, max ${MAX_FUTURE_OFFSET_MS}ms): ${String(intervalMs)}`,
      );
    }
  }
  if (input.execution === "llm-session" && (!input.prePrompt || input.prePrompt.trim().length === 0)) {
    throw new Error(`${label}: prePrompt is required and must be non-empty for execution='llm-session'`);
  }
  if (input.execution === "notification-only" && (!input.notificationTitle || input.notificationTitle.trim().length === 0)) {
    throw new Error(`${label}: notificationTitle is required and must be non-empty for execution='notification-only'`);
  }
  return input.schedule
    ? { ...input.schedule, ...(normalizedAt !== undefined ? { at: normalizedAt } : {}) }
    : undefined;
}

interface RemoveRoutineDeps {
  routinesStore: Pick<RoutinesStore, "remove">;
  memoryManager: Pick<MemoryManager, "listSessionsByRoutine" | "deleteSession">;
  /** Ends a deleted run session's session-scoped permissions. Injected: the plugin child bundles this module, and the
   * permissions code must stay out of its module graph. */
  endSessionScope: (sessionId: string) => void | Promise<void>;
}

/** Delete a schedule item and its own runs' sessions. A connected chat is never one of them: its runs carry no routine id. The
 * panel's delete and the agent's routine_schedule remove share this. */
export async function removeRoutineWithRuns(deps: RemoveRoutineDeps, id: string): Promise<boolean> {
  const ok = await deps.routinesStore.remove(id);
  if (ok) {
    for (const session of deps.memoryManager.listSessionsByRoutine(id)) {
      await deps.memoryManager.deleteSession(session.id);
      await deps.endSessionScope(session.id);
    }
  }
  return ok;
}
