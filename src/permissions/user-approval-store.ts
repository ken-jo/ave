/**
 * Exact User-Decision Memory Layer — persistent + session-scoped store.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691
 *
 * Stores remembered allow/deny decisions so subsequent calls with the same
 * identity can be handled consistently. The identity is tool + source/trust
 * origin + working directory + EITHER the exact canonical input (the default)
 * OR, for a tool that opted in with `approvalMemoryScope`, its target-wide
 * memory key (a public web_fetch origin, a write tool's target path). A
 * target-wide row records an args hash so a hit on other args can be
 * re-reviewed. See {@link ApprovalMemory}.
 *
 * Two-store role separation (do NOT merge — migration is out of scope):
 *   • Store A — durable glob allow/deny RULES + the `alwaysAllowed` Map in
 *     PermissionManager, managed by PermissionsTab and consulted by the SYNC
 *     `checkDetailed` (Layers 3 glob / 5 exact). It is edited explicitly in
 *     Settings and by explicit command-rule choices in the approval card.
 *   • Store B — THIS store. User DECISIONS, keyed as above, written
 *     for persistent allow or deny choices via the `userApprovalRecord` IPC.
 *     Exact allows are read by the reviewer lane
 *     (PermissionManager.dispatchReviewer) AND by the foreground dock-skip
 *     path (ToolExecutor.tryUserApprovalMemorySkip). Exact denies are checked
 *     before either lane and block the matching invocation.
 *
 * File: ~/.ave/permissions/user-approvals.json
 * Permissions: directory 0o700, file 0o600 (per CLAUDE.md storage namespace rule)
 *
 * Scope semantics:
 *   "session"    — conversation-bound in memory; legacy rows retain process lifetime.
 *   "persistent" — approval written to disk; survives restarts.
 *
 * The live approval gate owns persistence eligibility. An unavailable review
 * can retain a conservative HIGH display while the user remembers the exact
 * request. A completed HIGH assessment and mandatory one-shot approvals remain
 * ineligible. Exact deny decisions may persist regardless of displayed risk.
 *
 * Atomicity: writes go through the feature-namespace writer -- random-suffix
 * staging file, O_CREAT|O_EXCL, fsync of file and parent directory, then
 * rename. That sequence used to be spelled out in this file alone, which is why
 * the rest of `~/.ave` did not have it.
 */
import { mkdir, readFile, access, constants, stat, chmod } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { aveHome } from "../shared/ave-home.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { createLogger } from "../lib/logger.js";
import type {
  ApprovalMemory,
  UserApprovalDecision,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../shared/permissions-events.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isMissingPathError } from "../lib/atomic-file.js";
import { createSerialQueue } from "../lib/with-file-lock.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";


const log = createLogger("user-approval-store");
let persistentWrites = createSerialQueue();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserApprovalEntry {
  /** Conversation identity for newly recorded session decisions. */
  sessionId?: string;
  /** Host-captured directory for display; never an authority supplied by the UI. */
  projectCwd?: string;
  /** Legacy entries omit this field and are interpreted as an allow. */
  decision?: UserApprovalDecision;
  /** ISO 8601 wall-clock time the approval was granted. */
  approvedAt: string;
  /** "session" approvals are held in-memory only; "persistent" are written to disk. */
  scope: UserApprovalScope;
  /** The reviewer verdict that was shown to the user when they approved. */
  verdictAtApproval: UserApprovalVerdict;
  /** Host rule risk, separate from a conservative failed-assessment display. */
  riskCeilingAtApproval?: UserApprovalVerdict;
  /**
   * Optional historical justification. The approval dock does not require
   * renderer-authored prose to record an eligible exact decision.
   */
  nlJustification: string | null;
  /**
   * ISO 8601 timestamp when this approval was revoked, or null if active.
   * Revoked entries are retained for audit purposes but treated as absent
   * by {@link lookupApproval}.
   */
  revokedAt: string | null;
  /**
   * Display metadata — stored alongside the entry so listApprovals() can
   * return human-readable tool identity without re-parsing the hash key.
   * Required for PermissionsTab table to show toolName.
   */
  toolName?: string;
  source?: string;
  /**
   * Legacy pre-canonicalized args retained only until the v1 migration runs.
   * New entries never persist input text: exact identity is represented solely
   * by the hashed map key so DLP-masked values cannot be recovered through the
   * renderer-readable list API.
   */
  args?: string;
  /**
   * trustOrigin component used to compute the entryKey, stored for migration.
   * Optional — absent for entries that did not supply a trustOrigin.
   */
  trustOrigin?: string;
  /**
   * approvalCacheKey component used to compute the entryKey, stored for migration.
   * Optional — absent for entries that did not supply an approvalCacheKey.
   */
  approvalCacheKey?: string;
  /**
   * Which identity the map key was computed under. Absent on rows written
   * before the cache-key identity existed; those are args-identity rows.
   */
  rememberBy?: "key" | "args";
  /**
   * sha256 of the canonical args the decision was made on, for target-wide
   * (`rememberBy: "key"`) rows. A hash, never the input: the list API is
   * renderer-readable and the card may have DLP-masked those values.
   */
  argsIdentity?: string;
}

interface ApprovalsFile {
  /** Map from entry key → approval entry. */
  approvals: Record<string, UserApprovalEntry>;
}

// ─── In-memory session store ───────────────────────────────────────────────────

/**
 * Session-scoped approvals held in-process only. Not written to disk.
 * Cleared on process exit.
 */
const sessionStore = new Map<string, UserApprovalEntry>();
let approvalGeneration = 0;

/** Monotonic identity for Store B approval mutations. */
export function getUserApprovalGeneration(): string {
  return String(approvalGeneration);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filePath(): string {
  return resolve(aveHome(), "permissions", "user-approvals.json");
}

/** Idempotency sentinel: presence of this file means v1 migration ran. */
function migrationMarkerPath(): string {
  return resolve(aveHome(), "permissions", ".canonicalization-migration-v1");
}

/**
 * Stable cache key for a (toolName, args, source, trustOrigin?, approvalCacheKey?) tuple.
 *
 * `trustOrigin` and `approvalCacheKey` are included when present so that two
 * invocations of the same tool from different trust origins (e.g. "user-keyboard"
 * vs "plugin-abc") or with different semantic keys cannot collapse onto the same
 * cached approval. This prevents a low-trust caller from inheriting a high-trust
 * approval made by a different origin (CRITICAL cache-identity collapse fix).
 *
 * args is canonicalized via `canonicalStringify` (from shared/canonical-json.ts)
 * before hashing so that object key ordering differences ({a,b} vs {b,a}) do
 * not produce distinct keys for semantically identical inputs (HIGH JSON
 * canonical fix). Re-exported for backward-compat with existing importers.
 */
export { canonicalStringify } from "../shared/canonical-json.js";

/** Capture once before approval display; persistence consumes the frozen identity. */
export function captureApprovalWorkingDirectory(executionCwd: string): { path: string; identity: string } {
  if (!isAbsolute(executionCwd)) throw new Error("Approval working directory must be absolute");
  const path = canonicalizePathForMatch(executionCwd);
  return Object.freeze({ path, identity: sha256Hex(caseFoldForMatch(path)) });
}

/**
 * The identity components of one invocation that Store B keys on, besides
 * tool, args, source, trust origin and working directory:
 *  - `key`: the tool's policy `approvalCacheKey`. Under args identity it only
 *    narrows the exact-input hash (and it is what pre-v2 rows were hashed with).
 *  - `memoryKey`: present only when the tool opted into target-wide memory;
 *    it then REPLACES the args as the remembered identity.
 */
export interface ApprovalCacheKeyIdentity {
  readonly key?: string;
  readonly memoryKey?: string;
}

/**
 * Build the Store B identity from host-derived values. Every caller goes
 * through this, so a site that carries a policy key but forgot to say what
 * memory does fails here instead of being guessed.
 */
export function approvalCacheKeyIdentity(
  key: string | undefined,
  memory: ApprovalMemory | undefined,
): ApprovalCacheKeyIdentity | undefined {
  if (key !== undefined && key.length === 0) throw new Error("Approval cache key must be non-empty");
  if (memory === undefined) {
    if (key !== undefined) throw new Error("Approval cache key is missing its remembered-identity mode");
    return undefined;
  }
  if (memory.kind === "args") return key === undefined ? undefined : Object.freeze({ key });
  if (memory.kind !== "key" || typeof memory.key !== "string" || memory.key.length === 0) {
    throw new Error("Approval memory key must be non-empty");
  }
  return Object.freeze({ ...(key === undefined ? {} : { key }), memoryKey: memory.key });
}

/**
 * Whether a remembered decision was made for exactly this input. Args-identity
 * rows always are; a target-wide row is only when its recorded args hash
 * matches. A target-wide hit on different args must be re-reviewed before a
 * remembered allow is reused.
 */
export function isExactArgsDecision(entry: UserApprovalEntry, args: string): boolean {
  return entry.argsIdentity === undefined || entry.argsIdentity === sha256Hex(args);
}

function scopeToWorkingDirectory(unscopedKey: string, workingDirectoryIdentity?: string): string {
  if (workingDirectoryIdentity === undefined) return unscopedKey;
  if (!/^[a-f0-9]{64}$/.test(workingDirectoryIdentity)) throw new Error("Invalid approval working-directory identity");
  return sha256Hex(canonicalStringify({
    version: "working-directory/v1",
    unscopedKey,
    workingDirectoryIdentity,
  }));
}

/**
 * Args identity (v1). Byte-for-byte the formula every entry written before
 * the cache-key identity used, so args-identity rows on disk keep matching.
 */
function argsEntryKey(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: string,
  workingDirectoryIdentity?: string,
): string {
  const components = [toolName, args, source];
  if (trustOrigin) components.push(trustOrigin);
  if (approvalCacheKey) components.push(approvalCacheKey);
  return scopeToWorkingDirectory(sha256Hex(components.join("\0")), workingDirectoryIdentity);
}

/**
 * Target-wide identity (v2): the arguments are deliberately absent. The
 * version string keeps this hash space disjoint from {@link argsEntryKey}, so
 * a row recorded under the old args+key formula can never be read as a
 * target-wide decision. That is the migration rule: old allows for an
 * opted-in tool stop matching (they only ever covered identical input); old
 * denies are still honoured for their exact input by {@link lookupUserDecision}.
 */
function memoryEntryKey(
  toolName: string,
  source: string,
  trustOrigin: string | undefined,
  memoryKey: string,
  workingDirectoryIdentity?: string,
): string {
  return scopeToWorkingDirectory(sha256Hex(canonicalStringify({
    version: "approval-memory-key/v2",
    toolName,
    source,
    trustOrigin: trustOrigin || null,
    memoryKey,
  })), workingDirectoryIdentity);
}

function conversationEntryKey(key: string, sessionId: string): string {
  if (!sessionId.trim()) throw new Error("Approval session identity must be non-empty");
  return sha256Hex(canonicalStringify({ version: "conversation/v1", key, sessionId }));
}

function entryKey(
  toolName: string,
  args: string,
  source: string,
  trustOrigin: string | undefined,
  identity: ApprovalCacheKeyIdentity | undefined,
  workingDirectoryIdentity?: string,
): string {
  return identity?.memoryKey !== undefined
    ? memoryEntryKey(toolName, source, trustOrigin, identity.memoryKey, workingDirectoryIdentity)
    : argsEntryKey(toolName, args, source, trustOrigin, identity?.key, workingDirectoryIdentity);
}

function isApprovalVerdict(value: unknown): value is UserApprovalVerdict {
  return value === "low" || value === "medium" || value === "high";
}
function hasValidRiskProvenance(entry: UserApprovalEntry): boolean {
  return isApprovalVerdict(entry.verdictAtApproval) &&
    (entry.riskCeilingAtApproval === undefined || isApprovalVerdict(entry.riskCeilingAtApproval));
}

/**
 * Store B corruption is reported, never tolerated (issue #28). A malformed
 * file used to read as empty, and the next record then overwrote it — every
 * saved approval silently lost. Readers fail closed (the dock asks); writers
 * refuse to replace the file.
 */
export class UserApprovalStoreCorruptError extends Error {
  constructor(readonly filePath: string, detail: string) {
    super(`Saved approvals file ${filePath} is corrupt: ${detail}. Fix or remove the file; its approvals are not in force.`);
    this.name = "UserApprovalStoreCorruptError";
  }
}

async function readApprovalsFile(): Promise<ApprovalsFile> {
  const path = filePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isMissingPathError(err)) return { approvals: {} };
    throw err;
  }
  // An empty file holds no data (e.g. a lock placeholder); nothing is lost.
  if (!raw.trim()) return { approvals: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UserApprovalStoreCorruptError(path, "invalid JSON");
  }
  const approvals = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { approvals?: unknown }).approvals : undefined;
  if (!approvals || typeof approvals !== "object" || Array.isArray(approvals)) {
    throw new UserApprovalStoreCorruptError(path, "missing approvals object");
  }
  return parsed as ApprovalsFile;
}

async function atomicWrite(data: ApprovalsFile): Promise<void> {
  const path = filePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Verify directory permissions haven't drifted. Kept here rather than pushed
  // into the shared writer: this store holds granted approvals, so a widened
  // directory is a finding in its own right, and the shared writer's `chmod`
  // back to 0o700 is best-effort and silent by design.
  const dirStat = await stat(dir);
  if ((dirStat.mode & 0o777) !== 0o700) {
    await chmod(dir, 0o700);
  }

  // The random-tmp + O_CREAT|O_EXCL + fsync + directory-fsync sequence this
  // function used to spell out now lives in the feature-namespace writer, which
  // is where the rest of `~/.ave` already went and which did not have any of
  // it. The symlink-redirect this guarded against was live for every other
  // store in the tree for as long as the guard sat only here.
  await writeFileAtomicAtPath(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function mutatePersistentApprovals(
  mutator: (file: ApprovalsFile) => Promise<void> | void,
): Promise<void> {
  return persistentWrites(async () => {
    const file = await readApprovalsFile();
    await mutator(file);
    await atomicWrite(file);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a user approval decision.
 *
 * For "session" scope, stores only in memory (no disk write).
 * For "persistent" scope, appends to ~/.ave/permissions/user-approvals.json.
 *
 * The IPC caller must bind an allow to a live request whose host snapshot
 * permits persistence. This storage layer does not derive authority from risk.
 */
export async function recordApproval(
  toolName: string,
  args: string,
  source: string,
  entry: {
    decision?: UserApprovalDecision;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    approvedAt?: string;
    trustOrigin?: string;
    approvalCacheKey?: ApprovalCacheKeyIdentity;
    workingDirectoryIdentity?: string;
    riskCeilingAtApproval?: UserApprovalVerdict;
    sessionId?: string;
    projectCwd?: string;
  },
): Promise<void> {
  if (!isApprovalVerdict(entry.verdictAtApproval) ||
      (entry.riskCeilingAtApproval !== undefined && !isApprovalVerdict(entry.riskCeilingAtApproval))) {
    throw new Error("Invalid approval risk provenance");
  }
  const baseKey = entryKey(toolName, args, source, entry.trustOrigin, entry.approvalCacheKey, entry.workingDirectoryIdentity);
  if (entry.sessionId !== undefined && entry.scope !== "session") throw new Error("Conversation identity requires session scope");
  const key = entry.sessionId === undefined ? baseKey : conversationEntryKey(baseKey, entry.sessionId);
  const full: UserApprovalEntry = {
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
    ...(entry.projectCwd === undefined ? {} : { projectCwd: entry.projectCwd }),
    decision: entry.decision ?? "allow",
    approvedAt: entry.approvedAt ?? new Date().toISOString(),
    scope: entry.scope,
    verdictAtApproval: entry.verdictAtApproval,
    ...(entry.riskCeilingAtApproval === undefined ? {} : { riskCeilingAtApproval: entry.riskCeilingAtApproval }),
    nlJustification: entry.nlJustification,
    revokedAt: null,
    // Store display metadata so listApprovals() can surface toolName/source
    // without re-parsing the hash key.
    toolName,
    source,
    // Raw canonical args are intentionally used only for `key` above. Never
    // persist them as metadata: listApprovals is renderer-readable and the
    // approval card may have DLP-masked the same values before display.
    ...(entry.trustOrigin !== undefined ? { trustOrigin: entry.trustOrigin } : {}),
    ...(entry.approvalCacheKey?.key !== undefined ? { approvalCacheKey: entry.approvalCacheKey.key } : {}),
    rememberBy: entry.approvalCacheKey?.memoryKey !== undefined ? "key" : "args",
    ...(entry.approvalCacheKey?.memoryKey !== undefined ? { argsIdentity: sha256Hex(args) } : {}),
  };

  if (entry.scope === "session") {
    sessionStore.set(key, full);
    approvalGeneration += 1;
    return;
  }

  // persistent — write to disk
  await mutatePersistentApprovals((file) => {
    file.approvals[key] = full;
  });
  // Mirror into session cache for fast lookups.
  sessionStore.set(key, full);
  approvalGeneration += 1;
}

/**
 * Look up an active (non-revoked) approval for the given triple.
 *
 * Fast path: checks the in-memory session store first.
 * For persistent-scoped entries that survived a restart, falls through
 * to the disk file.
 *
 * Returns null when no approval is found or the approval is revoked.
 */
export async function lookupUserDecision(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: ApprovalCacheKeyIdentity,
  executionCwd?: string,
  sessionId?: string,
): Promise<UserApprovalEntry | null> {
  const workingDirectoryIdentity = executionCwd === undefined
    ? undefined
    : captureApprovalWorkingDirectory(executionCwd).identity;
  const key = entryKey(toolName, args, source, trustOrigin, approvalCacheKey, workingDirectoryIdentity);
  // Rows that may only ever restrict this lookup, never allow it:
  //  - the unscoped key: existing unscoped denials retain their original
  //    scope and precedence; no legacy allow is migrated or widened.
  //  - for a target-wide identity, the rows the same invocation has under the
  //    args(+policy key) formula. An exact deny saved before the tool opted
  //    in keeps blocking; an old allow (identical-input only) is ignored.
  const denyOnlyKeys = new Set<string>();
  const unscopedKey = entryKey(toolName, args, source, trustOrigin, approvalCacheKey);
  if (unscopedKey !== key) denyOnlyKeys.add(unscopedKey);
  if (approvalCacheKey?.memoryKey !== undefined) {
    denyOnlyKeys.add(argsEntryKey(toolName, args, source, trustOrigin, approvalCacheKey.key));
    if (workingDirectoryIdentity !== undefined) {
      denyOnlyKeys.add(argsEntryKey(toolName, args, source, trustOrigin, approvalCacheKey.key, workingDirectoryIdentity));
    }
  }
  const sessionKey = sessionId === undefined ? undefined : conversationEntryKey(key, sessionId);
  const keys = [...denyOnlyKeys, key];
  const file = keys.some((candidate) => !sessionStore.has(candidate)) ? await readApprovalsFile() : undefined;
  const readActive = (candidate: string): UserApprovalEntry | null => {
    const entry = sessionStore.get(candidate) ?? file?.approvals[candidate];
    if (!entry || entry.revokedAt) return null;
    // Invalid allow provenance is a miss; exact denies remain restrictive
    // regardless of the historical display risk stored alongside them.
    if (entry.decision !== "deny" && !hasValidRiskProvenance(entry)) return null;
    sessionStore.set(candidate, entry);
    return entry;
  };
  for (const candidate of denyOnlyKeys) {
    const restrictive = readActive(candidate);
    if (restrictive?.decision === "deny") return restrictive;
  }
  const legacy = readActive(key);
  if (legacy?.decision === "deny") return legacy;
  const conversation = sessionKey === undefined ? undefined : sessionStore.get(sessionKey);
  if (conversation && !conversation.revokedAt && hasValidRiskProvenance(conversation)) return conversation;
  return legacy;
}

/**
 * Backward-compatible allow-only lookup used by the existing reviewer and
 * foreground memory-skip lanes. Exact denies are deliberately invisible here:
 * the authorization choke point reads them through {@link lookupUserDecision}
 * and returns a deny before either auto-allow lane can run.
 */
export async function lookupApproval(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: ApprovalCacheKeyIdentity,
  executionCwd?: string,
  sessionId?: string,
): Promise<UserApprovalEntry | null> {
  const entry = await lookupUserDecision(
    toolName,
    args,
    source,
    trustOrigin,
    approvalCacheKey,
    executionCwd,
    sessionId,
  );
  return entry && (entry.decision ?? "allow") === "allow" ? entry : null;
}

/**
 * Revoke an active approval by key triple.
 *
 * Records `revokedAt` on the persistent entry (if present) and evicts
 * from the session cache. Idempotent: no-op if not found.
 */
export async function revokeApproval(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: ApprovalCacheKeyIdentity,
  executionCwd?: string,
): Promise<void> {
  const key = entryKey(toolName, args, source, trustOrigin, approvalCacheKey,
    executionCwd === undefined ? undefined : captureApprovalWorkingDirectory(executionCwd).identity);

  // Evict from session store.
  sessionStore.delete(key);

  // Mark revoked on disk (if persistent entry exists).
  await mutatePersistentApprovals((file) => {
    const existing = file.approvals[key];
    if (!existing) return;
    existing.revokedAt = new Date().toISOString();
  });
  approvalGeneration += 1;
}

/**
 * Revoke an approval by its raw composite key (as returned by {@link listApprovals}).
 *
 * Used by the PermissionsTab UI which receives pre-computed keys from the IPC list response.
 */
export async function revokeApprovalByKey(rawKey: string): Promise<void> {
  if (sessionStore.get(rawKey)?.scope === "session") {
    sessionStore.delete(rawKey);
    approvalGeneration += 1;
    return;
  }

  await mutatePersistentApprovals((file) => {
    const existing = file.approvals[rawKey];
    if (!existing) return;
    existing.revokedAt = new Date().toISOString();
  });
  sessionStore.delete(rawKey);
  approvalGeneration += 1;
}

/**
 * List all approval entries (including revoked) from the persistent store,
 * augmented with the in-memory session-only entries.
 *
 * Returned entries include the composite key so the UI can pass it back
 * for targeted revocation.
 */
export type UserApprovalListEntry = {
  projectCwd?: string;
  sessionId?: string;
  key: string;
  decision?: UserApprovalDecision;
  approvedAt: string;
  scope: UserApprovalScope;
  verdictAtApproval: UserApprovalVerdict;
  nlJustification: string | null;
  revokedAt: string | null;
  toolName?: string;
  source?: string;
};

function projectApprovalForList(key: string, entry: UserApprovalEntry): UserApprovalListEntry {
  return {
    ...(entry.projectCwd === undefined ? {} : { projectCwd: entry.projectCwd }),
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
    key,
    ...(entry.decision === undefined ? {} : { decision: entry.decision }),
    approvedAt: entry.approvedAt,
    scope: entry.scope,
    verdictAtApproval: entry.verdictAtApproval,
    nlJustification: entry.nlJustification,
    revokedAt: entry.revokedAt,
    ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
    ...(entry.source === undefined ? {} : { source: entry.source }),
  };
}

/** Session rows remain inspectable and revocable when the disk file is corrupt. */
export function listSessionApprovals(): UserApprovalListEntry[] {
  return [...sessionStore.entries()]
    .filter(([, entry]) => entry.scope === "session")
    .map(([key, entry]) => projectApprovalForList(key, entry));
}

export async function listApprovals(): Promise<UserApprovalListEntry[]> {
  const file = await readApprovalsFile();

  const result: UserApprovalListEntry[] = Object.entries(
    file.approvals,
  ).map(([key, entry]) => projectApprovalForList(key, entry));

  // Include session-only entries not persisted to disk.
  for (const row of listSessionApprovals()) {
    if (!file.approvals[row.key]) result.push(row);
  }

  return result;
}

/**
 * Read all persistent approvals (raw file contents). Exported for audit access.
 */
export async function readApprovals(): Promise<ApprovalsFile> {
  return readApprovalsFile();
}

async function scrubLegacyArgsMetadata(): Promise<void> {
  const file = await readApprovalsFile();
  if (!Object.values(file.approvals).some((entry) => entry.args !== undefined)) return;
  await mutatePersistentApprovals((current) => {
    for (const entry of Object.values(current.approvals)) delete entry.args;
  });
  for (const entry of sessionStore.values()) delete entry.args;
}

// ─── Migration helpers ────────────────────────────────────────────────────────

/**
 * Collision resolver: when two stale entries map to the same new key,
 * pick the survivor that preserves the most audit information.
 *
 * Rules (in priority order):
 *   1. A revoked entry (revokedAt non-null) wins — retains audit trail.
 *   2. Among two non-revoked (or two revoked) entries, the earlier approvedAt wins
 *      so we don't silently discard the oldest approval record.
 */
function chooseSurvivor(existing: UserApprovalEntry, incoming: UserApprovalEntry): UserApprovalEntry {
  // Rule 1: prefer revoked entry for audit preservation.
  if (existing.revokedAt && !incoming.revokedAt) return existing;
  if (!existing.revokedAt && incoming.revokedAt) return incoming;

  // Rule 2: prefer the entry with the earlier approvedAt.
  if (existing.approvedAt <= incoming.approvedAt) return existing;
  return incoming;
}

// ─── Boot-time migration ──────────────────────────────────────────────────────

/**
 * One-shot boot-time migration: re-canonicalize stored entry keys to match
 * the deep RFC 8785 JCS behaviour.
 *
 * Under the previous shallow behaviour, nested objects inside arrays were
 * serialized without recursive key-sorting. Entries recorded that way carry a
 * stale hash key that no longer matches what `entryKey()` produces for the
 * same args, silently invalidating the approval.
 *
 * Entries that stored `args` (written after this change) can be re-keyed
 * precisely. Entries without `args` (written before this field was added)
 * cannot be re-keyed and are carried forward unchanged — worst case the user
 * sees one re-prompt for those entries.
 *
 * The function is idempotent: it writes a marker file
 * `~/.ave/permissions/.canonicalization-migration-v1` on first run and
 * skips all work on subsequent boot calls.
 *
 * Atomicity: the updated approvals file is written via temp+rename.
 */
export async function migrateCanonicalization(): Promise<void> {
  const markerPath = migrationMarkerPath();

  // Idempotency check — skip re-keying if migration already completed, while
  // still removing legacy input metadata under its own best-effort boundary.
  let migrationAlreadyCompleted = false;
  try {
    await access(markerPath, constants.F_OK);
    migrationAlreadyCompleted = true;
  } catch {
    // marker absent → proceed
  }
  if (migrationAlreadyCompleted) {
    try {
      // The migration no longer needs raw args after the marker exists. Scrub
      // legacy metadata before returning so future host reads cannot expose
      // values that the approval card deliberately masked.
      await scrubLegacyArgsMetadata();
    } catch (err) {
      log.warn({
        event: "user-approval-args-scrub-failed",
        error: (err as Error).message ?? String(err),
      });
    }
    return;
  }

  // Wrap the entire migration body so a corrupt approvals file or
  // permission error does not crash boot. On failure, skip writing the marker
  // so the next boot will retry.
  try {
    const file = await readApprovalsFile();
    const entries = Object.entries(file.approvals);
    const total = entries.length;
    let migrated = 0;
    let skipped = 0;

    if (total > 0) {
      const updated: Record<string, UserApprovalEntry> = {};

      for (const [storedKey, entry] of entries) {
        // Entries without stored `args` cannot be re-keyed (written before
        // this migration field was introduced). Carry them forward unchanged.
        if (!entry.args || !entry.toolName || !entry.source) {
          updated[storedKey] = entry;
          continue;
        }

        // Guard against pathologically large args strings (>1 MB) to prevent
        // DoS via a hand-crafted approvals file.
        if (entry.args.length > 1_048_576) {
          log.warn({
            event: "r2-migration-args-too-large",
            storedKey,
            argsLength: entry.args.length,
          });
          updated[storedKey] = entry;
          skipped++;
          continue;
        }

        // Re-canonicalize args with the new deep SOT and compute the new key.
        // The stored `args` string is a pre-stringified canonical string;
        // parse it, then re-stringify with the new canonicalStringify to apply
        // recursive key-sorting inside arrays-of-objects.
        let reCanonicalizedArgs: string;
        try {
          const parsed: unknown = JSON.parse(entry.args);
          reCanonicalizedArgs = canonicalStringify(parsed);
        } catch {
          // args is not valid JSON (e.g. a plain string passed directly).
          // Cannot re-canonicalize — carry forward unchanged.
          updated[storedKey] = entry;
          skipped++;
          continue;
        }

        // v1 rows are args-identity rows by construction; re-key them under
        // the same (args) formula they were written with.
        const newKey = argsEntryKey(
          entry.toolName,
          reCanonicalizedArgs,
          entry.source,
          entry.trustOrigin,
          entry.approvalCacheKey,
        );

        if (newKey === storedKey) {
          // No change — args had no nested-array-of-objects, already canonical.
          updated[newKey] = entry;
        } else {
          // Two stale entries may canonicalize to the same newKey.
          // Prefer the revoked entry (revokedAt non-null wins for audit
          // preservation); otherwise prefer the entry with the earlier
          // approvedAt so we don't silently drop historical approvals.
          if (newKey in updated) {
            log.warn({
              event: "r2-migration-collision",
              oldKey: storedKey,
              newKey,
            });
            updated[newKey] = chooseSurvivor(updated[newKey], { ...entry, args: reCanonicalizedArgs });
          } else {
            updated[newKey] = { ...entry, args: reCanonicalizedArgs };
          }
          migrated++;
        }
      }

      if (migrated > 0) {
        await atomicWrite({ approvals: updated });
        // Invalidate session cache entries that were re-keyed.
        sessionStore.clear();
        approvalGeneration += 1;
      }
    }

    // Idempotency marker, through the same writer as the store itself.
    await writeFileAtomicAtPath(
      markerPath,
      `${JSON.stringify({ migratedAt: new Date().toISOString(), migrated, total })}\n`,
    );

    // MEDIUM: route through structured logger (bootAuditLogger not yet
    // available at this call site; createLogger routes to the same sink).
    log.info({
      event: "canonicalization-migration",
      migrated,
      skipped,
      total,
    });
    await scrubLegacyArgsMetadata();
  } catch (err) {
    // Log the failure but do NOT write the marker — next boot will retry.
    log.warn({
      event: "canonicalization-migration-failed",
      error: (err as Error).message ?? String(err),
    });
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * @internal Test only — clears the session cache between test cases.
 *
 * Resetting `persistentWrites` does not cancel an in-flight write — nothing can — it
 * only stops the NEXT write from chaining behind it, which is the isolation this reset is
 * for.
 *
 * There is deliberately NO drain helper beside this, and adding one would be dead code.
 * `mutatePersistentApprovals` RETURNS the promise covering
 * `readApprovalsFile → mutator → atomicWrite`, and every public caller
 * (`recordApproval`, `revokeApproval`, `revokeApprovalByKey`) awaits it — so an awaited
 * write has already landed and there is nothing left to wait for. An earlier version of
 * this file added `__drainPersistentWritesForTest` on the premise that `recordApproval`
 * resolves when the write is merely QUEUED. A reviewer demonstrated that premise is false;
 * the helper was a no-op in all three suites that called it, and the CI teardown failure it
 * was credited with fixing was actually an unflushed `AuditLogger` — see the note in
 * `src/tools/__tests__/executor-approval-memory-skip-integration.test.ts`.
 */
export function __resetSessionStoreForTest(): void {
  if (sessionStore.size > 0) approvalGeneration += 1;
  sessionStore.clear();
  persistentWrites = createSerialQueue();
}
