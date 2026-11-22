import { dialog, ipcMain, shell } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs, type Dirent } from "node:fs";
import { isAbsolute as isAbsolutePath, join, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { ensureFileAccess, sensitiveFilePattern } from "../../tools/file-access-policy.js";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import {
  readPermissionSettings,
  PermissionSettingsUnreadableError,
  addAllowedDirectoryPersist,
} from "../../permissions/permission-settings-store.js";
import {
  buildRuntimeAllowedDirectories,
  sanitizeRuntimeAllowedDirectories,
  validateDirectoryAddition,
} from "../../permissions/allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  resolvePathForPolicy,
  isSensitivePath,
  allowKeyMaterialInspectionUnder,
} from "../../permissions/sensitive-paths.js";
import { listAuthorizedWorkspaceRoots } from "../../permissions/workspace-authorized-roots.js";
import { getDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import {
  reconcileWorkspaceRoots,
  removeWorkspaceRootWithIntent,
  retainedDescendantWorkspaceRoots,
  workspaceRootRemovalContext,
  opaqueWorkspaceRootAuditRef,
} from "../../permissions/workspace-root-reconciler.js";
import {
  setWorkspaceRootLifecycle,
  withWorkspaceRootLifecycleLock,
} from "../../permissions/workspace-root-lifecycle.js";
import { getActivePluginSurfacePermissionScope } from "../../boot/plugin-surface-permissions.js";
import { detachWorkspaceRootSessions } from "../../memory/workspace-root-session-lifecycle.js";
import { errorMessage } from "../../shared/error-message.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import { validateAppWindowMainFrameSender } from "../app-window-sender.js";
import { linkChainVerdict, openVerifiedExternalFile, type ExternalOpenPass, type ExternalOpenRefusal } from "../../main/external-open-target.js";
import { buildEditorArgv, launchEditor } from "../../main/editor-command.js";
import { readUserEditableFile, saveUserFileEdit, type UserFileEditError } from "../../memory/code-checkpoints.js";
import { decodeEditableText, encodeEditableText, type EditableTextRefusal } from "../../shared/editable-text.js";
import { isWindowsNetworkOrDevicePath } from "../../shared/shell-native-path.js";
import {
  searchWorkspaceFiles,
  WORKSPACE_FILE_QUERY_MAX_CHARS,
  type WorkspaceFileMatch,
} from "./workspace-file-search.js";

const log = createLogger("ave");

const MAX_DIR_ENTRIES = 1_000;

const ACK_TOKEN_TTL_MS = 60_000;

// Keep warned picks in main behind one-time tokens; acknowledgment never accepts a renderer path.
/** Tokens main handed to one window: each is redeemed once, before it expires, and only by the window it was handed to. */
const pendingPicks = new Map<string, { path: string; expires: number; gesture: PickGesture; senderId: number }>();

// Native workspace gestures retain their direct-UI boundary; agent folder approval uses its own pipeline.
function validateWorkspaceDirectoryAddition(rawPath: string): ReturnType<typeof validateDirectoryAddition> {
  const verdict = validateDirectoryAddition(rawPath);
  if (!verdict.ok) return verdict;
  const sensitive = sensitiveFilePattern(expandLeadingTilde(rawPath), "write");
  return sensitive ? { ok: false, reason: `path matches sensitive pattern '${sensitive}'`, adjacencyWarnings: verdict.adjacencyWarnings } : verdict;
}

// Record picker, drop or undo provenance in widening audits; dropped paths have no native-picker authority, and an undo
// re-adds only the main-owned path a removal just took out.
type PickGesture = "dialog" | "drop" | "undo";

function prunePendingPicks(now: number): void {
  for (const [token, pending] of pendingPicks) {
    if (now > pending.expires) pendingPicks.delete(token);
  }
}

// Map validator prose to stable localized error codes before crossing IPC.
function directoryDenyCode(reason: string): "invalid-path" | "path-not-allowed" | "sensitive-path" {
  if (reason.startsWith("path matches sensitive pattern")) return "sensitive-path";
  if (reason === "filesystem root is not allowed") return "path-not-allowed";
  return "invalid-path";
}

export interface WorkspaceRoot {
  path: string;
  isDefault: boolean;
}

export interface WorkspaceListRootsResult {
  ok: boolean;
  defaultRoot?: string;
  roots?: WorkspaceRoot[];
  cleanupPending?: number;
  // Return trustworthy roots alongside a warning when only part of persisted settings is interpretable.
  settingsFault?: "pending-removals-malformed";
  error?: string;
}

export interface WorkspacePickRootResult {
  ok: boolean;
  canceled?: boolean;
  added?: string;
  roots?: WorkspaceRoot[];
  warnings?: string[];
  // Warned picks remain unpersisted until the renderer returns the acknowledgment token.
  requiresAcknowledgement?: boolean;
  pendingPath?: string;
  // Bind acknowledgment to the exact main-owned path; tokens expire and are single-use.
  ackToken?: string;
  error?: string;
}

// Dropped paths require validation and acknowledgment even without warnings; preparation grants no scope.
export interface WorkspaceDropPrepareResult {
  ok: boolean;
  // Reject sensitive paths and non-directories; never infer a dropped file's parent.
  error?: string;
  warnings?: string[];
  pendingPath?: string;
  ackToken?: string;
}

export interface WorkspaceDirEntry {
  name: string;
  path: string;
  // A link is listed, never followed: its target stays in main and only `outside` crosses IPC.
  type: "file" | "directory" | "link";
  /** Links only: the link's real target is not inside the project root that contains this folder (or cannot be resolved). */
  outside?: boolean;
  /** From the entry's own lstat; a link reports the link, not its target. */
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface WorkspaceListDirResult {
  ok: boolean;
  path?: string;
  entries?: WorkspaceDirEntry[];
  truncated?: boolean;
  /** How many listable entries the cap left out, counted after sorting (folders first). */
  omitted?: number;
  /** How many entries the sensitive-path floor left out, so an empty folder can say whether anything was hidden. */
  hidden?: number;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "permission-denied" | "not-found" | "read-failed";
  message?: string;
}

/** `outside-project` = the real target is not inside `projectRoot`; the rest come from the shared open sequence. */
export type WorkspaceOpenPathResult =
  | { ok: true }
  | {
    ok: false;
    error:
      | "unauthorized"
      | typeof USER_KEYBOARD_REQUIRED.error
      | "invalid-request"
      | "settings-unreadable"
      | "root-not-registered"
      | "path-not-allowed"
      | "sensitive-path"
      | "outside-project"
      | ExternalOpenRefusal;
  };

/** "Open in editor": the open-path refusals, plus no command being set, a command that cannot be split into a program and
 * arguments, and a program the OS could not start (which replaces the default app's `open-failed`). */
export type WorkspaceOpenInEditorResult =
  | { ok: true }
  | { ok: false; error: Exclude<Extract<WorkspaceOpenPathResult, { ok: false }>["error"], "open-failed"> | "not-configured" | "invalid-command" | "launch-failed" };

type ProjectFileRefusal = Exclude<Extract<WorkspaceOpenPathResult, { ok: false }>["error"], "open-failed">;

/** The in-app editor's read: the whole text with "\n" line breaks, and the hash of the file's bytes that a save must name.
 * Refused for a file a text box cannot give back byte for byte (see `editable-text.ts`) or cannot replace in place. */
export type WorkspaceReadForEditResult =
  | { ok: true; text: string; hash: string }
  | { ok: false; error: ProjectFileRefusal | EditableTextRefusal | "not-editable" };

/** The in-app editor's save. `changed` means the file no longer holds what the edit started from; nothing was written. */
export type WorkspaceSaveEditResult =
  | { ok: true; hash: string }
  | { ok: false; error: ProjectFileRefusal | EditableTextRefusal | UserFileEditError };

export interface WorkspaceRemoveRootResult {
  ok: boolean;
  removed?: string;
  roots?: WorkspaceRoot[];
  // Report pruned path grants; directory removal alone cannot revoke the separate rule-tier authority.
  prunedGrants?: number;
  cleanupPending?: boolean;
  /** One-time token that re-adds exactly the removed folder through `pickRoot({ackToken})`, within the ack TTL. Absent while
   * cleanup is pending, so an undo cannot race the deferred revocation. */
  undoToken?: string;
  error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default" | "lifecycle-failed";
  message?: string;
}

/** What removing a project would end or prune (case 31). Each count comes from the store that removal changes, by the same predicate. */
export interface WorkspaceRemovalCounts {
  /** Conversations with a turn running now that removal aborts, by the same per-loop test. The window's own terminals and
   * pages that removal closes are counted by the renderer, which closes them. */
  streamingSessions: number;
  /** Saved "always allow" path grants under the folder. Undo does not bring them back. */
  pathGrants: number;
  /** Routines whose folder scope narrows. Undo does not bring that back. */
  routines: number;
  /** Conversations whose project link is cleared. Their transcripts stay. */
  detachableSessions: number;
}

export type WorkspacePreviewRemoveRootResult =
  | { ok: true; counts: WorkspaceRemovalCounts }
  | { ok: false; error: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default" | "preview-failed" };

type WorkspaceSearchFilesResult =
  | { ok: true; matches: WorkspaceFileMatch[]; truncated: boolean }
  | { ok: false; error: "unauthorized" | "invalid-query" | "settings-unreadable" | "folder-not-allowed" };


export interface WorkspaceRevealResult {
  ok: boolean;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
  message?: string;
}

function currentScope(): { cwd: string; extraAllowed: string[] } {
  const cwd = getDefaultWorkspaceRoot();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  return { cwd, extraAllowed: buildRuntimeAllowedDirectories(additional) };
}

/** Case-folded canonical form used for every root and containment comparison in this domain. */
function matchKey(path: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(path));
}

/** Containment between two match keys, which use "/" on every platform (`foldCanonicalPathSeparators`). */
function keyWithin(rootKey: string, key: string): boolean {
  return key === rootKey || key.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`);
}

/** The registered root `projectRoot` names, compared canonically; null when it is not (or no longer) a project root. */
function registeredRoot(projectRoot: string): WorkspaceRoot | null {
  const key = matchKey(projectRoot);
  return computeRoots().find((root) => matchKey(root.path) === key) ?? null;
}

/** The innermost registered root containing `dir`; links in a folder outside every root count as outside. */
function containingRoot(dir: string): { key: string; path: string } | null {
  const dirKey = matchKey(dir);
  let best: { key: string; path: string } | null = null;
  for (const root of computeRoots()) {
    const key = matchKey(root.path);
    if (keyWithin(key, dirKey) && (best === null || key.length > best.key.length)) best = { key, path: root.path };
  }
  return best;
}

/**
 * A link target compared as the filesystem spells it: one separator and the platform's case folding, as the sandbox's
 * `isWithin` does, but no NFC folding. On ext4 an NFD folder and its NFC sibling are different folders, so folding here would
 * call a link into the sibling inside the root.
 */
function lexicalKey(path: string): string {
  // Not `foldCanonicalPathSeparators`, which also NFC-normalizes. Network and device targets are refused before this point.
  return caseFoldForMatch(path.replace(/[\\/]+/gu, "/"));
}

/**
 * Whether a readlink string has a `..` segment. Resolving one lexically folds it against the spelled parent, but the OS folds
 * it against the physical parent of whatever the preceding components resolve to: `linkdir/../x` with `linkdir -> ../out/sub`
 * lands in `../out`, not beside `linkdir`. Such a target is not judged lexically at all.
 */
function linkTargetClimbs(target: string): boolean {
  return target.split(/[\\/]+/u).includes("..");
}

/** A UNC or device spelling, judged as Windows reads it on every platform: such a link is never resolved, only marked outside. */
function isLinkTargetNetworkOrDevice(target: string): boolean {
  return isWindowsNetworkOrDevicePath(target, "win32");
}

/**
 * Whether a link listed in `realDir` points outside `realRoot`, decided without touching anything through a link: the readlink
 * string is resolved lexically against the link's own folder. A network or device target, a target outside the root, and a
 * target reached through another link (a chain, or a linked folder on the way) all count as outside. Only components that are
 * already known not to be links are lstat'ed, so the OS never follows a link here.
 */
async function linkPointsOutside(realDir: string, linkName: string, realRoot: string): Promise<boolean> {
  const target = await fs.readlink(join(realDir, linkName));
  if (isLinkTargetNetworkOrDevice(target)) return true;
  // A `..` in the target is resolved by the OS against physical parents, which this lexical check cannot see: outside.
  if (linkTargetClimbs(target)) return true;
  const lexical = resolvePath(realDir, target);
  if (isLinkTargetNetworkOrDevice(lexical)) return true;
  const rootKey = lexicalKey(realRoot);
  const targetKey = lexicalKey(lexical);
  if (!keyWithin(rootKey, targetKey)) return true;
  // Inside the root: walk from the root down, refusing any link on the way, including the target itself. The walk counts
  // components below the root and takes them from the target's own spelling instead of cutting the string at the root's
  // length.
  const below = targetKey.slice(rootKey.length).split("/").filter(Boolean).length;
  const parts = lexical.split(/[\\/]+/u).filter(Boolean);
  let current = realRoot;
  for (const component of parts.slice(parts.length - below)) {
    current = join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Map a filesystem failure to the folder view's stable codes. */
/** A listing row's kind from its directory entry; a filesystem that does not report the kind there costs one lstat. Sockets,
 * pipes and devices are not listed. */
async function listedEntryType(ent: Dirent, full: string): Promise<WorkspaceDirEntry["type"] | null> {
  if (ent.isSymbolicLink()) return "link";
  if (ent.isFile()) return "file";
  if (ent.isDirectory()) return "directory";
  if (ent.isFIFO() || ent.isSocket() || ent.isCharacterDevice() || ent.isBlockDevice()) return null;
  try {
    const info = await fs.lstat(full);
    return info.isSymbolicLink() ? "link" : info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
  } catch {
    // Removed between readdir and lstat; it is no longer there to show.
    return null;
  }
}

function listDirFailure(err: unknown): "permission-denied" | "not-found" | "read-failed" {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENOENT" || code === "ENOTDIR") return "not-found";
  return "read-failed";
}

function computeRoots(): WorkspaceRoot[] {
  const defaultRoot = getDefaultWorkspaceRoot();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  const canonicalAdds = sanitizeRuntimeAllowedDirectories(additional);
  const seen = new Set<string>([matchKey(defaultRoot)]);
  const roots: WorkspaceRoot[] = [{ path: defaultRoot, isDefault: true }];
  for (const dir of canonicalAdds) {
    const key = matchKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ path: resolvePathForPolicy(dir), isDefault: false });
  }
  return roots;
}

export function registerWorkspaceHandlers(deps: IpcDeps): void {
  // A `.pem` or `.key` file is opened to see whether it holds a private key only inside the person's projects: the
  // registered ones and the folders live conversations work in. If the project list cannot be read, only the latter
  // qualify and other such names are judged on the name alone.
  allowKeyMaterialInspectionUnder(() => {
    const live = listAuthorizedWorkspaceRoots();
    try { return [...computeRoots().map((root) => root.path), ...live]; }
    catch (error) {
      if (error instanceof PermissionSettingsUnreadableError) return live;
      throw error;
    }
  });
  const { auditLogger, getMainWindow } = deps;
  type WorkspaceMemoryLifecycle = {
    allowProjectRoot?: (root: string) => unknown;
    detachSessionsFromProject?: (root: string) => unknown;
  };
  type WorkspaceRootRevocationOptions = {
    globalScopeWasAuthorized?: boolean;
    preserveRoots?: readonly string[];
  };
  type WorkspaceLoopLifecycle = {
    revokeWorkspaceRoot?: (root: string, options?: WorkspaceRootRevocationOptions) => unknown;
  };

  const stableErrorCode = (error: unknown): string => {
    const candidate =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : error instanceof Error
          ? error.name
          : undefined;
    const code = String(candidate ?? "UNKNOWN").toUpperCase();
    return /^[A-Z0-9_-]{1,64}$/.test(code) ? code : "UNKNOWN";
  };
  const isLifecycleCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

  const auditLifecycleWarning = (
    source: string,
    root: string,
    phase:
      | "allow"
      | "revoke-live-scopes"
      | "prune-path-grants"
      | "prune-routine-scopes"
      | "detach-sessions",
    error: unknown,
  ): void => {
    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "workspace-root-lifecycle",
        type: "warn",
        input: JSON.stringify({
          channel: source,
          path: opaqueWorkspaceRootAuditRef(root),
          lifecyclePhase: phase,
          errorCode: stableErrorCode(error),
        }),
      });
    } catch {
      // An audit sink failure must not mask the lifecycle decision itself.
    }
  };

  const sessionMemoryManagers = (
    source: string = CHANNELS.workspace.listRoots,
    root: string = getDefaultWorkspaceRoot(),
    failClosed = false,
  ): WorkspaceMemoryLifecycle[] => {
    const managers: WorkspaceMemoryLifecycle[] = [];
    const add = (candidate: unknown): void => {
      if (
        candidate &&
        (typeof candidate === "object" || typeof candidate === "function") &&
        !managers.includes(candidate as WorkspaceMemoryLifecycle)
      ) {
        managers.push(candidate as WorkspaceMemoryLifecycle);
      }
    };
    const primary = deps.memoryManager?.sessions as unknown as WorkspaceMemoryLifecycle | undefined;
    if (failClosed && typeof primary?.detachSessionsFromProject !== "function") {
      const error = Object.assign(new Error("workspace memory manager unavailable"), {
        code: "MEMORY_MANAGER_UNAVAILABLE",
      });
      auditLifecycleWarning(source, root, "detach-sessions", error);
      throw error;
    }
    add(primary);
    try {
      const sideLoop = deps.sideChatConversationLoop as
        | { deps?: { memoryManager?: unknown } }
        | undefined;
      const sideMemoryManager = sideLoop?.deps?.memoryManager as IpcDeps["memoryManager"] | undefined;
      add(sideMemoryManager?.sessions);
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "detach-sessions", error);
      if (failClosed) throw error;
    }
    try {
      add(deps.getSubAgentRunner?.());
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "detach-sessions", error);
      if (failClosed) throw error;
    }
    return managers;
  };

  async function detachWorkspaceRootSessionsBeforeRemoval(
    root: string,
    source: string,
  ): Promise<number> {
    try {
      return await detachWorkspaceRootSessions(
        root,
        sessionMemoryManagers(source, root, true),
      );
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "detach-sessions", error);
      throw Object.assign(new Error("workspace-root-session-detach-failed"), {
        code: stableErrorCode(error),
      });
    }
  }
  const allowWorkspaceRoot = (root: string, source: string, allowRoutine = true): void => {
    for (const manager of sessionMemoryManagers(source, root)) {
      if (typeof manager.allowProjectRoot !== "function") continue;
      try {
        manager.allowProjectRoot(root);
      } catch (error: unknown) {
        auditLifecycleWarning(source, root, "allow", error);
      }
    }
    if (allowRoutine && typeof deps.routineEngine?.allowWorkspaceRoot === "function") {
      try {
        deps.routineEngine.allowWorkspaceRoot(root);
      } catch (error: unknown) {
        auditLifecycleWarning(source, root, "allow", error);
      }
    }
  };

  /**
   * Everything that holds a live scope over workspace roots, in revocation order. Removal revokes each; its preview asks each
   * how many running turns that revocation would stop, so the two walk one list. Throws when the sub-agent runner cannot be
   * reached, unless asked to go on without it.
   */
  function workspaceLiveScopeOwners(options: { withoutSubAgents?: boolean } = {}): unknown[] {
    const owners: unknown[] = [
      ...(deps.listChatGroupLoops?.() ?? [deps.conversationLoop]),
      deps.sideChatConversationLoop,
      ...(deps.paneChatLoops?.all() ?? []),
      deps.routineEngine,
      // Revoke plugin session grants too; they are independent live scope owners.
      getActivePluginSurfacePermissionScope(),
    ];
    if (!options.withoutSubAgents) owners.push(deps.getSubAgentRunner?.());
    return owners;
  }

  async function finalizeRemovedWorkspaceRoot(
    root: string,
    source: string,
    options: WorkspaceRootRevocationOptions,
  ): Promise<{ liveScopesRevoked: number }> {
    let liveScopesRevoked = 0;
    const errors: unknown[] = [];
    try {
      await deps.pluginRuntime.retireSandboxGrantsOutsideCeiling();
    } catch (error: unknown) {
      errors.push(error);
      auditLifecycleWarning(source, root, "revoke-live-scopes", error);
    }
    try {
      // A template run on the removed project loses its live stages now, not at their next tool call.
      deps.workBoardEngine?.projectRootRevoked(root);
    } catch (error: unknown) {
      errors.push(error);
      auditLifecycleWarning(source, root, "revoke-live-scopes", error);
    }
    let liveScopeOwners: unknown[];
    try {
      liveScopeOwners = workspaceLiveScopeOwners();
    } catch (error: unknown) {
      errors.push(error);
      auditLifecycleWarning(source, root, "revoke-live-scopes", error);
      liveScopeOwners = workspaceLiveScopeOwners({ withoutSubAgents: true });
    }
    for (const candidate of liveScopeOwners) {
      const loop = candidate as WorkspaceLoopLifecycle | undefined;
      if (typeof loop?.revokeWorkspaceRoot !== "function") continue;
      try {
        const result = await Promise.resolve(loop.revokeWorkspaceRoot(root, options)) as
          | {
              sessionDirectoriesRemoved?: unknown;
              turnDirectoriesRemoved?: unknown;
              liveScopesRevoked?: unknown;
            }
          | null
          | undefined;
        const hasDirectResult = Boolean(
          result && typeof result === "object" && "liveScopesRevoked" in result,
        );
        let removed: number | null = null;
        if (hasDirectResult) {
          if (isLifecycleCount(result?.liveScopesRevoked)) {
            removed = result.liveScopesRevoked;
          }
        } else if (
          isLifecycleCount(result?.sessionDirectoriesRemoved) &&
          isLifecycleCount(result?.turnDirectoriesRemoved)
        ) {
          const combined = result.sessionDirectoriesRemoved + result.turnDirectoriesRemoved;
          if (Number.isSafeInteger(combined)) removed = combined;
        }
        if (removed === null) {
          const invalidResult = Object.assign(
            new Error("workspace-root-live-scope-revoke-invalid-result"),
            { code: "WORKSPACE_ROOT_LIVE_SCOPE_REVOKE_INVALID_RESULT" },
          );
          errors.push(invalidResult);
          auditLifecycleWarning(source, root, "revoke-live-scopes", invalidResult);
          continue;
        }
        liveScopesRevoked += removed;
      } catch (error: unknown) {
        errors.push(error);
        auditLifecycleWarning(source, root, "revoke-live-scopes", error);
      }
    }

    if (errors.length > 0) {
      throw Object.assign(
        new AggregateError(errors, "workspace-root-live-scope-revoke-failed"),
        { code: "WORKSPACE_ROOT_LIVE_SCOPE_REVOKE_FAILED" },
      );
    }

    return { liveScopesRevoked };
  }
  async function pruneWorkspaceRootGrants(
    root: string,
    source: string,
    preserveRoots: readonly string[] = [],
  ): Promise<{
    count: number;
    audit: Array<{ tool: string; tier: string; path: string }>;
  }> {
    const permissionManager = deps.conversationLoop?.permissionManager;
    if (!permissionManager) {
      const error = Object.assign(new Error("workspace permission manager unavailable"), {
        code: "PERMISSION_MANAGER_UNAVAILABLE",
      });
      auditLifecycleWarning(source, root, "prune-path-grants", error);
      throw error;
    }
    try {
      const pruned = await permissionManager.prunePathGrantsUnderRoot(root, { preserveRoots });
      return {
        count: pruned.length,
        audit: pruned.map((grant) => ({
          tool: grant.toolName,
          tier: grant.tier,
          path: opaqueWorkspaceRootAuditRef(grant.path),
        })),
      };
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "prune-path-grants", error);
      const lifecycleError = new Error("workspace-root-grant-prune-failed");
      (lifecycleError as Error & { code: string }).code = stableErrorCode(error);
      throw lifecycleError;
    }
  }

  async function pruneWorkspaceRootRoutineScopes(
    root: string,
    source: string,
    preserveRoots: readonly string[],
  ): Promise<void> {
    const routinesStore = deps.routinesStore;
    if (typeof routinesStore?.revokeWorkspaceRoot !== "function") {
      const error = Object.assign(new Error("workspace routines store unavailable"), {
        code: "ROUTINES_STORE_UNAVAILABLE",
      });
      auditLifecycleWarning(source, root, "prune-routine-scopes", error);
      throw error;
    }
    try {
      await routinesStore.revokeWorkspaceRoot(root, { preserveRoots });
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "prune-routine-scopes", error);
      const lifecycleError = new Error("workspace-root-routine-prune-failed");
      (lifecycleError as Error & { code: string }).code = stableErrorCode(error);
      throw lifecycleError;
    }
  }

  async function pruneWorkspaceRootDurableScopes(
    root: string,
    source: string,
    preserveRoots: readonly string[],
  ): Promise<Awaited<ReturnType<typeof pruneWorkspaceRootGrants>>> {
    const errors: unknown[] = [];
    let grants: Awaited<ReturnType<typeof pruneWorkspaceRootGrants>> = {
      count: 0,
      audit: [],
    };
    try {
      await pruneWorkspaceRootRoutineScopes(root, source, preserveRoots);
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      grants = await pruneWorkspaceRootGrants(root, source, preserveRoots);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw Object.assign(
        new AggregateError(errors, "workspace-root-durable-scope-cleanup-failed"),
        { code: "WORKSPACE_ROOT_DURABLE_SCOPE_CLEANUP_FAILED" },
      );
    }
    return grants;
  }

  type WorkspaceRootRemoval = {
    storedPath: string;
    runtimePath: string;
    persisted: string[];
    prunedGrants: number;
    prunedAudit: Array<{ tool: string; tier: string; path: string }>;
    detachedSessions: number;
    liveScopesRevoked: number;
    cleanupPending: boolean;
    operationId: string;
  };

  async function allowPersistedWorkspaceRoot(root: string, source: string): Promise<string[]> {
    const runtimeRoot = canonicalizePathForMatch(resolvePath(root));
    return withWorkspaceRootLifecycleLock(runtimeRoot, async () => {
      // Validate persistent additions under the same-root lifecycle lock so all entrypoints reject vanished or non-directory paths.
      const stat = await fs.stat(runtimeRoot).catch(() => null);
      if (!stat) {
        throw new Error("workspace-root-not-found");
      }
      if (!stat.isDirectory()) {
        throw new Error("workspace-root-not-directory");
      }
      const current = readPermissionSettings().permissions.additionalDirectories;
      const runtimeKey = caseFoldForMatch(runtimeRoot);
      const alreadyRegistered = current.some(
        (candidate) =>
          caseFoldForMatch(canonicalizePathForMatch(candidate)) === runtimeKey,
      );
      if (alreadyRegistered) return current;
      const preserveRoots = retainedDescendantWorkspaceRoots(runtimeRoot, current);
      await pruneWorkspaceRootGrants(runtimeRoot, source, preserveRoots);
      try {
        // Finish stale routine-scope cleanup before re-add or restart could revive denied grants.
        await pruneWorkspaceRootRoutineScopes(runtimeRoot, source, preserveRoots);
      } catch (error: unknown) {
        try {
          deps.routineEngine?.revokeWorkspaceRoot(runtimeRoot, { preserveRoots });
        } catch (revokeError: unknown) {
          auditLifecycleWarning(source, runtimeRoot, "revoke-live-scopes", revokeError);
        }
        throw error;
      }
      const persisted = await addAllowedDirectoryPersist(runtimeRoot);
      allowWorkspaceRoot(runtimeRoot, source);
      return persisted;
    });
  }

  async function removePersistedWorkspaceRoot(
    root: string,
    source: string,
  ): Promise<WorkspaceRootRemoval | null> {
    const target = canonicalizePathForMatch(resolvePath(root));
    let grantResult: Awaited<ReturnType<typeof pruneWorkspaceRootGrants>> = {
      count: 0,
      audit: [],
    };
    let detachedSessions = 0;
    let liveScopesRevoked = 0;
    const execution = await removeWorkspaceRootWithIntent(target, {
      source,
      auditLogger,
      beforeRemove: async (runtimePath, context) => {
        grantResult = await pruneWorkspaceRootDurableScopes(
          runtimePath,
          source,
          context.preserveRoots,
        );
        return grantResult.count;
      },
      beforeComplete: async (runtimePath) => {
        detachedSessions = await detachWorkspaceRootSessionsBeforeRemoval(
          runtimePath,
          source,
        );
      },
      onInactive: async (intent, context) => {
        const finalized = await finalizeRemovedWorkspaceRoot(
          intent.runtimePath,
          source,
          context,
        );
        liveScopesRevoked = finalized.liveScopesRevoked;
      },
    });
    if (!execution) return null;
    return {
      storedPath: execution.intent.storedPath,
      runtimePath: execution.intent.runtimePath,
      persisted: readPermissionSettings().permissions.additionalDirectories,
      prunedGrants: execution.prunedGrants,
      prunedAudit: grantResult.audit,
      detachedSessions,
      liveScopesRevoked,
      cleanupPending: !execution.completed,
      operationId: execution.intent.operationId,
    };
  }

  const permissionDirectoryLifecycle = {
    allowDirectory: (root: string, source: "permission-slash") =>
      allowPersistedWorkspaceRoot(root, source),
    denyDirectory: async (root: string, source: "permission-slash") =>
      (await removePersistedWorkspaceRoot(root, source))?.persisted ??
        readPermissionSettings().permissions.additionalDirectories,
  };
  // Publish one lifecycle instance and resolve it lazily from every loop and permission consumer.
  setWorkspaceRootLifecycle(permissionDirectoryLifecycle);



  // Revalidate main-owned paths at the single durable scope-widening boundary before persistence and audit.
  async function persistValidatedRoot(
    picked: string,
    gesture: PickGesture,
  ): Promise<WorkspacePickRootResult> {
    const canonicalPicked = canonicalizePathForMatch(picked);
    const verdict = validateWorkspaceDirectoryAddition(canonicalPicked);
    if (!verdict.ok) {
      return { ok: false, error: directoryDenyCode(verdict.reason), warnings: verdict.adjacencyWarnings };
    }
    // Re-stat at acknowledgment because a prepared directory may have become a file or symlink.
    try {
      const stat = await fs.stat(canonicalPicked);
      if (!stat.isDirectory()) {
        return { ok: false, error: "not-a-dir", warnings: verdict.adjacencyWarnings };
      }
    } catch (error: unknown) {
      // Log the redacted resolution failure in main; the renderer's stable code cannot distinguish its cause.
      log.warn(
        { err: error, path: opaqueWorkspaceRootAuditRef(picked), gesture },
        "workspace root stat failed; pick refused",
      );
      return { ok: false, error: "not-found", warnings: verdict.adjacencyWarnings };
    }
    try {
      await allowPersistedWorkspaceRoot(canonicalPicked, CHANNELS.workspace.pickRoot);
    } catch (error: unknown) {
      // Log the cause behind persist-failed so settings, lifecycle, and pending-removal faults remain diagnosable.
      log.error(
        { err: error, path: opaqueWorkspaceRootAuditRef(picked), gesture },
        "workspace root persist failed; pick refused",
      );
      // Unparseable settings require repair; retrying the folder pick cannot fix them.
      if (error instanceof PermissionSettingsUnreadableError) {
        return { ok: false, error: "settings-unreadable", warnings: verdict.adjacencyWarnings };
      }
      return { ok: false, error: "persist-failed", warnings: verdict.adjacencyWarnings };
    }
    // Audit scope widening with a redacted path and picker/drop gesture provenance.
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "workspace-pick-root",
      type: "info",
      input: JSON.stringify({
        channel: CHANNELS.workspace.pickRoot,
        path: opaqueWorkspaceRootAuditRef(picked),
        gesture,
      }),
    });
    return {
      ok: true,
      added: canonicalPicked,
      roots: computeRoots(),
      warnings: verdict.adjacencyWarnings,
    };
  }

  ipcMain.handle(CHANNELS.workspace.listRoots, async (e): Promise<WorkspaceListRootsResult> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.workspace.listRoots, e);
      return { ok: false, error: "unauthorized" };
    }
    const reconciliation = await reconcileWorkspaceRoots({
      source: "list-roots",
      auditLogger,
      permissionManager: deps.conversationLoop?.permissionManager,
      beforeRemove: async (runtimeRoot, context) => {
        const grants = await pruneWorkspaceRootDurableScopes(
          runtimeRoot,
          CHANNELS.workspace.listRoots,
          context.preserveRoots,
        );
        return grants.count;
      },
      beforeComplete: async (runtimeRoot) => {
        await detachWorkspaceRootSessionsBeforeRemoval(
          runtimeRoot,
          CHANNELS.workspace.listRoots,
        );
      },
      onInactive: async (intent, context) => {
        await finalizeRemovedWorkspaceRoot(
          intent.runtimePath,
          CHANNELS.workspace.listRoots,
          context,
        );
      },
    });
    const settings = readPermissionSettings();
    if (settings.fault?.kind === "file-unreadable") {
      return { ok: false, error: "settings-unreadable" };
    }
    return {
      ok: true,
      defaultRoot: getDefaultWorkspaceRoot(),
      roots: computeRoots(),
      ...(reconciliation.pending?.length
        ? { cleanupPending: reconciliation.pending.length }
        : {}),
      ...(settings.fault?.kind === "pending-removals-malformed"
        ? { settingsFault: settings.fault.kind }
        : {}),
    };
  });

  ipcMain.handle(
    CHANNELS.workspace.pickRoot,
    async (e, opts?: { ackToken?: string }): Promise<WorkspacePickRootResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.pickRoot, e);
        return { ok: false, error: "unauthorized" };
      }
      // Consume the acknowledgment token before validation and persist only its main-owned bound path.
      const ackToken =
        typeof opts?.ackToken === "string" && opts.ackToken.length > 0 ? opts.ackToken : null;
      if (ackToken) {
        const now = Date.now();
        const pending = pendingPicks.get(ackToken);
        if (pending) pendingPicks.delete(ackToken); // consume regardless of validity
        if (!pending) return { ok: false, error: "ack-unknown" };
        // Another window's token is unknown here.
        if (pending.senderId !== e.sender.id) return { ok: false, error: "ack-unknown" };
        if (now > pending.expires) return { ok: false, error: "ack-expired" };
        return persistValidatedRoot(pending.path, pending.gesture);
      }

      const win = getMainWindow();
      const { filePaths, canceled } = win
        ? await dialog.showOpenDialog(win, {
            title: t("chatPreviewRail.pickRootTitle"),
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: t("chatPreviewRail.pickRootTitle"),
            properties: ["openDirectory", "createDirectory"],
          });
      if (canceled || !filePaths[0]) return { ok: true, canceled: true, roots: computeRoots() };

      const dialogPath = filePaths[0];
      const verdict = validateWorkspaceDirectoryAddition(dialogPath);
      if (!verdict.ok) {
        return { ok: false, error: directoryDenyCode(verdict.reason), warnings: verdict.adjacencyWarnings };
      }
      if (verdict.adjacencyWarnings.length > 0) {
        const now = Date.now();
        prunePendingPicks(now);
        const token = randomBytes(32).toString("base64url");
        pendingPicks.set(token, {
          path: dialogPath,
          expires: now + ACK_TOKEN_TTL_MS,
          gesture: "dialog",
          senderId: e.sender.id,
        });
        return {
          ok: true,
          requiresAcknowledgement: true,
          pendingPath: dialogPath,
          ackToken: token,
          warnings: verdict.adjacencyWarnings,
          roots: computeRoots(),
        };
      }
      return persistValidatedRoot(dialogPath, "dialog");
    },
  );

  ipcMain.handle(
    CHANNELS.workspace.listDir,
    async (e, rawPath: string): Promise<WorkspaceListDirResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.listDir, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-dir", message: "path must be a non-empty string" };
      }
      const { cwd, extraAllowed } = currentScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        const error = verdict.error === "not-a-file" ? "not-a-dir" : verdict.error;
        return { ok: false, error, message: `scope guard rejected: ${verdict.error}` };
      }
      const dir = verdict.resolved;
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(dir);
      } catch (err) {
        return { ok: false, error: listDirFailure(err), path: dir, message: errorMessage(err) };
      }
      if (!stat.isDirectory()) {
        return { ok: false, error: "not-a-dir", path: dir, message: "not a directory" };
      }
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const root = containingRoot(dir);
        // The listed folder's and its root's own physical paths, so link targets resolve against where the link really is.
        const realDir = root === null ? null : await fs.realpath(dir).catch(() => null);
        const realRoot = root === null ? null : await fs.realpath(root.path).catch(() => null);
        // Classify from the directory entries alone, sort, then cap: the cap keeps the first rows of the sorted listing
        // (folders first), and only the kept rows cost an lstat.
        const candidates: Array<{ name: string; type: WorkspaceDirEntry["type"] }> = [];
        let hidden = 0;
        for (const ent of dirents) {
          const full = join(dir, ent.name);
          // A link's own entry is judged by its spelling in the folder: canonicalizing it would resolve through the link.
          const link = ent.isSymbolicLink();
          const sensitivePath = link ? join(realDir ?? dir, ent.name) : full;
          // Filter sensitive entries using the file tools' policy. A key-extension file is hidden only when it holds a key:
          // one whose content was not shown harmless stays listed for the person, and an agent read of it still asks.
          if (isSensitivePath(sensitivePath, "write", "person")) {
            hidden += 1;
            continue;
          }
          const type = await listedEntryType(ent, full);
          if (type !== null) candidates.push({ name: ent.name, type });
        }
        candidates.sort((a, b) => {
          if ((a.type === "directory") !== (b.type === "directory")) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const omitted = Math.max(0, candidates.length - MAX_DIR_ENTRIES);
        const entries: WorkspaceDirEntry[] = [];
        for (const candidate of candidates.slice(0, MAX_DIR_ENTRIES)) {
          const full = join(dir, candidate.name);
          let info: Awaited<ReturnType<typeof fs.lstat>>;
          try {
            info = await fs.lstat(full);
          } catch {
            // Removed between readdir and lstat; it is no longer there to show.
            continue;
          }
          const times = { size: info.size, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs };
          if (candidate.type === "link") {
            // Replaced by something else since readdir; the next listing shows what it became.
            if (!info.isSymbolicLink()) continue;
            // Listed for display only; the target is resolved here solely to decide `outside` and never leaves main. A target
            // that names a network or device location is outside without being touched: resolving `\\host\share` would make
            // Windows authenticate to that host (NTLM) and a hung mount would stall the whole listing.
            let outside = true;
            try {
              outside = realDir === null || realRoot === null || await linkPointsOutside(realDir, candidate.name, realRoot);
            } catch {
              outside = true;
            }
            entries.push({ name: candidate.name, path: full, type: "link", outside, ...times });
          } else if (candidate.type === "file" ? info.isFile() : info.isDirectory()) {
            entries.push({ name: candidate.name, path: full, type: candidate.type, ...times });
          }
        }
        return { ok: true, path: dir, entries, truncated: omitted > 0, omitted, hidden };
      } catch (err) {
        return {
          ok: false,
          error: listDirFailure(err),
          path: dir,
          message: errorMessage(err),
        };
      }
    },
  );

  // Autocomplete accepts only a query; derive current roots in main and read-guard every returned path. The folder view
  // also names the folder it searches: it must pass the read guard and lie inside a registered root.
  ipcMain.handle(
    CHANNELS.workspace.searchFiles,
    async (e, rawQuery: unknown, rawOptions?: unknown): Promise<WorkspaceSearchFilesResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.searchFiles, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof rawQuery !== "string" || rawQuery.length > WORKSPACE_FILE_QUERY_MAX_CHARS) {
        return { ok: false, error: "invalid-query" };
      }
      let scope: { cwd: string; extraAllowed: string[] };
      let roots: WorkspaceRoot[];
      try {
        scope = currentScope();
        roots = computeRoots();
      } catch (error) {
        if (error instanceof PermissionSettingsUnreadableError) {
          return { ok: false, error: "settings-unreadable" };
        }
        throw error;
      }
      let folder: { path: string; root: string } | undefined;
      if (rawOptions !== undefined) {
        const rawFolder = typeof rawOptions === "object" && rawOptions !== null ? (rawOptions as { folder?: unknown }).folder : undefined;
        if (typeof rawFolder !== "string" || !isAbsolutePath(rawFolder)) return { ok: false, error: "invalid-query" };
        const verdict = assertReadableFilePath(rawFolder, scope.cwd, scope.extraAllowed);
        const root = verdict.ok ? containingRoot(verdict.resolved) : null;
        if (!verdict.ok || root === null) return { ok: false, error: "folder-not-allowed" };
        folder = { path: verdict.resolved, root: root.path };
      }
      const result = await searchWorkspaceFiles({
        query: rawQuery,
        roots: roots.map((root) => root.path),
        cwd: scope.cwd,
        extraAllowed: scope.extraAllowed,
        ...(folder ? { folder } : {}),
      });
      return { ok: true, ...result };
    },
  );

  // The removal preview (case 31) refuses exactly what removal refuses, then asks each store removal changes how much it would
  // change, with the removal's own root and preserved child roots. A store it cannot ask fails the preview: reporting zero
  // would send the renderer down the instant path.
  ipcMain.handle(
    CHANNELS.workspace.previewRemoveRoot,
    async (e, rawPath: unknown): Promise<WorkspacePreviewRemoveRootResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.previewRemoveRoot, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) return { ok: false, error: "invalid-path" };
      const rootKey = (value: string) => caseFoldForMatch(canonicalizePathForMatch(resolvePath(value)));
      const targetKey = rootKey(rawPath);
      if (targetKey === rootKey(getDefaultWorkspaceRoot())) return { ok: false, error: "cannot-remove-default" };
      const active = readPermissionSettings().permissions.additionalDirectories;
      const stored = active.find((candidate) => rootKey(candidate) === targetKey);
      if (!stored) return { ok: false, error: "not-an-additional-root" };
      const runtimePath = canonicalizePathForMatch(resolvePath(stored));
      // The context the removal itself hands each store and loop.
      const context = workspaceRootRemovalContext(runtimePath, active);
      const options = { preserveRoots: context.preserveRoots };
      try {
        const permissionManager = deps.conversationLoop?.permissionManager;
        if (typeof permissionManager?.countPathGrantsUnderRoot !== "function") throw new Error("permission manager unavailable");
        if (typeof deps.routinesStore?.countRoutinesScopedToWorkspaceRoot !== "function") throw new Error("routines store unavailable");
        const sessionStores = [deps.memoryManager?.sessions, ...sessionMemoryManagers(CHANNELS.workspace.previewRemoveRoot, runtimePath, true)]
          .filter((store, index, all) => all.indexOf(store) === index) as Array<{ countSessionsInProject?: (root: string) => number } | undefined>;
        let detachableSessions = 0;
        for (const store of sessionStores) {
          if (typeof store?.countSessionsInProject !== "function") throw new Error("session store unavailable");
          detachableSessions += store.countSessionsInProject(runtimePath);
        }
        // Every live-scope owner removal revokes (chat, side and pane loops, routines, plugin grants, sub-agents) says how many
        // running turns its revocation would stop, by the test it aborts by. An owner that cannot answer is a contract violation,
        // not a zero.
        let streamingSessions = 0;
        for (const owner of workspaceLiveScopeOwners()) {
          if (owner === undefined || owner === null) continue;
          const count = (owner as { countTurnsAbortedByWorkspaceRootRemoval?: unknown }).countTurnsAbortedByWorkspaceRootRemoval;
          if (typeof count !== "function") throw new Error("a live-scope owner cannot preview a workspace root removal");
          const turns: unknown = count.call(owner, runtimePath, context);
          if (typeof turns !== "number" || !Number.isSafeInteger(turns) || turns < 0) throw new Error("a live-scope owner answered the removal preview with no count");
          streamingSessions += turns;
        }
        const [pathGrants, routines] = await Promise.all([
          permissionManager.countPathGrantsUnderRoot(runtimePath, options),
          deps.routinesStore.countRoutinesScopedToWorkspaceRoot(runtimePath, options),
        ]);
        return {
          ok: true,
          counts: { streamingSessions, pathGrants, routines, detachableSessions },
        };
      } catch (error: unknown) {
        log.warn({ err: error, path: opaqueWorkspaceRootAuditRef(runtimePath) }, "workspace root removal preview failed");
        return { ok: false, error: "preview-failed" };
      }
    },
  );

  // Removal may target only an existing additional root; the default root is not removable.
  ipcMain.handle(
    CHANNELS.workspace.removeRoot,
    async (e, rawPath: string): Promise<WorkspaceRemoveRootResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.removeRoot, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "invalid-path", message: "path must be a non-empty string" };
      }
      const targetCanon = caseFoldForMatch(canonicalizePathForMatch(resolvePath(rawPath)));
      const defaultCanon = caseFoldForMatch(canonicalizePathForMatch(getDefaultWorkspaceRoot()));
      if (targetCanon === defaultCanon) {
        return { ok: false, error: "cannot-remove-default", message: "default root cannot be removed" };
      }
      let removal: WorkspaceRootRemoval | null;
      try {
        removal = await removePersistedWorkspaceRoot(rawPath, CHANNELS.workspace.removeRoot);
      } catch {
        return {
          ok: false,
          error: "lifecycle-failed",
          message: "workspace lifecycle update failed",
        };
      }
      if (!removal) {
        return { ok: false, error: "not-an-additional-root", message: "path is not a removable project root" };
      }
      // Revoke path-tier grants under removed roots or re-add would silently revive them.
      const prunedGrants = removal.prunedGrants;
      // Audit redacted grant tuples but expose only their count over IPC.
      const prunedAudit = removal.prunedAudit;
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "workspace-remove-root",
        type: "info",
        input: JSON.stringify({
          channel: CHANNELS.workspace.removeRoot,
          path: opaqueWorkspaceRootAuditRef(removal.runtimePath),
          operationId: removal.operationId,
          cleanupPending: removal.cleanupPending,
          prunedGrants,
          detachedSessions: removal.detachedSessions,
          liveScopesRevoked: removal.liveScopesRevoked,
          ...(prunedAudit.length > 0 ? { prunedPatterns: prunedAudit } : {}),
        }),
      });
      // Undo re-adds only this main-owned path through the ack flow (same TTL and one-time consumption). None while cleanup is
      // pending: a re-add must not race the deferred revocation.
      let undoToken: string | undefined;
      if (!removal.cleanupPending) {
        const now = Date.now();
        prunePendingPicks(now);
        undoToken = randomBytes(32).toString("base64url");
        pendingPicks.set(undoToken, { path: removal.runtimePath, expires: now + ACK_TOKEN_TTL_MS, gesture: "undo", senderId: e.sender.id });
      }
      return {
        ok: true,
        removed: removal.storedPath,
        roots: computeRoots(),
        prunedGrants,
        ...(removal.cleanupPending ? { cleanupPending: true } : {}),
        ...(undoToken ? { undoToken } : {}),
      };
    },
  );

  // The two user-click hand-offs of one in-project file (the OS default app, the user's editor command) share every check up
  // to the hand-off itself: the app window's main frame, the user gesture, a registered project root, a path with no `.` or
  // `..` segment, a local link chain and the read guard. Neither is a tool: no agent, plugin frame or remote controller
  // reaches them, and the permission tree gains no node for them.
  type ProjectFileOpenRefusal = {
    ok: false;
    error: "unauthorized" | typeof USER_KEYBOARD_REQUIRED.error | "invalid-request" | "settings-unreadable" | "root-not-registered"
      | "network-target" | "sensitive-path" | "path-not-allowed";
  };
  async function admitProjectFileOpen(e: Electron.IpcMainInvokeEvent, channel: string, payload: unknown): Promise<
    | { ok: false; refusal: ProjectFileOpenRefusal }
    | { ok: true; rawPath: string; rootPath: string; resolved: string; authorize: (real: string, pass: ExternalOpenPass) => "unauthorized" | "root-not-registered" | "outside-project" | null }
  > {
    if (!validateAppWindowMainFrameSender(e, deps)) {
      auditUnauthorized(auditLogger, channel, e);
      return { ok: false, refusal: { ok: false, error: "unauthorized" } };
    }
    if (!hasUserKeyboardIntentPayload(payload)) return { ok: false, refusal: USER_KEYBOARD_REQUIRED };
    const { projectRoot, path: rawPath } = payload as { projectRoot?: unknown; path?: unknown };
    if (typeof projectRoot !== "string" || typeof rawPath !== "string" || rawPath.length === 0
      || !isAbsolutePath(projectRoot) || !isAbsolutePath(rawPath)
      // A `.` or `..` segment is refused before any lstat or realpath: the link-chain walk, the scope guard and Win32 would
      // each fold it differently (lexically, or against a link's physical parent), so the checks could judge one file and
      // the open resolve another. The folder view never sends one.
      || rawPath.split(/[\\/]+/u).some((segment) => segment === "." || segment === "..")) {
      return { ok: false, refusal: { ok: false, error: "invalid-request" } };
    }
    let root: WorkspaceRoot | null;
    let scope: { cwd: string; extraAllowed: string[] };
    try {
      root = registeredRoot(projectRoot);
      scope = currentScope();
    } catch (error) {
      if (error instanceof PermissionSettingsUnreadableError) return { ok: false, refusal: { ok: false, error: "settings-unreadable" } };
      throw error;
    }
    if (!root) return { ok: false, refusal: { ok: false, error: "root-not-registered" } };
    // The scope guard canonicalizes, which resolves through links; a chain to a network or device location stops first.
    if (await linkChainVerdict(rawPath) === "network") return { ok: false, refusal: { ok: false, error: "network-target" } };
    // The person hands the file to another program: a key-extension file is refused only when it holds a key.
    const verdict = assertReadableFilePath(rawPath, scope.cwd, scope.extraAllowed, "person");
    if (!verdict.ok) {
      return { ok: false, refusal: { ok: false, error: verdict.error === "sensitive-path" ? "sensitive-path" : "path-not-allowed" } };
    }
    const rootPath = root.path;
    return {
      ok: true,
      rawPath,
      rootPath,
      resolved: verdict.resolved,
      authorize: (real, pass) => {
        // The entry check above covers the first pass; the frame is re-checked once, just before the hand-off.
        if (pass === "final" && !validateAppWindowMainFrameSender(e, deps)) return "unauthorized";
        // The root is re-read each time: removing it between the click and the hand-off withdraws the authority.
        const current = registeredRoot(rootPath);
        if (!current) return "root-not-registered";
        return keyWithin(matchKey(current.path), matchKey(real)) ? null : "outside-project";
      },
    };
  }

  function auditProjectFileOpen(channel: string, sessionId: string, rootPath: string, path: string, error: string | null): void {
    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: error === null ? "info" : "warn",
        input: JSON.stringify({
          channel,
          root: opaqueWorkspaceRootAuditRef(rootPath),
          path: opaqueWorkspaceRootAuditRef(path),
          ok: error === null,
          ...(error === null ? {} : { error }),
        }),
      });
    } catch {
      // An audit sink failure must not change what the user was told.
    }
  }

  // Open one in-project file with the OS default app.
  ipcMain.handle(
    CHANNELS.workspace.openPath,
    async (e, payload: unknown): Promise<WorkspaceOpenPathResult> => {
      const admitted = await admitProjectFileOpen(e, CHANNELS.workspace.openPath, payload);
      if (!admitted.ok) return admitted.refusal;
      // The requested spelling goes in, not the resolved one, so a `.sh` name that links to a text file is still refused.
      const opened = await openVerifiedExternalFile(admitted.rawPath, admitted.authorize);
      auditProjectFileOpen(CHANNELS.workspace.openPath, "workspace-open-path", admitted.rootPath,
        opened.ok ? opened.real : admitted.resolved, opened.ok ? null : opened.error);
      return opened.ok ? { ok: true } : { ok: false, error: opened.error };
    },
  );

  // Open one in-project file in the editor the user configured (`documents.editorCommand`). The command is the user's own
  // setting, written only from the settings screen; it is split into a program and arguments here and started without a
  // shell, with the verified real path and the line as whole arguments. The editor takes any regular file: it reads a
  // script as text, where the default app would run it.
  ipcMain.handle(
    CHANNELS.workspace.openInEditor,
    async (e, payload: unknown): Promise<WorkspaceOpenInEditorResult> => {
      const admitted = await admitProjectFileOpen(e, CHANNELS.workspace.openInEditor, payload);
      if (!admitted.ok) return admitted.refusal;
      const rawLine = (payload as { line?: unknown }).line;
      if (rawLine !== undefined && (typeof rawLine !== "number" || !Number.isSafeInteger(rawLine) || rawLine < 1)) {
        return { ok: false, error: "invalid-request" };
      }
      const command = deps.settingsService.get("documents").editorCommand;
      // Judge the command before touching the file, so "no editor is set" is the answer whatever the file is.
      const probe = buildEditorArgv(command, { file: admitted.rawPath, line: rawLine ?? 1 });
      if (!probe.ok) return { ok: false, error: probe.error };
      const opened = await openVerifiedExternalFile(admitted.rawPath, admitted.authorize, {
        formats: "any",
        launch: async (real) => {
          const argv = buildEditorArgv(command, { file: real, line: rawLine ?? 1 });
          return argv.ok && await launchEditor(argv.program, argv.args);
        },
      });
      auditProjectFileOpen(CHANNELS.workspace.openInEditor, "workspace-open-in-editor", admitted.rootPath,
        opened.ok ? opened.real : admitted.resolved, opened.ok ? null : opened.error);
      if (opened.ok) return { ok: true };
      return { ok: false, error: opened.error === "open-failed" ? "launch-failed" : opened.error };
    },
  );

  // The in-app text editor. Both calls are the person's own clicks on a file of a project they opened, so they pass the same
  // admission and the same twice-resolved target as the two hand-offs above; what differs is the last step, which reads or
  // replaces the file here instead of starting a program. Neither is a tool and neither asks: the permission tree has no
  // node for them. The save still passes the write guard (sensitive floor, project scope), and it goes through the
  // checkpoint module, which serializes it with agent writes and keeps a turn's record of the file truthful.
  async function withVerifiedEditTarget<R extends { ok: boolean }>(
    e: Electron.IpcMainInvokeEvent, channel: string, auditSession: string, payload: unknown,
    act: (real: string, stillAuthorized: () => boolean) => Promise<R>,
  ): Promise<R | { ok: false; error: ProjectFileRefusal }> {
    const admitted = await admitProjectFileOpen(e, channel, payload);
    if (!admitted.ok) return admitted.refusal;
    let outcome: R | undefined;
    const verified = await openVerifiedExternalFile(admitted.rawPath, admitted.authorize, {
      formats: "any",
      // `stillAuthorized` judges the sender and the registered project again, whenever the act asks.
      launch: async (real) => { outcome = await act(real, () => admitted.authorize(real, "final") === null); return true; },
    });
    const error = !verified.ok ? verified.error : outcome?.ok === false ? (outcome as { error?: string }).error ?? "failed" : null;
    auditProjectFileOpen(channel, auditSession, admitted.rootPath, verified.ok ? verified.real : admitted.resolved, error);
    if (!verified.ok) {
      if (verified.error === "open-failed") throw new Error("edit hand-off reported a failed launch");
      return { ok: false, error: verified.error };
    }
    if (outcome === undefined) throw new Error("edit hand-off did not run");
    return outcome;
  }

  ipcMain.handle(
    CHANNELS.workspace.readForEdit,
    async (e, payload: unknown): Promise<WorkspaceReadForEditResult> =>
      withVerifiedEditTarget<WorkspaceReadForEditResult>(e, CHANNELS.workspace.readForEdit, "workspace-read-for-edit", payload, async (real) => {
        const file = await readUserEditableFile(real);
        if (!file.ok) return { ok: false, error: file.error };
        const decoded = decodeEditableText(file.bytes);
        return decoded.ok ? { ok: true, text: decoded.text, hash: file.hash } : { ok: false, error: decoded.error };
      }),
  );

  ipcMain.handle(
    CHANNELS.workspace.saveEdit,
    async (e, payload: unknown): Promise<WorkspaceSaveEditResult> => {
      const { baseHash, text } = (typeof payload === "object" && payload !== null ? payload : {}) as { baseHash?: unknown; text?: unknown };
      if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/u.test(baseHash) || typeof text !== "string") {
        // Sender and gesture are judged first for every request; only then is a malformed one named.
        const admitted = await admitProjectFileOpen(e, CHANNELS.workspace.saveEdit, payload);
        return admitted.ok ? { ok: false, error: "invalid-request" } : admitted.refusal;
      }
      return withVerifiedEditTarget<WorkspaceSaveEditResult>(e, CHANNELS.workspace.saveEdit, "workspace-save-edit", payload, async (real, stillAuthorized) => {
        // The line ending and byte order mark come from the file as it is now, never from the renderer.
        const file = await readUserEditableFile(real);
        if (!file.ok) return { ok: false, error: file.error === "not-found" ? "changed" : "not-editable" };
        if (file.hash !== baseHash) return { ok: false, error: "changed" };
        const decoded = decodeEditableText(file.bytes);
        if (!decoded.ok) return { ok: false, error: decoded.error };
        // Asked again immediately before the file is replaced, so each answer reads the project list and the folder
        // grants as they are then: a project removed while the save was on its way is no longer written to.
        return saveUserFileEdit(real, baseHash, Buffer.from(encodeEditableText(text, decoded.shape)), (path) => {
          if (!stillAuthorized()) return true;
          const scope = currentScope();
          return ensureFileAccess(path, { cwd: scope.cwd, extraAllowedDirectories: scope.extraAllowed, metadata: {} }, "write") !== null;
        });
      });
    },
  );

  // Reveal selects an item's location without executing it; do not substitute open semantics.
  ipcMain.handle(
    CHANNELS.workspace.reveal,
    async (e, rawPath: string): Promise<WorkspaceRevealResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.reveal, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-found", message: "path must be a non-empty string" };
      }
      const { cwd, extraAllowed } = currentScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        const error = verdict.error === "not-a-file" ? "not-found" : verdict.error;
        return { ok: false, error, message: `scope guard rejected: ${verdict.error}` };
      }
      const target = verdict.resolved;
      try {
        await fs.stat(target);
      } catch {
        return { ok: false, error: "not-found", message: "path no longer exists" };
      }
      shell.showItemInFolder(target);
      return { ok: true };
    },
  );

  // A dropped path grants no authority; prepare validates it and mints a confirmation token.
  ipcMain.handle(
    CHANNELS.workspace.dropPrepare,
    async (e, rawPath: string): Promise<WorkspaceDropPrepareResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.dropPrepare, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "invalid-path" };
      }
      // Reject sensitive paths before minting tokens and return stable localized refusal codes.
      const verdict = validateWorkspaceDirectoryAddition(rawPath);
      if (!verdict.ok) {
        return { ok: false, error: directoryDenyCode(verdict.reason), warnings: verdict.adjacencyWarnings };
      }
      try {
        const stat = await fs.stat(rawPath);
        if (!stat.isDirectory()) return { ok: false, error: "not-a-dir" };
      } catch {
        return { ok: false, error: "not-found" };
      }
      const now = Date.now();
      prunePendingPicks(now);
      const token = randomBytes(32).toString("base64url");
      pendingPicks.set(token, {
        path: rawPath,
        expires: now + ACK_TOKEN_TTL_MS,
        gesture: "drop",
        senderId: e.sender.id,
      });
      return {
        ok: true,
        pendingPath: rawPath,
        ackToken: token,
        warnings: verdict.adjacencyWarnings,
      };
    },
  );
}
