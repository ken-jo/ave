/** Construct workflow stores, register builtin tools, and late-bind the sub-agent runner. */
import { SessionTasksStore } from "../../main/session-tasks-store.js";
import { join } from "node:path";
import { SessionGoalStore } from "../../main/session-goal-store.js";
import { AskUserQuestionGate } from "../../main/ask-user-question-gate.js";
import { SkillStore } from "../../main/skill-store.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillApprovalsStore } from "../../main/skill-approvals-store.js";
import { AgentProfileStore } from "../../main/agent-profile-store.js";
import { PersonaPromptStore } from "../../main/persona-prompt-store.js";
import type { SubAgentRunner } from "../../engine/subagent-runner.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import type { SkillLoadEvent } from "../../tools/skill-load.js";
import type { AgentSendRuntime } from "../../tools/agent-send.js";
import type { McpResourceToolDeps } from "../../tools/mcp-resource-tools.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  registerToolSearchMetaTool,
  wireIdleScheduler,
  type WorkflowToolDeps,
} from "../tools.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import { promptSurfaceResolver } from "../host-runtime.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { fanOutToAllWindows } from "../../ipc/window-fanout.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { ensureAgentTerminal, typeAgentTerminalCommand, verifyAgentTerminalShell } from "../../main/terminal/pty-manager.js";
import { findSessionMainWindowContents, mainWindowForContents, sideChatOwnerWindow } from "../../main/app-state.js";
import { browserOrigin } from "../../tools/browser-tools.js";
import { createRootSessionResolver } from "../../permissions/root-session-resolver.js";
import { setApprovalConversationRootResolver } from "../../permissions/user-approval-store.js";
import { resolveConversationTitle } from "../../shared/conversation-title.js";
import { t } from "../../i18n/index.js";

const log = createLogger("ave");

/** @param sessionMetadataStores every MemoryManager that owns conversation sidecars (main, side-chat, sub-agent), main first. A session's task list is persisted in the
 * sidecar of whichever store already holds that session; a session no store has seen yet is a brand-new main conversation whose transcript is flushed at the end of its first turn. */
export async function setupWorkflowStores(
  ctx: BootContext,
  sessionMetadataStores: readonly MemoryManager[],
): Promise<void> {
  const {
    routinesStore,
    getMainWindow,
    notificationService,
    approvalGate,
    networkFetch,
    singleHopNetworkFetch,
    toolRegistry,
    settingsService,
  } = ctx;

  const sessionOwner = (sessionId: string): MemoryManager =>
    sessionMetadataStores.find(
      (store) => store.hasSessionTranscript(sessionId) || store.hasSessionMetadataFile(sessionId),
    ) ?? sessionMetadataStores[0];
  approvalGate.setConversationTitleResolver((sessionId) => {
    const store = sessionOwner(sessionId);
    const metadata = store.loadSessionMetadata(sessionId);
    const liveLoop = ctx.findLoopBySessionId?.(sessionId)
      ?? (ctx.sideChatConversationLoop?.getSessionId() === sessionId ? ctx.sideChatConversationLoop : undefined)
      ?? ctx.paneChatLoops?.all().find((loop) => loop.getSessionId() === sessionId);
    return resolveConversationTitle({
      sessionId,
      title: metadata?.title,
      routineTitle: metadata?.routineTitle,
      messages: liveLoop?.getHistory().getMessages() ?? store.loadSession(sessionId),
    }, t);
  });
  const sessionTasksStore = new SessionTasksStore({
    load: (sessionId) => sessionOwner(sessionId).loadSessionMetadata(sessionId)?.tasks ?? [],
    save: (sessionId, items) => sessionOwner(sessionId).saveSessionTasks(sessionId, items),
  });
  // Keep goals and tasks in the same owner-resolved session sidecar.
  const sessionGoalStore = new SessionGoalStore({
    load: (sessionId) => sessionOwner(sessionId).loadSessionMetadata(sessionId)?.goal ?? null,
    save: (sessionId, goal) => sessionOwner(sessionId).saveSessionGoal(sessionId, goal),
  });
  const skillStore = new SkillStore({ bundledDir: join(ctx.host.resourcePath, "skills") });
  const agentProfileStore = new AgentProfileStore();
  const personaPromptStore = new PersonaPromptStore();
  const skillOverlay = new SkillOverlay();
  const skillApprovalsStore = new SkillApprovalsStore();
  await skillApprovalsStore.load().catch((err) => {
    log.warn(
      "boot: skill-approvals load failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  // Broadcast to all main windows; each renderer filters by session.
  const appWindows = () => ctx.host.desktop?.getAppWindows() ?? [getMainWindow()];
  const askUserQuestionGate = new AskUserQuestionGate(
    // Resolve the requesting session's live window per send so reloads and closed windows cannot strand cards.
    promptSurfaceResolver(ctx.host, getMainWindow),
    undefined,
    notificationService,
  );
  const subAgentRunnerRef: { fn: SubAgentRunner | undefined } = { fn: undefined };
  const workflowDeps: WorkflowToolDeps = {
    routinesStore,
    sessionTasksStore,
    sessionGoalStore,
    skillStore,
    agentProfileStore,
    personaPromptStore,
    skillOverlay,
    skillApprovalsStore,
    getAskUserQuestionGate: () => askUserQuestionGate,
    // Reuse the preconstructed approval gate for skills; first load asks, subsequent loads do not.
    approvalGate,
    getSubAgentRunner: () => subAgentRunnerRef.fn,
    getAgentSendRuntime: () => {
      const runtime = subAgentRunnerRef.fn as unknown as Partial<AgentSendRuntime> | undefined;
      return runtime
        && typeof runtime.sendAgentMessage === "function"
        && typeof runtime.auditAgentSendDrop === "function"
        && typeof runtime.reserveQuestionWait === "function"
        && typeof runtime.cancelQuestionWait === "function"
        ? runtime as AgentSendRuntime
        : undefined;
    },
    emitAgentSpawn: (event: AgentSpawnEvent) => {
      try {
        fanOutToAllWindows(appWindows(), "ave:agent-spawn:event", event);
      } catch (err) {
        log.warn("agent_spawn emit failed: %s", (err as Error).message);
      }
    },
    emitSkillLoad: (event: SkillLoadEvent) => {
      try {
        fanOutToAllWindows(appWindows(), "ave:skill-load:event", event);
      } catch (err) {
        log.warn("skill_load emit failed: %s", (err as Error).message);
      }
    },
    acquirePluginSkillGeneration: async (owner) => {
      const lifecycle = ctx.pluginBundleLifecycle;
      if (!lifecycle) throw new Error("plugin generation lifecycle is not ready");
      return lifecycle.acquire(owner.pluginId);
    },
    networkFetch,
    singleHopNetworkFetch,
    // Resolve each conversation's desktop window at call time; sub-agents inherit their parent's scope, while routines and work boards get none.
    ...(ctx.host.desktop !== undefined
      ? (() => {
        const desktop = ctx.host.desktop!;
        const windowIdForHostedSession = (sessionId: string): number | null => {
          if (ctx.findLoopBySessionId(sessionId) !== undefined) {
            const holder = findSessionMainWindowContents(sessionId);
            return holder ? mainWindowForContents(holder)?.id ?? null : null;
          }
          if (ctx.sideChatConversationLoop.getSessionId() === sessionId) {
            return sideChatOwnerWindow()?.id ?? null;
          }
          return ctx.paneChatLoops.holding(sessionId)?.windowId ?? null;
        };
        const liveOriginSessionId = (sessionId: string): string | undefined =>
          subAgentRunnerRef.fn?.liveOriginSessionId(sessionId);
        return {
          terminalRead: {
            windowIdForHostedSession,
            liveOriginSessionId,
            defaultTerminalTabId: (windowId: number, sessionId: string): string | undefined =>
              browserTabRegistry.defaultTerminalTabId(windowId, sessionId),
          },
          terminalRun: {
            windowIdForHostedSession,
            liveOriginSessionId,
            activeTerminalTabId: (windowId: number): string | undefined =>
              browserTabRegistry.activeTerminalTabId(windowId),
            boundSurface: (windowId: number, hostSessionId: string) =>
              browserTabRegistry.conversationSurface(windowId, hostSessionId),
            ensureAgentTerminal,
            typeCommand: typeAgentTerminalCommand,
            verifyShell: verifyAgentTerminalShell,
            auditMismatch: (mismatch) => {
              ctx.bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: mismatch.sessionId ?? "unknown",
                type: "warn",
                // Digests, not text: a command can hold secrets.
                output: `terminal_run: terminal ${mismatch.tabId} ran a different command from the one approved `
                  + `(approved sha256 ${mismatch.approvedSha256}, ran sha256 ${mismatch.ranSha256})`,
              });
            },
          },
          browser: {
            windowIdForHostedSession,
            liveOriginSessionId,
            tabs: browserTabRegistry,
            pickUploadFiles: desktop.pickBrowserUploadFiles,
            // Load page actions lazily outside the initial bundle.
            loadActions: async () => {
              const { createBrowserPageActions } = await import("../../main/browser/browser-actions.js");
              return createBrowserPageActions(browserTabRegistry, browserOrigin, desktop.browserGuestContentOrigin);
            },
          },
        };
      })()
      : {}),
    getStudioMcpConfigs: () => ctx.mcpManager ? ctx.mcpManager.getConfigs() : Promise.resolve([]),
    getStudioConnectorSummary: (serverId: string) => {
      if (!ctx.mcpManager) throw new Error("Connector manager is unavailable");
      return ctx.mcpManager.getStudioConnectorSummary(serverId);
    },
    // Resolve the later-built protocol manager per call; register tools once and report temporary unavailability explicitly.
    getMcpResourceAccess: () => {
      const manager = ctx.mcpManager;
      if (!manager) return undefined;
      const access: McpResourceToolDeps = {
        listResources: () => manager.listDeclaredResources(),
        readDeclaredResource: (serverId, uri) => manager.readDeclaredResource(serverId, uri),
      };
      return access;
    },
  };

  registerBuiltinTools(toolRegistry, settingsService, workflowDeps);
  registerRequestPluginMetaTool(toolRegistry);
  // Statically registered; visible whenever builtins are in scope because tool-level deferral is the only plugin/MCP schema exposure path.
  registerToolSearchMetaTool(toolRegistry);

  const idleScheduler = await wireIdleScheduler(ctx.host.desktop?.powerMonitor);

  ctx.sessionTasksStore = sessionTasksStore;
  ctx.sessionGoalStore = sessionGoalStore;
  ctx.skillStore = skillStore;
  ctx.agentProfileStore = agentProfileStore;
  ctx.personaPromptStore = personaPromptStore;
  ctx.skillOverlay = skillOverlay;
  ctx.skillApprovalsStore = skillApprovalsStore;
  ctx.askUserQuestionGate = askUserQuestionGate;
  ctx.subAgentRunnerRef = subAgentRunnerRef;
  // Share one restored-ancestry resolver for session approvals and the judge; separate roots must never share consent.
  ctx.resolveRootSessionId = createRootSessionResolver(
    (sessionId) => subAgentRunnerRef.fn?.resolveOriginSessionId(sessionId),
  );
  setApprovalConversationRootResolver(ctx.resolveRootSessionId);
  ctx.idleScheduler = idleScheduler;
}
