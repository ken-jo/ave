/**
 * Boot step — workflow system stores, workflow tool deps, and builtin tool
 * registration (§4.2 Step 4 + §4.4, extracted from boot.ts C18).
 *
 * Constructs the workflow-tool-backing stores (session tasks, skills, agent
 * profiles, persona prompts, skill overlay/approvals, ask-user gate), assembles
 * the {@link WorkflowToolDeps} closure bundle (late-binding the sub-agent runner
 * through a ref), registers the builtin + meta tools, and wires the idle
 * scheduler.
 */
import { SessionTasksStore } from "../../main/session-tasks-store.js";
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
import { findSessionMainWindowContents, mainWindowForContents, sideChatOwnerWindow } from "../../main/app-state.js";
import { browserOrigin } from "../../tools/browser-tools.js";

const log = createLogger("ave");

/**
 * @param sessionMetadataStores every MemoryManager that owns conversation
 *   sidecars (main, side-chat, sub-agent), main first. A session's task list
 *   is persisted in the sidecar of whichever store already holds that
 *   session; a session no store has seen yet is a brand-new main conversation
 *   whose transcript is flushed at the end of its first turn.
 */
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
  const sessionTasksStore = new SessionTasksStore({
    load: (sessionId) => sessionOwner(sessionId).loadSessionMetadata(sessionId)?.tasks ?? [],
    save: (sessionId, items) => sessionOwner(sessionId).saveSessionTasks(sessionId, items),
  });
  // The goal rides in the SAME sidecar as the task list, resolved through the
  // same owner lookup: the two are one session's bookkeeping and must never
  // land in two different files.
  const sessionGoalStore = new SessionGoalStore({
    load: (sessionId) => sessionOwner(sessionId).loadSessionMetadata(sessionId)?.goal ?? null,
    save: (sessionId, goal) => sessionOwner(sessionId).saveSessionGoal(sessionId, goal),
  });
  const skillStore = new SkillStore();
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
  // Spawn and skill events are filtered by session in each renderer; every
  // open main window receives them.
  const appWindows = () => ctx.host.desktop?.getAppWindows() ?? [getMainWindow()];
  const askUserQuestionGate = new AskUserQuestionGate(
    // Lazy resolver — dev-mode reloads destroy the captured webContents, and
    // several main windows may be open. Looking it up on every send, by the
    // asking session, sends the card to the window showing that conversation
    // (else the window in use), across reloads and closed windows.
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
    // The gate is constructed up-front (before initPluginRuntime), so it is
    // held by value like every other gate wiring. skill_load reuses the same
    // gate the executor uses so user-authored skills open the approval dock on
    // first load (and only on first load).
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
    // The workspace terminal and the browser tabs exist only in the desktop
    // host. A conversation reaches the window that shows it: a chat tile's
    // session the window whose tile holds it, the side chat the window it was
    // last typed in. A sub-agent inherits its parent's (session-window-scope.ts);
    // routine and work-board loops are shown nowhere and get neither. Read at
    // call time: the loops are wired after this step.
    ...(ctx.host.desktop !== undefined
      ? (() => {
        const windowIdForHostedSession = (sessionId: string): number | null => {
          if (ctx.findLoopBySessionId(sessionId) !== undefined) {
            const holder = findSessionMainWindowContents(sessionId);
            return holder ? mainWindowForContents(holder)?.id ?? null : null;
          }
          if (ctx.sideChatConversationLoop.getSessionId() === sessionId) {
            return sideChatOwnerWindow()?.id ?? null;
          }
          return null;
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
          browser: {
            windowIdForHostedSession,
            liveOriginSessionId,
            tabs: browserTabRegistry,
            // Page actions (CDP) load on first use, outside the initial bundle.
            loadActions: async () => {
              const { createBrowserPageActions } = await import("../../main/browser/browser-actions.js");
              return createBrowserPageActions(browserTabRegistry, browserOrigin, (guest) => {
                const host = guest.hostWebContents;
                const window = host && !host.isDestroyed() ? mainWindowForContents(host) : null;
                if (!window || window.isDestroyed()) return null;
                const bounds = window.getContentBounds();
                return { x: bounds.x, y: bounds.y };
              });
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
    // Resolved lazily: `ctx.mcpManager` is assigned by the MCP boot step, which runs
    // AFTER this one. Between the two, this returns undefined and the tools say so
    // rather than reporting a generic failure — the tools are registered either way,
    // because registration happens once and the window is short.
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

  // §4.2 Step 4: builtin tools + request_plugin / tool_search meta tools.
  registerBuiltinTools(toolRegistry, settingsService, workflowDeps);
  registerRequestPluginMetaTool(toolRegistry);
  // Statically registered; visible whenever builtins are in scope because
  // tool-level deferral is the only plugin/MCP schema exposure path.
  registerToolSearchMetaTool(toolRegistry);

  // §6.1 IdleSchedulerService.
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
  ctx.idleScheduler = idleScheduler;
}
