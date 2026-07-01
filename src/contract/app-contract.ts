/**
 * app-contract.ts — the #1409 single source of truth for the app's public wire
 * contract (channel names + public allowlist + gesture classification + session
 * addressing rule).
 *
 * SECURITY-SENSITIVE + BEHAVIOR-PRESERVING: every string in this module is
 * BYTE-IDENTICAL to the channel literal it replaces at the handler / preload
 * call sites. The C0 snapshot tests (`channel-inventory`, `preload-shape`,
 * `domain-exports`) must stay green with zero snapshot changes.
 *
 * Channel-name SOT first; request/response payload types are added
 * incrementally (per-handler) in later commits. The streaming/event contract
 * lives in `./events.ts`.
 */

import {
  PERMISSIONS,
  MARKETPLACE,
  UI,
  ROUTINES_V2,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
  SUGGESTED_REPLIES,
} from "../shared/ipc-channels.js";

// Re-export the pre-existing per-domain SOT groups so `src/contract/` is the
// single import surface for the wire contract. The preload sweep (C11) and the
// external API/CLI/SDK surfaces will consume these from here.
export {
  PERMISSIONS,
  MARKETPLACE,
  UI,
  ROUTINES_V2,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
  SUGGESTED_REPLIES,
};

/**
 * Channel-name SOT, grouped by domain. Values are byte-identical to the literal
 * strings previously inlined in `src/ipc/domains/{chat,plugins,settings}.ts`.
 *
 * NOTE: groups whose channels already had a SOT const in
 * `src/shared/ipc-channels.ts` (permissions, work-board, routines, ui,
 * marketplace announcements, overlay, suggested-replies, settings.updated /
 * settings.applyHostMap) are re-exported above rather than duplicated here.
 */
export const CHANNELS = {
  chat: {
    hasProvider: "ave:chat:has-provider",
    send: "ave:chat:send",
    guide: "ave:chat:guide",
    abort: "ave:chat:abort",
    new: "ave:chat:new",
    sessions: "ave:chat:sessions",
    compact: "ave:chat:compact",
    sessionResume: "ave:chat:session-resume",
    getHistory: "ave:chat:get-history",
    mainActiveState: "ave:chat:main-active-state",
    sessionHistory: "ave:chat:session-history",
    editResend: "ave:chat:edit-resend",
    fork: "ave:chat:fork",
    continueLastUser: "ave:chat:continue-last-user",
    retryEffort: "ave:chat:retry-effort",
    export: "ave:chat:export",
    enterCheckpointView: "ave:chat:enter-checkpoint-view",
    exitCheckpointView: "ave:chat:exit-checkpoint-view",
    branchFromCheckpoint: "ave:chat:branch-from-checkpoint",
    getVerbatimToolResult: "ave:chat:get-verbatim-tool-result",
    getWriteDiff: "ave:chat:get-write-diff",
    // Streaming / event channels (main → renderer). Full event schema in ./events.ts.
    stream: "ave:chat:stream",
    fallback: "ave:chat:fallback",
  },
  llm: {
    ping: "ave:llm:ping",
  },
  memory: {
    entriesList: "ave:memory:entries:list",
    entriesSave: "ave:memory:entries:save",
    entriesDelete: "ave:memory:entries:delete",
    entriesSearch: "ave:memory:entries:search",
    indexGet: "ave:memory:index:get",
    indexUpdateIfUnchanged: "ave:memory:index:update-if-unchanged",
    indexSectionsUpdate: "ave:memory:index:sections:update",
    sessionsList: "ave:memory:sessions:list",
    sessionsSearch: "ave:memory:sessions:search",
    agentsMdGet: "ave:memory:agents-md:get",
    agentsMdUpdate: "ave:memory:agents-md:update",
    userPrefsGet: "ave:memory:user-prefs:get",
    userPrefsUpdate: "ave:memory:user-prefs:update",
    userPrefsRefresh: "ave:memory:user-prefs:refresh",
  },
  starred: {
    list: "ave:starred:list",
    add: "ave:starred:add",
    remove: "ave:starred:remove",
  },
  feedback: {
    submit: "ave:feedback:submit",
  },
  askUserQuestion: {
    respond: "ave:ask-user-question:respond",
  },
  plugins: {
    install: "ave:plugins:install",
    uninstall: "ave:plugins:uninstall",
    setEnabled: "ave:plugins:set-enabled",
    installLocal: "ave:plugins:install-local",
    uiList: "ave:plugins:ui:list",
    uiReadModule: "ave:plugins:ui:read-module",
    cards: "ave:plugins:cards",
    marketplaceList: "ave:plugins:marketplace:list",
    configGet: "ave:plugins:config:get",
    configSet: "ave:plugins:config:set",
    configSchemaGet: "ave:plugins:config:schema:get",
    configSecretSet: "ave:plugins:config:secret:set",
    configSecretListKeys: "ave:plugins:config:secret:list-keys",
    perfStats: "ave:plugins:perf-stats",
    call: "ave:plugins:call",
    // Lifecycle event channels (main → renderer). Not registered via ipcMain.
    installProgress: "ave:plugins:install-progress",
    installResult: "ave:plugins:install-result",
    uninstallResult: "ave:plugins:uninstall-result",
    enabledChanged: "ave:plugins:enabled-changed",
  },
  bootstrap: {
    retry: "ave:bootstrap:retry",
  },
  runtime: {
    counts: "ave:runtime:counts",
    env: "ave:runtime:env",
  },
  marketplace: {
    ping: "ave:marketplace:ping",
  },
  agents: {
    list: "ave:agents:list",
    install: "ave:agents:install",
    uninstall: "ave:agents:uninstall",
    // Lifecycle event channels (main → renderer).
    installProgress: "ave:agents:install-progress",
    installResult: "ave:agents:install-result",
    uninstallResult: "ave:agents:uninstall-result",
  },
  skills: {
    list: "ave:skills:list",
    install: "ave:skills:install",
    uninstall: "ave:skills:uninstall",
    // Lifecycle event channels (main → renderer).
    installProgress: "ave:skills:install-progress",
    installResult: "ave:skills:install-result",
    uninstallResult: "ave:skills:uninstall-result",
  },
  mcp: {
    servers: "ave:mcp:servers",
    kill: "ave:mcp:kill",
    configGet: "ave:mcp:config:get",
    configPath: "ave:mcp:config:path",
    configAdd: "ave:mcp:config:add",
    configSetApiKey: "ave:mcp:config:set-api-key",
    configRemove: "ave:mcp:config:remove",
    uiResource: "ave:mcp:ui-resource",
    catalogList: "ave:mcp:catalog:list",
    installFromMarketplace: "ave:mcp:install-from-marketplace",
    importClaudeDesktopPreview: "ave:mcp:import:claude-desktop:preview",
    importClaudeDesktopApply: "ave:mcp:import:claude-desktop:apply",
  },
  /** Plugin webview bridge (ave:plugin:*) — sandboxed plugin-frame origin. */
  pluginBridge: {
    registerWebview: "ave:plugin:register-webview",
    getEntryUrl: "ave:plugin:get-entry-url",
    getTheme: "ave:plugin:get-theme",
    callTool: "ave:plugin:call-tool",
    configGet: "ave:plugin:config:get",
    configSet: "ave:plugin:config:set",
    storageGet: "ave:plugin:storage:get",
    storageSet: "ave:plugin:storage:set",
    emitEvent: "ave:plugin:emit-event",
    // Fan-out to plugin webviews (main → plugin frame).
    event: "ave:plugin:event",
  },
  host: {
    pluginThemeNotify: "ave:host:plugin-theme-notify",
  },
  notification: {
    clicked: "ave:notification:clicked",
  },
  settings: {
    get: "ave:settings:get",
    update: "ave:settings:update",
    setApiKey: "ave:settings:set-api-key",
    hasApiKey: "ave:settings:has-api-key",
    deleteApiKey: "ave:settings:delete-api-key",
    marketplaceSetApiKey: "ave:settings:marketplace:set-api-key",
    marketplaceHasApiKey: "ave:settings:marketplace:has-api-key",
    marketplaceDeleteApiKey: "ave:settings:marketplace:delete-api-key",
    setWebApiKey: "ave:settings:set-web-api-key",
    hasWebApiKey: "ave:settings:has-web-api-key",
    deleteWebApiKey: "ave:settings:delete-web-api-key",
  },
  shell: {
    openExternal: "ave:shell:open-external",
  },
  telemetry: {
    consentAnswer: "ave:telemetry:consent-answer",
  },
  usage: {
    summary: "ave:usage:summary",
    range: "ave:usage:range",
    exportCsv: "ave:usage:export-csv",
  },
} as const;

type ValuesOf<T> = T[keyof T];

/** Every channel name defined on {@link CHANNELS} (union of all group values). */
export type ChannelName = ValuesOf<{
  [Group in keyof typeof CHANNELS]: ValuesOf<(typeof CHANNELS)[Group]>;
}>;

// ─── Versioned public contract ──────────────────────────────────────────────

/**
 * Wire-contract version. Bump when the public surface (PUBLIC_CHANNELS, gesture
 * classification, or a public channel's payload shape) changes in a way an
 * external SDK/CLI must react to. Read-first callers pin this.
 */
export const CONTRACT_VERSION = "1.0.0";

/**
 * The versioned allowlist of channels an external surface (SDK / CLI / local
 * API) MAY touch. Deliberately a small, mostly-read subset:
 *   - chat send + session list/history/get-history (renderer-parity reads + send)
 *   - plugin status/list + marketplace list
 *   - permission mode (READ only — mutation stays internal + gesture-gated)
 *   - usage summary/range
 *
 * Fail-closed: anything NOT in this list is internal. The gesture-gated
 * mutating channels (permission/policy/sandbox-install) MUST never appear here
 * — enforced by the contract-version-freeze test.
 */
export const PUBLIC_CHANNELS = [
  CHANNELS.chat.send,
  CHANNELS.chat.sessions,
  CHANNELS.chat.getHistory,
  CHANNELS.chat.sessionHistory,
  CHANNELS.plugins.cards,
  CHANNELS.plugins.marketplaceList,
  PERMISSIONS.getMode,
  CHANNELS.usage.summary,
  CHANNELS.usage.range,
] as const;

/** A channel that is part of the externally-exposable public subset. */
export type PublicChannel = (typeof PUBLIC_CHANNELS)[number];

/** Is this channel in the externally-exposable public subset? (fail-closed) */
export function isPublicChannel(channel: string): channel is PublicChannel {
  return (PUBLIC_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Gesture requirement per channel. `"required"` ⇒ the mutating
 * permission/policy/sandbox-install family that demands a fresh user-keyboard
 * gesture REGARDLESS of origin (see {@link ./trust-origin}). `"none"` ⇒ reads
 * (and chat send) that do not consume the gesture token.
 *
 * Public channels are all classified `"none"`. The `"required"` entries are the
 * internal mutating channels — they are listed here so the freeze test can
 * assert none of them ever leaks into {@link PUBLIC_CHANNELS}.
 */
export const CHANNEL_GESTURE: Record<string, "required" | "none"> = {
  // ── public subset (reads + chat send) — gesture: none ──
  [CHANNELS.chat.send]: "none",
  [CHANNELS.chat.sessions]: "none",
  [CHANNELS.chat.getHistory]: "none",
  [CHANNELS.chat.sessionHistory]: "none",
  [CHANNELS.plugins.cards]: "none",
  [CHANNELS.plugins.marketplaceList]: "none",
  [PERMISSIONS.getMode]: "none",
  [CHANNELS.usage.summary]: "none",
  [CHANNELS.usage.range]: "none",
  // ── mutating gesture-gated (permission / policy / sandbox-install) ──
  [PERMISSIONS.setMode]: "required",
  [PERMISSIONS.addRule]: "required",
  [PERMISSIONS.removeRule]: "required",
  [PERMISSIONS.policySet]: "required",
  [PERMISSIONS.dirDispatch]: "required",
  [PERMISSIONS.reviewerDispatch]: "required",
  [PERMISSIONS.deferredResolve]: "required",
  [PERMISSIONS.userApprovalRecord]: "required",
  [PERMISSIONS.userApprovalRevoke]: "required",
  [PERMISSIONS.sandboxWindowsInstall]: "required",
};

// ─── Session addressing contract ────────────────────────────────────────────

/**
 * Session-scoped channels: their leading `sessionId` argument MUST match the
 * currently-active conversation session. The handler NEVER silently retargets
 * to the active session when they diverge — it fails closed and returns
 * {@link SESSION_NOT_ADDRESSABLE}. This prevents a stale/foreign `sessionId`
 * (e.g. from a background renderer, a plugin, or an external caller) from
 * mutating or reading the wrong session.
 *
 * The C10 handlers adopt {@link SESSION_NOT_ADDRESSABLE} as the canonical
 * return code; today the handlers return per-site codes ("session-mismatch",
 * bare `null`) — behavior is unchanged in this commit, the constant is defined
 * for C10 to consume.
 */
export const SESSION_SCOPED_CHANNELS = [
  CHANNELS.chat.getHistory,
  CHANNELS.chat.sessionHistory,
  CHANNELS.chat.enterCheckpointView,
  CHANNELS.chat.branchFromCheckpoint,
  CHANNELS.chat.continueLastUser,
] as const;

/**
 * Canonical fail-closed error returned by session-scoped handlers when the
 * requested `sessionId` is not the active session (never silently retargeted).
 */
export const SESSION_NOT_ADDRESSABLE = "session-not-active";
