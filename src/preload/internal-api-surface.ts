import type { RevocableEgressGrant } from "../shared/egress-grant-scopes.js";
import type { AppRelaunchResult } from "../shared/app-relaunch.js";
import type { ShellTask, ShellTaskAction, ShellTaskActionResult } from "../shared/shell-tasks.js";
// The internal renderer API is intentionally assembled in one typed surface.
import { ipcRenderer } from "electron";
import type { SideChatOperationFailure } from "../shared/side-chat-operation.js";
import { buildBrowserTabsApiSurface } from "./browser-api-surface.js";
import { buildTerminalApiSurface } from "./terminal-api-surface.js";
import { buildBrowserWorkspaceApiSurface } from "./browser-workspace-api-surface.js";
import {
  ALERTS,
  CHANNELS,
  MARKETPLACE,
  OVERLAY_V1,
  PERMISSIONS,
  ROUTINES,
  SETTINGS,
  WORK_BOARD,
  type AgentInstallResultPayload,
  type PluginInstallResultPayload,
  type SkillInstallResultPayload,
} from "../contract/app-contract.js";
import { t } from "../i18n/index.js";
import type {
  OnboardingProposalDisposition,
  PendingOnboardingProposal,
} from "../main/onboarding-proposal-store.js";
import { parseEnvForcedSettingsPaths } from "../shared/env-backed-settings.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";
import { serializePermissionJudgeSettingsPatch, type PermissionJudgeSettings } from "../shared/permission-judge-settings.js";
import { mcpApiSurface } from "./mcp-api-surface.js";
import { buildTelegramConnectionApiSurface } from "./telegram-connection-api-surface.js";
import { buildTailnetObserverApiSurface } from "./tailnet-observer-api-surface.js";
import { buildGitMarketplaceApiSurface } from "./git-marketplace-api-surface.js";
import { buildPluginStudioApiSurface } from "./plugin-studio-api-surface.js";
import { buildGitRuntimeApiSurface } from "./git-runtime-api-surface.js";
import { buildInstalledContentApiSurface } from "./installed-content-api-surface.js";
import { buildTailnetSharingApiSurface } from "./tailnet-sharing-api-surface.js";
import { buildDocumentEngineApiSurface } from "./document-engine-api-surface.js";
import { classifySubscription } from "../plugins/capabilities.js";
import type {
  PermissionReviewSuggestionPayload,
  UserApprovalHitPayload,
  ApprovalRuleSave,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../shared/permissions-events.js";
import {
  type ActiveWorkspaceSurface,
} from "../shared/browser-surface.js";
import type { MarketplaceAnnouncementPayload } from "../shared/marketplace-announcements.js";
import type { PackageUpdateView } from "../shared/git-marketplace.js";
import type { AiProviderPingIpcResult } from "../shared/ai-provider-ping.js";
import type { ModelCatalogIpcResult } from "../shared/model-catalog/types.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "../shared/render-html-preview.js";
import type { SessionTaskItem } from "../shared/session-tasks.js";
import type { SessionGoal } from "../shared/session-goal.js";
import type { ChatStreamEvent, ChatEntry } from "../lib/chat-stream-state.js";
import type { AgentSpawnEvent } from "../shared/subagent-events.js";
import type { SerializedHistoryMessage } from "../shared/chat-history.js";
import type { SubAgentTranscriptRequest, SubAgentTranscriptResult } from "../shared/subagent-transcript.js";
import type { TurnResult } from "../engine/conversation-loop.js";
import type { AppBootstrapStatus } from "../shared/bootstrap-status.js";
// Type-only: the renderer declares the surface it consumes; this file is the one implementation and is
// checked against it (`satisfies` below), so a handler shape that drifts on either side is a compile error here.
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  AveApi,
  NotificationClickPayload,
  NotificationToastPayload,
  OverlayTriggerCompletedPayload,
  OverlayTriggerExpiredPayload,
  OverlayTriggerFailedPayload,
  OverlayTriggerImportedPayload,
  OverlayTriggerStartedPayload,
} from "../ui/renderer/types.js";
import {
  isSubscriptionRuntimeStatusUpdatedEvent,
  type SubscriptionRuntimeStatusUpdatedEvent,
} from "../shared/subscription-runtime.js";

type MemoryProjectOptions = {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
};

function invokeWithOptionalMemoryOptions<T>(
  channel: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel) as Promise<T>
    : ipcRenderer.invoke(channel, opts) as Promise<T>;
}

function invokeMemorySearch<T>(
  channel: string,
  query: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel, query) as Promise<T>
    : ipcRenderer.invoke(channel, query, opts) as Promise<T>;
}

function invokeMemoryDelete<T>(
  channel: string,
  filename: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel, filename) as Promise<T>
    : ipcRenderer.invoke(channel, filename, opts) as Promise<T>;
}

function invokeMemoryCandidateAction<T>(
  channel: string,
  id: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel, { id }) as Promise<T>
    : ipcRenderer.invoke(channel, { id, opts }) as Promise<T>;
}

/** What an uninstall channel answers, as the renderer reads it. */
type PluginActionResult =
  | { ok: true; pluginId: string; uninstalled: true }
  | { ok: false; error: string; message?: string };

function invalidPluginActionResult(): PluginActionResult {
  return {
    ok: false,
    error: "invalid-result",
    message: t("be_preload.invalidPluginActionResult"),
  };
}

export function normalizePluginActionResult(result: unknown): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }
  const payload = result && typeof result === "object"
    ? result as { pluginId?: unknown; uninstalled?: unknown }
    : {};
  const pluginId = typeof payload.pluginId === "string" ? payload.pluginId.trim() : "";
  if (!pluginId || payload.uninstalled !== true) return invalidPluginActionResult();
  return { ok: true, pluginId, uninstalled: true };
}

type RemoteA2AStatusPromise = ReturnType<AveApi["remoteA2a"]["status"]>;

function invokeRemoteA2AAction(
  action: "resume",
  taskHandle: string,
  userIntent: string,
): RemoteA2AStatusPromise;
function invokeRemoteA2AAction(
  action: "cancel" | "replay",
  taskHandle: string,
): RemoteA2AStatusPromise;
async function invokeRemoteA2AAction(
  action: "resume" | "cancel" | "replay",
  taskHandle: string,
  userIntent?: string,
): RemoteA2AStatusPromise {
  return ipcRenderer.invoke(
    CHANNELS.remoteA2a.action,
    { action, taskHandle, ...(userIntent === undefined ? {} : { userIntent }), intentToken: ipcUserKeyboardIntent() },
  ) as RemoteA2AStatusPromise;
}

export function buildInternalApiSurface() {
  return {
  relaunchApp: () => ipcRenderer.invoke(CHANNELS.app.relaunch, { intent: ipcUserKeyboardIntent() }) as Promise<AppRelaunchResult>,
  getSettings: async () => ipcRenderer.invoke(CHANNELS.settings.get),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke(CHANNELS.settings.update, partial),
  // Parsed here rather than in the renderer: an unrecognized path is drift in this build's own registry, not something to render.
  envForcedSettings: async () =>
    parseEnvForcedSettingsPaths(await ipcRenderer.invoke(CHANNELS.settings.envForcedSettings)) ?? [],
  telemetryAllowedHosts: async () => {
    const hosts: unknown = await ipcRenderer.invoke(CHANNELS.telemetry.allowedHosts);
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  },
  remoteA2a: {
    targets: async () => ipcRenderer.invoke(CHANNELS.remoteA2a.targets),
    status: async () => ipcRenderer.invoke(CHANNELS.remoteA2a.status),
    send: async (targetAgentId: number, userIntent: string) => ipcRenderer.invoke(
      CHANNELS.remoteA2a.send,
      { targetAgentId, userIntent, intentToken: ipcUserKeyboardIntent() },
    ),
    task: async (taskHandle: string) => ipcRenderer.invoke(CHANNELS.remoteA2a.task, { taskHandle }),
    tasks: async () => ipcRenderer.invoke(CHANNELS.remoteA2a.tasks),
    action: invokeRemoteA2AAction,
  },
  tailnetSharing: buildTailnetSharingApiSurface(),
  tailnetObserver: buildTailnetObserverApiSurface(),
  gitRuntime: buildGitRuntimeApiSurface(),
  gitMarketplace: buildGitMarketplaceApiSurface(),
  pluginStudio: buildPluginStudioApiSurface(),
  installedContent: buildInstalledContentApiSurface(),
  telegramConnection: buildTelegramConnectionApiSurface(),
  documentEngine: buildDocumentEngineApiSurface(),
  onSettingsUpdated: (handler: Parameters<AveApi["onSettingsUpdated"]>[0]) => {
    const listener = (_event: unknown, settings: Parameters<typeof handler>[0]) => handler(settings);
    ipcRenderer.on(SETTINGS.updated, listener);
    return () => ipcRenderer.removeListener(SETTINGS.updated, listener);
  },
  onSubscriptionRuntimeStatusUpdated: (
    handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void,
  ) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isSubscriptionRuntimeStatusUpdatedEvent(payload)) {
        handler(payload);
      }
    };
    ipcRenderer.on(CHANNELS.settings.subscriptionRuntimeStatusUpdated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.settings.subscriptionRuntimeStatusUpdated, listener);
  },
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.setApiKey, vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke(CHANNELS.settings.hasApiKey, vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke(CHANNELS.settings.deleteApiKey, vendor),
  listLlmModels: async (request: unknown) => ipcRenderer.invoke(CHANNELS.settings.listLlmModels, request),
  codexSubscriptionStatus: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionStatus),
  codexSubscriptionStartBrowserLogin: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionStartBrowserLogin),
  codexSubscriptionStartDeviceCodeLogin: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionStartDeviceCodeLogin),
  codexSubscriptionCancelLogin: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionCancelLogin),
  codexSubscriptionLogout: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionLogout),
  codexSubscriptionListModels: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionListModels),
  subscriptionRuntimeStatus: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionRuntimeStatus, provider),
  subscriptionChooseRuntime: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionChooseRuntime, provider),
  subscriptionForgetRuntime: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionForgetRuntime, provider),
  subscriptionVerifyRuntime: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionVerifyRuntime, provider),
  subscriptionStartLogin: async (provider: unknown, method: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionStartLogin, provider, method),
  subscriptionOpenLoginBrowser: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionOpenLoginBrowser, provider),
  subscriptionCancelLogin: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionCancelLogin, provider),
  subscriptionAcknowledgeNotice: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionAcknowledgeNotice, provider),
  subscriptionLogout: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionLogout, provider),
  subscriptionListModels: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionListModels, provider),
  subscriptionUseForChat: async (provider: unknown, model?: unknown) => model === undefined
    ? ipcRenderer.invoke(CHANNELS.settings.subscriptionUseForChat, provider)
    : ipcRenderer.invoke(CHANNELS.settings.subscriptionUseForChat, provider, model),
  subscriptionUseApiForChat: async () => ipcRenderer.invoke(CHANNELS.settings.subscriptionUseApiForChat),
  acpSubscriptionStatus: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionStatus, provider),
  acpSubscriptionChooseRuntime: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionChooseRuntime, provider),
  acpSubscriptionForgetRuntime: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionForgetRuntime, provider),
  acpSubscriptionVerify: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionVerify, provider),
  acpSubscriptionStartLogin: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionStartLogin, provider),
  acpSubscriptionOpenLoginBrowser: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionOpenLoginBrowser, provider),
  acpSubscriptionCancelLogin: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionCancelLogin, provider),
  acpSubscriptionLogout: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionLogout, provider),
  installMarketplaceProviderPreset: async (preset: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.marketplaceInstallProviderPreset, preset),
  uninstallMarketplaceProviderPreset: async (providerId: string) =>
    ipcRenderer.invoke(CHANNELS.settings.marketplaceUninstallProviderPreset, providerId),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.setWebApiKey, provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke(CHANNELS.settings.hasWebApiKey, provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke(CHANNELS.settings.deleteWebApiKey, provider),
  // This can trigger a provider-backed LLM call, so it is intentionally kept out of the externally-parity-safe public surface and local API allowlist.
  getUsageDailySummary: async (input: unknown) => ipcRenderer.invoke(CHANNELS.usage.dailySummary, input),
  // The price corrections in force, which the renderer's cost surfaces apply.
  getPricingOverrides: async () => ipcRenderer.invoke(CHANNELS.usage.pricingOverrides) as Promise<unknown>,
  // Host-renderer-only surface. spawn/input/resize/kill are invokes; onData / onExit subscribe to main→renderer events and return an unsubscribe fn
  // (the settings.updated / auth.progress pattern). All channels are INTERNAL; an external origin can never reach them (fail-closed isPublicChannel).
  terminal: buildTerminalApiSurface(),
  browserTabs: buildBrowserTabsApiSurface(),
  browserWorkspace: buildBrowserWorkspaceApiSurface(),
  setActiveSurface: async (surface: ActiveWorkspaceSurface | null) =>
    ipcRenderer.invoke(CHANNELS.surface.setActive, surface) as Promise<{ ok: true } | { ok: false; error: string }>,
  // A second, independently-streaming chat session. send/new/load/abort are invokes; onStream/onFallback subscribe to the DEDICATED CHANNELS.sidechat.{stream,fallback} events
  // (NOT chat.stream) and return an unsubscribe fn (the onChatStream pattern). All channels are INTERNAL; an external origin can never reach them (fail-closed isPublicChannel).
  sideChat: {
    listShellTasks: async (expectedSessionId: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.listShellTasks, expectedSessionId) as Promise<ShellTask[]>,
    controlShellTask: async (expectedSessionId: string, action: ShellTaskAction, shellId?: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.controlShellTask, expectedSessionId, action, shellId) as Promise<ShellTaskActionResult>,
    send: async (
      input: string,
      attachments?: unknown[],
      originSessionId?: string,
      sendRequestId?: string,
      surface?: ActiveWorkspaceSurface,
      sessionId?: string,
    ) =>
      ipcRenderer.invoke(CHANNELS.sidechat.send, {
        input, attachments, originSessionId,
        ...(sendRequestId !== undefined ? { sendRequestId } : {}),
        ...(surface !== undefined ? { surface } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      }) as Promise<
        | { ok: true; result: TurnResult }
        | SideChatOperationFailure
      >,
    new: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.new) as Promise<
        | { ok: true; sessionId: string }
        | SideChatOperationFailure
      >,
    load: async (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.load, sessionId) as Promise<
        | { ok: true; sessionId: string; messages: SerializedHistoryMessage[] }
        | (SideChatOperationFailure & { messages: SerializedHistoryMessage[] })
      >,
    getSubAgentTranscript: async (request: SubAgentTranscriptRequest) =>
      ipcRenderer.invoke(CHANNELS.sidechat.getSubAgentTranscript, request) as Promise<SubAgentTranscriptResult>,
    abort: async (sendRequestId: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.abort, { sendRequestId }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    paneHistory: async (tabId: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.paneHistory, { tabId }) as Promise<
        | { ok: true; sessionId: string | null; messages: SerializedHistoryMessage[] }
        | { ok: false; error: string }
      >,
    endPaneChat: async (tabId: string, reason: "new" | "closed") =>
      ipcRenderer.invoke(CHANNELS.sidechat.endPaneChat, { tabId, reason }) as Promise<
        | { ok: true; sessionId: string | null }
        | { ok: false; error: string }
      >,
    onStream: (handler: (event: ChatStreamEvent) => void) => {
      const listener = (_event: unknown, payload: ChatStreamEvent) => handler(payload);
      ipcRenderer.on(CHANNELS.sidechat.stream, listener);
      return () => ipcRenderer.removeListener(CHANNELS.sidechat.stream, listener);
    },
    onFallback: (handler: (payload: { from: string; to: string }) => void) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
      ipcRenderer.on(CHANNELS.sidechat.fallback, listener);
      return () => ipcRenderer.removeListener(CHANNELS.sidechat.fallback, listener);
    },
  },
  // Tutorial-C; SpotlightTour state bridge. Host stores tour completion under `~/.ave/onboarding/tour-state.json`; `tour.start` broadcasts a `ave:tour:start`
  // event through the host's trusted renderer target set. `getState` is read-never-throws (returns the default shape on any failure) per the project storage contract.
  tour: {
    getState: async () =>
      ipcRenderer.invoke(CHANNELS.tour.getState) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    markComplete: async (scenarioId: string) =>
      ipcRenderer.invoke(CHANNELS.tour.markComplete, { scenarioId }) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    dismiss: async (scenarioId: string) =>
      ipcRenderer.invoke(CHANNELS.tour.dismiss, { scenarioId }) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    start: async (scenarioId: string) =>
      ipcRenderer.invoke(CHANNELS.tour.start, { scenarioId }) as Promise<
        | { ok: true; scenarioId: string }
        | { ok: false; error: string; message: string }
      >,
    onStart: (handler: (payload: { scenarioId: string }) => void) => {
      const listener = (
        _event: unknown,
        payload: { scenarioId?: unknown },
      ) => {
        const id = payload?.scenarioId;
        if (typeof id === "string" && id.length > 0) {
          handler({ scenarioId: id });
        }
      };
      ipcRenderer.on(CHANNELS.tour.start, listener);
      return () => ipcRenderer.removeListener(CHANNELS.tour.start, listener);
    },
  },
  // Plugin onboarding proposals. `listPending` is what the renderer calls once the tour gate opens; the host answers with the ordered pending list AND stages
  // the head of it as an overlay card, so which proposal is asked next is never decided here. `answer` records the user's word and stages whatever follows it.
  onboarding: {
    listPending: async (locale: string) =>
      ipcRenderer.invoke(CHANNELS.onboarding.listPending, { locale }) as Promise<
        | { ok: true; pending: PendingOnboardingProposal[] }
        | { ok: false; error: string; message: string }
      >,
    answer: async (
      key: string,
      disposition: OnboardingProposalDisposition,
      locale: string,
    ) =>
      ipcRenderer.invoke(CHANNELS.onboarding.answer, { key, disposition, locale }) as Promise<
        | { ok: true; pending: PendingOnboardingProposal[] }
        | { ok: false; error: string; message: string }
      >,
  },
  // Open an http(s) URL in the system browser. Main-side validates the scheme and rejects file://, javascript:, and any other handler.
  openExternalUrl: async (url: string) =>
    ipcRenderer.invoke(CHANNELS.shell.openExternal, url) as Promise<{
      ok: boolean;
      error?: string;
      protocol?: string;
      message?: string;
    }>,
  // Claude Desktop config import (two-phase: preview → apply).
  previewClaudeDesktopMcpImport: async (raw: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.importClaudeDesktopPreview, raw),
  applyClaudeDesktopMcpImport: async (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) =>
    ipcRenderer.invoke(CHANNELS.mcp.importClaudeDesktopApply, payload),

  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) =>
    ipcRenderer.invoke(CHANNELS.host.pluginThemeNotify, payload),

  // Plugin-owned OAuth removed host-owned provider auth IPC bridges.

  memoryListEntries: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions(CHANNELS.memory.entriesList, opts),
  memoryListCandidates: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions(CHANNELS.memory.candidatesList, opts),
  memorySaveEntry: async (title: string, content: string, opts?: MemoryProjectOptions) =>
    ipcRenderer.invoke(CHANNELS.memory.entriesSave, title, content, opts),
  memoryDeleteEntry: async (filename: string, opts?: MemoryProjectOptions) =>
    invokeMemoryDelete(CHANNELS.memory.entriesDelete, filename, opts),
  memoryActivateCandidate: async (id: string, opts?: MemoryProjectOptions) =>
    invokeMemoryCandidateAction(CHANNELS.memory.candidateActivate, id, opts),
  memoryDeleteCandidate: async (id: string, opts?: MemoryProjectOptions) =>
    invokeMemoryCandidateAction(CHANNELS.memory.candidateDelete, id, opts),
  memorySearchEntries: async (query: string, opts?: MemoryProjectOptions) =>
    invokeMemorySearch(CHANNELS.memory.entriesSearch, query, opts),
  memoryGetIndex: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions<string>(CHANNELS.memory.indexGet, opts),
  memoryUpdateIndexIfUnchanged: async (expectedContent: string, nextContent: string) =>
    ipcRenderer.invoke(CHANNELS.memory.indexUpdateIfUnchanged, expectedContent, nextContent) as Promise<boolean>,
  memoryUpdateIndexSections: async (sections: { urgentMemory?: string; references?: string }) =>
    ipcRenderer.invoke(CHANNELS.memory.indexSectionsUpdate, sections),
  memoryListSessions: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions(CHANNELS.memory.sessionsList, opts),
  memorySearchSessions: async (query: string, opts?: MemoryProjectOptions) =>
    invokeMemorySearch(CHANNELS.memory.sessionsSearch, query, opts),
  memoryGetAgentsMd: async () => ipcRenderer.invoke(CHANNELS.memory.agentsMdGet) as Promise<string>,
  memoryUpdateAgentsMd: async (content: string) => ipcRenderer.invoke(CHANNELS.memory.agentsMdUpdate, content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke(CHANNELS.memory.userPrefsGet) as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke(CHANNELS.memory.userPrefsUpdate, content),
  memoryRefreshUserPrefs: async () => ipcRenderer.invoke(CHANNELS.memory.userPrefsRefresh),
  memoryRefreshLongTerm: async () => ipcRenderer.invoke(CHANNELS.memory.longTermRefresh),

  homeDocsStatus: async () => ipcRenderer.invoke(CHANNELS.homeDocs.upgradeMarkersList),
  homeDocsReadMarker: async (markerPath: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.markerRead, markerPath),
  homeDocsApplyPackaged: async (markerPath: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.packagedApply, markerPath),
  homeDocsKeepMine: async (markerPath: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.markerKeepMine, markerPath),
  homeDocsGetCustom: async () =>
    ipcRenderer.invoke(CHANNELS.homeDocs.customGet) as Promise<string>,
  homeDocsUpdateCustom: async (content: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.customUpdate, content),
  homeDocsMerge: async (markerPath?: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.mergeRun, markerPath),
  homeDocsApplyMerged: async (expectedContent: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.mergeApply, expectedContent),
  homeDocsDiscardMerged: async () => ipcRenderer.invoke(CHANNELS.homeDocs.mergeDiscard),

  listPersonaPromptSummaries: async () => ipcRenderer.invoke(CHANNELS.prompts.listSummaries),
  listPersonaPrompts: async () => ipcRenderer.invoke(CHANNELS.prompts.list),
  savePersonaPrompt: async (prompt: { id: string; name: string; systemPromptAdd: string }) =>
    ipcRenderer.invoke(CHANNELS.prompts.save, prompt),
  deletePersonaPrompt: async (id: string) => ipcRenderer.invoke(CHANNELS.prompts.delete, id),
  listAgentProfiles: async () => ipcRenderer.invoke(CHANNELS.agents.list),
  listSkills: async () => ipcRenderer.invoke(CHANNELS.skills.list),
  listPluginUiExtensions: async () => ipcRenderer.invoke(CHANNELS.plugins.uiList),
  // #237; host renderer pre-binds (webContents.id → pluginId, entryUrl) before each plugin webview navigates. Main rejects unknown pluginId and any non-host frame.
  registerPluginWebview: async (payload: { webContentsId: number; pluginId: string; entryUrl: string }) =>
    ipcRenderer.invoke(CHANNELS.pluginBridge.registerWebview, payload) as Promise<{ ok: boolean; error?: string }>,
  // Awaited before the panel renders its <webview>; see the channel comment.
  ensurePluginPartition: async (pluginId: string) =>
    ipcRenderer.invoke(CHANNELS.pluginBridge.ensurePartition, { pluginId }) as Promise<{ ok: boolean; error?: string }>,
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke(CHANNELS.plugins.uiReadModule, { pluginId, viewId }) as Promise<string>,
  // #1176; toggle a plugin active/inactive. Returns the IPC result frame ({ ok, pluginId, enabled } | { ok:false, error, message }).
  setPluginEnabled: async (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke(CHANNELS.plugins.setEnabled, pluginId, enabled),
  listPluginContributionTrust: async (pluginId?: string) =>
    ipcRenderer.invoke(CHANNELS.plugins.contributionTrustList, pluginId),
  setPluginContributionTrust: async (input: {
    pluginId: string;
    localId: string;
    kind: "hook" | "mcpServer";
    approved: boolean;
    generationId?: string;
    approvalDigest?: string | null;
  }) => ipcRenderer.invoke(CHANNELS.plugins.contributionTrustSet, input),
  callPluginMethod: async (
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => ipcRenderer.invoke(CHANNELS.plugins.call, method, payload, {
    userAction: options?.userAction === true && navigator.userActivation?.isActive === true,
    ...(options?.operationGrantToken
      ? { operationGrantToken: options.operationGrantToken }
      : {}),
  }),
  e2ePluginBundleSnapshot: async (
    pluginId: string,
    skillLocalId: string,
    hookProbeToolName: string,
  ) =>
    ipcRenderer.invoke(
      CHANNELS.plugins.e2eBundleSnapshot,
      pluginId,
      skillLocalId,
      hookProbeToolName,
    ) as Promise<unknown>,

  onTriggerStarted: (handler: (payload: OverlayTriggerStartedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.started, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.started, listener);
  },
  onTriggerCompleted: (handler: (result: OverlayTriggerCompletedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.completed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.completed, listener);
  },
  onTriggerFailed: (handler: (payload: OverlayTriggerFailedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.failed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.failed, listener);
  },
  onTriggerExpired: (handler: (payload: OverlayTriggerExpiredPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.expired, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.expired, listener);
  },
  onTriggerImported: (handler: (payload: OverlayTriggerImportedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.imported, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.imported, listener);
  },
  dismissTrigger: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.trigger.dismiss, sessionId) as ReturnType<AveApi["dismissTrigger"]>,
  importTrigger: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.trigger.import, sessionId) as ReturnType<AveApi["importTrigger"]>,

  onMarketplaceUpdatesAvailable: (handler: (updates: PackageUpdateView[]) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on(CHANNELS.marketplace.updatesAvailable, listener);
    return () => ipcRenderer.removeListener(CHANNELS.marketplace.updatesAvailable, listener);
  },

  // The host pushes the active, not-yet-dismissed announcement set whenever the announcement poller runs (boot + interval). Dismissals are
  // persisted by the renderer via updateSettings, and the host filters them out before the next push so a dismissed banner never reappears.
  onMarketplaceAnnouncements: (handler: (announcements: MarketplaceAnnouncementPayload) => void) => {
    const listener = (_event: unknown, announcements: Parameters<typeof handler>[0]) => handler(announcements);
    ipcRenderer.on(MARKETPLACE.announcements, listener);
    return () => ipcRenderer.removeListener(MARKETPLACE.announcements, listener);
  },

  // Main process emits `ave:update:state` whenever the updater state transitions (available / downloading / downloaded). Renderer renders a permanent badge next to the Home
  // button so the user always sees the current state, not a transient toast. The two action commands are user-gated; `downloadAppUpdate` is only called from a badge click,

  // UpdateState type imported from the SoT at src/shared/update-state.ts so adding a new variant only needs editing that one file.
  onAppUpdateState: (
    handler: (state: import("../shared/update-state.js").UpdateState) => void,
  ) => {
    const listener = (_event: unknown, state: Parameters<typeof handler>[0]) => handler(state);
    ipcRenderer.on(CHANNELS.update.state, listener);
    return () => ipcRenderer.removeListener(CHANNELS.update.state, listener);
  },
  /** Fetch the last-known state synchronously (for late-mounting components that miss the initial broadcast). Returns { kind: "idle" } before the first check completes. */
  getAppUpdateState: () =>
    ipcRenderer.invoke(CHANNELS.update.getState) as Promise<
      import("../shared/update-state.js").UpdateState
    >,
  /** Start the actual download. Only valid when the current state is "available"; rejected (ok:false) otherwise. */
  downloadAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.downloadNow) as Promise<{ ok: boolean; reason?: string }>,
  /** Quit and apply the downloaded update. Main validates the sender and owns the native confirmation dialog before
   * it calls quitAndInstall(). Only valid when the current state is "downloaded"; rejected (ok:false) otherwise. */
  installAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.installNow) as Promise<{ ok: boolean; reason?: string }>,
  skipAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.skipVersion) as Promise<{ ok: boolean; reason?: string }>,

  // The marketplace boot pass emits these so the renderer can show a banner / toast during startup install. Three lifecycle states: - { phase: "start" } - { phase: "complete",
  // installed[], failed[], skipped? } - { phase: "error", message } Best-effort: the host swallows send errors, so the renderer must tolerate missing events (page reload during startup, etc.).
  onBootstrapStatus: (handler: (status: AppBootstrapStatus) => void) => {
    const listener = (_event: unknown, status: Parameters<typeof handler>[0]) => handler(status);
    ipcRenderer.on(CHANNELS.bootstrap.status, listener);
    return () => ipcRenderer.removeListener(CHANNELS.bootstrap.status, listener);
  },
  // Late-mount sync: on a cold boot the events above are all emitted before this renderer exists, so
  // the subscription alone never sees them. Resolves `null` when the host has reported nothing yet.
  getBootstrapStatus: () =>
    ipcRenderer.invoke(CHANNELS.bootstrap.statusGet) as Promise<AppBootstrapStatus | null>,
  // Banner-driven retry. Re-emits the start/complete/error status sequence so the banner subscriber updates without needing a separate result channel.
  retryBootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap.retry),

  // Fires when a local-folder install has finished installing + restartAll() in the main process. Renderer uses
  // this to refresh its plugin UI list so newly-installed plugin views appear without requiring an app restart.
  onPluginInstallResult: (handler: (payload: PluginInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.installResult, listener);
  },

  /** Dev-only: install a plugin from a local directory (AVE_DEV=1 required). Return shape: - `null`; the user cancelled the folder picker. NOT an error. - `{ pluginId, installed: true }`; install succeeded. - throws; auth/dev-mode/IO error.
   * Callers should surface this as a toast/alert rather than collapsing it into `null`, otherwise users can't distinguish "didn't run" from "ran but failed". See `installLocal` in `src/plugins/marketplace.ts` for the error producer side. */
  installLocalPlugin: async () => {
    const r = await ipcRenderer.invoke(CHANNELS.plugins.installLocal) as
      | { pluginId: string; installed: true }
      | { ok: false; error: string }
      | null;
    if (!r) return null; // user cancelled the folder picker
    if ("ok" in r) {
      throw new Error(`installLocalPlugin: ${r.error}`);
    }
    return r;
  },

  // Sibling of onPluginInstallResult; fires after PluginConfigTab or any other surface drives
  // uninstall through the IPC handler. Renderer uses this to drop the removed plugin view + marketplace card.
  onPluginUninstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.uninstallResult, listener);
  },
  // #1176; fires after a plugin's active/inactive state is toggled (via this surface or any other). Renderer
  // surfaces use this to refresh plugin cards so a disabled plugin's tools/UI disappear (and reappear on re-enable).
  onPluginEnabledChanged: (handler: (payload: { pluginId: string; enabled: boolean }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.enabledChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.enabledChanged, listener);
  },
  onPluginRuntimeUpdated: (handler: (payload: { pluginId: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.runtimeUpdated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.runtimeUpdated, listener);
  },
  onPersonaPromptsUpdated: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(CHANNELS.prompts.updated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.prompts.updated, listener);
  },

  onAgentUninstallResult: (handler: (payload: AgentInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.uninstallResult, listener);
  },
  onSkillUninstallResult: (handler: (payload: SkillInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.uninstallResult, listener);
  },

  // Status bar; aggregated runtime counters (tools / plugins / mcps).
  getRuntimeCounts: async () =>
    ipcRenderer.invoke(CHANNELS.runtime.counts) as Promise<{
      tools: number;
      plugins: number;
      mcps: number;
    }>,
  // Status bar; static environment info (platform / hostname / user). Static enough to fetch once on mount; values don't change
  // while the process is alive. Cwd is intentionally NOT exposed; least-privilege for plugin UI panels that share this contextBridge.
  getRuntimeEnv: async () =>
    ipcRenderer.invoke(CHANNELS.runtime.env) as Promise<{
      platform: string;
      hostname: string;
      user: string;
    }>,
  // Status bar; active LLM provider reachability probe. This performs a tiny one-shot model call from the main
  // process so "connected" means the provider itself answered, not only that the marketplace backend is online.
  pingAiProvider: async () =>
    ipcRenderer.invoke(CHANNELS.llm.ping) as Promise<AiProviderPingIpcResult>,
  // The model catalog main resolves against; the renderer installs it before it mounts (`src/ui/renderer/model-catalog-bootstrap.ts`).
  getModelCatalog: async () =>
    ipcRenderer.invoke(CHANNELS.llm.getModelCatalog) as Promise<ModelCatalogIpcResult>,

  // Settings "일반" dashboard; host metadata. SoT for `version` is the Ave project package.json (resolved by the main
  // process via `app.getAppPath()`); stack fields come from `process.versions`. The renderer never hard-codes these values.
  getAppInfo: async () =>
    ipcRenderer.invoke(CHANNELS.app.info) as Promise<{
      version: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      v8Version: string;
      platform: NodeJS.Platform;
      arch: string;
      userDataPath: string;
    }>,

  onPluginEvent: (
    eventType: string,
    handler: (data: unknown) => void,
  ): (() => void) => {
    // Reject private subscriptions at preload using classifySubscription, the shared event authority.
    // Do not reconstruct namespace rules here; exact host event types and sensitive state must follow the same classifier.
    if (classifySubscription(eventType) === "private") {
      // Return a no-op unsubscribe; the subscription is silently rejected.
      return () => undefined;
    }
    const listener = (_event: unknown, type: string, data: unknown) => {
      if (type === eventType) handler(data);
    };
    ipcRenderer.on(CHANNELS.pluginBridge.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.pluginBridge.event, listener);
  },

  // Assembled in its own module for size; spliced in here unchanged.
  mcp: mcpApiSurface,

  permission: {
    getMode: async () => ipcRenderer.invoke(PERMISSIONS.getMode),
    setMode: async (mode: string) => ipcRenderer.invoke(PERMISSIONS.setMode, {
      mode,
      intent: ipcUserKeyboardIntent(),
    }),
    onModeChanged: (cb: (mode: string) => void) => {
      const listener = (_event: unknown, payload: { mode?: unknown }) => {
        if (typeof payload?.mode === "string") cb(payload.mode);
      };
      ipcRenderer.on(PERMISSIONS.modeChanged, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.modeChanged, listener);
    },
    /** Hint event; directory config mutated. Listeners refresh state by calling `permission.dirDispatch("list")` rather
     * than receiving the full directory list in the broadcast payload (slash dispatcher is the single source of truth). */
    onConfigChanged: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(PERMISSIONS.configChanged, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.configChanged, listener);
    },
    /** Read-only: honest OS sandbox capability for the current platform. */
    sandboxCapability: async () => ipcRenderer.invoke(PERMISSIONS.sandboxCapability),
    /** Read-only: Windows srt-win install readiness (group + WFP + instructions). */
    sandboxWindowsStatus: async () => ipcRenderer.invoke(PERMISSIONS.sandboxWindowsStatus),
    /** Read-only: the ASRT proxy denies of the last 24 h, newest first. */
    egressDenialsRecent: async () => ipcRenderer.invoke(PERMISSIONS.egressDenialsRecent),
    /** Read-only: the shell egress grants for a conversation, a terminal tab, a workspace or always. */
    egressGrantsList: async () => ipcRenderer.invoke(PERMISSIONS.egressGrantsList),
    /** MUTATING: revoke one shell egress grant (user-keyboard intent attached). */
    egressGrantRevoke: async (grant: RevocableEgressGrant) => ipcRenderer.invoke(PERMISSIONS.egressGrantRevoke, { ...grant, intent: ipcUserKeyboardIntent() }),
    /** Read-only: the upstream proxy setting, whether credentials are stored, and the effective upstream. */
    upstreamProxyGet: async () => ipcRenderer.invoke(PERMISSIONS.upstreamProxyGet),
    /** MUTATING: change the upstream proxy setting (user-gesture intent attached). */
    upstreamProxySet: async (patch: {
      mode?: "off" | "system" | "manual";
      manualUrl?: string;
      bypass?: string;
      resolvesNames?: boolean;
      clearCredentials?: boolean;
    }) => ipcRenderer.invoke(PERMISSIONS.upstreamProxySet, { ...patch, intent: ipcUserKeyboardIntent() }),
    /** MUTATING: trigger the one-time Windows srt-win install (one self-elevating UAC prompt). The ONLY user-consented privilege-escalation entry
     * point; only ever called from an explicit "Install now" click. Auto-injects the user-keyboard intent the sender-guarded handler requires. */
    sandboxWindowsInstall: async () =>
      ipcRenderer.invoke(PERMISSIONS.sandboxWindowsInstall, { intent: ipcUserKeyboardIntent() }),
    approveExtensionsWithoutIsolation: async () =>
      ipcRenderer.invoke(PERMISSIONS.approveExtensionsWithoutIsolation, { intent: ipcUserKeyboardIntent() }),
    listRules: async () => ipcRenderer.invoke(PERMISSIONS.listRules),
    listScopedRules: async () => ipcRenderer.invoke(PERMISSIONS.listScopedRules),
    removeScopedRule: async (rule: import("../shared/permissions-events.js").ScopedPermissionRule) =>
      ipcRenderer.invoke(PERMISSIONS.removeScopedRule, { ...rule, intent: ipcUserKeyboardIntent() }),
    addRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke(PERMISSIONS.addRule, { pattern, action, intent: ipcUserKeyboardIntent() }),
    removeRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke(PERMISSIONS.removeRule, { pattern, action, intent: ipcUserKeyboardIntent() }),
    recentlyDeniedList: async () => ipcRenderer.invoke(PERMISSIONS.recentlyDeniedList),
    /** Permission policy hook quarantine state for non-modal settings badge. */
    hookTrustList: async () => ipcRenderer.invoke(PERMISSIONS.hookTrustList),
    /** Permission policy; `/permission dir ...` slash dispatch via IPC. */
    dirDispatch: async (rawArgs: string) =>
      ipcRenderer.invoke(PERMISSIONS.dirDispatch, { rawArgs, intent: ipcUserKeyboardIntent() }),
    recentlyDeniedRerun: async (id: string) => ipcRenderer.invoke(PERMISSIONS.recentlyDeniedRerun, {
      id, intent: ipcUserKeyboardIntent(),
    }),
    onRecentlyDeniedChanged: (cb: (summary: { total: number }) => void) => {
      const listener = (_event: unknown, summary: { total: number }) => cb(summary);
      ipcRenderer.on(PERMISSIONS.recentlyDeniedChanged, listener);
      return () => ipcRenderer.removeListener(PERMISSIONS.recentlyDeniedChanged, listener);
    },
    /** Memory-hit auto-approve disclosure; main→renderer event. */
    onUserApprovalHit: (cb: (payload: UserApprovalHitPayload) => void) => {
      const listener = (_event: unknown, payload: UserApprovalHitPayload) =>
        cb(payload);
      ipcRenderer.on(PERMISSIONS.userApprovalHit, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.userApprovalHit, listener);
    },
    onReviewSuggestion: (cb: (payload: PermissionReviewSuggestionPayload) => void) => {
      const listener = (_event: unknown, payload: PermissionReviewSuggestionPayload) =>
        cb(payload);
      ipcRenderer.on(PERMISSIONS.reviewSuggestion, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.reviewSuggestion, listener);
    },
    /** Permission policy; `/permission reviewer ...` slash dispatch via IPC. */
    reviewerDispatch: async (rawArgs: string) =>
      ipcRenderer.invoke(PERMISSIONS.reviewerDispatch, { rawArgs, intent: ipcUserKeyboardIntent() }),
    judgeGet: async () => ipcRenderer.invoke(PERMISSIONS.judgeGet),
    /** Sends only the fields present in `patch`; unchanged stored values stay as stored. */
    judgeSet: async (patch: Partial<PermissionJudgeSettings>) =>
      ipcRenderer.invoke(PERMISSIONS.judgeSet, {
        settings: serializePermissionJudgeSettingsPatch(patch),
        intent: ipcUserKeyboardIntent(),
      }),
    /** Permission policy; `/permission audit show`; fetch recent permission audit entries. */
    auditShow: async (last: number) =>
      ipcRenderer.invoke(PERMISSIONS.auditShow, { last }),
    /** Permission policy; `/permission audit verify`; chain integrity check. */
    auditVerify: async () =>
      ipcRenderer.invoke(PERMISSIONS.auditVerify),
    /** Permission policy; manifest integrity violation notifier. Subscribes to `PERMISSIONS.manifestViolation` so the renderer can surface a "Plugin X disabled; reinstall?" prompt. */
    onManifestViolation: (
      handler: (payload: {
        pluginId: string;
        toolName: string;
        attempted: string;
      }) => void,
    ) => {
      const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) =>
        handler(payload);
      ipcRenderer.on(PERMISSIONS.manifestViolation, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.manifestViolation, listener);
    },
  },

  policy: {
    get: async () => ipcRenderer.invoke(PERMISSIONS.policyGet),
    set: async (patch: unknown) =>
      ipcRenderer.invoke(PERMISSIONS.policySet, { patch, intent: ipcUserKeyboardIntent() }),
  },

  approval: {
    /** main→renderer 단방향 이벤트 구독 */
    onRequest: (cb: Parameters<AveApi["approval"]["onRequest"]>[0]) => {
      const listener = (_event: unknown, req: Parameters<typeof cb>[0]) => cb(req);
      ipcRenderer.on(CHANNELS.approval.request, listener);
      return () => ipcRenderer.removeListener(CHANNELS.approval.request, listener);
    },
    /** main→renderer: a request the host is no longer waiting on. Window-wide like `onRequest`; the queue
     * it reconciles is the window's one FIFO, and the surface drawing the card is decided renderer-side. */
    onSettled: (cb: Parameters<AveApi["approval"]["onSettled"]>[0]) => {
      const listener = (_event: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
      ipcRenderer.on(CHANNELS.approval.settled, listener);
      return () => ipcRenderer.removeListener(CHANNELS.approval.settled, listener);
    },
    /** 사용자 결정을 main으로 전송 */
    respond: async (decision: unknown) =>
      ipcRenderer.invoke(PERMISSIONS.approvalRespond, decision),
    /** The requests the host is still waiting on, exactly as `onRequest` delivered them. A renderer that (re)loads while a turn is parked
     * on an approval subscribed after the request went out, so this is how it gets the card back instead of leaving the turn to time out. */
    listPending: async () => ipcRenderer.invoke(PERMISSIONS.approvalPending),
    /** `/allow <sentence>`; ask the host which of the PENDING request's own scopes the sentence meant. Returns
     * a choice to pre-select; it decides nothing, so `respond` above is still the only way to answer a prompt. */
    selectSentence: async (requestId: string, input: string) =>
      ipcRenderer.invoke(PERMISSIONS.approvalSentenceSelect, {
        requestId,
        input,
        intent: ipcUserKeyboardIntent(),
      }),
  },

  userApproval: {
    /** Record an exact user decision (legacy callers default to allow). */
    record: async (entry: {
      /** Server-side ApprovalRequest binding; required for IPC handler validation. */
      requestId: string;
      /** A card's rule save: the choice's action and scope and, only when edited, the rule text (the host validates it against the card's own rule grammar). */
      rule?: ApprovalRuleSave;
      toolName: string;
      args: string;
      source: string;
      decision?: "allow" | "deny";
      scope: UserApprovalScope;
      verdictAtApproval: UserApprovalVerdict;
      nlJustification: string | null;
      /** Propagated for record/lookup key symmetry. */
      trustOrigin?: string;
      /** Propagated for record/lookup key symmetry. */
      approvalCacheKey?: string;
    }) => ipcRenderer.invoke(PERMISSIONS.userApprovalRecord, { ...entry, intent: ipcUserKeyboardIntent() }),
    /** Revoke an approval by raw composite key. */
    revokeByKey: async (key: string) =>
      ipcRenderer.invoke(PERMISSIONS.userApprovalRevoke, { key, intent: ipcUserKeyboardIntent() }),
    /** List all approval entries (for PermissionsTab display). */
    list: async () => ipcRenderer.invoke(PERMISSIONS.userApprovalList),
    listSession: async () => ipcRenderer.invoke(PERMISSIONS.userApprovalList, { scope: "session" }),
  },

  dlp: {
    getStats: async (days: number) => ipcRenderer.invoke(CHANNELS.dlp.stats, days),
  },

  audit: {
    search: async (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke(CHANNELS.audit.search, filter),
    getStats: async (lastDays: number) => ipcRenderer.invoke(CHANNELS.audit.stats, lastDays),
  },

  // ─── Diagnostics bundle + crash list ──
  diagnostics: {
    /** Build a redacted diagnostics ZIP and save via native dialog. */
    export: async (opts?: { dateFrom?: string; dateTo?: string; includeCrashDumps?: boolean }) =>
      ipcRenderer.invoke(CHANNELS.diagnostics.export, opts),
    /** List crash-dump metadata (filename/time/size). */
    crashList: async () => ipcRenderer.invoke(CHANNELS.diagnostics.crashList),
  },

  // ─── Production log tail viewer ──
  logs: {
    /** Recent N redacted log lines, optional level filter. */
    tail: async (args?: { lines?: number; level?: string }) =>
      ipcRenderer.invoke(CHANNELS.logs.tail, args),
  },

  submitFeedback: async (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) =>
    ipcRenderer.invoke(CHANNELS.feedback.submit, payload) as Promise<{ ok: boolean; error?: string }>,

  onViewActivate: (handler: (viewKey: string, settingsTab?: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string; settingsTab?: string }) =>
      handler(payload?.viewKey ?? "home", typeof payload?.settingsTab === "string" ? payload.settingsTab : undefined);
    ipcRenderer.on(CHANNELS.view.activate, listener);
    return () => ipcRenderer.removeListener(CHANNELS.view.activate, listener);
  },

  // ask_user_question; main process pushes FIFO question requests to the renderer's non-modal composer dock; the card resolves via this channel.
  onAskUserQuestion: (handler: (req: AskUserQuestionRequest) => void) => {
    const listener = (_e: unknown, req: Parameters<typeof handler>[0]) => handler(req);
    ipcRenderer.on(CHANNELS.askUserQuestion.request, listener);
    return () => ipcRenderer.removeListener(CHANNELS.askUserQuestion.request, listener);
  },
  respondAskUserQuestion: async (response: AskUserQuestionResponse) =>
    ipcRenderer.invoke(CHANNELS.askUserQuestion.respond, response),
  // Questions sent before this renderer subscribed (it loaded later).
  listPendingAskUserQuestions: async () => ipcRenderer.invoke(CHANNELS.askUserQuestion.pending),
  // Timeout side-channel; main process notifies the renderer when an ask_user_question request
  // expired (5 min default) so the card can drop the stale prompt before the user clicks into a no-op.
  onAskUserQuestionTimeout: (
    handler: (payload: { requestId: string }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.askUserQuestion.timeout, listener);
    return () => ipcRenderer.removeListener(CHANNELS.askUserQuestion.timeout, listener);
  },

  // routine_schedule; persistent routine list + lifecycle
  listRoutines: async () => ipcRenderer.invoke(ROUTINES.list),
  dismissRoutine: async (id: string) => ipcRenderer.invoke(ROUTINES.dismiss, id),
  removeRoutine: async (id: string) => ipcRenderer.invoke(ROUTINES.remove, id),
  triggerRoutineNow: async (id: string) => ipcRenderer.invoke(ROUTINES.triggerNow, id),
  listPendingRoutineResults: async () =>
    ipcRenderer.invoke(ROUTINES.pendingResults) as Promise<
      import("../shared/routines-types.js").RoutineFiredPayload[]
    >,
  acknowledgeRoutineResult: async (routineId: string, firedAt: string) =>
    ipcRenderer.invoke(ROUTINES.acknowledgeResult, routineId, firedAt) as Promise<{ ok: boolean; error?: string }>,
  addRoutine: async (input: import("../shared/routines-types.js").AddRoutineInput) =>
    ipcRenderer.invoke(ROUTINES.add, input) as Promise<
      { ok: true; routine: import("../shared/routines-types.js").RoutineRecord } | { ok: false; error: string }
    >,
  onRoutineFired: (
    handler: (event: import("../shared/routines-types.js").RoutineFiredPayload) => void,
  ) => {
    const listener = (_e: unknown, r: Parameters<typeof handler>[0]) => handler(r);
    ipcRenderer.on(ROUTINES.fired, listener);
    return () => ipcRenderer.removeListener(ROUTINES.fired, listener);
  },
  // Routine running indicator: emitted when a routine LLM session starts/finishes runningStarted payload enriched to {
  // routineId, firedAt, title } so the renderer can push a proper OverlayItem immediately without waiting for fired.
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(ROUTINES.runningStarted, listener);
    return () => ipcRenderer.removeListener(ROUTINES.runningStarted, listener);
  },
  onRoutineRunningFinished: (handler: (routineId: string) => void) => {
    const listener = (_e: unknown, id: string) => handler(id);
    ipcRenderer.on(ROUTINES.runningFinished, listener);
    return () => ipcRenderer.removeListener(ROUTINES.runningFinished, listener);
  },
  // failed: emitted when the routine LLM session throws (e.g. provider error). Without this bridge the
  // renderer never learns the session failed and the running OverlayItem stays stuck with running:true indefinitely.
  onRoutineFailed: (handler: (event: { routineId: string; error: string }) => void) => {
    const listener = (_e: unknown, payload: { routineId: string; error: string }) => handler(payload);
    ipcRenderer.on(ROUTINES.failed, listener);
    return () => ipcRenderer.removeListener(ROUTINES.failed, listener);
  },
  // Routine session history; the same conversation rows the sidebar lists, scoped by routineId, plus the opening snippet the panel shows.
  listRoutineSessions: async (routineId: string, limit?: number) =>
    ipcRenderer.invoke(ROUTINES.listSessions, routineId, limit) as Promise<
      import("../shared/session-lookup.js").RoutineRunRow[]
    >,

  // Personal board CRUD + lifecycle. Each method maps 1:1 to a WORK_BOARD.* channel; the main-process store returns discriminated `status` envelopes (or `{ ok:false, error }` for
  // unauthorized-frame / no-store), forwarded verbatim; no fallback / re-shaping. Shared payload + result types come from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkBoard: async (filter?: import("../shared/work-board-types.js").WorkItemListFilter) =>
    ipcRenderer.invoke(WORK_BOARD.list, filter) as Promise<
      | import("../shared/work-board-types.js").WorkItemListResult
      | { ok: false; error: string }
    >,
  getWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.get, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemGetResult
      | { ok: false; error: string }
    >,
  addWorkBoardItem: async (input: import("../shared/work-board-types.js").WorkItemCreateInput) =>
    ipcRenderer.invoke(WORK_BOARD.add, input) as Promise<
      | import("../shared/work-board-types.js").WorkItemCreateResult
      | { ok: false; error: string }
    >,
  updateWorkBoardItem: async (id: number, patch: import("../shared/work-board-types.js").WorkItemUpdateInput) =>
    ipcRenderer.invoke(WORK_BOARD.update, id, patch) as Promise<
      | import("../shared/work-board-types.js").WorkItemUpdateResult
      | { ok: false; error: string }
    >,
  transitionWorkBoardItem: async (id: number, to: import("../shared/work-board-types.js").WorkItemStatusStored) =>
    ipcRenderer.invoke(WORK_BOARD.transition, id, to) as Promise<
      | import("../shared/work-board-types.js").WorkItemTransitionResult
      | { ok: false; error: string }
    >,
  completeWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.complete, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemCompleteResult
      | { ok: false; error: string }
    >,
  reopenWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.reopen, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemReopenResult
      | { ok: false; error: string }
    >,
  removeWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.remove, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemDeleteResult
      | { ok: false; error: string }
    >,
  // Board view live refresh: emitted by the work-board IPC domain after any successful mutation
  // (created/updated/transitioned/completed/reopened/ removed) so the renderer board view re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.itemChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.itemChanged, listener);
  },
  // Agent-orchestration run: kick off plan→approve→execute for one item. The promise resolves with the terminal WorkItemRunResult, but live phase updates flow over
  // onWorkBoardRunProgress; coarse started/finished/failed markers (for the per-item running indicator) flow over the on* siblings. `opts.agentName` selects a named agent profile (drives the child model).
  runWorkBoardItem: async (id: number, opts?: { agentName?: string }) =>
    ipcRenderer.invoke(WORK_BOARD.run, id, opts) as Promise<
      | import("../shared/work-board-types.js").WorkItemRunResult
      | { ok: false; error: string }
    >,
  // Generate a daily / weekly personal work report from the board state + activity log + learned memory.
  // Resolves with the report markdown (ok), an empty-period envelope, an error envelope (LLM failure), or no-reporter.
  generateWorkBoardReport: async (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
  ) =>
    ipcRenderer.invoke(WORK_BOARD.generateReport, kind, input) as Promise<
      | import("../shared/work-board-types.js").WorkBoardReportResult
      | { ok: false; error: string }
    >,
  // Run the daily / weekly briefing: a read-only sub-agent survey of the user's work whose findings are filed onto the board
  // as proposals. Resolves with the ids of the cards it wrote (ok), a nothing-found envelope, an error envelope, or no-engine.
  runWorkBoardBriefing: async (
    kind: import("../shared/work-board-types.js").WorkBoardBriefingKind,
    projectRoot?: string,
  ) =>
    ipcRenderer.invoke(WORK_BOARD.runBriefing, kind, projectRoot) as Promise<
      | import("../shared/work-board-types.js").WorkBoardBriefingResult
      | { ok: false; error: string }
    >,
  // Read the open proposals, promote one into a work item, or close it. There is no renderer path that
  // CREATES a proposal; a proposal is a plugin's claim, and the user's own additions are ordinary work items.
  listWorkProposals: async () =>
    ipcRenderer.invoke(WORK_BOARD.listProposals) as Promise<
      | import("../shared/work-board-types.js").WorkProposalListResult
      | { ok: false; error: string }
    >,
  acceptWorkProposal: async (proposalId: string, projectRoot?: string) =>
    ipcRenderer.invoke(WORK_BOARD.acceptProposal, proposalId, projectRoot) as Promise<
      | import("../shared/work-board-types.js").WorkProposalAcceptResult
      | { ok: false; error: string }
    >,
  dismissWorkProposal: async (proposalId: string) =>
    ipcRenderer.invoke(WORK_BOARD.dismissProposal, proposalId) as Promise<
      | import("../shared/work-board-types.js").WorkProposalDismissResult
      | { ok: false; error: string }
    >,
  onWorkProposalChanged: (
    handler: (payload: import("../shared/work-board-types.js").WorkProposalChangedEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.proposalChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.proposalChanged, listener);
  },
  // Read a past run's persisted transcript (plan+execute conversation) for the run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript: async (itemId: number, runId: string) =>
    ipcRenderer.invoke(WORK_BOARD.runTranscript, itemId, runId) as Promise<
      | { events: import("../shared/work-board-types.js").RunTranscriptEvent[] }
      | { ok: false; error: string }
    >,
  // Live per-phase progress for an in-flight run (planning / awaiting_approval / executing / denied /
  // done / error). Payload === the engine's WorkBoardRunEvent (aliased as RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runProgress, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runProgress, listener);
  },
  // Coarse marker: a run started for `itemId` (renderer sets the running flag).
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runStarted, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runStarted, listener);
  },
  // Coarse marker: a run finished for `itemId` with a terminal status (renderer clears the running flag). `status` mirrors WorkItemRunResult.status.
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      status: "completed" | "denied" | "not_found" | "error" | "already_running";
      at: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFinished, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFinished, listener);
  },
  // Coarse marker: the engine threw before producing a result (renderer clears the running flag and surfaces `reason`).
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFailed, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFailed, listener);
  },

  // Overlay IPC bridges (main → renderer push)
  onOverlayShow: (handler: Parameters<AveApi["onOverlayShow"]>[0]) => {
    const listener = (_e: unknown, item: Parameters<typeof handler>[0]) => handler(item);
    ipcRenderer.on(OVERLAY_V1.show, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.show, listener);
  },
  onOverlayUpdate: (handler: Parameters<AveApi["onOverlayUpdate"]>[0]) => {
    const listener = (_e: unknown, id: string, patch: Parameters<typeof handler>[1]) => handler(id, patch);
    ipcRenderer.on(OVERLAY_V1.update, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.update, listener);
  },
  onOverlayDismiss: (handler: (id: string) => void) => {
    const listener = (_e: unknown, id: string) => handler(id);
    ipcRenderer.on(OVERLAY_V1.dismiss, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.dismiss, listener);
  },

  // Plugin alert cards: what the user did with one, and the cards staged before this window was listening.
  alerts: {
    removePredecessor: async (kindKey: string) =>
      ipcRenderer.invoke(ALERTS.removePredecessor, kindKey) as Promise<import("../shared/alerts-types.js").RemoveAlertPredecessorResult>,
    listKinds: async () =>
      ipcRenderer.invoke(ALERTS.listKinds) as Promise<import("../shared/alerts-types.js").AlertKindRow[]>,
    setKind: async (kindKey: string, patch: import("../shared/alerts-types.js").AlertKindPatch) =>
      ipcRenderer.invoke(ALERTS.setKind, kindKey, patch) as Promise<import("../shared/alerts-types.js").SetAlertKindResult>,
    setOsNotificationsEnabled: async (enabled: boolean) =>
      ipcRenderer.invoke(ALERTS.setOsNotificationsEnabled, enabled) as Promise<import("../shared/alerts-types.js").SetAlertOsNotificationsResult>,
    onKindsChanged: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on(ALERTS.kindsChanged, listener);
      return () => ipcRenderer.removeListener(ALERTS.kindsChanged, listener);
    },
    cardClosed: async (alertId: string, reason: "accepted" | "dismissed") =>
      ipcRenderer.invoke(ALERTS.cardClosed, alertId, reason) as Promise<{ ok: boolean; error?: string }>,
    listOpen: async () =>
      ipcRenderer.invoke(ALERTS.listOpen) as Promise<import("../shared/alerts-types.js").AlertCard[]>,
  },

  // session_tasks; assistant's current-turn checklist
  listSessionTasks: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionTasks.list, sessionId),
  clearSessionTasks: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionTasks.clear, sessionId),
  onSessionTasksChanged: (
    handler: (payload: {
      sessionId: string;
      items: SessionTaskItem[];
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.sessionTasks.changed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionTasks.changed, listener);
  },

  // session_goal; the objective this session is working towards
  getSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.get, sessionId),
  pauseSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.pause, sessionId),
  resumeSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.resume, sessionId),
  clearSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.clear, sessionId),
  onSessionGoalChanged: (
    handler: (payload: { sessionId: string; goal: SessionGoal | null }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.sessionGoal.changed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionGoal.changed, listener);
  },

  // agent_spawn; sub-agent lifecycle event stream
  onAgentSpawnEvent: (
    handler: (event: AgentSpawnEvent<ChatEntry>) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on(CHANNELS.agentSpawn.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agentSpawn.event, listener);
  },

  // skill_load; chat-side badge event
  onSkillLoaded: (
    handler: (event: {
      name: string;
      description: string;
      sessionId: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on(CHANNELS.skillLoad.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skillLoad.event, listener);
  },

  // Main process pushes in-app toast payloads when the window is focused; OS notifications fire when backgrounded/minimized. Renderer also signals
  // back when an in-app toast / OS notification is clicked so main can focus the window and the renderer can scroll/navigate to the source surface.
  onNotificationToast: (handler: (payload: NotificationToastPayload) => void) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.notification.toast, listener);
    return () => ipcRenderer.removeListener(CHANNELS.notification.toast, listener);
  },
  onNotificationClicked: (handler: (payload: NotificationClickPayload) => void) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.notification.clicked, listener);
    return () => ipcRenderer.removeListener(CHANNELS.notification.clicked, listener);
  },
  notifyClick: async (payload: NotificationClickPayload) =>
    ipcRenderer.invoke(CHANNELS.notification.clicked, payload),

  window: {
    /** Open a render_html result in an isolated BrowserWindow. */
    openHtmlPreview: async (payload: OpenHtmlPreviewWindowPayload) =>
      ipcRenderer.invoke(CHANNELS.window.openHtmlPreview, payload) as Promise<OpenHtmlPreviewWindowResult>,
  },

  /** Dev tools bridge; only useful in non-production builds. Renderer floating panel uses this to adjust the token
   * preflight threshold at runtime (so compact scenarios can be reproduced without filling the actual model context window). */
  dev: {
    setPreflightOverride: async (tokens: number | null) =>
      ipcRenderer.invoke(CHANNELS.dev.setPreflightOverride, tokens) as Promise<
        { ok: true; value: number | null } | { ok: false; error: string }
      >,
    getPreflightStatus: async () =>
      ipcRenderer.invoke(CHANNELS.dev.getPreflightStatus) as Promise<
        | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
        | { ok: false; error: string }
      >,
  },
  } satisfies Partial<AveApi>;
}
