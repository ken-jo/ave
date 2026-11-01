// Keep durable glob rules separate from exact decision memory. Identity binds tool/source/trust/cwd and canonical args or an opted-in target; changed target-wide args require re-review except explicit per-tool authority, and exact denies block both reviewer and foreground skip paths (docs/research/sandbox-isolation.md).
// The live gate controls persistence: completed HIGH and mandatory one-shot allows cannot persist, exact denies may. Session decisions stay in memory, persistent decisions use private namespace files and atomic exclusive staging/fsync/rename writes; legacy session rows retain process lifetime.
import { mkdir, readFile, stat, chmod } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { writeFileAtomicAtPath, writeFileAtomicAtPathIf } from "../main/storage/feature-namespace.js";
import { aveHome } from "../shared/ave-home.js";
import { matchesMcpToolApprovalMemory, mcpToolApprovalCacheKey, isMcpToolApprovalScope } from "../shared/mcp-tool-approval.js";
import { canonicalStringify } from "../shared/canonical-json.js";
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

import { refreshApprovalPersistence, type ApprovalPersistenceGuard } from "./approval-persistence-guard.js";

let persistentWrites = createSerialQueue();

export interface UserApprovalEntry {
  // Root conversation identity for newly recorded session decisions.
  sessionId?: string;
  // Host-captured directory for display; never an authority supplied by the UI.
  projectCwd?: string;
  // Legacy entries omit this field and are interpreted as an allow.
  decision?: UserApprovalDecision;
  // ISO 8601 wall-clock time the approval was granted.
  approvedAt: string;
  // "session" approvals are held in-memory only; "persistent" are written to disk.
  scope: UserApprovalScope;
  // The reviewer verdict that was shown to the user when they approved.
  verdictAtApproval: UserApprovalVerdict;
  // Host rule risk, separate from a conservative failed-assessment display.
  riskCeilingAtApproval?: UserApprovalVerdict;
  // Optional historical justification. The approval dock does not require renderer-authored prose to record an eligible exact decision.
  nlJustification: string | null;
  // ISO 8601 timestamp when this approval was revoked, or null if active. Revoked entries are retained for audit purposes but treated as absent by lookupApproval.
  revokedAt: string | null;
  // Display metadata — stored alongside the entry so listApprovals can return human-readable tool identity without re-parsing the hash key. Required for PermissionsTab table to show toolName.
  toolName?: string;
  source?: string;
  // Historical input metadata is never granted new authority or returned through approval lists. New entries never persist input text: exact identity is represented solely by the hashed map key so DLP-masked values cannot be recovered through the renderer-readable list API.
  args?: string;
  // trustOrigin component used to compute the entryKey, stored for migration. Optional — absent for entries that did not supply a trustOrigin.
  trustOrigin?: string;
  // approvalCacheKey component used to compute the entryKey, stored for migration. Optional — absent for entries that did not supply an approvalCacheKey.
  approvalCacheKey?: string;
  // Which identity the map key was computed under. Absent on rows written before the cache-key identity existed; those are args-identity rows.
  rememberBy?: "key" | "args";
  // sha256 of the canonical args the decision was made on, for target-wide (`rememberBy: "key"`) rows. A hash, never the input: the list API is renderer-readable and the card may have DLP-masked those values.
  argsIdentity?: string;
}

interface ApprovalsFile {
  // Map from entry key → approval entry.
  approvals: Record<string, UserApprovalEntry>;
}

// In-memory session store

// Session-scoped approvals held in-process only. Not written to disk. Cleared on process exit.
const sessionStore = new Map<string, UserApprovalEntry>();
let approvalGeneration = 0;

// Monotonic identity for Store B approval mutations.
export function getUserApprovalGeneration(): string {
  return String(approvalGeneration);
}

export function userApprovalFilePath(): string {
  return resolve(aveHome(), "permissions", "user-approvals.json");
}

// Bind approval identity to trust origin and semantic key as well as tool/args/source so low-trust calls cannot inherit another origin's approval. Canonical JSON hashing removes irrelevant object-key order differences.
export { canonicalStringify } from "../shared/canonical-json.js";

// Capture once before approval display; persistence consumes the frozen identity.
export function captureApprovalWorkingDirectory(executionCwd: string): { path: string; identity: string } {
  if (!isAbsolute(executionCwd)) throw new Error("Approval working directory must be absolute");
  const path = canonicalizePathForMatch(executionCwd);
  return Object.freeze({ path, identity: sha256Hex(caseFoldForMatch(path)) });
}

// The identity components of one invocation that Store B keys on, besides tool, args, source, trust origin and working directory: - `key`: the tool's policy `approvalCacheKey`. Under args identity it only narrows the exact-input hash (and it is what pre-v2 rows were hashed with). - `memoryKey`: present only when the tool opted into target-wide memory; it then REPLACES the args as the remembered identity.
export interface ApprovalCacheKeyIdentity {
  readonly key?: string;
  readonly memoryKey?: string;
  /** Retains restrictive argument decisions written before this scope had a policy key. */
  readonly scopeKind?: "mcp-tool";
}

// Build the Store B identity from host-derived values. Every caller goes through this, so a site that carries a policy key but forgot to say what memory does fails here instead of being guessed.
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
  if (memory.scope.kind === "mcp-tool") {
    if (!isMcpToolApprovalScope(memory.scope)) throw new Error("Invalid tool approval scope");
    const suffix = ":" + mcpToolApprovalCacheKey(memory.scope);
    const toolName = key?.endsWith(suffix) ? key.slice(0, -suffix.length) : "";
    if (!matchesMcpToolApprovalMemory({ source: "mcp", toolName, mcpServerId: memory.scope.serverId, approvalCacheKey: key, approvalMemory: memory })) {
      throw new Error("Tool approval memory identity does not match its scope");
    }
  }
  return Object.freeze({ ...(key === undefined ? {} : { key }), memoryKey: memory.key,
    ...(memory.scope.kind === "mcp-tool" ? { scopeKind: "mcp-tool" as const } : {}),
  });
}

// Exact input also requires the same tool: different native edits may interpret identical input fields differently.
export function isExactArgsDecision(entry: UserApprovalEntry, args: string, toolName: string): boolean {
  return entry.toolName === toolName && (entry.argsIdentity === undefined || entry.argsIdentity === sha256Hex(args));
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

// Args identity (v1). Byte-for-byte the formula every entry written before the cache-key identity used, so args-identity rows on disk keep matching.
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

// Target-wide identity (v2): the arguments are deliberately absent. The version string keeps this hash space disjoint from argsEntryKey, so a row recorded under the old args+key formula can never be read as a target-wide decision. That is the migration rule: old allows for an opted-in tool stop matching (they only ever covered identical input); old denies are still honoured for their exact input by lookupUserDecision.
function memoryEntryKey(
  toolName: string,
  source: string,
  trustOrigin: string | undefined,
  memoryKey: string,
  workingDirectoryIdentity?: string,
): string {
  const identityTool = source === "builtin" && memoryKey.startsWith("file-write-path:")
    && ["write_file", "edit_file", "multi_edit", "apply_patch"].includes(toolName)
    ? "file-write-path" : toolName;
  return scopeToWorkingDirectory(sha256Hex(canonicalStringify({
    version: "approval-memory-key/v2",
    toolName: identityTool,
    source,
    trustOrigin: trustOrigin || null,
    memoryKey,
  })), workingDirectoryIdentity);
}

// Maps a session to the root conversation that owns its session approvals. A session allow belongs to the root conversation: every agent in that tree (the conversation and the sub-agents it spawned, at any depth) shares it, and separate root conversations never do. This covers every session approval, not only shell ones. Boot registers the one root-session resolver (`createRootSessionResolver`, shared with the judge). Without a runner no session is a child, so each session is its own root; the identity resolver is that exact answer.
type ApprovalConversationRootResolver = (sessionId: string) => string;
const identityConversationRoot: ApprovalConversationRootResolver = (sessionId) => sessionId;
let resolveConversationRoot: ApprovalConversationRootResolver = identityConversationRoot;

export function setApprovalConversationRootResolver(resolver: ApprovalConversationRootResolver): void {
  resolveConversationRoot = resolver;
}

// The root conversation a session approval (and a session shell rule) is keyed and listed under.
export function approvalConversationRoot(sessionId: string): string {
  if (!sessionId.trim()) throw new Error("Approval session identity must be non-empty");
  const root = resolveConversationRoot(sessionId);
  if (!root.trim()) throw new Error("Approval root session identity must be non-empty");
  return root;
}

// A user-global exact decision (owner 2026-10-25): the same tool, input and origin in any project. Its own key namespace, so it never collides with a
// legacy unscoped row (those only ever restrict a lookup) or with a project row.
function globalEntryKey(unscopedKey: string): string {
  return sha256Hex(canonicalStringify({ version: "global/v1", key: unscopedKey }));
}

function conversationEntryKey(key: string, rootSessionId: string): string {
  return sha256Hex(canonicalStringify({ version: "conversation/v1", key, sessionId: rootSessionId }));
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

// Report corrupt decision memory: readers fail closed to the dock and writers refuse replacement, preserving saved approvals.
export class UserApprovalStoreCorruptError extends Error {
  constructor(readonly filePath: string, detail: string) {
    super(`Saved approvals file ${filePath} is corrupt: ${detail}. Fix or remove the file; its approvals are not in force.`);
    this.name = "UserApprovalStoreCorruptError";
  }
}

async function readApprovalsFile(): Promise<ApprovalsFile> {
  const path = userApprovalFilePath();
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

async function atomicWrite(data: ApprovalsFile, authority?: ApprovalPersistenceGuard): Promise<void> {
  const path = userApprovalFilePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Verify directory permissions haven't drifted. Kept here rather than pushed into the shared writer: this store holds granted approvals, so a widened directory is a finding in its own right, and the shared writer's `chmod` back to 0o700 is best-effort and silent by design.
  const dirStat = await stat(dir);
  if ((dirStat.mode & 0o777) !== 0o700) {
    await chmod(dir, 0o700);
  }

// The shared namespace writer owns exclusive random staging, file/directory fsync and rename to prevent symlink redirection.
  if (authority) {
    if (!await writeFileAtomicAtPathIf(path, `${JSON.stringify(data, null, 2)}\n`, authority.isCurrent, () => refreshApprovalPersistence(authority))) throw new Error("Approval authority is unavailable");
  } else {
    await writeFileAtomicAtPath(path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

async function mutatePersistentApprovals(
  mutator: (file: ApprovalsFile) => Promise<void> | void,
  authority?: ApprovalPersistenceGuard,
): Promise<void> {
  return persistentWrites(async () => {
    const file = await readApprovalsFile();
    await mutator(file);
    await atomicWrite(file, authority);
  });
}

// Record a user approval decision. For "session" scope, stores only in memory (no disk write). For "persistent" scope, appends to ~/.ave/permissions/user-approvals.json. The IPC caller must bind an allow to a live request whose host snapshot permits persistence. This storage layer does not derive authority from risk.
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
  authority?: ApprovalPersistenceGuard,
): Promise<void> {
  if (!isApprovalVerdict(entry.verdictAtApproval) ||
      (entry.riskCeilingAtApproval !== undefined && !isApprovalVerdict(entry.riskCeilingAtApproval))) {
    throw new Error("Invalid approval risk provenance");
  }
  // A global decision is keyed without the working directory: it applies in every project.
  const baseKey = entry.scope === "global"
    ? globalEntryKey(entryKey(toolName, args, source, entry.trustOrigin, entry.approvalCacheKey))
    : entryKey(toolName, args, source, entry.trustOrigin, entry.approvalCacheKey, entry.workingDirectoryIdentity);
  if (entry.scope === "global" && entry.projectCwd !== undefined) throw new Error("A global approval names no project");
  if (entry.sessionId !== undefined && entry.scope !== "session") throw new Error("Conversation identity requires session scope");
  // A session approval always belongs to a root conversation (owner decision 2026-10-23); an unscoped one would authorize every conversation.
  if (entry.scope === "session" && entry.sessionId === undefined) throw new Error("A session approval requires its conversation session");
  const rootSessionId = entry.sessionId === undefined ? undefined : approvalConversationRoot(entry.sessionId);
  const key = rootSessionId === undefined ? baseKey : conversationEntryKey(baseKey, rootSessionId);
  const full: UserApprovalEntry = {
    ...(rootSessionId === undefined ? {} : { sessionId: rootSessionId }),
    ...(entry.projectCwd === undefined ? {} : { projectCwd: entry.projectCwd }),
    decision: entry.decision ?? "allow",
    approvedAt: entry.approvedAt ?? new Date().toISOString(),
    scope: entry.scope,
    verdictAtApproval: entry.verdictAtApproval,
    ...(entry.riskCeilingAtApproval === undefined ? {} : { riskCeilingAtApproval: entry.riskCeilingAtApproval }),
    nlJustification: entry.nlJustification,
    revokedAt: null,
    // Store display metadata so listApprovals can surface toolName/source without re-parsing the hash key.
    toolName,
    source,
    // Raw canonical args are intentionally used only for `key` above. Never persist them as metadata: listApprovals is renderer-readable and the approval card may have DLP-masked the same values before display.
    ...(entry.trustOrigin !== undefined ? { trustOrigin: entry.trustOrigin } : {}),
    ...(entry.approvalCacheKey?.key !== undefined ? { approvalCacheKey: entry.approvalCacheKey.key } : {}),
    rememberBy: entry.approvalCacheKey?.memoryKey !== undefined ? "key" : "args",
    ...(entry.approvalCacheKey?.memoryKey !== undefined ? { argsIdentity: sha256Hex(args) } : {}),
  };

  if (entry.scope === "session") {
    await refreshApprovalPersistence(authority);
    sessionStore.set(key, full);
    approvalGeneration += 1;
    return;
  }

  // persistent or global — write to disk
  await mutatePersistentApprovals((file) => {
    file.approvals[key] = full;
  }, authority);
  // Mirror into session cache for fast lookups.
  sessionStore.set(key, full);
  approvalGeneration += 1;
}

// Look up an active (non-revoked) approval for the given triple. Fast path: checks the in-memory session store first. For persistent-scoped entries that survived a restart, falls through to the disk file. Returns null when no approval is found or the approval is revoked.
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
  // Rows that may only ever restrict this lookup, never allow it: - the unscoped key: existing unscoped denials retain their original scope and precedence; no legacy allow is migrated or widened. - for a target-wide identity, the rows the same invocation has under the args(+policy key) formula. An exact deny saved before the tool opted in keeps blocking; an old allow (identical-input only) is ignored.
  const denyOnlyKeys = new Set<string>();
  const unscopedKey = entryKey(toolName, args, source, trustOrigin, approvalCacheKey);
  if (unscopedKey !== key) denyOnlyKeys.add(unscopedKey);
  if (approvalCacheKey?.memoryKey !== undefined) {
    // Old per-tool path denies remain restrictive; old allows never widen to the shared identity.
    if (source === "builtin" && approvalCacheKey.memoryKey.startsWith("file-write-path:")
      && ["write_file", "edit_file", "multi_edit", "apply_patch"].includes(toolName)) {
      const legacyMemoryKey = toolName + approvalCacheKey.memoryKey.slice("file-write-path".length);
      const legacyUnscopedKey = memoryEntryKey(toolName, source, trustOrigin, legacyMemoryKey);
      denyOnlyKeys.add(legacyUnscopedKey);
      denyOnlyKeys.add(globalEntryKey(legacyUnscopedKey));
      if (workingDirectoryIdentity !== undefined) {
        const legacyProjectKey = memoryEntryKey(toolName, source, trustOrigin, legacyMemoryKey, workingDirectoryIdentity);
        denyOnlyKeys.add(legacyProjectKey);
        if (sessionId !== undefined) denyOnlyKeys.add(conversationEntryKey(legacyProjectKey, approvalConversationRoot(sessionId)));
      } else if (sessionId !== undefined) {
        denyOnlyKeys.add(conversationEntryKey(legacyUnscopedKey, approvalConversationRoot(sessionId)));
      }
    }
    // Server tools had no policy key before per-tool scopes. Keep those exact
    // denials restrictive without migrating an old exact allow into broad consent.
    const legacyPolicyKeys = source === "mcp" && approvalCacheKey.scopeKind === "mcp-tool"
      ? [approvalCacheKey.key, undefined] : [approvalCacheKey.key];
    for (const policyKey of legacyPolicyKeys) {
      const legacyArgsUnscopedKey = argsEntryKey(toolName, args, source, trustOrigin, policyKey);
      denyOnlyKeys.add(legacyArgsUnscopedKey);
      denyOnlyKeys.add(globalEntryKey(legacyArgsUnscopedKey));
      if (workingDirectoryIdentity !== undefined) {
        const legacyArgsProjectKey = argsEntryKey(toolName, args, source, trustOrigin, policyKey, workingDirectoryIdentity);
        denyOnlyKeys.add(legacyArgsProjectKey);
        if (sessionId !== undefined) denyOnlyKeys.add(conversationEntryKey(legacyArgsProjectKey, approvalConversationRoot(sessionId)));
      } else if (sessionId !== undefined) {
        denyOnlyKeys.add(conversationEntryKey(legacyArgsUnscopedKey, approvalConversationRoot(sessionId)));
      }
    }
  }
  const sessionKey = sessionId === undefined ? undefined : conversationEntryKey(key, approvalConversationRoot(sessionId));
  const globalKey = globalEntryKey(unscopedKey);
  const keys = [...denyOnlyKeys, key, globalKey];
  const file = keys.some((candidate) => !sessionStore.has(candidate)) ? await readApprovalsFile() : undefined;
  const readActive = (candidate: string): UserApprovalEntry | null => {
    const entry = sessionStore.get(candidate) ?? file?.approvals[candidate];
    if (!entry || entry.revokedAt) return null;
    // Invalid allow provenance is a miss; exact denies remain restrictive regardless of the historical display risk stored alongside them.
    if (entry.decision !== "deny" && !hasValidRiskProvenance(entry)) return null;
    sessionStore.set(candidate, entry);
    return entry;
  };
  for (const candidate of denyOnlyKeys) {
    const restrictive = readActive(candidate);
    if (restrictive?.decision === "deny") return restrictive;
  }
  // A deny at any scope beats every allow. Among allows the narrower one answers (conversation, then project, then global); since all of them allow,
  // the order only decides which row the hit reports.
  const legacy = readActive(key);
  if (legacy?.decision === "deny") return legacy;
  const global = readActive(globalKey);
  if (global?.decision === "deny") return global;
  const conversation = sessionKey === undefined ? undefined : sessionStore.get(sessionKey);
  if (conversation && !conversation.revokedAt && hasValidRiskProvenance(conversation)) return conversation;
  return legacy ?? global;
}

// Backward-compatible allow-only lookup used by the existing reviewer and foreground memory-skip lanes. Exact denies are deliberately invisible here: the authorization choke point reads them through lookupUserDecision and returns a deny before either auto-allow lane can run.
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

// Revoke an active approval by key triple. Records `revokedAt` on the persistent entry (if present) and evicts from the session cache. Idempotent: no-op if not found.
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

// Revoke an approval by its raw composite key (as returned by listApprovals). Used by the PermissionsTab UI which receives pre-computed keys from the IPC list response.
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

// List all approval entries (including revoked) from the persistent store, augmented with the in-memory session-only entries. Returned entries include the composite key so the UI can pass it back for targeted revocation.
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

// Forget the "This session" approvals of a conversation that ended (owner 2026-10-25: session scope dies with the session). Returns how many were dropped.
// Session approvals are held under the root conversation, so only a root id is accepted: a sub-agent's end must not drop its parent's approvals.
export function dropSessionApprovals(rootSessionId: string): number {
  if (approvalConversationRoot(rootSessionId) !== rootSessionId) {
    throw new Error("Session approvals end only with their root conversation");
  }
  const root = rootSessionId;
  let dropped = 0;
  for (const [key, entry] of sessionStore) {
    if (entry.scope === "session" && entry.sessionId === root) {
      sessionStore.delete(key);
      dropped += 1;
    }
  }
  if (dropped > 0) approvalGeneration += 1;
  return dropped;
}

// Session rows remain inspectable and revocable when the disk file is corrupt.
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

// Read all persistent approvals (raw file contents). Exported for audit access.
export async function readApprovals(): Promise<ApprovalsFile> {
  return readApprovalsFile();
}

// Test helpers

// Resetting the write chain isolates later tests but cannot cancel in-flight writes. Public mutation promises already await atomic persistence; no drain helper is needed.
export function __resetSessionStoreForTest(): void {
  if (sessionStore.size > 0) approvalGeneration += 1;
  sessionStore.clear();
  resolveConversationRoot = identityConversationRoot;
  persistentWrites = createSerialQueue();
}
