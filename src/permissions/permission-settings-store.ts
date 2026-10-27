// Absent additionalDirectories means host defaults only, never silent allow; callers compose through buildAllowedScope (docs/architecture/permission-policy-design.md).
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { isCommittedAtomicWriteError, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { aveHome, aveHomeConfigurationDirectory, AveHomeConfigurationUntrustedError } from "../shared/ave-home.js";
import { parseConfigurationObject } from "../shared/configuration-document.js";
import { readAveHomeConfigurationFile, resolveConfigurationFile, tryWithAveHomeConfigurationWrite, withAveHomeConfigurationWrite } from "../shared/ave-home-configuration-access.js";
import {
  PARENT_ADJUDICATION_CONTEXT_TURNS_MAX,
  PARENT_ADJUDICATION_CONTEXT_TURNS_MIN,
  PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MAX,
  PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MIN,
  PARENT_ADJUDICATION_TIMEOUT_MS_MAX,
  PARENT_ADJUDICATION_TIMEOUT_MS_MIN,
} from "../shared/parent-adjudication-bounds.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { isLLMVendor, type LLMVendor } from "../shared/llm-vendor-defaults.js";
import {
  JudgeSettingsError,
  normalizeJudgeSettings,
  serializeJudgeSettings,
  validateJudgeSettings,
  type JudgeModelCatalog,
  type JudgeSettings,
  type NormalizedJudgeSettings,
} from "./judge/judge-settings.js";

const log = createLogger("permission-settings");

async function withPermissionSettingsWrite<T>(path: string, callback: (filePath: string) => Promise<T>): Promise<T> {
  return withAveHomeConfigurationWrite(path, callback);
}

// Disabled bypasses review as LOW while matrix/hard gates still apply; rule is deterministic, llm composes with rule floors, and strict returns HIGH/defer for every review.
export type ReviewerMode = "disabled" | "rule" | "llm" | "strict";
export type ReviewerFallbackOnError = "deny" | "rule";

// Interactive auto-approve policy —. - "off" : reviewer never auto-approves in interactive (foreground) flow. Every ask hits the approval dock. - "low" : reviewer's LOW verdict in interactive flow silently allows the call without showing the prompt. MEDIUM/HIGH ask. - "medium": reviewer LOW and MEDIUM verdicts in interactive flow silently allow the call without showing the prompt. HIGH still asks. This inclusive threshold applies only to the foreground reviewer route. Headless review remains fail-closed for MEDIUM and HIGH.
export type ReviewerInteractiveAutoApprove = "off" | "low" | "medium";

export interface ReviewerInteractiveBlock {
  autoApprove: ReviewerInteractiveAutoApprove;
}

// Highest reviewer verdict a parent agent is allowed to adjudicate for its own child (tier 2 of the sub-agent approval chain). `"high"` is deliberately absent from the type, not merely absent from the default: a HIGH verdict is the class of call the user asked to see, and a ceiling the settings file could raise to `"high"` would let a hand-edited file hand the whole class to an agent. The host checks this ceiling before the parent is asked at all, so no parent answer can exceed it.
export type ParentAdjudicationMaxVerdict = "low" | "medium";

// Deferred escalation denies immediately and notifies only when the host knows nobody can answer: hidden/minimized background runs or armed away authority. Foreground users still get the dock; the queue cannot replay ended calls.
export type ParentAdjudicationBackgroundEscalation = "deferred" | "modal";

// Which model answers the tier-2 side turn. - `"reviewer"` — the permission reviewer's own adapter. It is already wired, already trusted with risk classification, and costs nothing extra to reach. - `"parent-session"` — the chat provider/model the parent's own loop runs on. It reasons about the parent's task with the parent's own model, and it is available even in reviewer modes that wire no LLM at all. COST: `"parent-session"` bills one extra call on the (usually larger) chat model for every adjudicated sub-agent tool call, bounded by `maxPerChildRun` per child run. `"reviewer"` is the cheaper default for that reason.
export type ParentAdjudicationModelSource = "reviewer" | "parent-session";

// Bounds for the numeric fields of ReviewerParentAdjudicationBlock live in shared/parent-adjudication-bounds.ts — the settings form mirrors the same ceilings it types values against, so they cannot be declared per layer.

// Tier-2 (parent-adjudication) policy for sub-agent tool approvals. Every field is a ceiling on what the lane may do, never a widening: the lane is skipped entirely unless the feature flag is on AND the request is eligible, and each of these only narrows it further. Reachable through ReviewerSettingsBlock.parentAdjudication, and read by the approval gate's tier-2 stage through the policy accessor it is wired with — the gate reads the live block per request rather than a value captured at boot, so a narrowed ceiling takes effect on the next ask.
export interface ReviewerParentAdjudicationBlock {
  // Verdict ceiling enforced by the host before the parent is asked.
  maxVerdict: ParentAdjudicationMaxVerdict;
  // How long one adjudication may take, measured from the moment it enters the queue rather than from the moment it starts, so a queue behind a slow adjudication cannot push a later request past this bound before it escalates to the user.
  timeoutMs: number;
  // Adjudications a single child run may consume. Past it the lane escalates to the user, so a child cannot spend the parent's judgement as a resource to exhaust.
  maxPerChildRun: number;
  // Parent conversation context is opt-in, default zero: it may leave for the reviewer's provider/endpoint rather than the chat provider. Bound, DLP-mask and quote it as data; never include child reports.
  includeParentContextTurns: number;
  // Where a tier-3 escalation goes for a background child run.
  backgroundEscalation: ParentAdjudicationBackgroundEscalation;
  // Which model answers the side turn. See the type for the cost note.
  model: ParentAdjudicationModelSource;
}

// Permission policy `permissions.reviewer` block. The reviewer's model is not stored here: it is `permissions.judge.model` (unset follows the active chat model). Files written by older builds may still carry `provider`/`model` keys; the read normalizer drops them and the next save writes the block without them. Defaults: fallbackOnError="deny", interactive.autoApprove="medium".
export interface ReviewerSettingsBlock {
  mode: ReviewerMode;
  fallbackOnError: ReviewerFallbackOnError;
  interactive: ReviewerInteractiveBlock;
  // Tier-2 policy for sub-agent asks a parent agent may decide.
  parentAdjudication: ReviewerParentAdjudicationBlock;
  // migration marker — ISO-8601 timestamp recorded the first time a pre-`mode:"disabled"` setting was rewritten to `mode:"strict"`. Pre-builds wired `disabled` as "defer-all-HIGH" (fail-closed), so an existing user file with `mode:"disabled"` and no marker represents a fail-closed posture the user actively chose. The normalization flipped `disabled` to pass-through-LOW; without this migration that flip would be a silent post-deploy security downgrade. The presence of `disabledMigratedAt` makes the migration idempotent — subsequent loads do not re-write.
  disabledMigratedAt?: string;
}

export interface PermissionSettingsBlock {
  additionalDirectories: string[];
  // Read fencing defaults off: sensitive-path denies protect secrets while directory lists bound changes. Keep the deployment override hand-editable without a settings control that implies additional secret protection.
  blockReadsOutsideWorkingDirectories: boolean;
  pendingWorkspaceRootRemovals: PendingWorkspaceRootRemoval[];
  reviewer: ReviewerSettingsBlock;
}

// Durable forward-only cleanup journal for a removed workspace root.
export interface PendingWorkspaceRootRemoval {
  operationId: string;
  storedPath: string;
  runtimePath: string;
  requestedAt: string;
  source: string;
}

// What a read could NOT interpret in the on-disk file. The settings file is an external boundary: it is hand-editable, it is restored from backups, and a half-written predecessor of the atomic writer could survive a crash. None of that may be answered by pretending the user simply has no projects — "we could not read your settings" and "you have no extra directories" are different facts and the UI owes the user the first one. So a read reports the condition here instead of erasing it, and the file itself is left byte-for-byte as it was found.
type PermissionSettingsFault =
  | {
      // The whole file failed to parse. No grant in it can be honoured.
      kind: "file-unreadable";
      filePath: string;
      detail: string;
    }
  | {
      // Individual cleanup-journal entries failed validation.
      kind: "pending-removals-malformed";
      filePath: string;
      // How many entries were kept on disk but not interpreted.
      entries: number;
    };

export interface PermissionSettingsFile {
  permissions: PermissionSettingsBlock;
  // `null` when the file was interpreted whole. Callers that GATE on the settings (the executor allow-list, the reviewer) deliberately ignore it: with an uninterpretable SOT the only honest gate answer is the deny-shaped default this read returns with it. Callers that DISPLAY the settings must not — a fault means the list they are about to draw is not the user's.
  fault: PermissionSettingsFault | null;
}

// A write path found the settings file unparseable. Merging into `{}` instead would let the next write replace every unrelated top-level key the user has in that file, so a write refuses. The file is left untouched for a hand-repair or a restore.
export class PermissionSettingsUnreadableError extends Error {
  readonly code = "settings-unreadable";
  constructor(
    readonly filePath: string,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`permission settings at ${filePath} are unreadable: ${detail}`, options);
    this.name = "PermissionSettingsUnreadableError";
  }
}

const DEFAULT_REVIEWER: ReviewerSettingsBlock = {
  // Default to model review; absent provider credentials visibly degrade to rules and rewire back after configuration. Foreground auto mode permits LOW/MEDIUM while HIGH blocks; headless thresholds stay unchanged. Host-proven sandbox-contained plugin writes remain LOW in either classifier.
  mode: "llm",
  fallbackOnError: "deny",
  interactive: { autoApprove: "medium" },
  // Parent adjudication never reaches HIGH; its ceiling tracks the interactive band one level lower. Bound wait and volume, default parent context off to avoid unrequested disclosure, and defer unattended escalation rather than waiting on an unseen modal.
  parentAdjudication: {
    maxVerdict: "medium",
    timeoutMs: 30_000,
    maxPerChildRun: 200,
    includeParentContextTurns: 0,
    backgroundEscalation: "deferred",
    model: "reviewer",
  },
};

const REVIEWER_INTERACTIVE_AUTO_APPROVES: ReadonlySet<ReviewerInteractiveAutoApprove> =
  new Set(["off", "low", "medium"]);

const PARENT_ADJUDICATION_MAX_VERDICTS: ReadonlySet<ParentAdjudicationMaxVerdict> =
  new Set(["low", "medium"]);

const PARENT_ADJUDICATION_BACKGROUND_ESCALATIONS: ReadonlySet<ParentAdjudicationBackgroundEscalation> =
  new Set(["deferred", "modal"]);

export const PARENT_ADJUDICATION_MODEL_SOURCES: ReadonlySet<ParentAdjudicationModelSource> =
  new Set(["reviewer", "parent-session"]);

const DEFAULT_FILE: PermissionSettingsFile = {
  permissions: {
    additionalDirectories: [],
    // Also the value an UNREADABLE file falls back to, and deliberately not the fenced one. The deny-shape this file owes on a fault is "no directory was granted", and that is `additionalDirectories: []` above. Reads are bounded by Layer 0, which does not live in this file, so fencing them here would withdraw no protection a fault put at risk.
    blockReadsOutsideWorkingDirectories: false,
    pendingWorkspaceRootRemovals: [],
    reviewer: { ...DEFAULT_REVIEWER },
  },
  fault: null,
};

const REVIEWER_MODES: ReadonlySet<ReviewerMode> = new Set([
  "disabled",
  "rule",
  "llm",
  "strict",
]);
const REVIEWER_FALLBACKS: ReadonlySet<ReviewerFallbackOnError> = new Set(["deny", "rule"]);

export function permissionSettingsPath(home = aveHome()): string {
  return pathResolve(aveHomeConfigurationDirectory(home), "settings.json");
}

// Unreadable existing settings return deny-shaped defaults with a visible fault, log an error and rewrite nothing. Migrate unmarked legacy disabled to strict and persist once; failed persistence still returns strict so upgrades cannot silently weaken policy.
export function readPermissionSettings(pathOverride?: string): PermissionSettingsFile {
  const filePath = resolveConfigurationFile(pathOverride ?? permissionSettingsPath());
  let parsed: Record<string, unknown>;
  try {
    const bytes = readAveHomeConfigurationFile(pathOverride ?? permissionSettingsPath());
    if (bytes === undefined) return structuredClone(DEFAULT_FILE);
    parsed = parseConfigurationObject(bytes.toString("utf8"), true);
  } catch (err) {
    if (err instanceof AveHomeConfigurationUntrustedError) throw err;
    const detail = (err as Error).message;
    log.error(
      "permission settings at %s are unreadable: %s — file preserved untouched, no directories granted",
      filePath,
      detail,
    );
    return {
      ...structuredClone(DEFAULT_FILE),
      fault: { kind: "file-unreadable", filePath, detail },
    };
  }
  {
    const migrated = migrateLegacyDisabledMode(parsed);
    const normalized = normalizePermissionSettings(parsed, filePath);
    if (migrated) {
      // Persist only when immediately available; the normalized runtime result stays strict.
      let persistFailure: string | undefined;
      try {
        const acquired = tryWithAveHomeConfigurationWrite(filePath, (target) => {
          const latest = readSettingsDocument(target);
          if (migrateLegacyDisabledMode(latest)) writeUtf8FileAtomicSync(target, JSON.stringify(latest, null, 2), 0o600);
        });
        if (!acquired) persistFailure = "Configuration owner is unavailable or busy";
      } catch (persistErr) {
        if (persistErr instanceof AveHomeConfigurationUntrustedError) throw persistErr;
        persistFailure = (persistErr as Error).message;
      }
      if (persistFailure !== undefined) {
        log.warn(
          "issue-664 migration: failed to persist migrated settings to %s — runtime still strict (%s)",
          filePath,
          persistFailure,
        );
      }
    }
    return normalized;
  }
}

// Preserve empty legacy documents; reject non-object roots before callers merge fields.
function readSettingsDocument(filePath: string, allowEmpty = true): Record<string, unknown> {
  filePath = resolveConfigurationFile(filePath);
  const bytes = readAveHomeConfigurationFile(filePath);
  if (bytes === undefined) {
    const error: NodeJS.ErrnoException = new Error("Configuration file does not exist");
    error.code = "ENOENT";
    throw error;
  }
  return parseConfigurationObject(bytes.toString("utf8"), allowEmpty);
}

// Read the settings object a write path is about to merge into. Refusing an unparseable file is the whole point: the previous `catch {}` here merged into an empty object, so the next successful write replaced the user's entire settings document — every unrelated top-level key included — with whatever that one mutation happened to hold.
function readSettingsObjectForUpdate(filePath: string): Record<string, unknown> {
  try {
    return readSettingsDocument(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (err instanceof AveHomeConfigurationUntrustedError) throw err;
    throw new PermissionSettingsUnreadableError(filePath, (err as Error).message, { cause: err });
  }
}

// Only unmarked legacy disabled mode auto-migrates to strict and gains a marker. Preserve later deliberate disabled choices; all other validation defaults without mutating disk.
export function migrateLegacyDisabledMode(parsed: Record<string, unknown>): boolean {
  const perm = parsed.permissions;
  if (!perm || typeof perm !== "object") return false;
  const reviewer = (perm as Record<string, unknown>).reviewer;
  if (!reviewer || typeof reviewer !== "object") return false;
  const r = reviewer as Record<string, unknown>;
  if (r.mode !== "disabled") return false;
  if (typeof r.disabledMigratedAt === "string" && r.disabledMigratedAt.length > 0) {
    return false;
  }
  const migratedAt = new Date().toISOString();
  r.mode = "strict";
  r.disabledMigratedAt = migratedAt;
  log.warn(
    "issue-664 migration: legacy reviewer mode 'disabled' (defer-all-HIGH) → 'strict' (defer-all-HIGH, honest name); marker=%s",
    migratedAt,
  );
  return true;
}

// Normalize an arbitrary parsed JSON value into a valid PermissionSettingsFile. Only `permissions.additionalDirectories` is accepted as the persisted directory SOT.
export function normalizePermissionSettings(
  parsed: Record<string, unknown>,
  filePath: string,
): PermissionSettingsFile {
  const perm = (parsed.permissions ?? {}) as Record<string, unknown>;
  const journal = partitionPendingWorkspaceRootRemovals(perm.pendingWorkspaceRootRemovals);
  const pendingWorkspaceRootRemovals = journal.intents;
  if (journal.malformed.length > 0) {
    log.error(
      "permissions.pendingWorkspaceRootRemovals in %s holds %d entry/entries that could not be interpreted — kept on disk, skipped at runtime",
      filePath,
      journal.malformed.length,
    );
  }
  // Every readable path in a damaged removal intent masks that root even if the intent cannot be acted on; readable intents block adds, but malformed-only roots can be added then masked until journal repair. Entries naming no path mask nothing and must surface a fault.
  // The journal provides crash recovery, not tamper evidence: clearing it alone cannot restore roots already removed from additionalDirectories, while hand edits can restore both the list and journal. Do not erase unrelated grants because one unreadable entry names nothing.
  const pendingPaths = [
    ...pendingWorkspaceRootRemovals.map((intent) => intent.runtimePath),
    ...journal.malformed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      return [value.runtimePath, value.storedPath].filter(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
      );
    }),
  ];
  const pendingKeys = new Set(
    pendingPaths.flatMap((path) => {
      const key = allowedDirectoryKey(path);
      return key === null ? [] : [key];
    }),
  );
  const additional = perm.additionalDirectories;
  let dirs: string[] = [];
  if (Array.isArray(additional)) {
    dirs = additional.filter((s): s is string => {
      if (typeof s !== "string" || s.length === 0) return false;
      const key = allowedDirectoryKey(s);
      // Pending wins over a conflicting list entry, however it got there.
      return key === null || !pendingKeys.has(key);
    });
  }
  return {
    permissions: {
      additionalDirectories: dirs,
      blockReadsOutsideWorkingDirectories: perm.blockReadsOutsideWorkingDirectories === true,
      pendingWorkspaceRootRemovals,
      reviewer: normalizeReviewerBlock(perm.reviewer),
    },
    fault:
      journal.malformed.length > 0
        ? {
            kind: "pending-removals-malformed",
            filePath,
            entries: journal.malformed.length,
          }
        : null,
  };
}

// Separate actionable intents from malformed entries; preserve malformed bytes on every write and report faults on reads so one bad removal does not block all directory adds.
interface PendingWorkspaceRootRemovalJournal {
  intents: PendingWorkspaceRootRemoval[];
  // Entries kept verbatim, never interpreted and never dropped.
  malformed: unknown[];
}

function partitionPendingWorkspaceRootRemovals(
  parsed: unknown,
): PendingWorkspaceRootRemovalJournal {
  if (parsed === undefined) return { intents: [], malformed: [] };
  // A non-array value carries no entry to keep apart, so the value itself is the thing preserved — a later write returns it to the journal as one element of the array, after whatever intents that write decided on, rather than deleting a key it cannot read. It is the sole element only when the write leaves no intents behind.
  if (!Array.isArray(parsed)) return { intents: [], malformed: [parsed] };
  const seenOperations = new Set<string>();
  const intents: PendingWorkspaceRootRemoval[] = [];
  const malformed: unknown[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") {
      malformed.push(candidate);
      continue;
    }
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.operationId !== "string"
      || !UUID_PATTERN.test(value.operationId)
      || typeof value.storedPath !== "string"
      || value.storedPath.length === 0
      || typeof value.runtimePath !== "string"
      || value.runtimePath.length === 0
      || typeof value.requestedAt !== "string"
      || value.requestedAt.length === 0
      || typeof value.source !== "string"
      || value.source.length === 0
      || seenOperations.has(value.operationId)
    ) {
      malformed.push(candidate);
      continue;
    }
    seenOperations.add(value.operationId);
    intents.push({
      operationId: value.operationId,
      storedPath: value.storedPath,
      runtimePath: value.runtimePath,
      requestedAt: value.requestedAt,
      source: value.source,
    });
  }
  return { intents, malformed };
}

// The journal a write persists: the intents it decided on, followed by the entries it could not read and therefore has no standing to remove.
function composePendingWorkspaceRootRemovals(
  intents: readonly PendingWorkspaceRootRemoval[],
  malformed: readonly unknown[],
): unknown[] {
  return [...intents, ...malformed];
}

// Permission policy normalize `permissions.reviewer` from arbitrary JSON to the canonical block. Unknown enum values fall back to defaults with a warn (per CLAUDE.md No-Fallback: this is the *external boundary* — settings file may be hand-edited with bad values).
function normalizeReviewerBlock(parsed: unknown): ReviewerSettingsBlock {
  if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_REVIEWER);
  const obj = parsed as Record<string, unknown>;
  const mode =
    typeof obj.mode === "string" && REVIEWER_MODES.has(obj.mode as ReviewerMode)
      ? (obj.mode as ReviewerMode)
      : DEFAULT_REVIEWER.mode;
  const fallbackOnError =
    typeof obj.fallbackOnError === "string" &&
    REVIEWER_FALLBACKS.has(obj.fallbackOnError as ReviewerFallbackOnError)
      ? (obj.fallbackOnError as ReviewerFallbackOnError)
      : DEFAULT_REVIEWER.fallbackOnError;
  const interactive = normalizeInteractiveBlock(obj.interactive);
  const parentAdjudication = normalizeParentAdjudicationBlock(obj.parentAdjudication);
  const disabledMigratedAt =
    typeof obj.disabledMigratedAt === "string" && obj.disabledMigratedAt.length > 0
      ? obj.disabledMigratedAt
      : undefined;
  // Only the known keys are carried, so the retired `provider`/`model` keys an older build wrote are dropped here and leave the file on the next save.
  return {
    mode,
    fallbackOnError,
    interactive,
    parentAdjudication,
    disabledMigratedAt,
  };
}

// Clamp rather than reject out-of-range numbers: the settings file is an external boundary a user may hand-edit, and both fields are ceilings whose clamped value is still a safe posture. A non-finite or non-numeric value has no clamped meaning at all, so it falls back to the default.
function clampParentAdjudicationNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeParentAdjudicationBlock(
  parsed: unknown,
): ReviewerParentAdjudicationBlock {
  const fallback = DEFAULT_REVIEWER.parentAdjudication;
  if (!parsed || typeof parsed !== "object") return { ...fallback };
  const obj = parsed as Record<string, unknown>;
  const maxVerdict =
    typeof obj.maxVerdict === "string" &&
    PARENT_ADJUDICATION_MAX_VERDICTS.has(obj.maxVerdict as ParentAdjudicationMaxVerdict)
      ? (obj.maxVerdict as ParentAdjudicationMaxVerdict)
      : fallback.maxVerdict;
  const backgroundEscalation =
    typeof obj.backgroundEscalation === "string" &&
    PARENT_ADJUDICATION_BACKGROUND_ESCALATIONS.has(
      obj.backgroundEscalation as ParentAdjudicationBackgroundEscalation,
    )
      ? (obj.backgroundEscalation as ParentAdjudicationBackgroundEscalation)
      : fallback.backgroundEscalation;
  const model =
    typeof obj.model === "string" &&
    PARENT_ADJUDICATION_MODEL_SOURCES.has(obj.model as ParentAdjudicationModelSource)
      ? (obj.model as ParentAdjudicationModelSource)
      : fallback.model;
  return {
    maxVerdict,
    timeoutMs: clampParentAdjudicationNumber(
      obj.timeoutMs,
      fallback.timeoutMs,
      PARENT_ADJUDICATION_TIMEOUT_MS_MIN,
      PARENT_ADJUDICATION_TIMEOUT_MS_MAX,
    ),
    maxPerChildRun: clampParentAdjudicationNumber(
      obj.maxPerChildRun,
      fallback.maxPerChildRun,
      PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MIN,
      PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MAX,
    ),
    // Clamped like the other numbers, and to a deliberately short range: each turn is a chunk of the user's conversation leaving the machine, so the upper bound is a property of the feature rather than a matter of taste.
    includeParentContextTurns: clampParentAdjudicationNumber(
      obj.includeParentContextTurns,
      fallback.includeParentContextTurns,
      PARENT_ADJUDICATION_CONTEXT_TURNS_MIN,
      PARENT_ADJUDICATION_CONTEXT_TURNS_MAX,
    ),
    backgroundEscalation,
    model,
  };
}

function normalizeInteractiveBlock(parsed: unknown): ReviewerInteractiveBlock {
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_REVIEWER.interactive };
  }
  const obj = parsed as Record<string, unknown>;
  const autoApprove =
    typeof obj.autoApprove === "string" &&
    REVIEWER_INTERACTIVE_AUTO_APPROVES.has(obj.autoApprove as ReviewerInteractiveAutoApprove)
      ? (obj.autoApprove as ReviewerInteractiveAutoApprove)
      : DEFAULT_REVIEWER.interactive.autoApprove;
  return { autoApprove };
}

// Preserve untouched top-level/permission keys, write canonical directories and normalize reviewer settings on every mutation. The deprecated allowedDirectories alias is ignored by readers and preserved by writers; do not revive write-time cleanup.
function composeSettingsForPersist(
  existing: Record<string, unknown>,
  existingPerm: Record<string, unknown>,
  next: {
    additionalDirectories: readonly string[];
    // Omit to carry the existing block through the read-time normalizer.
    reviewer?: ReviewerSettingsBlock;
    // Already composed by `composePendingWorkspaceRootRemovals`, so it carries the malformed entries the reader kept on disk verbatim — hence `unknown`.
    pendingWorkspaceRootRemovals?: readonly unknown[];
  },
): Record<string, unknown> {
  return {
    ...existing,
    permissions: {
      ...existingPerm,
      additionalDirectories: [...next.additionalDirectories],
      ...(next.pendingWorkspaceRootRemovals === undefined
        ? {}
        : { pendingWorkspaceRootRemovals: [...next.pendingWorkspaceRootRemovals] }),
      reviewer: next.reviewer ?? normalizeReviewerBlock(existingPerm.reviewer),
    },
  };
}

// Atomically rewrite `~/.ave/config/settings.json` with a fresh `permissions.additionalDirectories` value. Preserves any other top-level keys present in the existing file. Permission policy also accepts a `reviewer` patch (partial). Provided keys overwrite; missing keys preserve existing values.
export async function writePermissionSettings(
  patch: {
    additionalDirectories?: string[];
    reviewer?: Partial<ReviewerSettingsBlock>;
  },
  pathOverride?: string,
): Promise<void> {
  const filePath = pathOverride ?? permissionSettingsPath();
  await withPermissionSettingsWrite(filePath, async (filePath) => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = (existing.permissions ?? {}) as Record<string, unknown>;
    const existingReviewer = normalizeReviewerBlock(existingPerm.reviewer);
    const nextReviewer: ReviewerSettingsBlock = patch.reviewer
      ? validateReviewerPatch({ ...existingReviewer, ...patch.reviewer })
      : existingReviewer;
    const nextDirs =
      patch.additionalDirectories !== undefined
        ? [...patch.additionalDirectories]
        : Array.isArray(existingPerm.additionalDirectories)
          ? (existingPerm.additionalDirectories as string[])
          : [];
    const merged = composeSettingsForPersist(existing, existingPerm, {
      additionalDirectories: nextDirs,
      reviewer: nextReviewer,
    });
    writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
  });
}

// Strict validate a candidate reviewer block. Used by the slash handler / IPC writes — invalid input rejected with an error message (no silent default-substitution at write time, only at read time for hand-edited files).
const REVIEWER_BLOCK_KEYS: ReadonlySet<string> = new Set([
  "mode",
  "fallbackOnError",
  "interactive",
  "parentAdjudication",
  "disabledMigratedAt",
] satisfies ReadonlyArray<keyof ReviewerSettingsBlock>);

function validateReviewerPatch(patch: ReviewerSettingsBlock): ReviewerSettingsBlock {
  if (!REVIEWER_MODES.has(patch.mode)) {
    throw new Error(
      `permissions.reviewer.mode invalid: '${patch.mode}'. Allowed: ${[...REVIEWER_MODES].join("|")}`,
    );
  }
  const unknownKeys = Object.keys(patch).filter((key) => !REVIEWER_BLOCK_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `permissions.reviewer has unsupported keys: ${unknownKeys.join(", ")}. ` +
      `The reviewer model is set with permissions.judge.model.`,
    );
  }
  if (!REVIEWER_FALLBACKS.has(patch.fallbackOnError)) {
    throw new Error(
      `permissions.reviewer.fallbackOnError invalid: '${patch.fallbackOnError}'. Allowed: ${[...REVIEWER_FALLBACKS].join("|")}`,
    );
  }
  if (
    !patch.interactive ||
    !REVIEWER_INTERACTIVE_AUTO_APPROVES.has(patch.interactive.autoApprove)
  ) {
    throw new Error(
      `permissions.reviewer.interactive.autoApprove invalid: '${patch.interactive?.autoApprove}'. ` +
      `Allowed: ${[...REVIEWER_INTERACTIVE_AUTO_APPROVES].join("|")}`,
    );
  }
  return patch;
}

// Permission policy persist a reviewer-block partial. Convenience helper for `/permission reviewer...` slash dispatchers.
export async function setReviewerSettingsPersist(
  patch: Partial<ReviewerSettingsBlock>,
  pathOverride?: string,
): Promise<ReviewerSettingsBlock> {
  await writePermissionSettings({ reviewer: patch }, pathOverride);
  return readPermissionSettings(pathOverride).permissions.reviewer;
}

export type JudgeSettingsReadResult = Pick<NormalizedJudgeSettings, "settings" | "issues" | "chainRejected" | "modelRejected" | "rejectedModel"> & {
  // An existing settings document could not be safely interpreted.
  unreadable?: true;
};

// Read the user-owned judge block without concealing malformed file content.
export function readJudgeSettings(
  pathOverride?: string,
  catalog?: JudgeModelCatalog,
): JudgeSettingsReadResult {
  const filePath = pathOverride ?? permissionSettingsPath();
  try {
    const document = readSettingsDocument(filePath, false);
    const permissions = document.permissions;
    if (permissions !== undefined &&
        (!permissions || typeof permissions !== "object" || Array.isArray(permissions))) {
      return { ...normalizeJudgeSettings(undefined, catalog), issues: ["permissions must be an object"], unreadable: true };
    }
    return normalizeJudgeSettings((permissions as Record<string, unknown> | undefined)?.judge, catalog);
  } catch (error) {
    if (error instanceof AveHomeConfigurationUntrustedError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeJudgeSettings(undefined, catalog);
    log.warn("Judge settings could not be read: %s", (error as Error).message);
    return { ...normalizeJudgeSettings(undefined, catalog), issues: ["Judge settings file could not be read"], unreadable: true };
  }
}

export interface StoredJudgeModelRef { vendor: LLMVendor; model: string }

function storedJudgeModelRef(raw: unknown): StoredJudgeModelRef | null {
  if (typeof raw !== "string") return null;
  const slash = raw.indexOf("/");
  const vendor = raw.slice(0, slash);
  return slash > 0 && isLLMVendor(vendor) ? { vendor, model: raw.slice(slash + 1) } : null;
}

// The models the stored judge settings name, as written and read without the model catalog: the reviewer model (`permissions.judge.model`) and each chain stage's own `model`, in chain order. A change to such a model's route or catalogue must re-wire even when the model is not (or no longer) offered. An entry is `null` when unset, absent or not a known provider; read failures must surface to the caller.
export function readJudgeStoredModels(pathOverride?: string): {
  reviewer: StoredJudgeModelRef | null;
  stages: Array<StoredJudgeModelRef | null>;
} {
  try {
    const judge = (readSettingsDocument(pathOverride ?? permissionSettingsPath()).permissions as Record<string, unknown> | undefined)?.judge;
    const block = judge && typeof judge === "object" ? judge as Record<string, unknown> : {};
    const chain = Array.isArray(block.chain) ? block.chain : [];
    return {
      reviewer: storedJudgeModelRef(block.model),
      stages: chain.map((stage) =>
        stage && typeof stage === "object" ? storedJudgeModelRef((stage as Record<string, unknown>).model) : null),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reviewer: null, stages: [] };
    throw error;
  }
}

export interface JudgeSettingsWriteReceipt {
  settings: JudgeSettings;
  // Restore the exact prior subtree, including rejected configuration or absence.
  rollback(): Promise<void>;
}

function judgePermissionsForUpdate(document: Record<string, unknown>): Record<string, unknown> {
  if (document.permissions !== undefined &&
      (!document.permissions || typeof document.permissions !== "object" || Array.isArray(document.permissions))) {
    throw new JudgeSettingsError("permissions must be an object");
  }
  return (document.permissions ?? {}) as Record<string, unknown>;
}

function persistJudgeSubtree(
  filePath: string,
  document: Record<string, unknown>,
  permissions: Record<string, unknown>,
  subtree: { present: boolean; value?: unknown },
  keepPermissionsContainer: boolean,
): void {
  const nextPermissions = { ...permissions };
  if (subtree.present) nextPermissions.judge = subtree.value;
  else delete nextPermissions.judge;
  const nextDocument = { ...document };
  if (keepPermissionsContainer || Object.keys(nextPermissions).length > 0) nextDocument.permissions = nextPermissions;
  else delete nextDocument.permissions;
  writeUtf8FileAtomicSync(filePath, JSON.stringify(nextDocument, null, 2), 0o600);
}

// Atomically merge a user patch and retain its exact host-owned rollback state.
export async function setJudgeSettingsPersist(
  patch: unknown,
  pathOverride?: string,
  catalog?: JudgeModelCatalog,
): Promise<JudgeSettingsWriteReceipt> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new JudgeSettingsError("permissions.judge patch must be an object");
  }
  const update = patch as Record<string, unknown>;
  const allowed = new Set(["model", "chain", "provider", "external", "mode", "categories", "timeoutMs", "chainDeadlineMs", "breaker"]);
  if (Object.keys(update).some((key) => !allowed.has(key))) {
    throw new JudgeSettingsError("permissions.judge patch contains unknown fields");
  }
  const filePath = pathOverride ?? permissionSettingsPath();
  let receipt: JudgeSettingsWriteReceipt | undefined;
  await withPermissionSettingsWrite(filePath, async (filePath) => {
    const document = readSettingsObjectForUpdate(filePath);
    const permissions = judgePermissionsForUpdate(document);
    const previous = { present: Object.hasOwn(permissions, "judge"), value: permissions.judge };
    const permissionsPresent = Object.hasOwn(document, "permissions");
    const stored = (permissions.judge && typeof permissions.judge === "object" && !Array.isArray(permissions.judge)
      ? permissions.judge : {}) as Record<string, unknown>;
    const normalized = normalizeJudgeSettings(permissions.judge, catalog);
    const current = serializeJudgeSettings(normalized.settings);
    if (update.provider !== undefined || update.external !== undefined) delete current.chain;
    const merged = { ...current, ...update };
    for (const key of ["categories", "breaker"] as const) {
      if (update[key] && typeof update[key] === "object" && !Array.isArray(update[key])) {
        merged[key] = { ...(current[key] as Record<string, unknown>), ...(update[key] as Record<string, unknown>) };
      }
    }
    // Only the patched fields are validated against their normalized neighbours. A stored value the host rejected (an unavailable reviewer model, a chain it could not accept) and that this patch does not replace is written back exactly as stored, so saving another field never turns it into "follow chat" or "off": it keeps failing closed until replaced.
    const keepModel = normalized.modelRejected === true && !Object.hasOwn(update, "model");
    const keepChain = normalized.chainRejected === true &&
      !["chain", "provider", "external"].some((key) => Object.hasOwn(update, key));
    const settings = validateJudgeSettings(merged, catalog);
    const applied = serializeJudgeSettings(settings);
    if (keepModel) applied.model = stored.model;
    if (keepChain) {
      delete applied.chain;
      for (const key of ["chain", "provider", "external"] as const) {
        if (Object.hasOwn(stored, key)) applied[key] = stored[key];
      }
    }
    const appliedIdentity = JSON.stringify(applied);
    persistJudgeSubtree(filePath, document, permissions, { present: true, value: applied }, true);
    receipt = {
      settings,
      async rollback() {
        await withPermissionSettingsWrite(filePath, async (filePath) => {
          const latest = readSettingsObjectForUpdate(filePath);
          const latestPermissions = judgePermissionsForUpdate(latest);
          if (!Object.hasOwn(latestPermissions, "judge") || JSON.stringify(latestPermissions.judge) !== appliedIdentity) {
            throw new Error("Judge settings changed before rollback");
          }
          persistJudgeSubtree(filePath, latest, latestPermissions, previous, permissionsPresent);
        });
      },
    };
  });
  if (!receipt) throw new Error("Judge settings were not persisted");
  return receipt;
}

// Resolve an existing directory to the identity that is persisted in the permission SOT. Keeping the real path (instead of a symlink alias) freezes the authorized target even if that alias is later removed or retargeted. Legacy/non-existent values are kept verbatim so hand-edited settings and the slash-command parser retain their existing behaviour; workspace IPC validates existence before calling this helper.
function persistedAllowedDirectory(dir: string): string {
  if (dir.trim().length === 0) return dir;
  const resolved = pathResolve(dir);
  return existsSync(resolved) ? canonicalizePathForMatch(resolved) : dir;
}

function allowedDirectoryKey(dir: string): string | null {
  if (dir.trim().length === 0) return null;
  try {
    return caseFoldForMatch(canonicalizePathForMatch(pathResolve(dir)));
  } catch {
    return null;
  }
}

async function mutateAllowedDirectoriesPersist(
  mutation: (
    current: string[],
    pending: readonly PendingWorkspaceRootRemoval[],
  ) => string[],
  pathOverride?: string,
): Promise<string[]> {
  const filePath = pathOverride ?? permissionSettingsPath();
  let result: string[] = [];
  await withPermissionSettingsWrite(filePath, async (filePath) => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = { ...((existing.permissions ?? {}) as Record<string, unknown>) };
    const current = Array.isArray(existingPerm.additionalDirectories)
      ? existingPerm.additionalDirectories.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const journal = partitionPendingWorkspaceRootRemovals(
      existingPerm.pendingWorkspaceRootRemovals,
    );
    const next = mutation(current, journal.intents);
    result = [...next];
    if (
      next.length === current.length &&
      next.every((value, index) => value === current[index])
    ) {
      return;
    }
    const merged = composeSettingsForPersist(existing, existingPerm, {
      additionalDirectories: next,
    });
    writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
  });
  return result;
}

// Append a directory to `permissions.additionalDirectories`. Persists via writePermissionSettings. De-duplicates by exact string. Returns the post-add list (caller may show in toast).
export async function addAllowedDirectoryPersist(
  dir: string,
  pathOverride?: string,
): Promise<string[]> {
  const stored = persistedAllowedDirectory(dir);
  return mutateAllowedDirectoriesPersist((list, pending) => {
    const targetKey = allowedDirectoryKey(stored);
    if (
      targetKey !== null
      && pending.some((intent) => allowedDirectoryKey(intent.runtimePath) === targetKey)
    ) {
      throw Object.assign(new Error("workspace-root-removal-pending"), {
        code: "WORKSPACE_ROOT_REMOVAL_PENDING",
      });
    }
    if (
      list.some((entry) =>
        targetKey === null ? entry === stored : allowedDirectoryKey(entry) === targetKey,
      )
    ) {
      return list;
    }
    return [...list, stored];
  }, pathOverride);
}

// Remove a directory from `permissions.additionalDirectories`. Returns the post-removal list. No-op when the dir is not present.
export async function removeAllowedDirectoryPersist(
  dir: string,
  pathOverride?: string,
): Promise<string[]> {
  return mutateAllowedDirectoriesPersist((list) => {
    const targetKey = allowedDirectoryKey(dir);
    return list.filter((entry) =>
      targetKey === null ? entry !== dir : allowedDirectoryKey(entry) !== targetKey,
    );
  }, pathOverride);
}

export interface BeginWorkspaceRootRemovalResult {
  intent: PendingWorkspaceRootRemoval;
  activeDirectories: string[];
  created: boolean;
}

// Atomically cut a registered root out of the active allow-list and append a durable cleanup intent. A matching pending operation is returned on retry.
export async function beginWorkspaceRootRemovalPersist(
  root: string,
  source: string,
  pathOverride?: string,
): Promise<BeginWorkspaceRootRemovalResult | null> {
  const filePath = pathOverride ?? permissionSettingsPath();
  let result: BeginWorkspaceRootRemovalResult | null = null;
  await withPermissionSettingsWrite(filePath, async (filePath) => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = { ...((existing.permissions ?? {}) as Record<string, unknown>) };
    const current = Array.isArray(existingPerm.additionalDirectories)
      ? existingPerm.additionalDirectories.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const journal = partitionPendingWorkspaceRootRemovals(
      existingPerm.pendingWorkspaceRootRemovals,
    );
    const pending = journal.intents;
    const targetKey = allowedDirectoryKey(root);
    const existingIntent = pending.find((intent) =>
      targetKey === null
        ? intent.runtimePath === root || intent.storedPath === root
        : allowedDirectoryKey(intent.runtimePath) === targetKey,
    );
    const storedPath = current.find((candidate) =>
      targetKey === null ? candidate === root : allowedDirectoryKey(candidate) === targetKey,
    );
    if (!storedPath) {
      if (existingIntent) {
        result = { intent: existingIntent, activeDirectories: [...current], created: false };
      }
      return;
    }

    const runtimePath = canonicalizePathForMatch(pathResolve(storedPath));
    const runtimeKey = allowedDirectoryKey(runtimePath);
    const intent = existingIntent ?? {
      operationId: randomUUID(),
      storedPath,
      runtimePath,
      requestedAt: new Date().toISOString(),
      source,
    };
    const activeDirectories = current.filter((candidate) =>
      runtimeKey === null
        ? candidate !== storedPath
        : allowedDirectoryKey(candidate) !== runtimeKey,
    );
    const nextPending = existingIntent ? pending : [...pending, intent];
    const merged = composeSettingsForPersist(existing, existingPerm, {
      additionalDirectories: activeDirectories,
      pendingWorkspaceRootRemovals: composePendingWorkspaceRootRemovals(
        nextPending,
        journal.malformed,
      ),
    });
    try {
      writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
    } catch (error: unknown) {
      if (!isCommittedAtomicWriteError(error)) throw error;
      const verified = readPermissionSettings(filePath).permissions;
      const intentCommitted = verified.pendingWorkspaceRootRemovals.some(
        (candidate) => candidate.operationId === intent.operationId,
      );
      const rootInactive = !verified.additionalDirectories.some(
        (candidate) => runtimeKey !== null && allowedDirectoryKey(candidate) === runtimeKey,
      );
      if (!intentCommitted || !rootInactive) throw error;
    }
    result = { intent, activeDirectories, created: !existingIntent };
  });
  return result;
}

// Complete one exact operation; stale operation IDs are ABA-safe no-ops.
export async function completeWorkspaceRootRemovalPersist(
  operationId: string,
  pathOverride?: string,
): Promise<boolean> {
  const filePath = pathOverride ?? permissionSettingsPath();
  let completed = false;
  await withPermissionSettingsWrite(filePath, async (filePath) => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = { ...((existing.permissions ?? {}) as Record<string, unknown>) };
    const journal = partitionPendingWorkspaceRootRemovals(
      existingPerm.pendingWorkspaceRootRemovals,
    );
    const pending = journal.intents;
    const intent = pending.find((candidate) => candidate.operationId === operationId);
    if (!intent) return;
    const intentKey = allowedDirectoryKey(intent.runtimePath);
    const current = Array.isArray(existingPerm.additionalDirectories)
      ? existingPerm.additionalDirectories.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const activeDirectories = current.filter((candidate) =>
      intentKey === null
        ? candidate !== intent.storedPath
        : allowedDirectoryKey(candidate) !== intentKey,
    );
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: activeDirectories,
        pendingWorkspaceRootRemovals: composePendingWorkspaceRootRemovals(
          pending.filter((candidate) => candidate.operationId !== operationId),
          journal.malformed,
        ),
        reviewer: normalizeReviewerBlock(existingPerm.reviewer),
      },
    };
    try {
      writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
    } catch (error: unknown) {
      if (!isCommittedAtomicWriteError(error)) throw error;
      const verified = readPermissionSettings(filePath).permissions;
      const intentGone = !verified.pendingWorkspaceRootRemovals.some(
        (candidate) => candidate.operationId === operationId,
      );
      const rootInactive = !verified.additionalDirectories.some(
        (candidate) => intentKey !== null && allowedDirectoryKey(candidate) === intentKey,
      );
      if (!intentGone || !rootInactive) throw error;
    }
    completed = true;
  });
  return completed;
}
