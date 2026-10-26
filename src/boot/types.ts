/** Boot module; shared types + event bus Event handlers live here so every boot/* module
 * publishes/subscribes on the same map. Keeps boot.ts and boot/plugins.ts in sync without a circular dependency. */
import type { PluginRuntime, PluginToolInvocationDelegate,
} from "../plugins/runtime.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { SettingsService } from "../data/settings-store.js";
import type { HostFetchTransport } from "../main/host-fetch-guard.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { MemoryCaptureService } from "../memory/memory-capture-service.js";
import type { InputClassifier } from "../core/input-classifier.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { McpAppModelContextStore } from "../mcp/mcp-app-model-context.js";
import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { RoutineEngine } from "../routines/routine-engine.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { PluginLoopbackManager } from "../mcp/plugin-loopback-manager.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { AuditService } from "../main/audit-service.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { ApprovalSentenceSelector } from "../permissions/reviewer/approval-sentence-selector.js";
import type { StarredStore } from "../data/starred-store.js";
import type { FeedbackStore } from "../data/feedback-store.js";
import type { TelemetryService } from "../main/telemetry.js";
import type { PluginTelemetryClient } from "../telemetry/client.js";
import type { NotificationService } from "../main/notification-service.js";
import type { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import type { PreferenceRefreshService } from "../memory/preference-refresh-service.js";
import type { AgentsDocMergeService } from "../memory/agents-doc-merge-service.js";
import type { MemoryConsolidationService, MemoryMaintenanceCoordinator } from "../memory/memory-consolidation-service.js";
import type { A2ARemoteRuntime } from "../main/a2a-remote-runtime.js";
import type { A2ARemoteGateSnapshot } from "../main/a2a-remote-gates.js";
import type { RemoteA2AActionController } from "../main/remote-a2a-action-controller.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("ave");

export type EventHandler = (data: unknown) => void;

const eventHandlers = new Map<string, Set<EventHandler>>();

export function emitEvent(type: string, data?: unknown): void {
  const handlers = eventHandlers.get(type);
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data); } catch (err) { log.error({ err, eventType: type }, `event handler error (${type})`);
      }
    }
  }
}

/** Subscribe to a host event. Returns an unsubscribe disposer so callers (PluginRuntime.onDisable, test
 * cleanup) can remove handlers deterministically without having to hold onto the original reference. */
export function onEvent(type: string, handler: EventHandler): () => void {
  if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
  eventHandlers.get(type)!.add(handler);
  return () => {
    eventHandlers.get(type)?.delete(handler);
  };
}

export function offEvent(type: string, handler: EventHandler): void {
  eventHandlers.get(type)?.delete(handler);
}

export interface AppServices {
  relaunchApp?: () => void;
  pythonRuntime?: PythonRuntimeBootstrapper;
  pythonPath?: string;
  pluginRuntime: PluginRuntime;
  pluginMarketplace: PluginMarketplaceService;
  settingsService: SettingsService;
  /** Export completed spans while keeping the host available to its caller. */
  flushTracing(): Promise<void>;
  /** Optional host-owned P4-5 runtime. Absent means both immutable boot gates were OFF. */
  a2aRemoteRuntime?: A2ARemoteRuntime;
  /** Main-owned renderer action boundary; renderer supplies only target id and user intent. */
  remoteA2AActionController?: RemoteA2AActionController;
  /** Set only when a remote A2A gate was on and the runtime did not start this run: a clamped `a2a-remote-*` reason code, never a thrown message. */
  remoteA2AStartFailureReason?: string;
  /** The remote A2A gates this run booted with. The status channel compares the saved switches against it to tell the owner a change waits for a restart. */
  remoteA2ABootGates: Readonly<A2ARemoteGateSnapshot>;
  memoryManager: MemoryManager;
  /** Host-owned LLM review gate for explicit and automatic long-term memory. */
  memoryCaptureService?: MemoryCaptureService;
  inputClassifier: InputClassifier;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  systemPromptBuilder: SystemPromptBuilder;
  /** MCP-app `ui/update-model-context` slots; ONE instance shared by its only two consumers: the gated IPC (`mcp.uiModelContext`) writes a card's slot, and the SystemPromptBuilder's
   * "MCP App Context" source reads the active session's slots at turn build. No push path exists between them, which is precisely why an app context update can never trigger a turn. */
  mcpAppModelContext: McpAppModelContextStore;
  conversationLoop: ConversationLoop;
  /** Side-chat (workspace rail); a SECOND, independently-streaming ConversationLoop with its own history/sessionId and an isolated
   * MemoryManager rooted at `~/.ave/side-chat/`. Optional: absent in test fixtures that boot only the main loop. Wired in `conversation-wiring.ts`. */
  sideChatConversationLoop?: ConversationLoop;
  /** The loops of the pane chats; a terminal or web pane's own chat is its own conversation, so each runs on its own ConversationLoop
   * over the side-chat store, concurrently with the rail and with the other panes. Optional on the same terms as the rail loop above. */
  paneChatLoops?: PaneChatLoops;
  /** The side-chat store itself. The conversation list federates it beside the main store, and a listing is a read of the STORE, not of the loop
   * that happens to hold one of its sessions. Optional on the same terms as the loop above: absent in fixtures that boot only the main conversation. */
  sideChatMemoryManager?: MemoryManager;
  /** Each chat tile needs its own single-turn loop; create non-main loops lazily under a cap.
   * Fixtures without group support resolve only the main group. */
  resolveChatGroupLoop?: (chatGroupId: string) => ConversationLoop;
  /** Forgets a group's loop once its tile is gone, so the ceiling counts live tiles only. */
  releaseChatGroupLoop?: (chatGroupId: string) => void;
  /** Look up the loop already holding a session; undefined is a mismatch and must never fall back to the primary loop. */
  findLoopBySessionId: (sessionId: string) => ConversationLoop | undefined;
  /** Look up only existing groups; unknown IDs are refusals, never constructors or primary-loop substitutions. */
  findChatGroupLoop: (chatGroupId: string) => ConversationLoop | undefined;
  /** The tiled chat group this bundle is bound to. Set only on the per-group bundle `chat.ts`
   * derives for a non-primary tile; the bundle assembled at boot has none and is the primary's. */
  chatGroupId?: string;
  routineEngine?: RoutineEngine;
  mcpManager: McpManager;
  /** Owns each first-party plugin's in-process loopback MCP host. Backs the loopback-first arm of the render IPC's unified `ui://` resolver
   * (`resolveMcpUiBackend`): a plugin's `ui://` card is served here because its `serverId === pluginId` is NEVER in `mcpManager.clients` (external-only). */
  pluginLoopbackManager: PluginLoopbackManager;
  pluginBundleLifecycle?: import("../plugins/plugin-bundle-lifecycle.js").PluginBundleLifecycle;
  /** Resolve this late-bound gated executor per call for external tool IPC.
   * Loopback plugin calls keep the runtime path that installs the same permission and audit delegate. */
  getPluginToolInvoker: () => PluginToolInvocationDelegate | null;
  /** Host-owned one-shot grant issuer for a plugin panel mutation. */
  requestPluginOperationGrant: (request: {
    pluginId: string;
    toolName: string;
    input: Record<string, unknown>;
    appSessionId: string;
    origin?: "ui" | "mcp-app";
    expectedGenerationId?: string;
  }) => Promise<{
    operationGrantToken: string;
    grantId: string;
    expiresAt: number;
  }>;
  /** Revoke one plugin-panel session and its read/grant lifecycle state. */
  revokePluginOperationSession: (appSessionId: string) => void;
  idleScheduler?: IdleSchedulerService;
  preferenceRefreshService?: PreferenceRefreshService;
  /** Reviewer-backed merge of the packaged agent context with the user's own. */
  agentsDocMergeService?: AgentsDocMergeService;
  memoryConsolidationService?: MemoryConsolidationService;
  memoryMaintenanceCoordinator?: MemoryMaintenanceCoordinator;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  /** A3; structured audit logger (JSONL, ~/.ave/audit/) */
  auditLogger: AuditLogger;
  postTurnHookChain: PostTurnHookChain;
  /** B1: approval gate, created after mainWindow is ready. */
  approvalGate?: ApprovalGate;
  /** Rebuild Layer 5 reviewer bindings after persisted reviewer settings change. */
  rewireReviewerAgent?: () => void;
  /** current `/allow` sentence selector. A GETTER, not the instance: reviewer re-wiring replaces it (a login that finally configures a
   * provider heals it from the no-op stand-in to the live one), and a value captured at IPC-registration time would pin the stand-in forever. */
  getApprovalSentenceSelector?: () => ApprovalSentenceSelector | undefined;
  /** #893; Re-sync the plugin runtime's wildcard config overrides. Only the non-secret `hostApiVendor` is projected, and only while an API provider owns generation; subscription
   * runtime selection clears it. Invoked from settings IPC after runtime or API-vendor changes so plugins observe the correct execution identity on their next call without an app restart. */
  refreshActiveLlmWildcard?: () => void;
  /** Live-refresh sandbox proxy policy after a settings change. Recomputes plugin manifest domains and configured model endpoint hostnames for worker egress, preserving the empty shell allowlist
   * and invocation grants. No-op when the sandbox gate is OFF (ASRT never initialized); there is no live config to update. Invoked from the settings IPC handler when a vendor/endpoint changes. */
  refreshSandboxNetworkConfig?: () => Promise<void>;
  /** Starred messages persistence (~/.ave/sessions/starred.json) */
  starredStore?: StarredStore;
  /** Privacy hardening; feedback persistence separate from audit log (~/.ave/feedback.jsonl) */
  feedbackStore?: FeedbackStore;
  /** Workflow tools; exposed for IPC handlers + shutdown wiring. */
  routinesStore?: import("../main/routines-store.js").RoutinesStore;
  routinesScheduler?: import("../main/routines-scheduler.js").RoutinesScheduler;
  sessionTasksStore?: import("../main/session-tasks-store.js").SessionTasksStore;
  sessionGoalStore?: import("../main/session-goal-store.js").SessionGoalStore;
  /** Late-bound sub-agent runner lookup for read-only transcript/status IPC surfaces. */
  getSubAgentRunner?: () =>
    | import("../engine/subagent-runner.js").SubAgentRunner | undefined;
  /** Work board persistence (~/.ave/work-board/board.json); backs the work-board IPC domain. */
  workBoardStore?: import("../main/work-board-store.js").WorkBoardStore;
  /** Plugin alerts pipeline; backs `hostApi.raiseAlert` and the alerts IPC domain. */
  alertsService?: import("../alerts/service.js").AlertsService;
  /** Work board agent-orchestration engine; owns the plan→approve→execute run for one item. Wired after the
   * SubAgentRunner exists at boot; reached by the work-board IPC `run` handler and the `work_board_run` LLM tool. */
  workBoardEngine?: import("../core/work-board-engine.js").WorkBoardEngine;
  /** Host Work Board reporter (daily / weekly). Constructed at boot after the one-shot LLM caller exists; the work-board IPC domain's `generate-report`
   * channel forwards renderer requests here. Absent ⇒ boot did not construct it (the IPC handler then returns `{ ok: false, error: "no-reporter" }`). */
  workBoardReport?: import("../work-board/work-report.js").WorkBoardReporter;
  askUserQuestionGate?: import("../main/ask-user-question-gate.js").AskUserQuestionGate;
  skillStore?: import("../main/skill-store.js").SkillStore;
  agentProfileStore?: import("../main/agent-profile-store.js").AgentProfileStore;
  personaPromptStore?: import("../main/persona-prompt-store.js").PersonaPromptStore;
  /** Rebuild plugin event bridge subscriptions after install or removal. */
  refreshPluginEventBridge?: () => void;
  /** SoT; canonical plugin install/cache paths. */
  pluginPaths?: ReturnType<typeof import("../plugins/plugin-paths.js").resolvePluginPaths>;
  /** Host-owned wipe for persistent plugin auth sessions. */
  clearAuthPartitionService?: (partition: string) => Promise<void>;
  /** Returns the tracked persistent auth partitions for a plugin, including the base partition. */
  listPluginAuthPartitionsService?: (pluginId: string) => string[];
  /** Drops tracked persistent auth partitions after uninstall cleanup completes. */
  forgetPluginAuthPartitionsService?: (pluginId: string) => void | Promise<void>;
  /** Issue 5: Bridge plugin events to a newly created main window. Called for every main window opened
   * after boot (macOS `activate`, tray, "New Window", a second launch); other windows keep their own bridges. */
  registerPluginEventBridge?: (win: import("electron").BrowserWindow) => void;
  /** Release-prep; anonymous telemetry service. Retained here so the shutdown hook can run a
   * final flush + stop() before the process exits (otherwise queued events are lost on shutdown). */
  telemetry?: TelemetryService;
  /** S12; plugin lifecycle telemetry client (opt-in). Tracks plugin_install / plugin_uninstall / plugin_update / plugin_error
   * events to POST /telemetry/events on the marketplace backend. Never active until the user answers the first-boot consent prompt. */
  pluginTelemetry?: PluginTelemetryClient;
  /** Release-prep; auto-updater stop handle. Retained so shutdown can clear the 4h interval deterministically instead of relying on unref(). */
  autoUpdaterStop?: () => void;
  /** Runs HostApi onShutdown handlers exactly once; shared by normal quit and updater install prep. */
  runPluginShutdownHandlers?: () => Promise<void>;
  /** Central app shutdown hook for timers, background services, and transports. */
  shutdown?: () => Promise<void>;
  /** L1: deferred RoutinesScheduler.start() handle. main.ts calls this AFTER registerIpcHandlers() so a past-due
   * routine firing immediately on boot has a renderer listener attached. Idempotent; safe to call multiple times. */
  startRoutinesScheduler?: () => void;
  /** Deferred Work Board due-soon scanner handle. main.ts calls this AFTER registerIpcHandlers() (mirroring startRoutinesScheduler) so the
   * initial scan + the 60-min tick emit `work_board.work_item.due_soon` onto a fully wired plugin bus. The interval is cleared in `shutdown()`. */
  startWorkBoardDueSoon?: () => void;
  /** Deferred alerts expiry sweep. main.ts calls this beside startWorkBoardDueSoon, once IPC and plugins are up; the timer stops in `shutdown()`. */
  startAlerts?: () => void;
  /** system-level notification service. Auto-fires desktop notifications at lifecycle points (turn-end / routine / ask-user / approval / plugin /
   * system). Constructed AFTER main window exists in boot.ts. The LLM never sees this; it's a passive surface called by the host at trigger sites. */
  notificationService?: NotificationService;
  /** Permission policy Layer 6 hook system runtime. Holds the trusted-hook list resolved from `~/.config/ave/hooks/` after boot-time hash verification and any explicit
   * `/permission hooks accept <name>` command. Executor / approval-gate consult this for pre/post/perm hooks. Absent when the hooks directory cannot be created (rare). */
  scriptHookManager?: import("../hooks/script-hook-manager.js").ScriptHookManager;
  /** Host requests use the injected system-aware transport so proxy and trust configuration are honored outside the engine.
   * Return redirects without following them so the SSRF guard can revalidate each hop. */
  singleHopNetworkFetch: HostFetchTransport;
}

/** The pane chats' loops, one per workspace tab in a window. A loop is made on a pane's first use and dropped
 * when its pane closes or its window goes, so the count is bounded by the panes that are open; no cap is needed. */
export interface PaneChatLoops {
  /** The loop of the pane chat for `tabId` in `windowId`, made on first use. */
  resolve(windowId: number, tabId: string): ConversationLoop;
  /** That loop when it exists; never makes one. */
  get(windowId: number, tabId: string): ConversationLoop | undefined;
  /** Stop that pane chat's turn and drop its loop; returns the loop dropped. */
  release(windowId: number, tabId: string): ConversationLoop | undefined;
  /** The pane chats of one window, with their tabs. */
  inWindow(windowId: number): Array<{ tabId: string; loop: ConversationLoop }>;
  /** The pane chat whose loop holds `sessionId`, if one does. */
  holding(sessionId: string): { windowId: number; tabId: string; loop: ConversationLoop } | undefined;
  /** Every pane chat loop (settings refresh, aborts, shutdown, live scopes). */
  all(): ConversationLoop[];
}
