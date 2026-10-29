import { dialog, ipcMain, shell } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { sensitiveFilePattern } from "../../tools/file-access-policy.js";
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
  isSensitivePath,
} from "../../permissions/sensitive-paths.js";
import { getDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import {
  reconcileWorkspaceRoots,
  removeWorkspaceRootWithIntent,
  retainedDescendantWorkspaceRoots,
  opaqueWorkspaceRootAuditRef,
} from "../../permissions/workspace-root-reconciler.js";
import {
  setWorkspaceRootLifecycle,
  withWorkspaceRootLifecycleLock,
} from "../../permissions/workspace-root-lifecycle.js";
import { getActivePluginSurfacePermissionScope } from "../../boot/plugin-surface-permissions.js";
import { detachWorkspaceRootSessions } from "../../memory/workspace-root-session-lifecycle.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  searchWorkspaceFiles,
  WORKSPACE_FILE_QUERY_MAX_CHARS,
  type WorkspaceFileMatch,
} from "./workspace-file-search.js";

const log = createLogger("ave");

const MAX_DIR_ENTRIES = 1_000;

const ACK_TOKEN_TTL_MS = 60_000;

// Keep warned picks in main behind one-time tokens; acknowledgment never accepts a renderer path.
const pendingPicks = new Map<string, { path: string; expires: number; gesture: PickGesture }>();

// Native workspace gestures retain their direct-UI boundary; agent folder approval uses its own pipeline.
function validateWorkspaceDirectoryAddition(rawPath: string): ReturnType<typeof validateDirectoryAddition> {
  const verdict = validateDirectoryAddition(rawPath);
  if (!verdict.ok) return verdict;
  const sensitive = sensitiveFilePattern(expandLeadingTilde(rawPath), "write") ?? isSensitivePath(verdict.canonicalPath, "write");
  return sensitive ? { ok: false, reason: `path matches sensitive pattern '${sensitive}'`, adjacencyWarnings: verdict.adjacencyWarnings } : verdict;
}

// Record picker versus drop provenance in widening audits; dropped paths have no native-picker authority.
type PickGesture = "dialog" | "drop";

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
  type: "file" | "directory";
}

export interface WorkspaceListDirResult {
  ok: boolean;
  path?: string;
  entries?: WorkspaceDirEntry[];
  truncated?: boolean;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "read-failed";
  message?: string;
}

export interface WorkspaceRemoveRootResult {
  ok: boolean;
  removed?: string;
  roots?: WorkspaceRoot[];
  // Report pruned path grants; directory removal alone cannot revoke the separate rule-tier authority.
  prunedGrants?: number;
  cleanupPending?: boolean;
  error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default" | "lifecycle-failed";
  message?: string;
}

type WorkspaceSearchFilesResult =
  | { ok: true; matches: WorkspaceFileMatch[]; truncated: boolean }
  | { ok: false; error: "unauthorized" | "invalid-query" | "settings-unreadable" };

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

function computeRoots(): WorkspaceRoot[] {
  const defaultRoot = getDefaultWorkspaceRoot();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  const canonicalAdds = sanitizeRuntimeAllowedDirectories(additional);
  const seen = new Set<string>([defaultRoot]);
  const roots: WorkspaceRoot[] = [{ path: defaultRoot, isDefault: true }];
  for (const dir of canonicalAdds) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.push({ path: dir, isDefault: false });
  }
  return roots;
}

export function registerWorkspaceHandlers(deps: IpcDeps): void {
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
    const primary = deps.memoryManager as unknown as WorkspaceMemoryLifecycle | undefined;
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
      add(sideLoop?.deps?.memoryManager);
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
    const liveScopeOwners: unknown[] = [
      deps.conversationLoop,
      deps.sideChatConversationLoop,
      ...(deps.paneChatLoops?.all() ?? []),
      deps.routineEngine,
      // Revoke plugin session grants too; they are independent live scope owners.
      getActivePluginSurfacePermissionScope(),
    ];
    try {
      liveScopeOwners.push(deps.getSubAgentRunner?.());
    } catch (error: unknown) {
      errors.push(error);
      auditLifecycleWarning(source, root, "revoke-live-scopes", error);
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
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) {
          return { ok: false, error: "not-a-dir", path: dir, message: "not a directory" };
        }
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const entries: WorkspaceDirEntry[] = [];
        let truncated = false;
        for (const ent of dirents) {
          if (entries.length >= MAX_DIR_ENTRIES) {
            truncated = true;
            break;
          }
          const full = join(dir, ent.name);
          // Filter sensitive entries using the file tools' policy so browsing cannot offer paths reads refuse.
          if (isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(full)))) continue;
          // List only plain files and directories; symlink entries could advertise out-of-scope targets.
          if (ent.isFile()) entries.push({ name: ent.name, path: full, type: "file" });
          else if (ent.isDirectory()) entries.push({ name: ent.name, path: full, type: "directory" });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { ok: true, path: dir, entries, truncated };
      } catch (err) {
        return {
          ok: false,
          error: "read-failed",
          path: dir,
          message: errorMessage(err),
        };
      }
    },
  );

  // Autocomplete accepts only a query; derive current roots in main and read-guard every returned path.
  ipcMain.handle(
    CHANNELS.workspace.searchFiles,
    async (e, rawQuery: unknown): Promise<WorkspaceSearchFilesResult> => {
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
      const result = await searchWorkspaceFiles({
        query: rawQuery,
        roots: roots.map((root) => root.path),
        cwd: scope.cwd,
        extraAllowed: scope.extraAllowed,
      });
      return { ok: true, ...result };
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
      return {
        ok: true,
        removed: removal.storedPath,
        roots: computeRoots(),
        prunedGrants,
        ...(removal.cleanupPending ? { cleanupPending: true } : {}),
      };
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
