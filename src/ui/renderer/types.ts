import type { RewindMode, RewindResult } from "../../shared/code-rewind.js";
import type { DocumentEngineApi } from "../../shared/document-engine-api.js";
import type { TurnReviewResult } from "../../shared/turn-change-review.js";
import type { ShellTask, ShellTaskAction, ShellTaskActionResult } from "../../shared/shell-tasks.js";
import type { SideChatOperationFailure } from "../../shared/side-chat-operation.js";
import type { AdminPolicyDiagnostic } from "../../shared/policy-editability.js";
// Types extracted from src/renderer.tsx.
// Pure type declarations — no React runtime, no hook state, no side effects.

import type { UpstreamProxyPatch, UpstreamProxyView } from "../../shared/upstream-proxy.js";
import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type {
  AgentInstallResultPayload,
  PluginInstallResultPayload,
  SkillInstallResultPayload,
} from "../../contract/app-contract.js";
import type { ChatStreamEvent, ChatEntry } from "../../lib/chat-stream-state.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import type {
  ActiveWorkspaceSurface,
} from "../../shared/browser-surface.js";
import type { AppBootstrapStatus } from "../../shared/bootstrap-status.js";
import type { RoutineRunRow, SessionFamily, SessionListKindFilter, SessionListRow } from "../../shared/session-lookup.js";
import type { McpAuthErrorCode, McpAuthenticationResult, McpConfigMutationResult, McpResourceSummary, McpResourceTemplateSummary, McpServerConfig, McpServerConfigDto, McpServerState, McpUiResourceBundle, McpUiToolCallOutcome } from "../../mcp/types.js";
import type { McpUiMessageOutcome } from "../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../mcp/mcp-app-model-context.js";
import type { SerializedHistoryMessage } from "../../shared/chat-history.js";
import type { SubAgentTranscriptRequest, SubAgentTranscriptResult } from "../../shared/subagent-transcript.js";
import type { PluginConfigRecord } from "../../shared/plugin-config.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import type {
  CodexSubscriptionActionResult,
  CodexSubscriptionDeviceCodeResult,
  CodexSubscriptionModelsResult,
} from "../../shared/codex-subscription.js";
import type {
  AcpSubscriptionActionResult,
  AcpSubscriptionProviderId,
} from "../../shared/acp-subscription.js";
import type {
  SubscriptionLoginMethod,
  SubscriptionRuntimeActionResult,
  SubscriptionRuntimeErrorCode,
  SubscriptionRuntimeId,
  SubscriptionRuntimeModelsResult,
  SubscriptionUsageSource,
  SubscriptionRuntimeStatusUpdatedEvent,
} from "../../shared/subscription-runtime.js";
import type { ChatSendInputOrigin } from "../../shared/chat-origin.js";
import type { TailnetSharingOwnerApi } from "../../shared/tailnet-sharing.js";
import type { TailnetObserverConfigApi } from "../../shared/tailnet-observer-config.js";
import type { GitMarketplaceApi, PackageUpdateView } from "../../shared/git-marketplace.js";
import type { PluginAttemptRefusal, PluginConfinementReport, PluginLoadArm } from "../../plugins/runtime/types.js";
import type { PluginStudioApi } from "../../shared/plugin-studio.js";
import type { GitRuntimeApi } from "../../shared/git-runtime.js";
import type { InstalledContentApi } from "../../shared/installed-content.js";
import type { TelegramConnectionOwnerApi } from "../../shared/telegram-connection.js";
import type { RolePreset } from "../../data/role-presets.js";
import type {
  AssistantAgentSummary,
  AssistantSkillSummary,
} from "../../shared/assistant-context.js";
import type {
  NativeContextMenuAction,
  NativeContextMenuPayload,
  DynamicNativeMenuAction,
  DynamicNativeMenuPayload,
} from "../../shared/native-context-menu.js";
import type { AiProviderPingIpcResult } from "../../shared/ai-provider-ping.js";
import type { ModelCatalogIpcResult } from "../../shared/model-catalog/types.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "../../shared/render-html-preview.js";
import type { SessionTaskItem } from "../../shared/session-tasks.js";
import type { SessionGoal } from "../../shared/session-goal.js";
import type { MarketplaceAnnouncementPayload } from "../../shared/marketplace-announcements.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import type { PluginOnboardingSpec } from "../../plugins/types.js";
import type {
  LlmModelListRequest,
  LlmModelListResult,
} from "../../shared/llm-model-list.js";
import type {
  SandboxCapabilityInfo,
  SandboxWindowsStatusInfo,
  SandboxWindowsInstallResult,
} from "../../shared/sandbox-capability-info.js";
import type { EgressDenialRow } from "../../shared/egress-denials.js";
import type { ListedEgressGrant, RevocableEgressGrant } from "../../shared/egress-grant-scopes.js";

// Re-export MCP types for renderer-side consumers (type-only, no main-process runtime)
export type { McpAuthErrorCode, McpServerConfig, McpServerConfigDto, McpServerState };
export type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
export type { ExecutionMode } from "../../shared/permission-mode.js";

// Re-export checkpoint types for renderer-side consumers (type-only, no main-process runtime).
export type { CheckpointTrigger, Checkpoint } from "../../memory/memory-manager.js";
// Remote A2A action status is the controller's own status record.
import type { RemoteA2AActionStatus } from "../../main/remote-a2a-action-controller.js";
export type { RemoteA2AActionStatus };
// Onboarding proposals are selected and stored in main; the renderer only
// renders what it is handed and reports the answer back.
import type {
  OnboardingProposalDisposition,
  PendingOnboardingProposal,
} from "../../main/onboarding-proposal-store.js";

// Plugin / hook trust rows and perf stats are the host row types.
import type { PluginPerfStats } from "../../plugins/runtime/index.js";
import type { PluginContributionTrustRow } from "../../plugins/plugin-bundle-lifecycle.js";
import type { HookTrustRow } from "../../hooks/hook-trust-commands.js";
export type { PluginPerfStats, PluginContributionTrustRow, HookTrustRow };

// Usage aggregates come from the engine/IPC owners; only the renderer-side
// derived shapes (UsagePerX, UsageTrendPt, UsageConv) are declared here.
import type { UsageTotals } from "../../engine/usage-stats.js";
import type { UsageDailySummaryInput, UsageDailySummaryResult } from "../../ipc/handlers/usage.js";

// Settings: the renderer sees the host AppSettings minus the main-only
// `a2aRemote` block, expressed once by the IPC projection type.
import type { RendererSettingsSnapshot as AppSettings } from "../../ipc/domains/settings.js";
import type { HomeDocsStatus } from "../../ipc/domains/home-docs.js";
import type { MemoryCaptureMode } from "../../data/settings-store.js";
export type { AppSettings, MemoryCaptureMode };

// Approval / permission contracts are the host types themselves (the full
// ApprovalRequest crosses the IPC boundary — see approval-gate.ts IPC_APPROVAL_REQUEST).
import type { ApprovalChoice, ApprovalDecision, ApprovalRequest } from "../../permissions/approval-gate.js";
import type { PermissionRule } from "../../permissions/permission-manager.js";
import type { ParentAdjudicationBackgroundEscalation, ParentAdjudicationMaxVerdict, ParentAdjudicationModelSource } from "../../permissions/permission-settings-store.js";
import type { PreviewReadDocumentResult } from "../../shared/preview-document.js";
export type { ApprovalChoice, ApprovalDecision, ApprovalRequest, PermissionRule, ParentAdjudicationBackgroundEscalation, ParentAdjudicationMaxVerdict, ParentAdjudicationModelSource };

export type PluginUiExtension = PluginUiExtensionView;
export type PluginManifestUiExtensionSummary = PluginUiExtensionView["extension"];

export type PluginConfigSchemaPropertySummary = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "secret" | "uri" | "email" | "date-time";
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Array<string | number | boolean> };
  /** Per-language `title` / `description` overrides (normalized BCP-47 tag → text). */
  locales?: Record<string, { title?: string; description?: string }>;
};

export type PluginConfigSchemaSummary = {
  $schema?: string;
  properties: Record<string, PluginConfigSchemaPropertySummary>;
  required?: string[];
  customPanel?: { entry: string; exportName: string };
};

export type PluginCardSummary = {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  capabilities: string[];
  tools: string[];
  toolDescriptions?: Record<string, string>;
  loadStatus?: "loaded" | "preparing" | "failed" | "disabled";
  /** Whether the plugin's tools are currently exposed to the model. */
  active?: boolean;
  /** Whether an active immutable plugin generation is currently instantiated. */
  runtimeLoaded?: boolean;
  preparationStatus?: {
    phase: string;
    message: string;
    progressPct?: number;
    updatedAt: string;
  };
  /** Optional Lucide icon name declared in the plugin manifest. */
  icon?: string;
  /** Optional short text rendered in place of a Lucide icon. */
  iconText?: string;
  /** Manifest-declared sidebar UI metadata, even before the plugin is loaded. */
  uiExtensions?: PluginManifestUiExtensionSummary[];
  version?: string;
  /** Declarative settings schema, when the manifest declares one. */
  configSchema?: PluginConfigSchemaSummary;
  /** Optional declarative auth contract for the host UI surface. */
  auth?: PluginAuthSummary;
  /** Declarative egress disclosure copied from the plugin manifest. */
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    allowPrivateNetworks?: boolean;
  };
  /** Declarative first-run guidance copied unchanged from the manifest. */
  onboarding?: PluginOnboardingSpec;
  /** Structured marketplace install failure classification for Doctor UI. */
  installFailureKind?: PluginInstallFailureKind;
  /** User-visible install/load failure detail preserved for Doctor diagnostics. */
  installFailureMessage?: string;
  /** The arm the plugin's factory came from (Doctor; §9.8 A1). */
  arm?: PluginLoadArm;
  /** The wrap the plugin's child was spawned under, or `not-spawned`. */
  confinement?: PluginConfinementReport;
  /** The last refused update or restart of this running plugin. */
  lastAttemptRefusal?: PluginAttemptRefusal;
  /** Marketplace request slugs that should collapse onto this installed plugin. */
  installAliases?: string[];
};

/**
 * One sub-agent row rebuilt from persisted metadata by a session-load handler.
 * The panel's live `agent_spawn` event stream does not survive an app restart,
 * so these rows are the only way a reopened conversation shows its agents.
 */
interface RestoredSubAgentPayload {
  spawnId: string;
  childSessionId: string;
  title: string;
  modifiedAt: string;
  taskState?: string;
  toolUseId?: string;
}

/**
 * Mirror of host-side `PluginAuthSpec` for renderer consumption — kept as a
 * separate name to make the renderer/host boundary explicit. Field shape
 * matches the host contract.
 */
export type PluginAuthSummary = {
  label?: string;
  /** Per-language `label` overrides (normalized BCP-47 tag → text). */
  locales?: Record<string, { label: string }>;
  statusTool: string;
  loginTool: string;
  logoutTool?: string;
};

/** Recommended return shape of `auth.statusTool`. Host parses defensively. */
export type PluginAuthStatusResult = {
  authenticated: boolean;
  account?: string;
};

export type LLMVendorSettingsRenderer = {
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
  /** Mirrors `LLMVendorSettings.presetModels` — read via `llmRouteModel`. */
  presetModels?: Record<string, string>;
  enableThinking: boolean;
  thinkingBudgetTokens: number;
};

export type IpcErrorResult = { ok: false; error: string; message?: string };
export type SettingsUpdateResult = AppSettings | IpcErrorResult;

export function isIpcErrorResult(value: unknown): value is IpcErrorResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type UsagePerX = UsageTotals & { vendor: string; model: string };
export type UsageTrendPt = UsageTotals & { date: string };
export type UsageConv = UsageTotals & { sessionId: string; turns: number; firstInput?: string };

/** Token-only telemetry for authenticated subscription runtimes. */
type SubscriptionUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  segments: number;
};
type SubscriptionUsagePerX = SubscriptionUsageTotals & {
  provider: SubscriptionRuntimeId;
  model: string;
};
type SubscriptionUsageTrendPt = SubscriptionUsageTotals & { date: string };
type SubscriptionUsageSummaryShape = {
  today: SubscriptionUsageTotals;
  thisWeek: SubscriptionUsageTotals;
  thisMonth: SubscriptionUsageTotals;
  perRuntime: SubscriptionUsagePerX[];
  perModel: SubscriptionUsagePerX[];
  trend: SubscriptionUsageTrendPt[];
  sources: Record<SubscriptionUsageSource, SubscriptionUsageTotals>;
};

export type UsageSummaryShape = {
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerX[];
  perModel: UsagePerX[];
  trend: UsageTrendPt[];
  topConversations: UsageConv[];
  /** Kept separate from API-key usage and all cost calculations. */
  subscription?: SubscriptionUsageSummaryShape;
  generatedAt: string;
};

/**
 * `reason` accompanies only `a2a-remote-start-failed`: the clamped `a2a-remote-*`
 * code naming why a switched-on gate did not start this run.
 */
type RemoteA2AFailure = { ok: false; error: string; reason?: string };

/**
 * The status channel also says whether the saved remote A2A switches differ
 * from the ones this run booted with (a change waiting for a restart). Absent
 * on the other channels, and when main could not read the saved switches.
 */
type RemoteA2ARuntimeFields = {
  restartPending?: boolean;
  /** The inbound receiver's loopback port this launch; null while it is not running. */
  receiverPort?: number | null;
};

type RemoteA2AStatusResult =
  | ({ ok: true; status: RemoteA2AActionStatus } & RemoteA2ARuntimeFields)
  | (RemoteA2AFailure & RemoteA2ARuntimeFields);

type RemoteA2AActionCall = {
  (action: "resume", taskHandle: string, userIntent: string): Promise<RemoteA2AStatusResult>;
  (action: "cancel" | "replay", taskHandle: string): Promise<RemoteA2AStatusResult>;
};

export type ProjectQueryOptions = {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
};

/** Host-owned metadata attached to a managed long-term memory. */
type MemoryEntry = {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  projectRoot?: string;
  projectName?: string;
  id?: string;
  kind?: "preference" | "constraint" | "fact" | "goal" | "reference" | "note";
  state?: "candidate" | "active";
  source?: "user" | "assistant" | "import";
  createdAt?: string;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
};

/** A review-only memory always has an immutable id and remains outside prompts. */
export type MemoryCandidate = MemoryEntry & { id: string; state: "candidate" };

type MemoryMutationResult =
  | { ok: true; entry?: MemoryEntry }
  | { ok: false; error: string };

type LongTermMemoryConsolidationScopeResult = {
  status: "updated" | "up-to-date" | "empty";
  sourceCount: number;
  consolidatedAt?: string;
};

type LongTermMemoryConsolidationResult =
  | { ok: true; global: LongTermMemoryConsolidationScopeResult; project?: LongTermMemoryConsolidationScopeResult }
  | { ok: false; error: string };

export type PluginMarketplaceActionResult =
  | { ok: true; pluginId: string; uninstalled: true }
  | { ok: false; error: string; message?: string };

/** ask_user_question — one FIFO request main pushes to the composer dock. */
export type AskUserQuestionRequest = {
  id: string;
  sessionId: string;
  questions: Array<{
    question: string;
    choices: string[];
    recommendedIndex?: number;
    altIndices?: number[];
    allowMultiple?: boolean;
    /** Draws a free-text field as the last answer row. */
    allowFreeText?: boolean;
    placeholder?: string;
    summaryHint?: string;
  }>;
  createdAt: number;
};

export type AskUserQuestionResponse = {
  requestId: string;
  answers?: Array<{
    choice?: string;
    /** Multi-select selections (only set when the question allowMultiple). */
    choices?: string[];
    /** Typed answer (only set when the question allowFreeText). */
    freeText?: string;
  }>;
  dismissed?: boolean;
};

/** Which surface raised an in-app toast / OS notification. */
type NotificationKind = "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "alert" | "system";

/** What the notification points back at, so a click can land on its source. */
type NotificationContextRef = {
  sessionId?: string;
  routineId?: string;
  questionId?: string;
  approvalId?: string;
};

export type NotificationToastPayload = {
  kind: NotificationKind;
  title: string;
  body: string;
  contextRef?: NotificationContextRef;
  /** Stays until the user dismisses it (a `high` priority alert). */
  sticky?: true;
};

/** An overlay trigger began running — main → renderer, before any item is shown. */
export type OverlayTriggerStartedPayload = {
  sessionId: string;
  pluginId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  startedAt: string;
};

export type OverlayTriggerCompletedPayload = {
  sessionId: string;
  pluginId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  prompt: string;
  summary: string;
  completedAt: string;
};

export type OverlayTriggerExpiredPayload = { sessionId: string; pluginId: string; source: string };

export type OverlayTriggerFailedPayload = {
  sessionId: string;
  pluginId: string;
  source: string;
  reason: "provider_error" | "tool_error" | "abort" | "unknown";
  errorId: string;
};

export type OverlayTriggerImportedPayload = {
  sessionId: string;
  source: string;
  prompt: string;
  summary: string;
  toolCallCount: number;
  importedAt: string;
  wrappedPrompt: string;
};

export type NotificationClickPayload = {
  kind: NotificationKind;
  contextRef?: NotificationContextRef;
};

export type AveApi = {
  relaunchApp: () => Promise<import("../../shared/app-relaunch.js").AppRelaunchResult>;
  /**
   * Deterministic file:// URL of the bundled `plugin-preload.js`. Computed in
   * the host preload from `__dirname` (= `dist/src/`) so the plugin <webview>
   * can be mounted with a stable preload regardless of `window.location.href`.
   */
  pluginPreloadUrl: string;
  permission: AvePermissionApi;
  approval: AveApprovalApi;
  policy: AvePolicyApi;
  mcp: AveMcpApi;
  remoteA2a: {
    targets: () => Promise<
      | { ok: true; targets: Array<{ targetAgentId: number; label: string }> }
      | RemoteA2AFailure
    >;
    status: () => Promise<RemoteA2AStatusResult>;
    send: (targetAgentId: number, userIntent: string) => Promise<RemoteA2AStatusResult>;
    task: (taskHandle: string) => Promise<RemoteA2AStatusResult>;
    tasks: () => Promise<{ ok: true; tasks: RemoteA2AActionStatus[] } | RemoteA2AFailure>;
    action: RemoteA2AActionCall;
  };
  tailnetSharing: TailnetSharingOwnerApi;
  tailnetObserver: TailnetObserverConfigApi;
  /** Git marketplace runtime: status, managed install, install progress. */
  gitRuntime: GitRuntimeApi;
  /** Git marketplace: sources, catalog, install plans and execution (design §13). */
  gitMarketplace: GitMarketplaceApi;
  pluginStudio: PluginStudioApi;
  /** Installed content packages: themes, languages and fonts, and installed language catalogs. */
  installedContent: InstalledContentApi;
  telegramConnection: TelegramConnectionOwnerApi;
  /**
   * Deterministic file:// URL of the bundled `plugin-ui-shell.html`. Same
   * stability guarantee as `pluginPreloadUrl` — read directly from the host
   * renderer instead of resolving against `window.location.href`.
   */
  pluginShellUrl: string;
  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) => Promise<{ ok: boolean; error?: string }>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<SettingsUpdateResult>;
  /** Settings paths the boot environment is forcing ON; presence only, never values. */
  envForcedSettings: () => Promise<readonly string[]>;
  /** Hosts `telemetry.endpoint` may point at. Read-only: the bound, not a setting. */
  telemetryAllowedHosts: () => Promise<readonly string[]>;
  onSettingsUpdated: (handler: (settings: AppSettings) => void) => () => void;
  onSubscriptionRuntimeStatusUpdated: (
    handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void,
  ) => () => void;
  listPersonaPromptSummaries: () => Promise<{ prompts: Array<Pick<RolePreset, "id" | "name">> }>;
  listPersonaPrompts: () => Promise<{ prompts: RolePreset[]; templates: import("../../shared/agent-plugin-prompt.js").AgentPluginTemplatePrompt[] }>;
  savePersonaPrompt: (prompt: { id: string; name: string; systemPromptAdd: string }) => Promise<
    | { ok: true; prompt: RolePreset }
    | { ok: false; error: string }
  >;
  deletePersonaPrompt: (id: string) => Promise<
    | { ok: true; deleted: boolean }
    | { ok: false; error: string }
  >;
  onPersonaPromptsUpdated?: (handler: () => void) => () => void;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  listLlmModels: (request: LlmModelListRequest) => Promise<LlmModelListResult>;
  codexSubscriptionStatus: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionStartBrowserLogin: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionStartDeviceCodeLogin: () => Promise<CodexSubscriptionDeviceCodeResult>;
  codexSubscriptionCancelLogin: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionLogout: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionListModels: () => Promise<CodexSubscriptionModelsResult>;
  subscriptionRuntimeStatus: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionChooseRuntime: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionForgetRuntime: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionVerifyRuntime: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionStartLogin: (provider: SubscriptionRuntimeId, method: SubscriptionLoginMethod) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionOpenLoginBrowser: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionCancelLogin: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  /** Dismiss the card's sign-in notice (ChatGPT plan usage). */
  subscriptionAcknowledgeNotice: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionLogout: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionListModels: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeModelsResult>;
  subscriptionUseForChat: (provider: SubscriptionRuntimeId, model?: string) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionUseApiForChat: () => Promise<
    | { ok: true }
    | { ok: false; error: SubscriptionRuntimeErrorCode }
  >;
  acpSubscriptionStatus: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionChooseRuntime: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionForgetRuntime: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionVerify: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionStartLogin: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionOpenLoginBrowser: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionCancelLogin: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionLogout: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  installMarketplaceProviderPreset: (
    preset: MarketplaceInstalledProviderPreset,
  ) => Promise<SettingsUpdateResult>;
  uninstallMarketplaceProviderPreset: (
    providerId: string,
  ) => Promise<SettingsUpdateResult>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  /**
   * Browser tabs for the agent browser tools (shared/browser-surface.ts):
   * bind a tab id to its guest <webview> after attach, revoke control on stop or user navigation,
   * and main's tab-op / agent-control events. Optional for test fixtures.
   */
  browserTabs?: import("../../shared/browser-surface.js").BrowserTabsApi;
  browserWorkspace?: import("../../shared/browser-workspace.js").BrowserWorkspaceApi;
  /** Report the browser/terminal tab the user is looking at (a hint for agent tools). */
  setActiveSurface?: (surface: ActiveWorkspaceSurface | null) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Interactive PTY terminal (#1444, workspace rail). `spawn` is idempotent per
   * tab (a remount replays the scrollback rather than starting a fresh shell);
   * `onData` / `onExit` return unsubscribe functions (the onChatStream pattern).
   * Optional so test fixtures casting a partial object to AveApi keep compiling
   * — production preload always defines it.
   */
  terminal?: import("../../shared/terminal-session.js").TerminalApi;
  /**
   * Side chat (workspace rail) — a second, independently-streaming chat session
   * driven by a dedicated ConversationLoop in main. `onStream` / `onFallback`
   * subscribe to the DEDICATED CHANNELS.sidechat.{stream,fallback} events (never
   * the main chat.stream), so a main-chat stream frame never reaches this
   * subscriber and vice versa. Optional so test fixtures casting a partial
   * object to AveApi keep compiling — production preload always defines it.
   */
  sideChat?: {
    listShellTasks: (expectedSessionId: string) => Promise<ShellTask[]>;
    controlShellTask: (expectedSessionId: string, action: ShellTaskAction, shellId?: string) => Promise<ShellTaskActionResult>;
    send: (
      input: string,
      attachments?: unknown[],
      /** The conversation this side chat belongs to — recorded at its first turn. */
      originSessionId?: string,
      /** Opaque correlation echoed in the user prelude and used for scoped cancellation. */
      sendRequestId?: string,
      /** The pane tab a pane's own chat is bound to; its tools default to that tab. */
      surface?: ActiveWorkspaceSurface,
      /** The side chat the sending view shows; a turn never lands in a pane's chat by accident. */
      sessionId?: string,
    ) => Promise<
      | { ok: true; result: unknown }
      | SideChatOperationFailure
    >;
    new: () => Promise<{ ok: true; sessionId: string } | SideChatOperationFailure>;
    load: (sessionId: string) => Promise<
      | { ok: true; sessionId: string; messages: SerializedHistoryMessage[] }
      | (SideChatOperationFailure & { messages: SerializedHistoryMessage[] })
    >;
    /** Reads a child of the active side-chat session; optional only in partial fixtures. */
    getSubAgentTranscript?: (request: SubAgentTranscriptRequest) => Promise<SubAgentTranscriptResult>;
    abort: (sendRequestId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** A pane chat's conversation and history, read without moving the side loop. */
    paneHistory: (tabId: string) => Promise<
      | { ok: true; sessionId: string | null; messages: SerializedHistoryMessage[] }
      | { ok: false; error: string }
    >;
    /** End a pane chat: `new` starts it afresh, `closed` also archives it. */
    endPaneChat: (tabId: string, reason: "new" | "closed") => Promise<
      | { ok: true; sessionId: string | null }
      | { ok: false; error: string }
    >;
    onStream: (handler: (event: ChatStreamEvent) => void) => () => void;
    onFallback: (handler: (payload: { from: string; to: string }) => void) => () => void;
  };
  /**
   * Tutorial-C — SpotlightTour state + broadcast bridge. The host persists
   * the tour state under `~/.ave/onboarding/tour-state.json` (Storage
   * Namespace per Feature). `tour.start` fans out to every open window
   * so any renderer surface can launch the tour without owning tour state.
   */
  tour: {
    getState: () => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    markComplete: (scenarioId: string) => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    dismiss: (scenarioId: string) => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    start: (scenarioId: string) => Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    >;
    onStart: (handler: (payload: { scenarioId: string }) => void) => () => void;
  };
  /**
   * Plugin onboarding proposals — the host asks each declared proposal once and
   * remembers the answer under `~/.ave/onboarding/proposals.json`. Both calls
   * stage the head of the remaining queue as an overlay card, so the renderer
   * never chooses which proposal comes next.
   */
  onboarding: {
    listPending: (locale: string) => Promise<
      | { ok: true; pending: PendingOnboardingProposal[] }
      | { ok: false; error: string; message: string }
    >;
    answer: (
      key: string,
      disposition: OnboardingProposalDisposition,
      locale: string,
    ) => Promise<
      | { ok: true; pending: PendingOnboardingProposal[] }
      | { ok: false; error: string; message: string }
    >;
  };
  documentEngine: DocumentEngineApi;
  /** Open an http(s) URL in the system browser. Main-side rejects any other scheme. */
  openExternalUrl: (url: string) => Promise<{
    ok: boolean;
    error?: string;
    protocol?: string;
    message?: string;
  }>;
  /** Claude Desktop config import. */
  previewClaudeDesktopMcpImport: (raw: string) => Promise<{
    entries: Array<{
      id: string;
      config: McpServerConfig;
      suspectedSecretEnvKeys: string[];
      warning?: string;
    }>;
    errors: Array<{ id: string; reason: string }>;
  }>;
  applyClaudeDesktopMcpImport: (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) => Promise<
    | {
        ok: true;
        results: Array<
          | { id: string; action: "added" | "skipped-conflict" | "overwritten"; reason?: string; warning?: string }
          | { id: string; action: "failed"; failure: import("../../mcp/claude-desktop-import.js").ClaudeDesktopImportFailure; reason: string; warning?: string }
        >;
        parseErrors: Array<{ id: string; reason: string }>;
      }
    | { ok: false; error: string }
  >;
  // Provider-auth bridge methods are plugin-owned.
  chatHasProvider: () => Promise<boolean>;
  /** Custom slash commands visible from this tile's session project. */
  chatListCustomCommands?: () => Promise<{ commands: import("../../shared/custom-command.js").CustomCommandEntry[] }>;
  captureUserKeyboardIntent: () => import("../../shared/chat-origin.js").UserKeyboardIntentSnapshot;
  chatSend: (
    input: string,
    attachments: import("../../engine/llm/types.js").UserContentPart[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: import("../../shared/chat-origin.js").UserKeyboardIntentSnapshot,
    personaPromptId?: string,
    options?: { interrupt?: boolean },
  ) => Promise<unknown>;
  chatGuide: (input: string) => Promise<unknown>;
  chatNew: (opts?: { projectRoot?: string; projectName?: string }) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  chatSessions: (opts?: { kind?: SessionListKindFilter; families?: SessionFamily[]; routineId?: string; projectRoot?: string; limit?: number; before?: string; beforeId?: string; after?: string }) => Promise<{ current: string; sessions: SessionListRow[] }>;
  onChatStream: (h: (e: ChatStreamEvent) => void) => () => void;
  /**
   * One tiled chat group's view of the per-conversation channels.
   *
   * A tile passes this where it would otherwise pass the api, so nothing below
   * it has to know about groups — its calls already name the right
   * conversation, and its stream subscription only sees that group's frames.
   * See docs/design/tiled-chat-groups.md.
   */
  /**
   * One tile's view of the per-conversation channels. It rebinds those
   * channels only — settings, plugins and the rest are window-wide — so a
   * tile layers it over the base surface (`{ ...api, ...api.chatGroup(id) }`).
   */
  chatGroup?: (chatGroupId: string) => Partial<AveApi>;
  /**
   * Let go of this group's conversation in main. Sent when its tile closes;
   * the primary group refuses it.
   */
  chatGroupRelease: () => Promise<{ ok: boolean; released?: boolean; error?: string }>;
  onChatFallback: (h: (payload: { from: string; to: string }) => void) => () => void;
  chatGetHistory: () => Promise<{ restoredSubAgents?: RestoredSubAgentPayload[]; sessionId: string; sessionTitle?: string; sessionKind: "main" | "routine"; routineId?: string; routineTitle?: string; projectRoot?: string; projectName?: string; projectIsDefault?: boolean; messages: SerializedHistoryMessage[] }>;
  chatMainActiveState: () => Promise<{ mainActiveSessionId: string | null; mainActiveMode: "resume" | "fresh"; updatedAt: string } | null>;
  chatSessionHistory: (sessionId: string) => Promise<{
    ok: boolean;
    restoredSubAgents?: RestoredSubAgentPayload[];
    sessionTitle?: string;
    sessionKind?: "main" | "routine";
    routineId?: string;
    routineTitle?: string;
    routineFiredAt?: string;
    projectRoot?: string;
    projectName?: string;
    messages: SerializedHistoryMessage[];
    /** Chars in the rolling summary preamble applied to this session. 0 = no preamble. */
    preambleChars?: number;
  }>;
  /**
   * Replace one user message and re-run the conversation from it. `messageId`
   * is the row's durable identity (see ChatEntry.messageId) — a position would
   * name a different row after the next compaction.
   */
  chatEditResend: (messageId: string, newText: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Restore conversation, native file-tool edits, or both before this user
   * message. Omitted mode restores conversation only: the message and later
   * rows are discarded and its input is returned for the composer. Code-only
   * restore keeps the conversation intact.
   */
  chatRewindTo: (messageId: string, mode?: RewindMode) => Promise<RewindResult>;
  chatGetTurnReview: (expectedSessionId: string) => Promise<TurnReviewResult>;
  /** Branch into a new session up to and including `messageId`; omit it to branch the whole conversation. */
  chatFork: (messageId?: string) => Promise<{ ok: boolean; sessionId: string | null; error?: string }>;
  chatContinueLastUser: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  /** `sessionId` targets a conversation other than the loaded one. */
  chatExport: (format: "markdown" | "json", sessionId?: string) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  /** Row-level conversation edits. Each field is optional; omitted means unchanged. */
  chatSessionUpdate: (payload: {
    sessionId: string;
    title?: string;
    archived?: boolean;
    unread?: boolean;
  }) => Promise<{ ok: true } | { ok: false; error?: string }>;
  chatSessionDelete: (
    sessionId: string,
  ) => Promise<{ ok: true; wasLoaded: boolean } | { ok: false; error?: string; canceled?: boolean }>;
  /** Reverse of chatExport. Always creates a brand-new session (never overwrites). */
  chatImport: () => Promise<
    { ok: true; sessionId: string; messageCount: number } | { ok: false; error?: string; canceled?: boolean }
  >;
  /** `focus` steers what the summary keeps (`/compact <focus>`). */
  chatCompact: (focus?: string) => Promise<{ compacted: boolean; compactedAt: string | null; summary: string; removedMessageCount: number }>;
  chatSessionResume: (sessionId: string) => Promise<{
    ok: boolean; compacted: boolean; compactedAt: string | null; removedMessageCount: number;
    error?: string;
    /** On `session-open-in-other-group`: the chat group whose loop holds the session. */
    holderChatGroupId?: string;
  }>;
  // Checkpoint view and explicit branch actions.
  // Note: enter/branch return discriminated unions without `ok`; exit follows the
  // standard { ok: boolean } pattern. Callers guard with `"error" in result`.
  chatEnterCheckpointView: (sessionId: string, compactNum: number) => Promise<{ messageIndexAtCreation: number } | { error: string }>;
  chatExitCheckpointView: () => Promise<{ ok: boolean }>;
  chatBranchFromCheckpoint: (sessionId: string, compactNum: number) => Promise<{
    newSessionId: string;
    lastMessageRole: "user" | "assistant" | "tool_result" | null;
    shouldAutoContinue: boolean;
  } | { error: string }>;
  chatAbort: () => Promise<{ ok: boolean }>;
  chatListShellTasks: (expectedSessionId: string) => Promise<ShellTask[]>;
  chatControlShellTask: (expectedSessionId: string, action: ShellTaskAction, shellId?: string) => Promise<ShellTaskActionResult>;
  /** Lazy-load in-session verbatim content for a compacted tool_result.
   * Returns null when: session changed, toolUseId not found, verbatim
   * already flushed to disk stub, or meta.compactedAt was never set. lineCount
   * is pre-computed server-side. */
  chatGetVerbatimToolResult: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ content: string; lineCount: number } | null>;
  /** Lazy-load the isolated child-session transcript for a sub-agent row. */
  chatGetSubAgentTranscript?: (opts: SubAgentTranscriptRequest) => Promise<SubAgentTranscriptResult>;
  /** Issue #749: lazy-load full write_file diff when content exceeded preview limit.
   * Returns { before, after } from ~/.ave/diff-cache/<sessionId>/<toolUseId>.json,
   * or null when sidecar not found / session id invalid. */
  chatGetWriteDiff: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ before: string; after: string } | null>;
  submitFeedback: (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => Promise<{ ok: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListEntries: (opts?: ProjectQueryOptions) => Promise<Array<{ filename: string; title: string; content: string; updatedAt?: string; projectRoot?: string; projectName?: string }>>;
  memoryListCandidates: (opts?: ProjectQueryOptions) => Promise<MemoryCandidate[]>;
  memorySaveEntry: (t: string, c: string, opts?: ProjectQueryOptions) => Promise<unknown>;
  memoryDeleteEntry: (f: string, opts?: ProjectQueryOptions) => Promise<MemoryMutationResult>;
  memoryActivateCandidate: (id: string, opts?: ProjectQueryOptions) => Promise<MemoryMutationResult>;
  memoryDeleteCandidate: (id: string, opts?: ProjectQueryOptions) => Promise<MemoryMutationResult>;
  memorySearchEntries: (q: string, opts?: ProjectQueryOptions) => Promise<Array<{ filename?: string; title: string; content?: string; excerpt: string; updatedAt: string; projectRoot?: string; projectName?: string }>>;
  memoryGetIndex: (opts?: ProjectQueryOptions) => Promise<string>;
  memoryUpdateIndexIfUnchanged: (expectedContent: string, nextContent: string) => Promise<boolean>;
  memoryUpdateIndexSections: (sections: { urgentMemory?: string; references?: string }) => Promise<unknown>;
  memoryListSessions: (opts?: ProjectQueryOptions) => Promise<Array<{ sessionId: string; title?: string; matchedMessage: string; timestamp: string }>>;
  memorySearchSessions: (q: string, opts?: ProjectQueryOptions) => Promise<Array<{ sessionId: string; title?: string; matchedMessage: string; timestamp: string }>>;
  memoryGetAgentsMd: () => Promise<string>;
  memoryUpdateAgentsMd: (content: string) => Promise<unknown>;
  memoryGetUserPrefs: () => Promise<string>;
  memoryUpdateUserPrefs: (content: string) => Promise<unknown>;
  memoryRefreshUserPrefs: () => Promise<
    | {
        ok: true;
        content: string;
        refreshedAt?: string;
        sources?: string[];
      }
    | { ok: false; error: string }
  >;
  /** `~/.ave` reference docs: pending packaged updates + the merge artifact. */
  homeDocsStatus: () => Promise<HomeDocsStatus>;
  homeDocsReadMarker: (markerPath: string) => Promise<
    | { ok: true; content: string; live: string }
    | { ok: false; error: string }
  >;
  homeDocsApplyPackaged: (markerPath: string) => Promise<
    | { ok: true; movedToCustom: boolean }
    | { ok: false; error: string }
  >;
  homeDocsKeepMine: (markerPath: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  homeDocsGetCustom: () => Promise<string>;
  homeDocsUpdateCustom: (content: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  homeDocsMerge: (markerPath?: string) => Promise<
    | { ok: true; content: string; mergedAt: string; sources: string[] }
    | { ok: false; error: string }
  >;
  homeDocsApplyMerged: (expectedContent: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  homeDocsDiscardMerged: () => Promise<{ ok: true }>;
  memoryRefreshLongTerm: () => Promise<LongTermMemoryConsolidationResult>;
  listAgentProfiles: () => Promise<{ agents: AssistantAgentSummary[] }>;
  listSkills: () => Promise<{ skills: AssistantSkillSummary[] }>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  readPluginUiModule: (pluginId: string, viewId: string) => Promise<string>;
  callPluginMethod: (
    m: string,
    p?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => Promise<unknown>;
  /** AVE_E2E-only generation/Skill/tool/Hook projection; production fails closed. */
  e2ePluginBundleSnapshot: (
    pluginId: string,
    skillLocalId: string,
    hookProbeToolName: string,
  ) => Promise<unknown>;
  /**
   * Subscribe to plugin-emitted events forwarded by the host event bridge
   * (`boot/steps/ipc-bridge.ts` → `ave:plugin:event`). Plugin must declare
   * the type in `manifest.emittedEvents[]`. The preload layer rejects
   * subscriptions whose namespace prefix appears in `PLUGIN_PRIVATE_NAMESPACES`
   * by returning a no-op unsubscribe without wiring the IPC listener — so
   * renderer code can never observe sensitive host state (memory contents,
   * secrets, audit trails, DLP decisions) through this API. Returns an
   * unsubscribe function. Used by `usePluginAuthStatuses` for
   * `<pluginId>.auth.changed`.
   */
  onPluginEvent?: (eventType: string, handler: (data: unknown) => void) => (() => void);
  listPluginCards: () => Promise<PluginCardSummary[]>;
  listPluginContributionTrust: (pluginId?: string) => Promise<
    | { ok: true; rows: PluginContributionTrustRow[] }
    | { ok: false; error: string }
  >;
  /**
   * Approve or revoke an installed bundled component. An approval carries the
   * reviewed row's `generationId` and `approvalDigest` (design §18.7.5); a
   * revoke carries neither. A row that changed since it was listed answers
   * `contribution-trust-review-stale`.
   */
  setPluginContributionTrust: (input: {
    pluginId: string;
    localId: string;
    kind: "hook" | "mcpServer";
    approved: boolean;
    generationId?: string;
    approvalDigest?: string | null;
  }) => Promise<
    | { ok: true; pluginId: string; localId: string; kind: "hook" | "mcpServer"; approved: boolean }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * Toggle a plugin active/inactive. Disable retires and unloads the active
   * generation; re-enable re-verifies the receipt and activates a fresh one.
   */
  setPluginEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<
    | { ok: true; pluginId: string; enabled: boolean }
    | { ok: false; error: string; message: string }
  >;
  // routine_schedule — persistent routine list + lifecycle
  listRoutines: () => Promise<import("../../shared/routines-types.js").RoutineListResult>;
  dismissRoutine: (id: string) => Promise<{ ok: boolean; error?: string }>;
  removeRoutine: (id: string) => Promise<{ ok: boolean; error?: string }>;
  triggerRoutineNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
  listPendingRoutineResults: () => Promise<import("../../shared/routines-types.js").RoutineFiredPayload[]>;
  acknowledgeRoutineResult: (routineId: string, firedAt: string) => Promise<{ ok: boolean; error?: string }>;
  addRoutine: (
    input: import("../../shared/routines-types.js").AddRoutineInput,
  ) => Promise<
    | { ok: true; routine: import("../../shared/routines-types.js").RoutineRecord }
    | { ok: false; error: string }
  >;
  onRoutineFired: (
    handler: (event: import("../../shared/routines-types.js").RoutineFiredPayload) => void,
  ) => () => void;
  // Routine running indicator
  // Enriched payload includes title+firedAt so renderer can push OverlayItem immediately
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => () => void;
  onRoutineRunningFinished: (handler: (routineId: string) => void) => () => void;
  // failed: clears running:true stuck OverlayItem when the LLM session throws
  onRoutineFailed: (handler: (event: { routineId: string; error: string }) => void) => () => void;
  // Overlay IPC bridges
  // ─── Observability + privacy surfaces ─────────────────────────────────
  // The IPC bridge resolves these to `unknown`; each result's shape is
  // declared by its one consumer tab (AuditTab, DiagnosticsSection,
  // PrivacyTab) until it is lifted here. Parameters are the contract.
  dlp: {
    getStats: (days: number) => Promise<unknown>;
  };
  audit: {
    search: (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => Promise<unknown>;
    getStats: (lastDays: number) => Promise<unknown>;
  };
  diagnostics: {
    /** Build a redacted diagnostics ZIP and save via native dialog. */
    export: (opts?: { dateFrom?: string; dateTo?: string; includeCrashDumps?: boolean }) => Promise<unknown>;
    /** Crash-dump metadata (filename/time/size). */
    crashList: () => Promise<unknown>;
  };
  logs: {
    /** Recent N redacted log lines, optional level filter. */
    tail: (args?: { lines?: number; level?: string }) => Promise<unknown>;
  };
  /** The same store `window.ave.userApproval` fronts. */
  userApproval: AveUserApprovalApi;
  // ─── Overlay trigger lifecycle ────────────────────────────────────────
  dismissTrigger: (sessionId: string) => Promise<{
  ok: boolean;
  removed?: boolean;
  error?: string;
}>;
  importTrigger: (sessionId: string) => Promise<{
  ok: boolean;
  imported?: number;
  reason?: string;
  error?: string;
}>;
  onTriggerStarted: (handler: (payload: OverlayTriggerStartedPayload) => void) => () => void;
  onTriggerCompleted: (handler: (result: OverlayTriggerCompletedPayload) => void) => () => void;
  onTriggerExpired: (handler: (payload: OverlayTriggerExpiredPayload) => void) => () => void;
  onTriggerFailed: (handler: (payload: OverlayTriggerFailedPayload) => void) => () => void;
  onTriggerImported: (handler: (payload: OverlayTriggerImportedPayload) => void) => () => void;
  onOverlayShow: (handler: (item: import("./context/OverlayContext.js").OverlayItem) => void) => () => void;
  onOverlayUpdate: (handler: (id: string, patch: Partial<import("./context/OverlayContext.js").OverlayItem>) => void) => () => void;
  onOverlayDismiss: (handler: (id: string) => void) => () => void;
  /** Plugin alert cards: report the user's answer, and pull the cards staged before this window listened. */
  alerts?: {
    removePredecessor: (kindKey: string) => Promise<import("../../shared/alerts-types.js").RemoveAlertPredecessorResult>;
    listKinds: () => Promise<import("../../shared/alerts-types.js").AlertKindRow[]>;
    setKind: (kindKey: string, patch: import("../../shared/alerts-types.js").AlertKindPatch) => Promise<import("../../shared/alerts-types.js").SetAlertKindResult>;
    setOsNotificationsEnabled: (enabled: boolean) => Promise<import("../../shared/alerts-types.js").SetAlertOsNotificationsResult>;
    onKindsChanged: (handler: () => void) => () => void;
    cardClosed: (alertId: string, reason: import("../../shared/alerts-types.js").AlertCardClosedReason) => Promise<{ ok: boolean; error?: string }>;
    listOpen: () => Promise<import("../../shared/alerts-types.js").AlertCard[]>;
  };
  // Routine session history
  listRoutineSessions: (
    routineId: string,
    limit?: number,
  ) => Promise<RoutineRunRow[]>;
  // ─── Work Board — personal board CRUD + lifecycle ───
  // Result envelopes are the store's discriminated `status` unions (or
  // `{ ok:false, error }` for unauthorized-frame / no-store). Shared types come
  // from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkBoard: (
    filter?: import("../../shared/work-board-types.js").WorkItemListFilter,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemListResult
    | { ok: false; error: string }
  >;
  getWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemGetResult
    | { ok: false; error: string }
  >;
  addWorkBoardItem: (
    input: import("../../shared/work-board-types.js").WorkItemCreateInput,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemCreateResult
    | { ok: false; error: string }
  >;
  updateWorkBoardItem: (
    id: number,
    patch: import("../../shared/work-board-types.js").WorkItemUpdateInput,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemUpdateResult
    | { ok: false; error: string }
  >;
  transitionWorkBoardItem: (
    id: number,
    to: import("../../shared/work-board-types.js").WorkItemStatusStored,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemTransitionResult
    | { ok: false; error: string }
  >;
  completeWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemCompleteResult
    | { ok: false; error: string }
  >;
  reopenWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemReopenResult
    | { ok: false; error: string }
  >;
  removeWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemDeleteResult
    | { ok: false; error: string }
  >;
  // Board view live refresh: emitted after any successful board mutation so the
  // renderer re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => () => void;
  // Agent-orchestration run: kick off plan→approve→execute for one item. The
  // promise resolves with the terminal run result; live phase + coarse marker
  // updates flow over the on* subscriptions below. `opts.agentName` selects a
  // named agent profile (drives the child model for both phases).
  runWorkBoardItem: (
    id: number,
    opts?: { agentName?: string },
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemRunResult
    | { ok: false; error: string }
  >;
  // Generate a daily / weekly personal work report (markdown) from the board
  // state + activity log + learned memory.
  generateWorkBoardReport?: (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkBoardReportResult
    | { ok: false; error: string }
  >;
  // Run the daily / weekly briefing — the reports surface in the opposite
  // direction. It surveys the user's work and files what it found onto the
  // board as proposals, resolving with the ids of the cards it wrote.
  runWorkBoardBriefing?: (
    kind: import("../../shared/work-board-types.js").WorkBoardBriefingKind,
    projectRoot?: string,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkBoardBriefingResult
    | { ok: false; error: string }
  >;
  // ─── Recommended work (plugin-proposed cards) ────
  // Read-only from the renderer's side plus the two answers the user can give.
  // Plugins post and withdraw over HostApi; there is no renderer create path.
  listWorkProposals?: () => Promise<
    | import("../../shared/work-board-types.js").WorkProposalListResult
    | { ok: false; error: string }
  >;
  acceptWorkProposal?: (
    proposalId: string,
    projectRoot?: string,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkProposalAcceptResult
    | { ok: false; error: string }
  >;
  dismissWorkProposal?: (
    proposalId: string,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkProposalDismissResult
    | { ok: false; error: string }
  >;
  onWorkProposalChanged?: (
    handler: (payload: import("../../shared/work-board-types.js").WorkProposalChangedEventPayload) => void,
  ) => () => void;
  // Read a past run's persisted transcript (plan+execute conversation) for the
  // run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript?: (
    itemId: number,
    runId: string,
  ) => Promise<
    | { events: import("../../shared/work-board-types.js").RunTranscriptEvent[] }
    | { ok: false; error: string }
  >;
  // Live per-phase progress for an in-flight run. Payload === the engine's
  // WorkBoardRunEvent (aliased RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => () => void;
  // Coarse markers so the renderer can set/clear a per-item running indicator
  // without re-listing.
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string }) => void,
  ) => () => void;
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      status: "completed" | "denied" | "not_found" | "error" | "already_running";
      at: string;
    }) => void,
  ) => () => void;
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => () => void;
  /** Installed packages whose bound source offers a newer version (design §7.3). */
  onMarketplaceUpdatesAvailable: (h: (updates: PackageUpdateView[]) => void) => () => void;
  /**
   * Marketplace announcement stream — the host pushes the currently-active,
   * not-yet-dismissed announcements whenever the announcement poller runs.
   * The renderer shows them in a banner and persists dismissals via
   * `updateSettings({ marketplace: { dismissedAnnouncementIds } })`.
   */
  onMarketplaceAnnouncements: (h: (announcements: MarketplaceAnnouncementPayload) => void) => () => void;
  /**
   * App auto-update state stream — emitted by the main process whenever
   * the updater state changes (available → downloading → downloaded).
   * Renderer renders a permanent badge next to the Home button based on
   * this state. Download is user-gated (badge click) — see `downloadAppUpdate`.
   *
   * Both this method and `getAppUpdateState` reference the SoT
   * `UpdateState` union from `src/shared/update-state.ts` — never inline
   * the discriminated literals here (Field-Addition Sweep rule).
   */
  onAppUpdateState: (
    handler: (state: import("../../shared/update-state.js").UpdateState) => void,
  ) => () => void;
  /** Late-mount sync: fetch the last broadcasted state. */
  getAppUpdateState: () => Promise<import("../../shared/update-state.js").UpdateState>;
  /** Trigger download. Valid only when state is "available". */
  downloadAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** Quit & install after main-owned native confirmation. Valid only when state is "downloaded". */
  installAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** Hide the current available/downloaded app update until a newer version appears. */
  skipAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  onBootstrapStatus: (h: (status: AppBootstrapStatus) => void) => () => void;
  /**
   * Late-mount sync for `onBootstrapStatus`: on a cold boot the whole status
   * sequence is emitted before this renderer exists, so the subscription alone
   * never sees it. `null` when the host has reported nothing yet.
   */
  getBootstrapStatus: () => Promise<AppBootstrapStatus | null>;
  retryBootstrap: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onPluginInstallResult: (h: (payload: PluginInstallResultPayload) => void) => () => void;
  onPluginUninstallResult: (h: (payload: { slug: string; success: boolean; error?: string }) => void) => () => void;
  /** #1176 — plugin active/inactive toggled (this surface or another). */
  onPluginEnabledChanged?: (h: (payload: { pluginId: string; enabled: boolean }) => void) => () => void;
  /** Fires after a loaded plugin runtime is restarted/reloaded without a full app restart. */
  onPluginRuntimeUpdated?: (h: (payload: { pluginId: string }) => void) => () => void;
  onAgentUninstallResult: (h: (payload: AgentInstallResultPayload) => void) => () => void;
  onSkillUninstallResult: (h: (payload: SkillInstallResultPayload) => void) => () => void;
  /**
   * Dev-only: open a folder picker and install a local plugin directory.
   *
   * Return shape:
   *   - `null` — the user cancelled the folder picker. NOT an error.
   *   - `{ pluginId, installed: true }` — install succeeded.
   *   - throws — auth/dev-mode/IO error. Callers must catch + surface as a
   *     toast/alert; collapsing the error into `null` would hide failures.
   */
  installLocalPlugin: () => Promise<{ pluginId: string; installed: true } | null>;
  getRuntimeCounts: () => Promise<{ tools: number; plugins: number; mcps: number }>;
  getRuntimeEnv: () => Promise<{ platform: string; hostname: string; user: string }>;
  pingAiProvider: () => Promise<AiProviderPingIpcResult>;
  getModelCatalog: () => Promise<ModelCatalogIpcResult>;

  getAppInfo: () => Promise<{
    version: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
    v8Version: string;
    platform: NodeJS.Platform;
    arch: string;
    userDataPath: string;
  }>;
  registerPluginWebview: (payload: { webContentsId: number; pluginId: string; entryUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  ensurePluginPartition: (pluginId: string) => Promise<{ ok: boolean; error?: string }>;
  onViewActivate: (h: (k: string, settingsTab?: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
  getUsageRange: (opts: { dateFrom: string; dateTo: string }) => Promise<UsageSummaryShape>;
  getUsageDailySummary: (input: UsageDailySummaryInput) => Promise<UsageDailySummaryResult>;
  /** The price corrections in force; untrusted until `normalizePricingOverrides` reads it. */
  getPricingOverrides: () => Promise<unknown>;
  exportUsageCsv: (rows: Array<Record<string, string | number>>) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
  plugins: {
    getPerfStats: () => Promise<Record<string, PluginPerfStats>>;
  };
  // Workflow tools — routines
  onAskUserQuestion: (h: (req: AskUserQuestionRequest) => void) => () => void;
  respondAskUserQuestion: (response: AskUserQuestionResponse) => Promise<{ ok: boolean; error?: string }>;
  /** Questions still waiting that were sent before this renderer subscribed. */
  listPendingAskUserQuestions?: () => Promise<AskUserQuestionRequest[]>;
  /** Renderer is notified when the gate's 5-minute timeout fires. */
  onAskUserQuestionTimeout?: (
    h: (payload: { requestId: string }) => void,
  ) => () => void;
  listSessionTasks: (sessionId: string) => Promise<SessionTaskItem[]>;
  clearSessionTasks: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  onSessionTasksChanged: (
    h: (payload: {
      sessionId: string;
      items: SessionTaskItem[];
    }) => void,
  ) => () => void;
  getSessionGoal: (sessionId: string) => Promise<SessionGoal | null>;
  pauseSessionGoal: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  resumeSessionGoal: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  clearSessionGoal: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  onSessionGoalChanged: (
    h: (payload: { sessionId: string; goal: SessionGoal | null }) => void,
  ) => () => void;
  onAgentSpawnEvent: (
    h: (event: AgentSpawnEvent<ChatEntry>) => void,
  ) => () => void;
  onSkillLoaded: (
    h: (event: {
      name: string;
      description: string;
      sessionId: string;
    }) => void,
  ) => () => void;
  // ─── Notifications (#260) ────────────────────────
  onNotificationToast?: (h: (payload: NotificationToastPayload) => void) => () => void;
  onNotificationClicked?: (h: (payload: NotificationClickPayload) => void) => () => void;
  notifyClick?: (payload: NotificationClickPayload) => Promise<{ ok: boolean }>;

  // ─── Main-window management ─────────────────────────────────────────────
  window?: {
    openHtmlPreview: (payload: OpenHtmlPreviewWindowPayload) => Promise<OpenHtmlPreviewWindowResult>;
  };
  /**
   * Dev tools bridge — only useful in non-production NODE_ENV. Renderer
   * floating panel uses these to adjust token preflight threshold at
   * runtime. production builds reject set/get with `production-disabled`.
   */
  dev: {
    setPreflightOverride: (tokens: number | null) => Promise<
      { ok: true; value: number | null } | { ok: false; error: string }
    >;
    getPreflightStatus: () => Promise<
      | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
      | { ok: false; error: string }
    >;
  };
};

/**
 * Result of resolving a `/allow` sentence. `ok: true` carries a scope to
 * PRE-SELECT on the pending card — never a grant, and never a path. Every
 * failure is a kebab error code the renderer maps to plain localized text via
 * `COMMON_IPC_ERROR_MESSAGES`, so no outcome can read as an approval.
 */
type ApprovalSentenceSelectResult =
  | { ok: true; requestId: string; choice: ApprovalChoice }
  | { ok: false; error: string; message?: string };

  export type AveApprovalApi = {
  onRequest: (cb: (req: ApprovalRequest) => void) => () => void;
  /**
   * One request stopped being answerable, whatever settled it host-side.
   * The queue reconciles against it: a card the surface that asked can no
   * longer take down (its tile closed, a navigation let go of it) goes here.
   */
  onSettled: (cb: (payload: { requestId: string }) => void) => () => void;
  respond: (decision: ApprovalDecision) => Promise<unknown>;
  /**
   * Requests the host is still waiting on, in the order they were asked.
   * Read once on mount: a renderer that loaded after a request went out never
   * saw it through `onRequest`.
   */
  listPending: () => Promise<ApprovalRequest[]>;
  selectSentence: (
    requestId: string,
    input: string,
  ) => Promise<ApprovalSentenceSelectResult>;
};

/** User-Approval Store API */
/**
 * Approval scope + verdict — re-uses the union literal types from the
 * shared SOT (`UserApprovalScope` / `UserApprovalVerdict`) so renderer
 * types stay in lockstep with the IPC contract. Issue #802 follow-up
 * (cross-cutting review of PRs #822-#827).
 */
import type {
  PermissionReviewSuggestionPayload,
  ScopedPermissionRule,
  ScopedPermissionRuleError,
  UserApprovalDecision,
  UserApprovalHitPayload,
  ApprovalRuleSave,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../../shared/permissions-events.js";

export type { ScopedPermissionRule, ScopedPermissionRuleError } from "../../shared/permissions-events.js";

export type AveUserApprovalApi = {
  record: (entry: {
    /** ID of the in-flight ApprovalRequest. Main process reads the
     *  authoritative trustOrigin/source/approvalCacheKey from this ID via
     *  ApprovalGate.getRequestSnapshot — renderer-supplied authority fields
     *  below are ignored (kept on the wire for legacy callers + audit). */
    requestId: string;
    rule?: ApprovalRuleSave;
    toolName: string;
    args: string;
    source: string;
    decision?: UserApprovalDecision;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    /** Propagate trust origin for record/lookup key symmetry. */
    trustOrigin?: string;
    /** Propagate cache key for record/lookup key symmetry. */
    approvalCacheKey?: string;
  }) => Promise<{ ok: boolean; error?: string; message?: string; warning?: "wildcard-allow-sandboxed-only" }>;
  revokeByKey: (key: string) => Promise<{ ok: boolean; error?: string; message?: string }>;
  listSession: () => ReturnType<AveUserApprovalApi["list"]>;
  list: () => Promise<Array<{
    key: string;
    decision?: UserApprovalDecision;
    approvedAt: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    revokedAt: string | null;
    /** Safe display metadata. Exact input/trust/cache identity never crosses IPC. */
    toolName?: string;
    source?: string;
    projectCwd?: string;
    sessionId?: string;
  }>>;
};

export type AddRuleResult =
  | { ok: true; rule: PermissionRule }
  | { ok: false; error: string; message?: string };

export type RemoveRuleResult =
  | { ok: true }
  | { ok: false; error: string; message?: string };

export type { RecentlyDeniedEntry } from "../../shared/recently-denied.js";

export type PermissionReviewerMode = "disabled" | "rule" | "llm" | "strict";
export type PermissionReviewerFallbackOnError = "deny" | "rule";
/** Issue #690 — interactive reviewer auto-approve scope. */
export type PermissionReviewerInteractiveAutoApprove = "off" | "low" | "medium";

interface PermissionReviewerParentAdjudication {
  maxVerdict: ParentAdjudicationMaxVerdict;
  timeoutMs: number;
  maxPerChildRun: number;
  /** Parent conversation turns quoted into the evidence. `0` sends none. */
  includeParentContextTurns: number;
  backgroundEscalation: ParentAdjudicationBackgroundEscalation;
  model: ParentAdjudicationModelSource;
}

export interface PermissionReviewerSettings {
  mode: PermissionReviewerMode;
  fallbackOnError: PermissionReviewerFallbackOnError;
  interactive: { autoApprove: PermissionReviewerInteractiveAutoApprove };
  parentAdjudication: PermissionReviewerParentAdjudication;
}

export type PermissionReviewerDispatchResult =
  | {
      ok: true;
      verb: "show" | "mode" | "fallback" | "interactive" | "adjudication";
      settings: PermissionReviewerSettings;
      /**
       * Runtime degrade flag — true when the persisted reviewer mode is "llm"
       * but boot wiring could not instantiate the LLM provider (no chat
       * provider/key configured) and fell back to the rule classifier. The UI
       * surfaces a banner. Undefined on legacy/main builds that do not report it.
       */
      reviewerDegradedToRule?: boolean;
    }
  | { ok: false; error: string };

export type AvePermissionApi = {
  getMode: () => Promise<{ mode: string }>;
  setMode: (mode: string) => Promise<
    | { ok: true; mode: string }
    | { ok: false; error: string; message?: string }
  >;
  onModeChanged: (cb: (mode: string) => void) => () => void;
  /**
   * Hint event — directory config mutated. Listeners refresh state via
   * `permission.dirDispatch("list")` rather than receiving payload data
   * (slash dispatcher is the single source of truth).
   */
  onConfigChanged: (cb: () => void) => () => void;
  listRules: () => Promise<PermissionRule[]>;
  listScopedRules: () => Promise<{ rules: ScopedPermissionRule[]; errors: ScopedPermissionRuleError[] }>;
  removeScopedRule: (rule: ScopedPermissionRule) => Promise<{ ok: boolean; error?: string; message?: string }>;
  addRule: (pattern: string, action: "allow" | "deny") => Promise<AddRuleResult>;
  removeRule: (pattern: string, action: "allow" | "deny" | "ask") => Promise<RemoveRuleResult>;
  recentlyDeniedList: () => Promise<{ ok: true; entries: import("../../shared/recently-denied.js").RecentlyDeniedEntry[] } | { ok: false; error: string }>;
  recentlyDeniedRerun: (id: string) => Promise<import("../../shared/recently-denied.js").RecentlyDeniedRerunResult | { ok: false; error: string }>;
  onRecentlyDeniedChanged: (cb: (summary: { total: number }) => void) => () => void;
  /** Permission policy issue #633 — list active + quarantined script hooks. */
  hookTrustList: () => Promise<
    | { ok: true; active: HookTrustRow[]; disabled: HookTrustRow[]; totalDisabled: number }
    | { ok: false; error: string }
  >;
  /** Permission policy — `/permission dir ...` slash dispatch. */
  dirDispatch: (
    rawArgs: string,
  ) => Promise<
    | { ok: true; verb: "allow"; persisted: string[]; sessionOnly: boolean; warnings: string[] }
    | { ok: true; verb: "deny"; persisted: string[] }
    | { ok: true; verb: "list"; defaults: string[]; userAdditions: string[]; effective: string[] }
    | { ok: false; error: string }
  >;
  /** Permission policy — subscribe to manifest-integrity violation notifications. */
  onManifestViolation: (
    handler: (payload: {
      pluginId: string;
      toolName: string;
      attempted: string;
    }) => void,
  ) => () => void;
  /**
   * Permission policy — subscribe to user-approval memory-hit
   * disclosure events. Fires when a user-approval cache entry auto-resolves
   * a tool invocation that would otherwise have prompted. Renderer is
   * expected to surface a transient toast/banner so the user sees that a
   * stored approval was applied. Returns an unsubscribe function.
   */
  onUserApprovalHit: (cb: (payload: UserApprovalHitPayload) => void) => () => void;
  /** Read-only: honest OS sandbox capability for the current platform. */
  sandboxCapability: () => Promise<SandboxCapabilityInfo>;
  /** Read-only: Windows srt-win install readiness (group + WFP + verbatim instructions). */
  sandboxWindowsStatus: () => Promise<SandboxWindowsStatusInfo>;
  /**
   * Read-only: the connections the sandbox proxy refused in the last 24 h,
   * newest first, each with the tool call, terminal tab or plugin process
   * that opened it ("unattributed" when no live invocation held its key).
   */
  egressDenialsRecent: () => Promise<EgressDenialRow[] | IpcErrorResult>;
  /** Read-only: the shell egress grants that outlive a call (conversation, terminal tab, workspace, always). */
  egressGrantsList: () => Promise<
    | { ok: true; grants: ListedEgressGrant[] }
    | { ok: false; error: string; message: string }
    | IpcErrorResult
  >;
  /** Read-only: the upstream proxy setting (no credential values) and the effective upstream for https://example.com. */
  upstreamProxyGet: () => Promise<UpstreamProxyView | IpcErrorResult>;
  /** MUTATING: change the upstream proxy setting; resolves to the new view or a refusal. */
  upstreamProxySet: (patch: UpstreamProxyPatch) => Promise<
    /** `credentialsRemoved`: the stored credentials belonged to the previous proxy and were removed. */
    | { ok: true; view: UpstreamProxyView; credentialsRemoved?: true }
    | { ok: false; error: string; message: string }
    | IpcErrorResult
  >;
  /** MUTATING: revoke one shell egress grant. */
  egressGrantRevoke: (grant: RevocableEgressGrant) => Promise<{ ok: boolean; error?: string; message?: string } | IpcErrorResult>;
  /**
   * MUTATING: trigger the one-time Windows srt-win install (one self-elevating
   * UAC prompt). The ONLY user-consented privilege-escalation entry point —
   * call ONLY from an explicit "Install now" click. Resolves to the install's
   * `outcome` (ready, already-ready, installed-unverified, cancelled,
   * timed-out, failed) or to an IPC refusal; the caller shows every one.
   * Call it directly from the click, with no await before it: the click's
   * user activation lapses after ~5 s, and main reads status itself.
   */
  sandboxWindowsInstall: () => Promise<SandboxWindowsInstallResult | IpcErrorResult>;
  approveExtensionsWithoutIsolation: () => Promise<{ ok: true } | IpcErrorResult>;
  /** Subscribe to default-mode repeated-approval hints for LLM permission review. */
  onReviewSuggestion: (cb: (payload: PermissionReviewSuggestionPayload) => void) => () => void;
  /** Permission policy — `/permission reviewer ...` slash dispatch. */
  reviewerDispatch: (
    rawArgs: string,
  ) => Promise<PermissionReviewerDispatchResult>;
  judgeGet: () => Promise<import("../../shared/permission-judge-settings.js").PermissionJudgeReadResult>;
  /** Only the changed fields: unchanged stored values (even rejected ones) stay as stored. */
  judgeSet: (
    patch: Partial<import("../../shared/permission-judge-settings.js").PermissionJudgeSettings>,
  ) => Promise<import("../../shared/permission-judge-settings.js").PermissionJudgeWriteResult>;
  /** Permission policy — `/permission audit show` — recent permission audit entries. */
  auditShow: (last: number) => Promise<
    | {
        ok: true;
        entries: PermissionAuditEntrySummary[];
        total: number;
        summary: { files: number; bytes: number };
      }
    | { ok: false; error: string }
  >;
  /** Permission policy — `/permission audit verify` — HMAC chain integrity check. */
  auditVerify: () => Promise<
    | {
        ok: true;
        intact: boolean;
        totalFiles: number;
        totalEntries: number;
        firstBrokenFile?: string;
        perDay: Array<{
          file: string;
          totalLines: number;
          chainOk: boolean;
          firstBrokenLineIndex?: number;
          reason?: string;
          sealMatch: boolean | null;
        }>;
      }
    | { ok: false; error: string }
  >;
};

/**
 * Permission policy — minimal audit entry shape surfaced to the renderer's
 * `AuditPanel`. The full discriminated union (with `decision` field
 * + per-decision payload) is sent verbatim — this type is just a
 * structural tag the panel uses to gate the expand/filter UI.
 */
export interface PermissionAuditEntrySummary {
  ts: string;
  auditId: string;
  decision: string;
  trustOrigin: string;
  prevHash: string;
  /** Anything else from the discriminated union — opaque to the renderer. */
  [key: string]: unknown;
}

export type AvePolicyApi = {
  get: () => Promise<{
    version: 1;
    requireExplicitApproval: boolean;
    managed: boolean;
    updatedAt: string;
    source: "defaults" | "user" | "admin" | "merged";
    adminOverrides?: string[];
    adminPath?: string;
    /**
     * Host-derived: whether `policy.set` will be accepted. Computed by
     * `isPolicyUserEditable`, the same predicate behind `savePolicy`'s
     * blocking conditions — do NOT re-derive it in the renderer from
     * `managed`/`source`.
     */
    editable: boolean;
  } & AdminPolicyDiagnostic>;
  set: (patch: unknown) => Promise<{ ok: boolean; policy?: unknown; error?: string; message?: string }>;
};

export type AvePluginConfigApi = {
  get: (pluginId: string) => Promise<
    | { ok: true; config: PluginConfigRecord }
    | { ok: false; error: string; message?: string }
  >;
  set: (pluginId: string, config: Record<string, unknown>) => Promise<
    | { ok: true; config: PluginConfigRecord }
    | { ok: false; error: string; message?: string }
  >;
  /** Fetch the manifest's declarative settings schema. */
  getSchema: (pluginId: string) => Promise<
    | { ok: true; schema: PluginConfigSchemaSummary | null }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * Persist a `format: "secret"` field. The value lands in
   * the encrypted keychain (`ave-secrets.json`) and the host strips any
   * stale cleartext mirror from `pluginConfigs`.
   */
  setSecret: (pluginId: string, key: string, value: string) => Promise<
    | { ok: true }
    | { ok: false; error: string; message?: string }
  >;

  listSecretKeys: (pluginId: string) => Promise<
    | { ok: true; keys: string[] }
    | { ok: false; error: string; message?: string }
  >;
};

export type AvePluginsApi = {
  cards: () => Promise<PluginCardSummary[]>;
};

/** One installed plugin view as the composer surfaces (slash picker, input bar) list it. */
export interface PluginEntry {
  viewKey: string;
  /** Plugin id owning the view — drives auth-state lookup. @optional */
  pluginId?: string;
  /** Runtime card status for surfacing host-managed dependency preparation. */
  loadStatus?: PluginCardSummary["loadStatus"];
  /** Current dependency/runtime preparation step while loadStatus is "preparing". */
  preparationStatus?: PluginCardSummary["preparationStatus"];
  label: string;
  /** Lucide icon name from the plugin manifest (PascalCase, e.g. "Mic"). */
  icon?: string;
  /**
   * Short text (1-4 chars) rendered in place of the Lucide icon — e.g.
   * `"AB"`. Takes precedence over `icon` when both are set.
   */
  iconText?: string;
  /**
   * `true` when the owning plugin declares `manifest.auth` and its current
   * statusTool result is `kind: "unauthed"`. (architecture.md §9.4a)
   */
  unauthed?: boolean;
  /** True when this cell represents a failed plugin that should route to Doctor. */
  doctorRequired?: boolean;
}

/** Plugin removal only: packages install through the git marketplace (`gitMarketplace`, design §13). */
export type AveHostMarketplaceApi = {
  uninstallMarketplacePlugin: (id: string) => Promise<PluginMarketplaceActionResult>;
};

export type AveHostApi = {
  takePluginMarketplaceApi: () => AveHostMarketplaceApi | null;
};

export type AveMcpApi = {
  servers: () => Promise<McpServerState[]>;
  kill: (id: string) => Promise<void>;
  authenticate: (id: string) => Promise<McpAuthenticationResult>;
  getConfigs: () => Promise<McpServerConfigDto[]>;
  getConfigPath: () => Promise<string>;
  addConfig: (config: McpServerConfig) => Promise<McpConfigMutationResult>;
  setApiKey: (id: string, apiKey: string) => Promise<{ connected: boolean; warning?: string }>;
  removeConfig: (id: string) => Promise<void>;
  /**
   * MCP Apps UI resource fetch. Returns the sandbox-proxy URL to navigate the
   * <webview> to, plus the app HTML to hand the proxy over the bridge. `csp` is
   * the server's declared policy; main sanitizes it and emits it as the proxy
   * document's CSP response header.
   */
  readUiResource: (serverId: string, uri: string, generationId?: string) => Promise<McpUiResourceBundle>;
  /**
   * MCP Apps `oncalltool` — run a tool on the card's OWN server through the host's
   * risk/consent gate. `serverId` comes from the card payload the renderer holds,
   * never from the app. Denials and tool failures come back as `{ ok: false }`.
   */
  callTool: (
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    generationId?: string,
  ) => Promise<McpUiToolCallOutcome>;
  /**
   * MCP Apps `onmessage` (`ui/message`). `serverId` + `sessionId` are bound by the
   * renderer from the card (never by the app). Main decides the path: notification,
   * round-boundary guidance, or a user-gated staging card. The outcome carries NO
   * conversation content back.
   */
  /**
   * MCP server prompt (`prompts/get`). Returns the server's messages ALREADY
   * wrapped in their provenance envelope; the renderer sends that verbatim
   * under the `mcp-prompt-emitted` origin and never assembles it itself.
   */
  getPrompt: (
    serverId: string,
    name: string,
    args: Record<string, string>,
  ) => Promise<
    | { ok: true; envelope: string; truncated?: boolean; omittedBlocks?: number }
    | { ok: false; error: string }
  >;
  /**
   * Reads a DECLARED resource and returns the fenced block to attach to the user's own
   * turn. The host builds the fence; the renderer attaches it verbatim.
   */
  // OPTIONAL for the same reason `listResourceTemplates` is: the picker guards each
  // channel per row KIND, and a required type makes that guard unreachable — dead code
  // by the type, while tests and reduced harness surfaces build the API partially.
  attachResource?: (
    serverId: string,
    uri: string,
  ) => Promise<
    | {
      ok: true;
      attachment: { type: "text"; text: string };
      truncated?: boolean;
      omittedBlocks?: number;
    }
    | { ok: false; error: string }
  >;
  /**
   * The catalogue the `@` mention picker offers — `listDeclaredResources()`, the same
   * projection the model-facing tools read, so the picker cannot offer a URI the read
   * path would refuse as undeclared.
   */
  listResources: () => Promise<
    | { ok: true; servers: Array<{ serverId: string; resources: McpResourceSummary[] }> }
    | { ok: false; error: string }
  >;
  /**
   * The URI TEMPLATES half of that catalogue. A template is an OFFER, not a resource:
   * the picker renders it as a row that opens a form rather than one that attaches.
   *
   * OPTIONAL because the picker treats it as optional: a surface without it degrades to
   * resources-only rather than losing the whole catalogue. Declaring it required would
   * make that guard look like dead code and force the test that pins it to cast around
   * the type it is supposed to be checking.
   */
  listResourceTemplates?: () => Promise<
    | { ok: true; servers: Array<{ serverId: string; templates: McpResourceTemplateSummary[] }> }
    | { ok: false; error: string }
  >;
  /**
   * Fill a declared template and attach what it reads. The renderer sends the TEMPLATE
   * and the user's values; main expands and reads. `uri` comes back for the chip's
   * label. Handing it back grants nothing: `attachResource` is the only channel that
   * routes a renderer-supplied URI into the CORE-capability read, and that read is gated
   * on the listed set inside the client, which a template expansion was never in. (See
   * the handler in `ipc/domains/plugins.ts` for why this is stated so narrowly.)
   */
  attachResourceTemplate?: (
    serverId: string,
    uriTemplate: string,
    values: Record<string, string>,
  ) => Promise<
    | {
      ok: true;
      attachment: { type: "text"; text: string };
      uri: string;
      truncated?: boolean;
      omittedBlocks?: number;
    }
    | { ok: false; error: string }
  >;
  postUiMessage: (
    serverId: string,
    sessionId: string,
    params: unknown,
  ) => Promise<McpUiMessageOutcome>;
  /**
   * MCP Apps `ondownloadfile` (`ui/download-file`). `serverId` is bound by the renderer
   * from the card. Main decodes the app's INLINE bytes, bounds them, and puts the user's
   * save dialog in front of the write; it never fetches an app-supplied URI (a
   * `resource_link` is rejected). A user cancel is `{ ok: true, disposition: "cancelled" }`
   * — not an error.
   */
  downloadFile: (serverId: string, params: unknown) => Promise<McpUiDownloadOutcome>;
  /**
   * MCP Apps `onupdatemodelcontext` (`ui/update-model-context`). `serverId` + `sessionId`
   * + `cardId` are all bound by the renderer from the card. Main OVERWRITES that card's
   * one slot; the content is read at the NEXT turn's prompt build and never triggers one.
   */
  postUiModelContext: (
    serverId: string,
    sessionId: string,
    cardId: string,
    params: unknown,
  ) => Promise<McpUiModelContextOutcome>;
  /** Free a card's sandbox-proxy session token on unmount (fire-and-forget). */
  disposeUiSession: (token: string) => void;
  /** #885 b3 — subscribe to the server-disconnected broadcast; returns an unsubscribe fn. */
  onServerDisconnected: (handler: (serverId: string) => void) => () => void;
};

export type RenderHtmlPayload = {
  kind: "ave.render_html";
  title?: string;
  height: number;
  html: string;
  warnings?: string[];
};

/**
 * Composer attachment API. Wired in `src/ipc/domains/attach.ts` (main) and
 * `src/preload.ts` (renderer bridge). Exposes file picker, image reader,
 * clipboard-image saver (writes to OS tmp), and shell-open.
 */
export interface AveAttachApi {
  openFile: () => Promise<{
    canceled: boolean;
    files: Array<{
      path: string;
      name: string;
      ext: string;
      bytes: number;
      isImage: boolean;
      mimeType?: string;
    }>;
    rejected: string[];
  }>;
  readImage: (filePath: string) => Promise<{
    ok: boolean;
    dataUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    error?: string;
  }>;
  saveClipboardImage: (base64: string) => Promise<{
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    dataUrl?: string;
    error?: string;
  }>;
  discardClipboardImage: (filePath: string) => Promise<{
    ok: boolean;
    /** The app revoked this rejected image's capability without pathname deletion. */
    retained?: true;
    error?: string;
  }>;
  openExternal: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Composer drop, step 2. Redeem the one-shot token from
   * `aveDrop.prepareFileDrop`; main authorizes exactly the files bound to it.
   * A reused, unknown, other-window or expired token is refused.
   */
  redeemDrop: (token: string) => Promise<
    | {
        ok: true;
        files: Array<{
          path: string;
          name: string;
          ext: string;
          bytes: number;
          isImage: boolean;
          mimeType?: string;
        }>;
      }
    | { ok: false; error: "unauthorized" | "drop-token-invalid" | "drop-token-expired" }
  >;
}

/** One `@file` autocomplete row: a main-verified readable path in a workspace root. */
interface WorkspaceFileMatch {
  path: string;
  /** Path relative to its root, `/`-separated — the row label. */
  relativePath: string;
  /** The workspace root the file belongs to. */
  root: string;
  /** Size at listing time, for the attachment chip. */
  bytes: number;
}

/**
 * Preview file-read surface (§6.10). Reads text or passive image data for in-panel preview,
 * gated by the SAME traversal guard as the builtin `read_file` tool — never a
 * broader read authority. `error` is a kebab-case code the renderer maps to a
 * Korean message; `message` is English dev detail.
 */
export interface AvePreviewApi {
  onDocumentOpen: (handler: (request: import("../../shared/document-open.js").DocumentOpenRequest) => void) => () => void;
  acknowledgeDocumentOpen: (ack: import("../../shared/document-open.js").DocumentOpenAck) => Promise<{ ok: true } | { ok: false; error: string }>;
  readFile: (path: string, window?: { offset?: number; limit?: number; workspaceRoot?: string; sessionId?: string }) => Promise<{
    ok: boolean;
    content?: string;
    path?: string;
    bytes?: number;
    truncated?: boolean;
    lineCount?: number;
    observation?: import("../../shared/agent-observation.js").ObservationBinding;
    document?: import("../../shared/agent-observation.js").PreviewObservedTextDocument;
    image?: { dataUrl: string; mimeType: string };
    error?:
      | "unauthorized"
      | "path-not-allowed"
      | "sensitive-path"
      | "not-a-file"
      | "binary-file"
      | "too-large"
      | "read-failed";
    message?: string;
  }>;
  /**
   * Read under `readFile` authority and parse in an isolated child. The
   * zero-based index selects a sheet or page, according to the file format.
   */
  readDocument: (path: string, sheetIndex: number, sessionId?: string) => Promise<PreviewReadDocumentResult>;
  onAgentObservation: (handler: (events: import("../../shared/agent-observation.js").AgentObservationEvent[]) => void) => () => void;
  acknowledgeObservation: (request: import("../../shared/agent-observation.js").ObservationRequest) => Promise<import("../../shared/agent-observation.js").ObservationResponse>;
  onObservationPreview: (handler: (message: import("../../shared/agent-observation.js").BrowserObservationPreviewMessage) => void) => () => void;
  requestObservationPreview: (request: import("../../shared/agent-observation.js").BrowserObservationPreviewRequest) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Workspace file-browser surface (§6.10). Project roots are persisted to
 * `permissions.additionalDirectories` (the executor's Layer 1 allow-list SOT),
 * so a browsable folder is exactly a readable folder.
 */
export interface AveWorkspaceApi {
  listRoots: () => Promise<{
    ok: boolean;
    defaultRoot?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    /** Part of the settings file could not be interpreted — the roots stand. */
    settingsFault?: string;
    error?: string;
  }>;
  pickRoot: (opts?: { ackToken?: string }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    added?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    warnings?: string[];
    /** Adjacency warnings present + not persisted — renderer must confirm. */
    requiresAcknowledgement?: boolean;
    /** Picked path awaiting acknowledgement — display only. */
    pendingPath?: string;
    /** One-time token bound to the picked path — confirm by echoing it via `ackToken`. */
    ackToken?: string;
    error?: string;
  }>;
  listDir: (path: string) => Promise<{
    ok: boolean;
    path?: string;
    entries?: Array<{ name: string; path: string; type: "file" | "directory" }>;
    truncated?: boolean;
    error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "read-failed";
    message?: string;
  }>;
  /** Remove an additional project root from the read allow-list. Never the default root. */
  removeRoot: (path: string) => Promise<{
    ok: boolean;
    removed?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    /**
     * #1493 — count of orphaned path-scoped grants pruned because they targeted
     * a path strictly under the removed root. Non-zero counts are surfaced in
     * the removal toast so the user knows saved grants were revoked too.
     */
    prunedGrants?: number;
    error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default" | "lifecycle-failed";
    message?: string;
  }>;
  /** Reveal a scope-revalidated file/folder in the OS file manager (location only, never opens it). */
  reveal: (path: string) => Promise<{
    ok: boolean;
    error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
    message?: string;
  }>;
  /**
   * Drag-drop add-root, step 1 (#1458). Submit a renderer-resolved dropped folder
   * path (from `window.aveDrop.resolveDroppedPaths`) for Layer-0 hard-deny +
   * is-a-directory validation. On success returns a one-time ack token bound to
   * the now-main-owned path — confirm the add via `pickRoot({ ackToken })`.
   */
  dropPrepare: (path: string) => Promise<{
    ok: boolean;
    error?: string;
    warnings?: string[];
    /** Validated main-owned path awaiting acknowledgement — display only. */
    pendingPath?: string;
    /** One-time token bound to the path — confirm by echoing it via `pickRoot`. */
    ackToken?: string;
  }>;
  /**
   * Composer `@file` autocomplete. Only the query crosses; main walks the
   * current roots, applies the Layer-0 sensitive filter and the read-scope guard.
   */
  searchFiles: (query: string) => Promise<
    | { ok: true; matches: WorkspaceFileMatch[]; truncated: boolean }
    | { ok: false; error: "unauthorized" | "invalid-query" | "settings-unreadable" }
  >;
}

/**
 * Drop-path resolution bridge (#1458). Exposed as its own preload world. Resolves
 * dropped `File` objects to filesystem paths via `webUtils.getPathForFile` — the
 * ONLY context that can, since a `File` cannot cross IPC. The returned paths are
 * renderer-NAMED candidates that grant no capability; the main-process
 * `workspace.dropPrepare` gate makes the read-scope decision.
 */
export interface AveDropApi {
  resolveDroppedPaths: (files: FileList | readonly File[]) => string[];
  /**
   * Composer drop, step 1. Takes dropped `File`s (never paths): the preload
   * resolves them and registers them with main in one step, returning a
   * one-shot token to redeem via `ave.attach.redeemDrop`. `rejected` names the
   * items main refused, by stable reason code.
   */
  prepareFileDrop: (files: FileList | readonly File[]) => Promise<
    | { ok: true; token: string; rejected: Array<{ name: string; reason: string }> }
    | { ok: false; error: string; rejected?: Array<{ name: string; reason: string }> }
  >;
}

export interface AveUiApi {
  showNativeContextMenu: (
    payload: NativeContextMenuPayload,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onNativeContextMenuAction: (
    cb: (action: NativeContextMenuAction) => void,
  ) => () => void;
  showDynamicMenu: (
    payload: DynamicNativeMenuPayload,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDynamicMenuAction: (
    cb: (action: DynamicNativeMenuAction) => void,
  ) => () => void;
}

/** The preload platform bridge (`window.avePlatform`). */
export type AvePlatformApi = {
  isDarwin: boolean;
};

declare global {
  interface Window {
    aveApi: AveApi;
    aveHost: AveHostApi;
    /** Absent outside Electron (jsdom, Storybook) — there is no native chrome to adapt to. */
    avePlatform?: AvePlatformApi;
    aveDrop: AveDropApi;
    ave: {
      permission: AvePermissionApi;
      approval: AveApprovalApi;
      userApproval: AveUserApprovalApi;
      policy: AvePolicyApi;
      mcp: AveMcpApi;
      plugins: AvePluginsApi;
      pluginConfig: AvePluginConfigApi;
      ui: AveUiApi;
      attach: AveAttachApi;
      preview: AvePreviewApi;
      documentEngine: DocumentEngineApi;
      workspace: AveWorkspaceApi;
      env: {
        isDev: boolean;
        isE2E: boolean;
        enableDevConsole: boolean;
        debugStream: boolean;
      };
    };
  }
}
