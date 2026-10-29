/**
 * Preload contextBridge shape lock — Commit C0 safety snapshot.
 *
 * Mocks electron's `contextBridge.exposeInMainWorld` to record every exposed
 * world `(worldName, apiObject)`, imports `src/preload.ts`, and snapshots a
 * DEEP shape of each world: the sorted top-level keys plus, for each nested
 * object value, one level of sorted keys. This locks the `window.*` world
 * names and their exposed API surface byte-identical before the refactor that
 * follows moves them.
 *
 * Values are intentionally NOT captured (only `typeof` / nested key lists) so
 * env-dependent values (e.g. `__aveDevMode`, platform flags) stay
 * deterministic across machines. MUST pass against the current (unchanged) code.
 *
 * Mock scaffolding mirrors `src/__tests__/preload.test.ts` (which already
 * imports preload successfully).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ALERTS } from "../shared/ipc-channels.js";
import type { AveApi } from "../ui/renderer/types.js";
import { dockAssetArgs } from "../shared/floating-dock-args.js";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockUserActivation = { isActive: false };

// Named exports only — mirrors the named-import shape in preload.ts.
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed.set(key, value);
    }),
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

// Some node/bun runtimes leave `globalThis.navigator` undefined; preload reads
// `navigator.userActivation` inside its bridge functions, so stub it first.
if (typeof globalThis.navigator !== "object" || globalThis.navigator === null) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
}
Object.defineProperty(globalThis.navigator, "userActivation", {
  configurable: true,
  value: mockUserActivation,
});

/**
 * Deep shape: primitives → their `typeof` (or `"null"`); objects → an object
 * mapping each sorted key to either its nested one-level sorted key list
 * (nested plain objects), `"array"`, or the leaf `typeof`.
 */
function deepShape(value: unknown): unknown {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return "array";
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === null) {
      out[key] = "null";
    } else if (Array.isArray(v)) {
      out[key] = "array";
    } else if (typeof v === "object") {
      out[key] = Object.keys(v as Record<string, unknown>).sort();
    } else {
      out[key] = typeof v;
    }
  }
  return out;
}

beforeAll(async () => {
  await import("../preload.js");
});

describe("preload contextBridge world shape lock", () => {
  it("attaches fresh click intent to an internal relaunch request", async () => {
    const api = exposed.get("aveApi") as AveApi;
    mockUserActivation.isActive = true;
    mockInvoke.mockResolvedValueOnce({ ok: true });
    await expect(api.relaunchApp()).resolves.toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenLastCalledWith("ave:app:relaunch", { intent: { inputOrigin: "user-keyboard", userActivation: true } });
    mockUserActivation.isActive = false;
    await api.relaunchApp();
    expect(mockInvoke).toHaveBeenLastCalledWith("ave:app:relaunch", { intent: { inputOrigin: "user-keyboard", userActivation: false } });
  });
  it("exposes alert Settings and tears down kind-change listeners without forwarding the event object", async () => {
    const alerts = (exposed.get("aveApi") as AveApi).alerts!;
    await alerts.listKinds();
    await alerts.removePredecessor("fixturemail:reply");
    expect(mockInvoke).toHaveBeenCalledWith(ALERTS.removePredecessor, "fixturemail:reply");
    await alerts.setKind("@host:due-soon", { enabled: true });
    await alerts.setOsNotificationsEnabled(false);
    await alerts.listOpen();
    expect(mockInvoke).toHaveBeenCalledWith(ALERTS.listKinds);
    expect(mockInvoke).toHaveBeenCalledWith(ALERTS.setKind, "@host:due-soon", { enabled: true });
    expect(mockInvoke).toHaveBeenCalledWith(ALERTS.setOsNotificationsEnabled, false);
    expect(mockInvoke).toHaveBeenCalledWith(ALERTS.listOpen);
    const handler = vi.fn();
    const dispose = alerts.onKindsChanged(handler);
    const listener = mockOn.mock.calls.findLast(([channel]) => channel === ALERTS.kindsChanged)![1];
    listener({ sender: "not forwarded" });
    expect(handler).toHaveBeenCalledWith();
    dispose();
    expect(mockRemoveListener).toHaveBeenCalledWith(ALERTS.kindsChanged, listener);
  });
  it("exposes the expected set of worlds", () => {
    expect([...exposed.keys()].sort()).toMatchInlineSnapshot(`
      [
        "__aveDevMode",
        "__aveInitialTheme",
        "ave",
        "aveApi",
        "aveDrop",
        "aveHost",
        "avePlatform",
        "aveWindow",
      ]
    `);
  });

  it("locks each exposed world's deep shape", () => {
    const worlds: Record<string, unknown> = {};
    for (const name of [...exposed.keys()].sort()) {
      worlds[name] = deepShape(exposed.get(name));
    }
    expect(worlds).toMatchInlineSnapshot(`
      {
        "__aveDevMode": "boolean",
        "__aveInitialTheme": "null",
        "ave": {
          "approval": [
            "listPending",
            "onRequest",
            "onSettled",
            "respond",
            "selectSentence",
          ],
          "attach": [
            "discardClipboardImage",
            "openExternal",
            "openFile",
            "readImage",
            "redeemDrop",
            "saveClipboardImage",
          ],
          "documentEngine": [
            "cancel",
            "install",
            "status",
            "uninstall",
          ],
          "env": [
            "debugStream",
            "enableDevConsole",
            "isDev",
            "isE2E",
          ],
          "mcp": [
            "addConfig",
            "attachResource",
            "attachResourceTemplate",
            "authenticate",
            "callTool",
            "disposeUiSession",
            "downloadFile",
            "getConfigPath",
            "getConfigs",
            "getPrompt",
            "kill",
            "listResourceTemplates",
            "listResources",
            "onServerDisconnected",
            "postUiMessage",
            "postUiModelContext",
            "readUiResource",
            "removeConfig",
            "servers",
            "setApiKey",
          ],
          "permission": [
            "addRule",
            "approveExtensionsWithoutIsolation",
            "auditShow",
            "auditVerify",
            "deferredList",
            "deferredResolve",
            "dirDispatch",
            "egressDenialsRecent",
            "egressGrantRevoke",
            "egressGrantsList",
            "getMode",
            "hookTrustList",
            "judgeGet",
            "judgeSet",
            "listRules",
            "listScopedRules",
            "onConfigChanged",
            "onDeferredPending",
            "onManifestViolation",
            "onModeChanged",
            "onReviewSuggestion",
            "onUserApprovalHit",
            "removeRule",
            "removeScopedRule",
            "reviewerDispatch",
            "sandboxCapability",
            "sandboxWindowsInstall",
            "sandboxWindowsStatus",
            "setMode",
            "upstreamProxyGet",
            "upstreamProxySet",
          ],
          "pluginConfig": [
            "get",
            "getSchema",
            "listSecretKeys",
            "set",
            "setSecret",
          ],
          "plugins": [
            "cards",
          ],
          "policy": [
            "get",
            "set",
          ],
          "preview": [
            "acknowledgeDocumentOpen",
            "acknowledgeObservation",
            "onAgentObservation",
            "onDocumentOpen",
            "onObservationPreview",
            "readDocument",
            "readFile",
            "requestObservationPreview",
          ],
          "ui": [
            "onDynamicMenuAction",
            "onNativeContextMenuAction",
            "showDynamicMenu",
            "showNativeContextMenu",
          ],
          "userApproval": [
            "list",
            "listSession",
            "record",
            "revokeByKey",
          ],
          "workspace": [
            "dropPrepare",
            "listDir",
            "listRoots",
            "pickRoot",
            "removeRoot",
            "reveal",
            "searchFiles",
          ],
        },
        "aveApi": {
          "acceptWorkProposal": "function",
          "acknowledgeRoutineResult": "function",
          "acpSubscriptionCancelLogin": "function",
          "acpSubscriptionChooseRuntime": "function",
          "acpSubscriptionForgetRuntime": "function",
          "acpSubscriptionLogout": "function",
          "acpSubscriptionOpenLoginBrowser": "function",
          "acpSubscriptionStartLogin": "function",
          "acpSubscriptionStatus": "function",
          "acpSubscriptionVerify": "function",
          "addRoutine": "function",
          "addWorkBoardItem": "function",
          "alerts": [
            "cardClosed",
            "listKinds",
            "listOpen",
            "onKindsChanged",
            "removePredecessor",
            "setKind",
            "setOsNotificationsEnabled",
          ],
          "applyClaudeDesktopMcpImport": "function",
          "approval": [
            "listPending",
            "onRequest",
            "onSettled",
            "respond",
            "selectSentence",
          ],
          "audit": [
            "getStats",
            "search",
          ],
          "awayAuthority": [
            "arm",
            "disarm",
            "status",
          ],
          "browserTabs": [
            "bindTab",
            "getSessionBindings",
            "getState",
            "onControl",
            "onSessionBindingsChanged",
            "onTabOp",
            "pause",
            "pausePopup",
            "resume",
            "resumePopup",
            "stop",
          ],
          "browserWorkspace": [
            "clearHistory",
            "find",
            "getState",
            "onChanged",
            "preview",
            "setBookmark",
            "setSitePermission",
            "stopFind",
            "zoom",
          ],
          "callPluginMethod": "function",
          "captureUserKeyboardIntent": "function",
          "chatAbort": "function",
          "chatBranchFromCheckpoint": "function",
          "chatCompact": "function",
          "chatContinueLastUser": "function",
          "chatControlShellTask": "function",
          "chatEditResend": "function",
          "chatEnterCheckpointView": "function",
          "chatExitCheckpointView": "function",
          "chatExport": "function",
          "chatFork": "function",
          "chatGetHistory": "function",
          "chatGetSubAgentTranscript": "function",
          "chatGetTurnReview": "function",
          "chatGetVerbatimToolResult": "function",
          "chatGetWriteDiff": "function",
          "chatGroup": "function",
          "chatGroupRelease": "function",
          "chatGuide": "function",
          "chatHasProvider": "function",
          "chatImport": "function",
          "chatListCustomCommands": "function",
          "chatListShellTasks": "function",
          "chatMainActiveState": "function",
          "chatNew": "function",
          "chatRetryEffort": "function",
          "chatRewindTo": "function",
          "chatSend": "function",
          "chatSessionDelete": "function",
          "chatSessionHistory": "function",
          "chatSessionResume": "function",
          "chatSessionUpdate": "function",
          "chatSessions": "function",
          "clearSessionGoal": "function",
          "clearSessionTasks": "function",
          "codexSubscriptionCancelLogin": "function",
          "codexSubscriptionListModels": "function",
          "codexSubscriptionLogout": "function",
          "codexSubscriptionStartBrowserLogin": "function",
          "codexSubscriptionStartDeviceCodeLogin": "function",
          "codexSubscriptionStatus": "function",
          "completeWorkBoardItem": "function",
          "deleteApiKey": "function",
          "deletePersonaPrompt": "function",
          "deleteWebApiKey": "function",
          "dev": [
            "getPreflightStatus",
            "setPreflightOverride",
          ],
          "diagnostics": [
            "crashList",
            "export",
          ],
          "dismissRoutine": "function",
          "dismissTrigger": "function",
          "dismissWorkProposal": "function",
          "dlp": [
            "getStats",
          ],
          "documentEngine": [
            "cancel",
            "install",
            "status",
            "uninstall",
          ],
          "downloadAppUpdate": "function",
          "e2ePluginBundleSnapshot": "function",
          "ensurePluginPartition": "function",
          "envForcedSettings": "function",
          "exportUsageCsv": "function",
          "generateWorkBoardReport": "function",
          "getAppInfo": "function",
          "getAppUpdateState": "function",
          "getBootstrapStatus": "function",
          "getModelCatalog": "function",
          "getPricingOverrides": "function",
          "getRuntimeCounts": "function",
          "getRuntimeEnv": "function",
          "getSessionGoal": "function",
          "getSettings": "function",
          "getUsageDailySummary": "function",
          "getUsageRange": "function",
          "getUsageSummary": "function",
          "getWorkBoardItem": "function",
          "getWorkBoardRunTranscript": "function",
          "gitMarketplace": [
            "acceptRewrite",
            "acknowledgeSource",
            "addSource",
            "applyUpdatesNow",
            "approveComponents",
            "bootInstallNotice",
            "checkUpdates",
            "deleteToken",
            "dismissBootInstallNotice",
            "executeInstall",
            "listCatalog",
            "listSources",
            "onBootInstallsApplied",
            "onCatalogChanged",
            "onDeepLink",
            "onInstallProgress",
            "onSyncProgress",
            "onUpdateStatus",
            "packageDetail",
            "pickFolder",
            "planInstall",
            "planUpdate",
            "previewDirectMcp",
            "previewSource",
            "refreshSources",
            "removeSource",
            "repairSource",
            "revealSource",
            "setSourceEnabled",
            "setToken",
            "takeDeepLink",
            "uninstall",
            "updateStatus",
          ],
          "gitRuntime": [
            "install",
            "onProgress",
            "status",
          ],
          "hasApiKey": "function",
          "hasWebApiKey": "function",
          "homeDocsApplyMerged": "function",
          "homeDocsApplyPackaged": "function",
          "homeDocsDiscardMerged": "function",
          "homeDocsGetCustom": "function",
          "homeDocsKeepMine": "function",
          "homeDocsMerge": "function",
          "homeDocsReadMarker": "function",
          "homeDocsStatus": "function",
          "homeDocsUpdateCustom": "function",
          "importTrigger": "function",
          "installAppUpdate": "function",
          "installLocalPlugin": "function",
          "installMarketplaceProviderPreset": "function",
          "installedContent": [
            "installed",
            "languageMessages",
          ],
          "listAgentProfiles": "function",
          "listLlmModels": "function",
          "listPendingAskUserQuestions": "function",
          "listPendingRoutineResults": "function",
          "listPersonaPromptSummaries": "function",
          "listPersonaPrompts": "function",
          "listPluginCards": "function",
          "listPluginContributionTrust": "function",
          "listPluginUiExtensions": "function",
          "listRoutineSessions": "function",
          "listRoutines": "function",
          "listSessionTasks": "function",
          "listSkills": "function",
          "listWorkBoard": "function",
          "listWorkProposals": "function",
          "logs": [
            "tail",
          ],
          "mcp": [
            "addConfig",
            "attachResource",
            "attachResourceTemplate",
            "authenticate",
            "callTool",
            "disposeUiSession",
            "downloadFile",
            "getConfigPath",
            "getConfigs",
            "getPrompt",
            "kill",
            "listResourceTemplates",
            "listResources",
            "onServerDisconnected",
            "postUiMessage",
            "postUiModelContext",
            "readUiResource",
            "removeConfig",
            "servers",
            "setApiKey",
          ],
          "memoryActivateCandidate": "function",
          "memoryDeleteCandidate": "function",
          "memoryDeleteEntry": "function",
          "memoryGetAgentsMd": "function",
          "memoryGetIndex": "function",
          "memoryGetUserPrefs": "function",
          "memoryListCandidates": "function",
          "memoryListEntries": "function",
          "memoryListSessions": "function",
          "memoryRefreshLongTerm": "function",
          "memoryRefreshUserPrefs": "function",
          "memorySaveEntry": "function",
          "memorySearchEntries": "function",
          "memorySearchSessions": "function",
          "memoryUpdateAgentsMd": "function",
          "memoryUpdateIndexIfUnchanged": "function",
          "memoryUpdateIndexSections": "function",
          "memoryUpdateUserPrefs": "function",
          "notifyClick": "function",
          "notifyPluginTheme": "function",
          "onAgentSpawnEvent": "function",
          "onAgentUninstallResult": "function",
          "onAppUpdateState": "function",
          "onAskUserQuestion": "function",
          "onAskUserQuestionTimeout": "function",
          "onBootstrapStatus": "function",
          "onChatFallback": "function",
          "onChatStream": "function",
          "onMarketplaceAnnouncements": "function",
          "onMarketplaceUpdatesAvailable": "function",
          "onNotificationClicked": "function",
          "onNotificationToast": "function",
          "onOverlayDismiss": "function",
          "onOverlayShow": "function",
          "onOverlayUpdate": "function",
          "onPersonaPromptsUpdated": "function",
          "onPluginEnabledChanged": "function",
          "onPluginEvent": "function",
          "onPluginInstallResult": "function",
          "onPluginRuntimeUpdated": "function",
          "onPluginUninstallResult": "function",
          "onRoutineFailed": "function",
          "onRoutineFired": "function",
          "onRoutineRunningFinished": "function",
          "onRoutineRunningStarted": "function",
          "onSessionGoalChanged": "function",
          "onSessionTasksChanged": "function",
          "onSettingsUpdated": "function",
          "onSkillLoaded": "function",
          "onSkillUninstallResult": "function",
          "onSubscriptionRuntimeStatusUpdated": "function",
          "onTriggerCompleted": "function",
          "onTriggerExpired": "function",
          "onTriggerFailed": "function",
          "onTriggerImported": "function",
          "onTriggerStarted": "function",
          "onViewActivate": "function",
          "onWorkBoardItemChanged": "function",
          "onWorkBoardRunFailed": "function",
          "onWorkBoardRunFinished": "function",
          "onWorkBoardRunProgress": "function",
          "onWorkBoardRunStarted": "function",
          "onWorkProposalChanged": "function",
          "onboarding": [
            "answer",
            "listPending",
          ],
          "openExternalUrl": "function",
          "pauseSessionGoal": "function",
          "permission": [
            "addRule",
            "approveExtensionsWithoutIsolation",
            "auditShow",
            "auditVerify",
            "deferredList",
            "deferredResolve",
            "dirDispatch",
            "egressDenialsRecent",
            "egressGrantRevoke",
            "egressGrantsList",
            "getMode",
            "hookTrustList",
            "judgeGet",
            "judgeSet",
            "listRules",
            "listScopedRules",
            "onConfigChanged",
            "onDeferredPending",
            "onManifestViolation",
            "onModeChanged",
            "onReviewSuggestion",
            "onUserApprovalHit",
            "removeRule",
            "removeScopedRule",
            "reviewerDispatch",
            "sandboxCapability",
            "sandboxWindowsInstall",
            "sandboxWindowsStatus",
            "setMode",
            "upstreamProxyGet",
            "upstreamProxySet",
          ],
          "pingAiProvider": "function",
          "pluginPreloadUrl": "string",
          "pluginShellUrl": "string",
          "pluginStudio": [
            "availableParts",
            "confirmConnectorCopy",
            "connectorCopyPreview",
            "exportDraft",
            "exportInstalled",
            "exportToCheckout",
            "importPackage",
            "installFromFile",
            "listDrafts",
            "previewInstallDraft",
            "previewInstallFromFile",
            "readDraft",
            "reviewDraft",
            "validateDraft",
            "writeDraft",
          ],
          "plugins": [
            "getPerfStats",
          ],
          "policy": [
            "get",
            "set",
          ],
          "previewClaudeDesktopMcpImport": "function",
          "readPluginUiModule": "function",
          "registerPluginWebview": "function",
          "relaunchApp": "function",
          "remoteA2a": [
            "action",
            "send",
            "status",
            "targets",
            "task",
            "tasks",
          ],
          "removeRoutine": "function",
          "removeWorkBoardItem": "function",
          "reopenWorkBoardItem": "function",
          "respondAskUserQuestion": "function",
          "resumeSessionGoal": "function",
          "retryBootstrap": "function",
          "runWorkBoardBriefing": "function",
          "runWorkBoardItem": "function",
          "savePersonaPrompt": "function",
          "setActiveSurface": "function",
          "setApiKey": "function",
          "setPluginContributionTrust": "function",
          "setPluginEnabled": "function",
          "setWebApiKey": "function",
          "sideChat": [
            "abort",
            "controlShellTask",
            "endPaneChat",
            "getSubAgentTranscript",
            "listShellTasks",
            "load",
            "new",
            "onFallback",
            "onStream",
            "paneHistory",
            "send",
          ],
          "skipAppUpdate": "function",
          "starredAdd": "function",
          "starredList": "function",
          "starredRemove": "function",
          "submitFeedback": "function",
          "subscriptionAcknowledgeNotice": "function",
          "subscriptionCancelLogin": "function",
          "subscriptionChooseRuntime": "function",
          "subscriptionForgetRuntime": "function",
          "subscriptionListModels": "function",
          "subscriptionLogout": "function",
          "subscriptionOpenLoginBrowser": "function",
          "subscriptionRuntimeStatus": "function",
          "subscriptionStartLogin": "function",
          "subscriptionUseApiForChat": "function",
          "subscriptionUseForChat": "function",
          "subscriptionVerifyRuntime": "function",
          "tailnetObserver": [
            "apply",
            "configureServe",
            "guidedSetup",
            "setOwnDeviceAdmission",
            "snapshot",
          ],
          "tailnetSharing": [
            "activatePairing",
            "createCurrentConversationShare",
            "createInvitation",
            "onChanged",
            "revokePairing",
            "revokeShare",
            "snapshot",
          ],
          "telegramConnection": [
            "approveCurrentConversation",
            "connect",
            "createPairingCode",
            "disconnect",
            "onChanged",
            "pause",
            "resume",
            "revokeApproval",
            "revokePairing",
            "snapshot",
          ],
          "telemetryAllowedHosts": "function",
          "terminal": [
            "getBlock",
            "input",
            "kill",
            "listBlocks",
            "listFileReviews",
            "onData",
            "onExit",
            "resize",
            "reviewFiles",
            "spawn",
          ],
          "tour": [
            "dismiss",
            "getState",
            "markComplete",
            "onStart",
            "start",
          ],
          "transitionWorkBoardItem": "function",
          "triggerRoutineNow": "function",
          "uninstallMarketplaceProviderPreset": "function",
          "updateSettings": "function",
          "updateWorkBoardItem": "function",
          "userApproval": [
            "list",
            "listSession",
            "record",
            "revokeByKey",
          ],
          "window": [
            "openHtmlPreview",
          ],
        },
        "aveDrop": {
          "prepareFileDrop": "function",
          "resolveDroppedPaths": "function",
        },
        "aveHost": {
          "takePluginMarketplaceApi": "function",
        },
        "avePlatform": {
          "isDarwin": "boolean",
        },
        "aveWindow": {
          "close": "function",
          "minimize": "function",
          "onFullscreenChanged": "function",
          "onMaximizedChanged": "function",
          "syncTitleBarTheme": "function",
          "toggleMaximize": "function",
        },
      }
    `);
  });
});

describe("floating dock preload world shape lock", () => {
  // The dock's own preload, not the host one: a persistent always-on-top window
  // gets only these, and its theme arrives from main (no plugin `getTheme`, whose
  // guard refuses a non-plugin frame).
  it("exposes only aveDock with the dock's API, and forwards each theme without the event object", async () => {
    const before = new Set(exposed.keys());
    // Main passes the asset URLs; the sandboxed preload cannot resolve files itself.
    const argv = process.argv;
    process.argv = [...argv, ...dockAssetArgs({ pluginShellUrl: "file:///app/plugin-ui-shell.html", pluginPreloadUrl: "file:///app/plugin-preload.cjs" })];
    try {
      await import("../floating-dock-preload.js");
    } finally {
      process.argv = argv;
    }
    const added = [...exposed.keys()].filter((key) => !before.has(key));
    expect(added).toEqual(["aveDock"]);
    const dock = exposed.get("aveDock") as Record<string, unknown> & { onTheme(handler: (theme: unknown) => void): () => void };
    exposed.delete("aveDock");
    expect(deepShape(dock)).toMatchInlineSnapshot(`
      {
        "ensurePartition": "function",
        "onActivity": "function",
        "onMount": "function",
        "onResize": "function",
        "onRetitle": "function",
        "onTheme": "function",
        "onUnmount": "function",
        "pluginPreloadUrl": "string",
        "pluginShellUrl": "string",
        "registerWebview": "function",
        "reportSlotGone": "function",
        "requestClose": "function",
      }
    `);

    expect(dock.pluginShellUrl).toBe("file:///app/plugin-ui-shell.html");
    expect(dock.pluginPreloadUrl).toBe("file:///app/plugin-preload.cjs");

    const handler = vi.fn();
    const dispose = dock.onTheme(handler);
    const listener = mockOn.mock.calls.findLast(([channel]) => channel === "ave:dock:theme")![1];
    const theme = { bundleId: "moonstone", shell: "light", tokens: { "--ave-bg": "#ffffff" } };
    listener({ sender: "not forwarded" }, theme);
    expect(handler).toHaveBeenCalledExactlyOnceWith(theme);
    dispose();
    expect(mockRemoveListener).toHaveBeenCalledWith("ave:dock:theme", listener);
  });
});
