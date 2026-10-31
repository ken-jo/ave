import type { ConversationLoop, SessionTransitionLease } from "../conversation-loop.js";
import { isValidSessionId, type SessionKind } from "../../memory/memory-manager.js";
import type { GenericMessage } from "../llm/types.js";
import type { WorkspaceRootRevocationOptions } from "./types.js";
import { normalizeToolPairInvariant } from "../conversation-history.js";
import { endShellSession } from "../../tools/shell-tools.js";
import { disposeSessionFileReads } from "../../tools/file-read-state.js";
import { createTracer } from "../../observability/conversation-trace.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { withSummaryBoundary } from "../structured-compact.js";
import { createLogger } from "../../lib/logger.js";
import { projectBasename, projectRootEquals } from "../../shared/project-identity.js";
import { createWorkspaceRootRevocationFilter } from "../../permissions/workspace-root-lifecycle.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";

const log = createLogger("ave");

export interface SessionProjectContext {
  projectRoot?: string;
  projectName?: string;
  isDefault?: boolean;
}

function normalizeProjectString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function applyProjectContext(self: ConversationLoop, project?: SessionProjectContext): void {
  let projectRoot = normalizeProjectString(project?.projectRoot);
  let projectName = normalizeProjectString(project?.projectName);
  if (projectRoot && self.deps.authorizeProject) {
    const authorized = self.deps.authorizeProject(projectRoot, projectName ?? undefined);
    if (authorized) {
      projectRoot = normalizeProjectString(authorized.projectRoot);
      projectName = normalizeProjectString(authorized.projectName) ?? projectName;
      project = { ...project, isDefault: authorized.isDefault };
    } else {
      const fallback = self.deps.getDefaultProject?.();
      projectRoot = normalizeProjectString(fallback?.projectRoot);
      projectName = normalizeProjectString(fallback?.projectName);
      project = fallback;
    }
  }
  const projectIsDefault = projectRoot
    ? project?.isDefault === true || self.deps.isDefaultProjectRoot?.(projectRoot) === true
    : false;
  self.sessionProjectRoot = projectRoot;
  self.sessionProjectName = projectName;
  self.sessionProjectIsDefault = projectIsDefault;
  self.sessionAdditionalDirectories = projectRoot ? [projectRoot] : [];
  self.deps.systemPromptBuilder.setProjectContext?.(projectRoot
    ? {
        projectRoot,
        projectName: projectName ?? projectBasename(projectRoot),
        ...(projectIsDefault ? { isDefault: true } : {}),
      }
    : null);
}

function currentProjectContext(self: ConversationLoop): SessionProjectContext {
  return {
    ...(self.sessionProjectRoot ? { projectRoot: self.sessionProjectRoot } : {}),
    ...(self.sessionProjectName ? { projectName: self.sessionProjectName } : {}),
  };
}

export interface WorkspaceRootRevocationResult {
  sessionDirectoriesRemoved: number;
  turnDirectoriesRemoved: number;
  projectRebound: boolean;
}

async function settleOutgoingSession(
  self: ConversationLoop,
  lease: SessionTransitionLease,
): Promise<void> {
  self.assertSessionTransitionLease(lease);
  disposeSessionFileReads(lease.sessionId);
  const report = await endShellSession(lease.sessionId);
  self.assertSessionTransitionLease(lease);
  if (report?.state === "cleanup-unproven") {
    throw new Error("workload-broker:session-cleanup-unproven");
  }
}

function applyFreshSessionState(
  self: ConversationLoop,
  kind: SessionKind,
  project?: SessionProjectContext,
): void {
  self.replaceSessionIdentity(createDlpSafeUuid());
  self.sessionKind = kind;
  self.sessionRoutineId = null;
  self.sessionRoutineTitle = null;
  self.sessionAdditionalDirectories = [];
  applyProjectContext(self, project);
  self.sessionStartFiredFor = null;
  self.sessionSource = "clear";
  self.turnAdditionalDirectories = [];
  self.history.clear();
  self.history.clearUserQuoteEvidence();
  self.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
  self.lastRoundProviderInputTokens = 0;
  self.lastReportedSubscriptionContextWindow = null;
  self.lastRoundInputProjection = null;
  self.lastContextInputTokens = 0;
  self.lastContextInputProjectionTokens = 0;
  self.sessionPluginExpansions = 0;
  self.sessionToolSearches = 0;
  self.sessionActivatedPluginIds.clear();
  self.lastTurnScope = null;
  self.lastTurnToolNames = null;
  self.compactNum = 0;
  self.rateLimitRecoveryAttempted = false;
  self.resetSessionModelOverride();
  self.gitIgnoreVerdicts.clear();
  self.tracer = createTracer(self.sessionId);
}

// Revoke grants under removed roots; keep independently authorized children and fall back for unauthorized projects.
export function revokeWorkspaceRoot(
  self: ConversationLoop,
  removedRoot: string,
  options: WorkspaceRootRevocationOptions = {},
): WorkspaceRootRevocationResult {
  const normalizedRoot = normalizeProjectString(removedRoot);
  if (!normalizedRoot) {
    return { sessionDirectoriesRemoved: 0, turnDirectoriesRemoved: 0, projectRebound: false };
  }
  const previousSessionDirectories = [...self.sessionAdditionalDirectories];
  const previousTurnDirectories = [...self.turnAdditionalDirectories];
  const previousProjectRoot = self.sessionProjectRoot;
  const previousProjectName = self.sessionProjectName;
  const previousProjectWasDefault = self.sessionProjectIsDefault;
  const staticDirectories = self.deps.additionalDirectories ?? [];
  // Share the workspace-root lifecycle revocation predicate with other live-scope owners.
  const isRevoked = createWorkspaceRootRevocationFilter(
    normalizedRoot,
    options.preserveRoots ?? [],
  );
  const affectsActiveTurn = Boolean(
    options.globalScopeWasAuthorized === true
      || (previousProjectRoot && isRevoked(previousProjectRoot))
      || previousSessionDirectories.some(isRevoked)
      || previousTurnDirectories.some(isRevoked)
      || staticDirectories.some(isRevoked),
  );
  if (affectsActiveTurn) {
    // Abort only loops whose snapshotted execution directory references the removed root.
    self.abortCurrentTurn(new Error("workspace-removal"));
  }

  const retainedSessionDirectories = previousSessionDirectories.filter(
    (directory) => !isRevoked(directory),
  );
  self.turnAdditionalDirectories = previousTurnDirectories.filter(
    (directory) => !isRevoked(directory),
  );
  const projectNeedsReauthorization = Boolean(
    previousProjectRoot && isRevoked(previousProjectRoot),
  );

  self.sessionAdditionalDirectories = retainedSessionDirectories;
  if (projectNeedsReauthorization) {
    applyProjectContext(self, currentProjectContext(self));
    for (const directory of retainedSessionDirectories) {
      if (!self.sessionAdditionalDirectories.some((current) => projectRootEquals(current, directory))) {
        self.sessionAdditionalDirectories.push(directory);
      }
    }
  }

  const projectRebound = projectNeedsReauthorization && (
    !projectRootEquals(previousProjectRoot ?? "", self.sessionProjectRoot ?? "")
    || previousProjectName !== self.sessionProjectName
    || previousProjectWasDefault !== self.sessionProjectIsDefault
  );
  const sessionDirectoriesRemoved = previousSessionDirectories.length - retainedSessionDirectories.length;
  const turnDirectoriesRemoved = previousTurnDirectories.length - self.turnAdditionalDirectories.length;
  if (projectNeedsReauthorization || sessionDirectoriesRemoved > 0 || turnDirectoriesRemoved > 0) {
    self.deps.broadcastPermissionConfigChanged?.();
  }
  return { sessionDirectoriesRemoved, turnDirectoriesRemoved, projectRebound };
}

export function initializeConversation(
  self: ConversationLoop,
  kind: SessionKind = "main",
  project?: SessionProjectContext,
): void {
  if (self.sessionEpoch !== 0 || self.history.length !== 0 || self.sessionStartFiredFor !== null) {
    throw new Error("conversation-loop:initialization-requires-pristine-session");
  }
  applyFreshSessionState(self, kind, project);
  self.sessionSource = "startup";
}

export async function newConversation(
  self: ConversationLoop,
  kind: SessionKind = "main",
  project?: SessionProjectContext,
  lease?: SessionTransitionLease,
): Promise<void> {
    if (lease === undefined) throw new Error("conversation-loop:session-transition-lease-required");
    self.assertSessionTransitionLease(lease);
    const outgoingSessionId = lease.sessionId;
    const leavingStartFiredFor = self.sessionStartFiredFor;
    const leavingSessionMeta = self.sessionMetaForLifecycle();
    if (self.history.length > 0) {
      self.deps.memoryManager.saveSession(outgoingSessionId, self.history.getMessages()).catch((err: unknown) => {
        log.warn("newConversation saveSession failed: %s", (err as Error).message);
      });
    }
    // Require terminal resource-zero cleanup proof before mutating session identity or scoped state.
    await settleOutgoingSession(self, lease);
    self.deps.closeRationaleSession?.(outgoingSessionId);
    self.deps.permissionManager?.clearUserOwnedSurfaceChoices?.(outgoingSessionId);
    self.deps.skillOverlay?.clear(outgoingSessionId);
    // Clear old session activations before replacing its ID or the runtime entry will be orphaned.
    self.deps.pluginRuntime?.clearSessionActivated?.(outgoingSessionId);
    // Emit after proven cleanup and fallible retirement, immediately before committing the new generation.
    if (leavingStartFiredFor !== null) {
      void self.fireLifecycleEvent(
        "SessionEnd",
        { reason: "new-conversation", sessionMeta: leavingSessionMeta },
        leavingStartFiredFor,
      );
    }
    applyFreshSessionState(self, kind, project);
  }

export async function loadSession(
  self: ConversationLoop,
  sessionId: string,
  lease?: SessionTransitionLease,
): Promise<boolean> {
    if (lease === undefined) throw new Error("conversation-loop:session-transition-lease-required");
    self.assertSessionTransitionLease(lease);
    const outgoingSessionId = lease.sessionId;
    const leavingStartFiredFor = self.sessionStartFiredFor;
    const leavingSessionMeta = self.sessionMetaForLifecycle();
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "loadSession rejected unsafe sessionId");
      return false;
    }
    if (self.deps.sessionHeldElsewhere?.(sessionId)) {
      log.warn({ sessionId }, "loadSession refused: session open in another conversation loop");
      return false;
    }
    const messages = self.deps.memoryManager.loadSession(sessionId);
    if (!messages) return false;

    if (self.history.length > 0) {
      self.deps.memoryManager.saveSession(outgoingSessionId, self.history.getMessages()).catch((err: unknown) => {
        log.warn("loadSession saveSession failed: %s", (err as Error).message);
      });
    }

    const normalized = normalizeToolPairInvariant(messages as import("../llm/types.js").GenericMessage[]);
    if (normalized.removedMessages > 0 || normalized.removedToolCalls > 0) {
      log.warn(
        `loadSession: repaired invalid tool history for ${sessionId} (removedMessages=${normalized.removedMessages}, removedToolCalls=${normalized.removedToolCalls})`,
      );
      void self.deps.memoryManager.saveSession(sessionId, normalized.messages).catch((err: unknown) => {
        log.warn("loadSession repair saveSession failed: %s", (err as Error).message);
      });
    }
    await settleOutgoingSession(self, lease);
    self.deps.closeRationaleSession?.(outgoingSessionId);
    self.deps.permissionManager?.clearUserOwnedSurfaceChoices?.(outgoingSessionId);

    // Clear old session activations before replacing its ID or the runtime entry will be orphaned.
    self.deps.pluginRuntime?.clearSessionActivated?.(outgoingSessionId);
    if (leavingStartFiredFor !== null) {
      void self.fireLifecycleEvent(
        "SessionEnd",
        { reason: "load-session", sessionMeta: leavingSessionMeta },
        leavingStartFiredFor,
      );
    }
    self.replaceSessionIdentity(sessionId);
    self.sessionStartFiredFor = null;
    self.sessionSource = "resume";
    const sessionMeta = self.deps.memoryManager.loadSessionMetadata(sessionId);
    self.sessionKind = sessionMeta?.sessionKind ?? "main";
    self.sessionRoutineId = sessionMeta?.routineId ?? null;
    self.sessionRoutineTitle = sessionMeta?.routineTitle ?? null;
    self.sessionAdditionalDirectories = [];
    self.resetSessionModelOverride();
    self.gitIgnoreVerdicts.clear();
    applyProjectContext(self, sessionMeta?.projectRoot
      ? {
          projectRoot: sessionMeta.projectRoot,
          ...(sessionMeta.projectName ? { projectName: sessionMeta.projectName } : {}),
        }
      : self.deps.getDefaultProject?.());
    self.history.clear();
    self.history.clearUserQuoteEvidence();
    self.history.restore(withSummaryBoundary(normalized.messages, {
      compactNum: sessionMeta?.branchedFromCompactNum ?? 0,
      summary: sessionMeta?.summaryPreamble,
      ...(sessionMeta?.branchedAt !== undefined ? { createdAt: sessionMeta.branchedAt } : {}),
    }));
    self.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    self.lastRoundProviderInputTokens = 0;
    self.lastReportedSubscriptionContextWindow = null;
    self.lastRoundInputProjection = null;
    self.lastContextInputTokens = latestPersistedContextTokens(normalized.messages);
    self.lastContextInputProjectionTokens = 0;
    self.sessionPluginExpansions = 0;
    self.sessionToolSearches = 0;
    self.sessionActivatedPluginIds.clear();
    self.lastTurnScope = null;
    self.lastTurnToolNames = null;
    self.turnAdditionalDirectories = [];
    // Use maximum checkpoint number, not filtered array length, to prevent number reuse.
    self.compactNum = sessionMeta?.checkpoints?.reduce(
      (max, c) => Math.max(max, c.compactNum ?? 0),
      0,
    ) ?? 0;
    self.tracer = createTracer(self.sessionId);
    return true;
  }

export async function resetAndResume(
  self: ConversationLoop,
  sessionId: string,
  lease?: SessionTransitionLease,
): Promise<{
    ok: boolean;
    compacted: boolean;
    compactedAt: string | null;
    removedMessageCount: number;
  }> {
    const loaded = await loadSession(self, sessionId, lease);
    if (!loaded) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }

    // Defer resume compaction until the next turn can measure its live prompt and tool scope.
    self.cumulativeUsage = {
      inputTokens: estimateMessagesTokens(self.history.getMessages()),
      outputTokens: 0,
    };
    self.lastRoundProviderInputTokens = 0;
    self.lastReportedSubscriptionContextWindow = null;
    self.lastRoundInputProjection = null;
    self.rateLimitRecoveryAttempted = false;

    return {
      ok: true,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
    };
  }

export async function startRoutineConversation(
  self: ConversationLoop,
  routineId: string,
  routineTitle: string,
  routineFiredAt?: string,
  lease?: SessionTransitionLease,
): Promise<string> {
    const project = currentProjectContext(self);
    await newConversation(self, "routine", project, lease);
    self.sessionRoutineId = routineId;
    self.sessionRoutineTitle = routineTitle;
    await self.deps.memoryManager.saveSession(self.sessionId, []);
    await self.deps.memoryManager.saveSessionMetadata(self.sessionId, {
      sessionKind: "routine",
      routineId,
      routineTitle,
      ...(routineFiredAt ? { routineFiredAt } : {}),
      ...project,
    });
    return self.sessionId;
  }

export async function branchFromCheckpoint(self: ConversationLoop, compactNum: number): Promise<{
    newSessionId: string;
    lastMessageRole: GenericMessage["role"] | null;
    shouldAutoContinue: boolean;
  }> {
    const checkpoints = self.deps.memoryManager.loadSessionMetadata(self.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) throw new Error(`Checkpoint #${compactNum} not found in session ${self.sessionId}`);

    // Branch from the pre-compact snapshot; main session files already contain rewritten post-compact history.
    const snapshotMessages = self.deps.memoryManager.loadCheckpointSnapshot(self.sessionId, compactNum);
    if (!snapshotMessages) {
      throw new Error(
        `branchFromCheckpoint: no snapshot found for checkpoint #${compactNum} in session ${self.sessionId}. ` +
        `Snapshots are only available for checkpoints created after this feature was introduced.`,
      );
    }
    if (snapshotMessages.length < target.messageCountAtTrigger) {
      throw new Error(
        `branchFromCheckpoint: snapshot length ${snapshotMessages.length} < checkpoint messageCountAtTrigger ${target.messageCountAtTrigger} for session ${self.sessionId}`,
      );
    }

    const newSessionId = createDlpSafeUuid();
    const sliced = (snapshotMessages as import("../llm/types.js").GenericMessage[]).slice(0, target.messageCountAtTrigger);

    // Repair pairs after snapshot loading skips malformed rows and can leave orphan calls or results.
    const { messages: repaired, removedMessages, removedToolCalls } = normalizeToolPairInvariant(sliced);
    if (removedMessages > 0 || removedToolCalls > 0) {
      log.warn(
        `branchFromCheckpoint: repaired ${removedMessages} messages + ${removedToolCalls} tool calls from snapshot (session ${self.sessionId} compact #${compactNum})`,
      );
    }

    const rehydrated = self.deps.memoryManager.rehydrateToolResultArtifacts(self.sessionId, repaired) as GenericMessage[];
    const forkMessages = target.summary
      ? withSummaryBoundary(rehydrated, {
          compactNum,
          summary: target.summary,
          trigger: target.trigger,
          createdAt: target.triggeredAt,
        })
      : rehydrated;
    await self.deps.memoryManager.saveSession(newSessionId, forkMessages);

    await self.deps.memoryManager.saveSessionMetadata(newSessionId, {
      sessionKind: self.sessionKind,
      ...(self.sessionRoutineId ? { routineId: self.sessionRoutineId } : {}),
      ...(self.sessionRoutineTitle ? { routineTitle: self.sessionRoutineTitle } : {}),
      ...currentProjectContext(self),
      parentSessionId: self.sessionId,
      ...(target.summary ? { summaryPreamble: target.summary } : {}),
      branchedFromCompactNum: compactNum,
      branchedAt: new Date().toISOString(),
    });

    // Transcript content decides fork resumability; an inserted summary row does not.
    const lastMessageRole = rehydrated[rehydrated.length - 1]?.role ?? null;
    const shouldAutoContinue = lastMessageRole === "user";

    log.info(`branchFromCheckpoint: new session ${newSessionId} from ${self.sessionId} @ compact #${compactNum}`);
    return { newSessionId, lastMessageRole, shouldAutoContinue };
  }

function latestPersistedContextTokens(messages: GenericMessage[]): number {
  let latestTurnSummaryTokens = 0;
  let latestTurnSummaryCreatedAt = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const contextTokensAfter = messages[i]?.meta?.checkpointMeta?.contextTokensAfter;
    if (
      typeof contextTokensAfter === "number" &&
      Number.isFinite(contextTokensAfter) &&
      contextTokensAfter > 0
    ) {
      const compactedAt = messages[i]?.meta?.createdAt;
      if (
        latestTurnSummaryTokens > 0 &&
        typeof compactedAt === "number" &&
        Number.isFinite(compactedAt) &&
        latestTurnSummaryCreatedAt > compactedAt
      ) {
        return latestTurnSummaryTokens;
      }
      return Math.floor(contextTokensAfter);
    }
    const tokensIn = messages[i]?.meta?.turnSummary?.tokensIn;
    if (typeof tokensIn === "number" && Number.isFinite(tokensIn) && tokensIn > 0) {
      latestTurnSummaryTokens = Math.floor(tokensIn);
      const createdAt = messages[i]?.meta?.createdAt;
      latestTurnSummaryCreatedAt =
        typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0;
    }
  }
  return latestTurnSummaryTokens;
}
