

import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import { type Tool } from "../tools/base.js";
import { createRenderHtmlTool } from "../tools/render-html.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createRequestPluginTool } from "../tools/request-plugin.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { createAskUserQuestionTool } from "../tools/ask-user-question.js";
import { createRoutineScheduleTool } from "../tools/routine-schedule.js";
import { createSessionTasksTool } from "../tools/session-tasks.js";
import { createSessionGoalTool } from "../tools/session-goal.js";
import {
  createAgentInterruptTool,
  createAgentSpawnTool,
  createAgentStatusTool,
} from "../tools/agent-spawn.js";
import type { AgentSpawnEvent } from "../shared/subagent-events.js";
import { createSkillLoadTool, type SkillLoadEvent, type SkillLoadToolDeps } from "../tools/skill-load.js";
import { createSkillListTool } from "../tools/skill-list.js";
import { createSkillReadTool } from "../tools/skill-read.js";
import { createPluginStudioTools } from "../tools/plugin-studio.js";
import { PluginStudioStore } from "../studio/store.js";
import type { McpServerConfigDto } from "../mcp/types.js";
import {
  createMcpResourceListTool,
  createMcpResourceReadTool,
  type McpResourceAccessResolver,
} from "../tools/mcp-resource-tools.js";
import { createAgentListTool } from "../tools/agent-list.js";
import { createTerminalReadTool, type TerminalReadToolDeps } from "../tools/terminal-read.js";
import { createTerminalRunTool, type TerminalRunToolDeps } from "../tools/terminal-run.js";
import { createBrowserTools, type BrowserToolDeps } from "../tools/browser-tools.js";
import type { WebContents } from "electron";
import { createAgentGuideTool } from "../tools/agent-guide.js";
import { createAgentSendTool, type AgentSendRuntime } from "../tools/agent-send.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { SessionTasksStore } from "../main/session-tasks-store.js";
import type { SessionGoalStore } from "../main/session-goal-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { SkillStore } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { PersonaPromptStore } from "../main/persona-prompt-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { IdleSchedulerService, type PowerMonitorLike } from "../main/idle-scheduler.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("ave");

export function registerRequestPluginMetaTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createRequestPluginTool());
}

export function registerToolSearchMetaTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createToolSearchTool());
}

/** Construct the idle scheduler unconditionally; missing it disables every shared idle consumer. */
export async function wireIdleScheduler(powerMonitor?: PowerMonitorLike): Promise<IdleSchedulerService | undefined> {
  try {
    const idleScheduler = new IdleSchedulerService({
      powerMonitor,
    });
    idleScheduler.start();
    return idleScheduler;
  } catch (err) {
    log.warn(
      "boot: idle-scheduler setup failed (non-fatal): %s",
      (err as Error).message,
    );
    return undefined;
  }
}

export interface WorkflowToolDeps {
  /** Lazy-resolved gate — populated after BrowserWindow is ready. */
  getAskUserQuestionGate?: () => AskUserQuestionGate | undefined;
  routinesStore?: RoutinesStore;
  sessionTasksStore?: SessionTasksStore;
  sessionGoalStore?: SessionGoalStore;
  /** Lazy-resolved sub-agent runner — populated after ConversationLoop wiring. */
  getSubAgentRunner?: () => SubAgentRunner | undefined;
  /** Host-only A2A runtime; agent_send still rejects every non-child context. */
  getAgentSendRuntime?: () => AgentSendRuntime | undefined;
  skillStore?: SkillStore;
  agentProfileStore?: AgentProfileStore;
  personaPromptStore?: PersonaPromptStore;
  /** Per-session skill overlay registry. */
  skillOverlay?: SkillOverlay;
  /** Persistent first-use skill approval allow-list. */
  skillApprovalsStore?: SkillApprovalsStore;
  approvalGate?: ApprovalGate;
  /** Use OS proxy and certificate-store routing for built-in network tools. */
  networkFetch: typeof fetch;
  /** Return each redirect for SSRF validation; the plain desktop fetch API throws instead. */
  singleHopNetworkFetch: typeof fetch;
  emitAgentSpawn?: (event: AgentSpawnEvent) => void;
  /** Register terminal reading only on hosts with workspace-terminal scope resolvers. */
  terminalRead?: TerminalReadToolDeps;
  /** Desktop-only command entry into approved workspace terminals. */
  terminalRun?: TerminalRunToolDeps;
  /** Register browser tools only on hosts with app windows. */
  browser?: BrowserToolDeps<WebContents>;
  emitSkillLoad?: (event: SkillLoadEvent) => void;
  acquirePluginSkillGeneration?: NonNullable<SkillLoadToolDeps["acquirePluginGeneration"]>;
  /** Resolve MCP lazily after setup; expose list and read without callTool authority. */
  getMcpResourceAccess?: McpResourceAccessResolver;
  getStudioMcpConfigs?: () => Promise<McpServerConfigDto[]>;
  getStudioConnectorSummary?: (serverId: string) => Promise<{ digest: string; argsCount: number; envCount: number }>;
}

export function registerBuiltinTools(
  toolRegistry: ToolRegistry,
  settingsService: SettingsService,
  workflowDeps: WorkflowToolDeps,
): void {
  const { networkFetch, singleHopNetworkFetch } = workflowDeps;
  const builtins: Tool[] = [
    ...createPluginStudioTools(new PluginStudioStore(workflowDeps.getStudioConnectorSummary), { skillStore: workflowDeps.skillStore,
      agentProfileStore: workflowDeps.agentProfileStore, personaPromptStore: workflowDeps.personaPromptStore,
      routinesStore: workflowDeps.routinesStore, getMcpConfigs: workflowDeps.getStudioMcpConfigs }),
    createWebSearchTool(settingsService, networkFetch),
    createWebFetchTool(singleHopNetworkFetch),
    createRenderHtmlTool(),
  ];

  if (workflowDeps?.getAskUserQuestionGate) {
    builtins.push(
      createAskUserQuestionTool({
        getGate: workflowDeps.getAskUserQuestionGate,
      }),
    );
  }
  if (workflowDeps?.routinesStore) {
    builtins.push(createRoutineScheduleTool(workflowDeps.routinesStore));
  }
  if (workflowDeps?.sessionTasksStore) {
    builtins.push(createSessionTasksTool(workflowDeps.sessionTasksStore));
  }
  if (workflowDeps?.sessionGoalStore) {
    builtins.push(createSessionGoalTool(workflowDeps.sessionGoalStore));
  }
  if (workflowDeps?.getSubAgentRunner && workflowDeps.emitAgentSpawn) {
    const agentProfileStore = workflowDeps.agentProfileStore;
    builtins.push(
      createAgentSpawnTool({
        getRunner: workflowDeps.getSubAgentRunner,
        getAgentProfile: agentProfileStore
          ? async (name) => await agentProfileStore.load(name)
          : undefined,
        emit: workflowDeps.emitAgentSpawn,
      }),
      createAgentStatusTool({
        getRunner: workflowDeps.getSubAgentRunner,
      }),
      createAgentInterruptTool({
        getRunner: workflowDeps.getSubAgentRunner,
      }),
      createAgentGuideTool({
        getRunner: workflowDeps.getSubAgentRunner,
      }),
    );
  }
  if (workflowDeps?.agentProfileStore) {
    builtins.push(createAgentListTool({
      store: workflowDeps.agentProfileStore,
      getRunner: workflowDeps.getSubAgentRunner,
    }));
  }
  if (workflowDeps?.terminalRead) {
    builtins.push(createTerminalReadTool(workflowDeps.terminalRead));
  }
  if (workflowDeps?.terminalRun) {
    builtins.push(createTerminalRunTool(workflowDeps.terminalRun));
  }
  if (workflowDeps?.browser) {
    builtins.push(...createBrowserTools(workflowDeps.browser));
  }
  if (workflowDeps?.getAgentSendRuntime) {
    builtins.push(createAgentSendTool({
      getRuntime: workflowDeps.getAgentSendRuntime,
    }));
  }
  if (
    workflowDeps?.skillStore &&
    workflowDeps.emitSkillLoad &&
    workflowDeps.skillOverlay &&
    workflowDeps.skillApprovalsStore &&
    workflowDeps.approvalGate
  ) {
    builtins.push(
      createSkillLoadTool({
        store: workflowDeps.skillStore,
        overlay: workflowDeps.skillOverlay,
        approvals: workflowDeps.skillApprovalsStore,
        approvalGate: workflowDeps.approvalGate,
        emit: workflowDeps.emitSkillLoad,
        acquirePluginGeneration: workflowDeps.acquirePluginSkillGeneration,
      }),
    );
    builtins.push(createSkillListTool(workflowDeps.skillStore));
    // Resource reads require an already-loaded skill, sharing its approval overlay and generation lease.
    builtins.push(
      createSkillReadTool({
        store: workflowDeps.skillStore,
        overlay: workflowDeps.skillOverlay,
        acquirePluginGeneration: workflowDeps.acquirePluginSkillGeneration,
      }),
    );
  }

  // Pass the resolver without calling it; early capture would retain undefined before MCP setup.
  const mcpResourceAccess = workflowDeps?.getMcpResourceAccess;
  if (mcpResourceAccess) {
    builtins.push(createMcpResourceListTool(mcpResourceAccess));
    builtins.push(createMcpResourceReadTool(mcpResourceAccess));
  }

  toolRegistry.registerBatch(builtins);
}
