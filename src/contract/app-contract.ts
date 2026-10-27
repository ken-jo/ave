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
  ROUTINES,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
  ALERTS,
} from "../shared/ipc-channels.js";

// Re-export the pre-existing per-domain SOT groups so `src/contract/` is the
// single import surface for the wire contract. The preload surfaces and the
// external API/CLI/SDK surfaces consume these from here.
export {
  PERMISSIONS,
  MARKETPLACE,
  UI,
  ROUTINES,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
  ALERTS,
};

/**
 * Channel-name SOT, grouped by domain. Values are byte-identical to the literal
 * strings previously inlined in `src/ipc/domains/{chat,plugins,settings}.ts`.
 *
 * NOTE: groups whose channels already had a SOT const in
 * `src/shared/ipc-channels.ts` (permissions, work-board, routines, ui,
 * marketplace announcements, overlay, suggested-replies, settings.updated)
 * are re-exported above rather than duplicated here.
 */
/**
 * Tiled chat groups — the main area can show more than one conversation.
 *
 * The id travels on every `ave:chat:*` call, so it belongs to the contract
 * rather than to either side of it. A conversation is one ConversationLoop in
 * main, so a group id names a LOOP, not a view: two tiles showing the same
 * group would be two views of one conversation, which is not what a split is.
 */
export const MAIN_CHAT_GROUP_ID = "main";

/**
 * How many conversations may be tiled at once.
 *
 * Capped because each one is a live agent loop: an uncapped split would let the
 * window run more background work than the user can watch, and four is the
 * point past which a tile is too narrow to read a transcript in.
 */
export const MAX_CHAT_GROUPS = 4;

/**
 * How many panes the main area may be split into.
 *
 * The same number as {@link MAX_CHAT_GROUPS}, and deliberately a SEPARATE fact:
 * this one is about the canvas, not about loops. A pane's frame has a 448x280
 * floor, and four is where a full window stops affording another split. A pane
 * does not have to hold a conversation — a feature panel, a plugin view and
 * Settings are all pane contents — so counting panes against the conversation
 * ceiling would charge an empty split for a loop it never opened, and counting
 * conversations against the pane ceiling would let a window run more loops than
 * it has tiles to show them in.
 */
export const MAX_PANES = 4;

export const CHANNELS = {
  chat: {
    hasProvider: "ave:chat:has-provider",
    listCustomCommands: "ave:chat:list-custom-commands",
    send: "ave:chat:send",
    guide: "ave:chat:guide",
    abort: "ave:chat:abort",
    // Host-renderer-only lifecycle controls, scoped to the preload-bound conversation.
    listShellTasks: "ave:chat:list-shell-tasks",
    controlShellTask: "ave:chat:control-shell-task",
    new: "ave:chat:new",
    sessions: "ave:chat:sessions",
    compact: "ave:chat:compact",
    sessionResume: "ave:chat:session-resume",
    getHistory: "ave:chat:get-history",
    mainActiveState: "ave:chat:main-active-state",
    sessionHistory: "ave:chat:session-history",
    editResend: "ave:chat:edit-resend",
    // Rewind the conversation to just before one of its own user messages and
    // stop there — no replay. Distinct from `editResend` (rewind THEN resend)
    // and from `fork` (branch into a NEW session): this discards everything
    // from that message onward in the SAME session so the user can retype the
    // input. INTERNAL (mutating; destructive by intent).
    rewindTo: "ave:chat:rewind-to",
    getTurnReview: "ave:chat:get-turn-review",
    fork: "ave:chat:fork",
    continueLastUser: "ave:chat:continue-last-user",
    retryEffort: "ave:chat:retry-effort",
    export: "ave:chat:export",
    // Reverse of `export` — always creates a brand-new session,
    // never overwrites. INTERNAL (mutating; not in PUBLIC_CHANNELS below).
    import: "ave:chat:import",
    // Row-level conversation edits. INTERNAL (mutating) — the renderer may set
    // ONLY the three fields these name, never arbitrary session metadata.
    sessionUpdate: "ave:chat:session-update",
    sessionDelete: "ave:chat:session-delete",
    enterCheckpointView: "ave:chat:enter-checkpoint-view",
    exitCheckpointView: "ave:chat:exit-checkpoint-view",
    branchFromCheckpoint: "ave:chat:branch-from-checkpoint",
    // A closed tile lets go of its conversation. INTERNAL (mutating).
    groupRelease: "ave:chat:group-release",
    getVerbatimToolResult: "ave:chat:get-verbatim-tool-result",
    getSubAgentTranscript: "ave:chat:get-sub-agent-transcript",
    getWriteDiff: "ave:chat:get-write-diff",
    // Streaming / event channels (main → renderer). Full event schema in ./events.ts.
    stream: "ave:chat:stream",
    fallback: "ave:chat:fallback",
  },
  llm: {
    ping: "ave:llm:ping",
    // The model catalog the main process resolves against, handed to the
    // renderer before it mounts so both sides resolve against the same one.
    getModelCatalog: "ave:llm:get-model-catalog",
  },
  memory: {
    entriesList: "ave:memory:entries:list",
    entriesSave: "ave:memory:entries:save",
    entriesDelete: "ave:memory:entries:delete",
    candidatesList: "ave:memory:candidates:list",
    candidateActivate: "ave:memory:candidates:activate",
    candidateDelete: "ave:memory:candidates:delete",
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
    longTermRefresh: "ave:memory:long-term:refresh",
  },
  /**
   * The `~/.ave` reference docs as a surface rather than a boot log line.
   *
   * Separate from `memory` because the subject is the FILES and their pending
   * packaged updates, not the context the prompt reads: skills and prompts get
   * upgrade markers too, and folding them into a channel named for agent
   * context would make which doc owns a marker a matter of naming.
   */
  homeDocs: {
    upgradeMarkersList: "ave:home-docs:upgrade-markers:list",
    markerRead: "ave:home-docs:marker:read",
    packagedApply: "ave:home-docs:packaged:apply",
    markerKeepMine: "ave:home-docs:marker:keep-mine",
    customGet: "ave:home-docs:custom:get",
    customUpdate: "ave:home-docs:custom:update",
    mergeRun: "ave:home-docs:merge:run",
    mergeApply: "ave:home-docs:merge:apply",
    mergeDiscard: "ave:home-docs:merge:discard",
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
    // The questions still waiting, read by a renderer that (re)loaded after
    // they were sent — e.g. a window opened after the one that drew them closed.
    pending: "ave:ask-user-question:pending",
    // Request + timeout events (main → renderer).
    request: "ave:ask-user-question:request",
    timeout: "ave:ask-user-question:timeout",
  },
  plugins: {
    uninstall: "ave:plugins:uninstall",
    setEnabled: "ave:plugins:set-enabled",
    installLocal: "ave:plugins:install-local",
    uiList: "ave:plugins:ui:list",
    uiReadModule: "ave:plugins:ui:read-module",
    cards: "ave:plugins:cards",
    configGet: "ave:plugins:config:get",
    configSet: "ave:plugins:config:set",
    configSchemaGet: "ave:plugins:config:schema:get",
    configSecretSet: "ave:plugins:config:secret:set",
    configSecretListKeys: "ave:plugins:config:secret:list-keys",
    perfStats: "ave:plugins:perf-stats",
    call: "ave:plugins:call",
    contributionTrustList: "ave:plugins:contribution-trust:list",
    contributionTrustSet: "ave:plugins:contribution-trust:set",
    /** Trusted-renderer, AVE_E2E-only bundle generation observation. */
    e2eBundleSnapshot: "ave:plugins:e2e:bundle-snapshot",
    // Lifecycle event channels (main → renderer). Not registered via ipcMain.
    installResult: "ave:plugins:install-result",
    uninstallResult: "ave:plugins:uninstall-result",
    enabledChanged: "ave:plugins:enabled-changed",
    runtimeUpdated: "ave:plugins:runtime-updated",
  },
  bootstrap: {
    retry: "ave:bootstrap:retry",
    // Lifecycle status event (main → renderer).
    status: "ave:bootstrap:status",
    // Late-mount sync for the status event above. The managed bootstrap runs
    // to completion before the renderer is loaded on a cold boot, so those
    // events reach a webContents with no listener; the renderer pulls the
    // recorded snapshot on connect.
    statusGet: "ave:bootstrap:status:get",
  },
  runtime: {
    counts: "ave:runtime:counts",
    env: "ave:runtime:env",
  },
  remoteA2a: {
    targets: "ave:a2a-remote:targets",
    send: "ave:a2a-remote:send",
    status: "ave:a2a-remote:status",
    task: "ave:a2a-remote:task",
    tasks: "ave:a2a-remote:tasks",
    action: "ave:a2a-remote:action",
  },
  // Local-owner-only Tailnet pairing/share administration. These are INTERNAL:
  // never add them to PUBLIC_CHANNELS or EXTERNAL_MUTATION_CHANNELS. A pairing
  // invite is not access, and every mutation requires a fresh local keyboard
  // intent in addition to the host-renderer sender guard.
  tailnetSharing: {
    snapshot: "ave:tailnet-sharing:snapshot",
    createInvitation: "ave:tailnet-sharing:create-invitation",
    activatePairing: "ave:tailnet-sharing:activate-pairing",
    createCurrentConversationShare: "ave:tailnet-sharing:create-current-conversation-share",
    revokeShare: "ave:tailnet-sharing:revoke-share",
    revokePairing: "ave:tailnet-sharing:revoke-pairing",
    // Main → renderer only. Carries no data; consumers pull a fresh safe snapshot.
    changed: "ave:tailnet-sharing:changed",
  },
  // Local-owner-only Tailnet observer configuration. INTERNAL for the same
  // reasons as tailnetSharing: `apply` decides whether a listener comes up at
  // all, which capability key authorizes it, and whether remote control and the
  // web surface are in scope. The renderer proposes and the host persists —
  // never to the settings store, which a webpage can reach.
  tailnetObserver: {
    snapshot: "ave:tailnet-observer:snapshot",
    apply: "ave:tailnet-observer:apply",
    // Runs `tailscale serve` on the owner's behalf, after the surface has shown
    // the exact command. Executing a binary for someone is a capability of its
    // own, so it is gated like `apply` and never inferred from a snapshot read.
    configureServe: "ave:tailnet-observer:configure-serve",
    // Writes the whole recommended configuration and runs Serve in one step.
    // It is `apply` plus `configureServe` with the host choosing the answers,
    // so it carries exactly their gate — never a weaker one for being one press.
    guidedSetup: "ave:tailnet-observer:guided-setup",
    // Decides whether this desktop's own Tailscale account skips the approval
    // click. The payload is one boolean: the account it applies to is the one
    // the host's own probe reports, never a login a renderer names.
    setOwnDeviceAdmission: "ave:tailnet-observer:set-own-device-admission",
  },
  // Local-owner-only Telegram private-DM connection administration. These are
  // INTERNAL for the same reasons as tailnetSharing, and additionally because
  // Telegram is an external cloud recipient: connecting is an egress decision
  // the local owner makes at the keyboard, never something a caller can drive.
  telegramConnection: {
    snapshot: "ave:telegram-connection:snapshot",
    connect: "ave:telegram-connection:connect",
    disconnect: "ave:telegram-connection:disconnect",
    pause: "ave:telegram-connection:pause",
    resume: "ave:telegram-connection:resume",
    createPairingCode: "ave:telegram-connection:create-pairing-code",
    revokePairing: "ave:telegram-connection:revoke-pairing",
    approveCurrentConversation: "ave:telegram-connection:approve-current-conversation",
    revokeApproval: "ave:telegram-connection:revoke-approval",
    // Main → renderer only. Carries no data; consumers pull a fresh safe snapshot.
    changed: "ave:telegram-connection:changed",
  },
  // Local-owner-only arming of the desk-armed away answerer. INTERNAL for the
  // same reasons as the two above, and additionally because arming is the one
  // gesture that lets an approval be answered while nobody is watching: it is a
  // decision the owner makes at this keyboard, in advance, and nothing reachable
  // from a message may create, extend, or widen it.
  awayAuthority: {
    status: "ave:away-authority:status",
    arm: "ave:away-authority:arm",
    disarm: "ave:away-authority:disarm",
  },
  marketplace: {
    /** Legacy main-to-renderer update notification; kept byte-identical on wire. */
    updatesAvailable: "marketplace:updates-available",
  },
  // Git runtime of the git marketplace (design §9, §13). Host-renderer only;
  // installing downloads and runs a binary, so it needs a live keyboard gesture.
  gitRuntime: {
    status: "ave:git:runtime:status",
    install: "ave:git:runtime:install",
    progress: "git-runtime:progress", // event main→renderer (GitRuntimeProgress)
  },
  // The git marketplace (design §13): sources, catalog, install plans and
  // execution. Host-renderer only; every answer is a GitMarketplaceResult.
  gitMarketplace: {
    sourcesList: "ave:marketplace:sources:list",
    sourcesPreview: "ave:marketplace:sources:preview",
    sourcesAdd: "ave:marketplace:sources:add",
    sourcesAcknowledge: "ave:marketplace:sources:acknowledge",
    sourcesPickFolder: "ave:marketplace:sources:pick-folder",
    sourcesReveal: "ave:marketplace:sources:reveal",
    sourcesRemove: "ave:marketplace:sources:remove",
    sourcesSetEnabled: "ave:marketplace:sources:set-enabled",
    sourcesRefresh: "ave:marketplace:sources:refresh",
    sourcesAcceptRewrite: "ave:marketplace:sources:accept-rewrite",
    sourcesSetToken: "ave:marketplace:sources:set-token",
    sourcesDeleteToken: "ave:marketplace:sources:delete-token",
    catalogList: "ave:marketplace:catalog:list",
    packageDetail: "ave:marketplace:package:detail",
    installPlan: "ave:marketplace:install:plan",
    installExecute: "ave:marketplace:install:execute",
    updatePlan: "ave:marketplace:update:plan",
    uninstall: "ave:marketplace:uninstall",
    directPreview: "ave:marketplace:direct:preview",
    deepLinkTake: "ave:marketplace:deep-link:take",
    bootInstallsNotice: "ave:marketplace:boot-installs:notice",
    bootInstallsDismiss: "ave:marketplace:boot-installs:dismiss",
    updatesStatus: "ave:marketplace:updates:status",
    updatesCheck: "ave:marketplace:updates:check",
    updatesApplyNow: "ave:marketplace:updates:apply-now",
    componentsApprove: "ave:marketplace:components:approve",
    syncProgress: "marketplace:sync-progress", // event main→renderer (SyncProgressView)
    catalogChanged: "marketplace:catalog-changed", // event main→renderer
    installProgress: "marketplace:install-progress", // event main→renderer (InstallProgressView)
    deepLink: "marketplace:deep-link", // event main→renderer: a deep link waits in deepLinkTake
    bootInstallsApplied: "marketplace:boot-installs-applied", // event main→renderer: a notice waits in bootInstallsNotice
    updateStatusChanged: "marketplace:update-status", // event main→renderer (UpdateStatusView)
  },
  pluginStudio: {
    availableParts: "ave:plugin-studio:parts:list",
    listDrafts: "ave:plugin-studio:drafts:list",
    readDraft: "ave:plugin-studio:drafts:read",
    writeDraft: "ave:plugin-studio:drafts:write",
    validateDraft: "ave:plugin-studio:drafts:validate",
    connectorCopyPreview: "ave:plugin-studio:connector-copy:preview",
    confirmConnectorCopy: "ave:plugin-studio:connector-copy:confirm",
    importPackage: "ave:plugin-studio:import",
    reviewDraft: "ave:plugin-studio:drafts:review",
    exportDraft: "ave:plugin-studio:export",
    exportInstalled: "ave:plugin-studio:installed:export",
    exportToCheckout: "ave:plugin-studio:checkout:write",
    previewInstallFromFile: "ave:plugin-studio:file:preview",
    previewInstallDraft: "ave:plugin-studio:drafts:install-preview",
    installFromFile: "ave:plugin-studio:file:install",
  },
  // Installed content packages of the git marketplace (blueprint P3): what the
  // settings pickers list and the catalogs of installed languages. Host-renderer only.
  marketplaceContent: {
    installed: "ave:marketplace:content:installed",
    languageMessages: "ave:marketplace:content:language-messages",
  },
  agents: {
    list: "ave:agents:list",
    uninstall: "ave:agents:uninstall",
    // Lifecycle event channel (main → renderer).
    uninstallResult: "ave:agents:uninstall-result",
  },
  skills: {
    list: "ave:skills:list",
    uninstall: "ave:skills:uninstall",
    // Lifecycle event channel (main → renderer).
    uninstallResult: "ave:skills:uninstall-result",
  },
  mcp: {
    servers: "ave:mcp:servers",
    kill: "ave:mcp:kill",
    authenticate: "ave:mcp:authenticate",
    configGet: "ave:mcp:config:get",
    configPath: "ave:mcp:config:path",
    configAdd: "ave:mcp:config:add",
    configSetApiKey: "ave:mcp:config:set-api-key",
    configRemove: "ave:mcp:config:remove",
    uiResource: "ave:mcp:ui-resource",
    // MCP Apps `oncalltool` — an app calls a tool on ITS OWN server (the renderer
    // supplies the card's serverId; the app never names one). INTERNAL, same posture
    // as the MCP-app channels below: absent from PUBLIC_CHANNELS /
    // EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE, so no external origin can reach
    // it (fail-closed isPublicChannel). Registered in ipc/domains/plugins.ts and
    // gated on validateHostRendererSender (state-mutating: it runs a tool). The call
    // itself is NOT authorized by the channel — it runs the same risk/consent gate as
    // any host tool call.
    callTool: "ave:mcp:call-tool",
    // MCP Apps `onmessage` (`ui/message`) — the app asks for its text to enter the
    // conversation, or (with `_meta["ave/notification"]`) the notification surface.
    // The renderer binds the card's `serverId` AND its origin session id; the app
    // supplies neither. INTERNAL, same posture as `callTool`: absent from
    // PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed
    // isPublicChannel). Registered in ipc/domains/plugins.ts and gated on
    // validateHostRendererSender — it mutates conversation state (queues guidance /
    // stages a user-gated card) and fires OS notifications.
    uiMessage: "ave:mcp:ui-message",
    // MCP server prompt (`prompts/get`) — the USER picked a prompt the server
    // declared, and the host fetches its messages and returns them wrapped in the
    // `<mcp-prompt source="mcp-prompt:<serverId>">` provenance envelope. The
    // renderer then sends that envelope through the ordinary `chat:send` path
    // under the `mcp-prompt-emitted` origin, so nothing here starts a turn.
    // INTERNAL, same posture as `callTool` / `uiMessage`: absent from
    // PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed
    // isPublicChannel). Registered in ipc/domains/plugins.ts and gated on
    // validateHostRendererSender — it reaches out to a server on the user's behalf.
    getPrompt: "ave:mcp:get-prompt",
    // INTERNAL, same posture as `getPrompt`: the renderer asks the host to read a
    // DECLARED resource and hand back the fenced block the user attaches to their own
    // turn. The host builds the fence, never the renderer — that is what keeps the
    // untrusted framing on server text that lands beside the user's words.
    attachResource: "ave:mcp:attach-resource",
    // The catalogue the composer's `@` mention picker offers, read from
    // `McpManager.listDeclaredResources()`.
    //
    // Why a channel rather than deriving it in the renderer from `mcp:servers`: that
    // payload carries configs, errors and transport state the picker has no business
    // seeing, and a renderer-side filter would be a second place that decides which
    // servers count. The narrow surface is the whole reason — this channel returns
    // exactly `{serverId, resources[]}` and nothing else.
    //
    // It does NOT filter for attachability, and an earlier version of this comment
    // claimed it did. `listDeclaredResources` answers "what did the host catalogue",
    // which is what the model-facing tool wants; a row the host will refuse to fetch
    // (`hostFetchRefused`, the spec's client-fetched `https:` case) is still listed and
    // is disabled by the PICKER, which answers the different question "what can be
    // attached right now".
    listResources: "ave:mcp:list-resources",
    // The URI TEMPLATES half of that catalogue, from
    // `McpManager.listDeclaredResourceTemplates()`.
    //
    // A sibling channel rather than another field on `listResources` for the reason the
    // two projections are separate in the manager: a template's identity is its
    // `uriTemplate` and a resource's is its `uri`, so one payload carrying both would
    // make every consumer discriminate before it could validate an entry — and the
    // picker is not the only consumer this surface will ever have.
    listResourceTemplates: "ave:mcp:list-resource-templates",
    // INTERNAL, same posture as `attachResource`, and the reason it is a SEPARATE
    // channel: the renderer sends the TEMPLATE plus the user's values, never a URI.
    // Main matches the template against what the client listed and expands it there.
    // Accepting a URI here instead would mean matching an arbitrary URI back against a
    // pattern, and a matcher for `file:///{path}` accepts `file:///../../etc/passwd`.
    attachResourceTemplate: "ave:mcp:attach-resource-template",
    // MCP Apps `ondownloadfile` (`ui/download-file`) — the app hands over INLINE bytes it
    // already possessed and asks the host to save them. The host never fetches an
    // app-supplied URI (a `resource_link` is rejected at parse time), so this channel
    // grants no egress; the user's own save dialog is the authorization for the write.
    // INTERNAL, same posture as `callTool` / `uiMessage`: absent from PUBLIC_CHANNELS /
    // EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed isPublicChannel).
    // Registered in ipc/domains/plugins.ts and gated on validateHostRendererSender —
    // state-mutating (it writes a file the user picked).
    uiDownloadFile: "ave:mcp:ui-download-file",
    // MCP Apps `onupdatemodelcontext` (`ui/update-model-context`) — the app OVERWRITES the
    // context slot the model will see on the NEXT turn. It can never start one (the store
    // has no reference to the conversation loop), and the body is carried as untrusted
    // DATA. The renderer binds serverId + sessionId + cardId; the app supplies none.
    // INTERNAL, same posture as `callTool` / `uiMessage`: absent from PUBLIC_CHANNELS /
    // EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed isPublicChannel).
    // Registered in ipc/domains/plugins.ts and gated on validateHostRendererSender — it
    // mutates what the model reads next turn.
    uiModelContext: "ave:mcp:ui-model-context",
    importClaudeDesktopPreview: "ave:mcp:import:claude-desktop:preview",
    importClaudeDesktopApply: "ave:mcp:import:claude-desktop:apply",
    // #885 b3 — INTERNAL: absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
    // EXTERNAL_MUTATION_CHANNELS, so an external origin (local-api / cli / plugin
    // frame) can never reach it (fail-closed isPublicChannel). A pure main→renderer
    // event (no ipcMain.handle; the renderer validates the payload shape).
    serverDisconnected: "ave:mcp:server-disconnected",
    // Renderer → main on card unmount: dispose the sandbox-proxy session so its token
    // is freed promptly instead of waiting for the global LRU to evict it. INTERNAL,
    // same posture as the three above. Idempotent and harmless — worst case a stale
    // token 404s a dead card's reload.
    disposeUiSession: "ave:mcp:dispose-ui-session",
  },
  /** Plugin webview bridge (ave:plugin:*) — sandboxed plugin-frame origin. */
  pluginBridge: {
    // Renderer → main BEFORE a plugin panel's <webview> exists: install the
    // partition's session policy (preload, network gate, asset scheme) so the
    // guest frame is never the thing that creates the partition. A frame binds
    // its URL loaders once, at first load, so a scheme installed after that
    // point is unreachable from it for the frame's whole life.
    ensurePartition: "ave:plugin:ensure-partition",
    registerWebview: "ave:plugin:register-webview",
    getEntryUrl: "ave:plugin:get-entry-url",
    getTheme: "ave:plugin:get-theme",
    callTool: "ave:plugin:call-tool",
    requestOperationGrant: "ave:plugin:request-operation-grant",
    configGet: "ave:plugin:config:get",
    configSet: "ave:plugin:config:set",
    storageGet: "ave:plugin:storage:get",
    storageSet: "ave:plugin:storage:set",
    emitEvent: "ave:plugin:emit-event",
    // Fan-out to plugin webviews (main → plugin frame).
    event: "ave:plugin:event",
  },
  /**
   * Floating dock (ave:dock:*) — the host's always-on-top window.
   *
   * Main-to-dock unless the comment says otherwise. Separate from
   * `pluginBridge` because these are the HOST's channels: the plugin cards
   * inside the dock talk over `pluginBridge` exactly as sidebar cards do, and
   * nothing here is reachable from a plugin frame.
   */
  dock: {
    /** Replace the host's activity line. `null` clears it. */
    activity: "ave:dock:activity",
    /** Add a plugin card to a slot. */
    mount: "ave:dock:mount",
    /** Change one card's height. */
    resize: "ave:dock:resize",
    /** Replace one card's header title (the UI language changed). */
    retitle: "ave:dock:retitle",
    /** Remove a plugin card. */
    unmount: "ave:dock:unmount",
    /** The host theme changed (`host.theme.changed` payload); the dock repaints its own chrome. */
    theme: "ave:dock:theme",
    /** Dock-to-main: the user pressed the dock's close control. */
    requestClose: "ave:dock:request-close",
    /** Dock-to-main: one slot's guest died. */
    slotGone: "ave:dock:slot-gone",
  },
  host: {
    pluginThemeNotify: "ave:host:plugin-theme-notify",
  },
  notification: {
    clicked: "ave:notification:clicked",
    // In-app toast push (main → renderer).
    toast: "ave:notification:toast",
  },
  settings: {
    get: "ave:settings:get",
    update: "ave:settings:update",
    setApiKey: "ave:settings:set-api-key",
    hasApiKey: "ave:settings:has-api-key",
    // Which settings the boot environment is currently forcing ON. A read of
    // presence only — never the value of any variable.
    envForcedSettings: "ave:settings:env-forced",
    deleteApiKey: "ave:settings:delete-api-key",
    listLlmModels: "ave:settings:list-llm-models",
    codexSubscriptionStatus: "ave:settings:codex-subscription:status",
    codexSubscriptionStartBrowserLogin: "ave:settings:codex-subscription:start-browser-login",
    codexSubscriptionStartDeviceCodeLogin: "ave:settings:codex-subscription:start-device-code-login",
    codexSubscriptionCancelLogin: "ave:settings:codex-subscription:cancel-login",
    codexSubscriptionLogout: "ave:settings:codex-subscription:logout",
    codexSubscriptionListModels: "ave:settings:codex-subscription:list-models",
    subscriptionRuntimeStatus: "ave:settings:subscription:status",
    // Main → host renderer safe status invalidation; never carries a status payload.
    subscriptionRuntimeStatusUpdated: "ave:settings:subscription:status-updated",
    subscriptionChooseRuntime: "ave:settings:subscription:choose-runtime",
    subscriptionForgetRuntime: "ave:settings:subscription:forget-runtime",
    subscriptionVerifyRuntime: "ave:settings:subscription:verify",
    subscriptionStartLogin: "ave:settings:subscription:start-login",
    subscriptionOpenLoginBrowser: "ave:settings:subscription:open-login-browser",
    subscriptionCancelLogin: "ave:settings:subscription:cancel-login",
    subscriptionAcknowledgeNotice: "ave:settings:subscription:acknowledge-notice",
    subscriptionLogout: "ave:settings:subscription:logout",
    subscriptionListModels: "ave:settings:subscription:list-models",
    subscriptionUseForChat: "ave:settings:subscription:use-for-chat",
    subscriptionUseApiForChat: "ave:settings:subscription:use-api-for-chat",
    acpSubscriptionStatus: "ave:settings:acp-subscription:status",
    acpSubscriptionChooseRuntime: "ave:settings:acp-subscription:choose-runtime",
    acpSubscriptionForgetRuntime: "ave:settings:acp-subscription:forget-runtime",
    acpSubscriptionVerify: "ave:settings:acp-subscription:verify",
    acpSubscriptionStartLogin: "ave:settings:acp-subscription:start-login",
    acpSubscriptionOpenLoginBrowser: "ave:settings:acp-subscription:open-login-browser",
    acpSubscriptionCancelLogin: "ave:settings:acp-subscription:cancel-login",
    acpSubscriptionLogout: "ave:settings:acp-subscription:logout",
    marketplaceInstallProviderPreset: "ave:settings:marketplace:install-provider-preset",
    marketplaceUninstallProviderPreset: "ave:settings:marketplace:uninstall-provider-preset",
    setWebApiKey: "ave:settings:set-web-api-key",
    hasWebApiKey: "ave:settings:has-web-api-key",
    deleteWebApiKey: "ave:settings:delete-web-api-key",
  },
  shell: {
    openExternal: "ave:shell:open-external",
  },
  telemetry: {
    consentPrompt: "ave:telemetry:consent-prompt",
    consentAnswer: "ave:telemetry:consent-answer",
    allowedHosts: "ave:telemetry:allowed-hosts",
  },
  usage: {
    summary: "ave:usage:summary",
    range: "ave:usage:range",
    dailySummary: "ave:usage:daily-summary",
    exportCsv: "ave:usage:export-csv",
    // The price corrections in force (the setting, or the deployment's
    // `AVE_PRICING_OVERRIDE`), so the renderer prices with the list the
    // usage dashboard prices with.
    pricingOverrides: "ave:usage:pricing-overrides",
  },
  // ── preload-swept channel groups ───────────────────────────────────────────
  // Added so the preload surfaces (public/internal) reference the contract SOT
  // instead of inline `"ave:*"` literals. Byte-identical to the strings the
  // preload previously inlined; registered-handler groups are cross-checked by
  // the channel-inventory snapshot.
  tour: {
    getState: "ave:tour:get-state",
    markComplete: "ave:tour:mark-complete",
    dismiss: "ave:tour:dismiss",
    start: "ave:tour:start",
  },
  // Plugin onboarding proposals. INTERNAL, same posture as `tour`: absent from
  // PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE, so only the
  // host renderer reaches them.
  onboarding: {
    listPending: "ave:onboarding:proposals:list-pending",
    answer: "ave:onboarding:proposals:answer",
  },
  documentEngine: {
    status: "ave:document-engine:status",
    install: "ave:document-engine:install",
    cancel: "ave:document-engine:cancel",
    uninstall: "ave:document-engine:uninstall",
  },
  prompts: {
    listSummaries: "ave:prompts:list-summaries",
    list: "ave:prompts:list",
    save: "ave:prompts:save",
    delete: "ave:prompts:delete",
    updated: "ave:prompts:updated",
  },
  trigger: {
    started: "ave:trigger:started",
    completed: "ave:trigger:completed",
    failed: "ave:trigger:failed",
    expired: "ave:trigger:expired",
    imported: "ave:trigger:imported",
    dismiss: "ave:trigger:dismiss",
    import: "ave:trigger:import",
  },
  update: {
    state: "ave:update:state",
    getState: "ave:update:get-state",
    downloadNow: "ave:update:download-now",
    installNow: "ave:update:install-now",
    skipVersion: "ave:update:skip-version",
  },
  app: {
    info: "ave:app:info",
    relaunch: "ave:app:relaunch",
  },
  approval: {
    request: "ave:approval:request",
    /**
     * main→renderer: this request is no longer answerable, whatever settled
     * it. The renderer reconciles its queue against it, so a card whose turn
     * ended somewhere the renderer could not watch — the tile closed, a
     * navigation let go of it — is taken down instead of outliving its ask.
     */
    settled: "ave:approval:settled",
  },
  dlp: {
    stats: "ave:dlp:stats",
  },
  audit: {
    search: "ave:audit:search",
    stats: "ave:audit:stats",
  },
  // ── Diagnostics bundle + production log viewer + crash list ──────
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. A diagnostics bundle serializes redacted host
  // state (settings whitelist, audit jsonl, logs, crash-dump metadata) to a
  // user-chosen file — it must never be reachable from an external origin
  // (local-api / cli / plugin frame). The fail-closed default
  // (isPublicChannel === false) enforces that; each invoke additionally gates
  // on validateHostRendererSender so a plugin-ui-shell frame cannot reach them
  // either.
  diagnostics: {
    export: "ave:diagnostics:export", // invoke renderer→main → { ok, path } | { ok:false, error }
    crashList: "ave:diagnostics:crash-list", // invoke → crash-dump metadata list
  },
  logs: {
    tail: "ave:logs:tail", // invoke (lines, level?) → redacted recent log lines
  },
  view: {
    activate: "ave:view:activate",
  },
  sessionTasks: {
    list: "ave:session-tasks:list",
    clear: "ave:session-tasks:clear",
    changed: "ave:session-tasks:changed",
  },
  sessionGoal: {
    get: "ave:session-goal:get",
    pause: "ave:session-goal:pause",
    resume: "ave:session-goal:resume",
    clear: "ave:session-goal:clear",
    changed: "ave:session-goal:changed",
  },
  agentSpawn: {
    event: "ave:agent-spawn:event",
  },
  skillLoad: {
    event: "ave:skill-load:event",
  },
  window: {
    minimize: "window:minimize",
    toggleMaximize: "window:toggleMaximize",
    close: "window:close",
    syncTitleBarTheme: "window:syncTitleBarTheme",
    maximizedChanged: "window:maximizedChanged",
    fullscreenChanged: "window:fullscreenChanged",
    openHtmlPreview: "ave:window:open-html-preview",
  },
  dev: {
    setPreflightOverride: "ave:dev:setPreflightOverride",
    getPreflightStatus: "ave:dev:getPreflightStatus",
  },
  attach: {
    openFile: "ave:attach:openFile",
    readImage: "ave:attach:readImage",
    saveClipboardImage: "ave:attach:saveClipboardImage",
    discardClipboardImage: "ave:attach:discardClipboardImage",
    openExternal: "ave:attach:openExternal",
    // Composer drag-drop, step 1. Invoked ONLY by the preload's
    // `aveDrop.prepareFileDrop`, which resolves OS-backed dropped `File`s via
    // webUtils.getPathForFile and sends the paths here in the same call — the
    // main world has no wrapper that takes a path string for this channel. Main
    // validates (deny-list, sensitive-path, regular file) and mints a one-shot,
    // sender-bound, expiring token. INTERNAL: absent from PUBLIC_CHANNELS.
    registerDrop: "ave:attach:registerDrop",
    // Composer drag-drop, step 2: the renderer redeems the main-owned token;
    // main authorizes exactly the files bound to it. INTERNAL.
    redeemDrop: "ave:attach:redeemDrop",
  },
  preview: {
    readFile: "ave:preview:read-file",
    // Documents use readFile's authority and an isolated parser. Returns a
    // bounded sheet or page, never source bytes. The index selects a sheet
    // for table formats or a page for presentations/PDF. INTERNAL.
    readDocument: "ave:preview:read-document",
    observationEvents: "ave:preview:observation-events",
    observationAck: "ave:preview:observation-ack",
    // Transient live preview of an agent-driven browser tab. The invoke starts, stops or
    // acknowledges a frame; frames are pushed outbound only and never retained. INTERNAL.
    observationPreview: "ave:preview:observation-preview",
    observationPreviewFrames: "ave:preview:observation-preview-frames",
    documentOpenRequest: "ave:preview:document-open-request",
    documentOpenAck: "ave:preview:document-open-ack",
  },
  workspace: {
    pickRoot: "ave:workspace:pick-root",
    listRoots: "ave:workspace:list-roots",
    listDir: "ave:workspace:list-dir",
    removeRoot: "ave:workspace:remove-root",
    reveal: "ave:workspace:reveal",
    // Drag-drop add-root, step 1 (#1458). A dropped folder path is renderer-NAMED
    // (resolved in preload via webUtils.getPathForFile), so this handler re-runs
    // the SAME Layer-0 hard-deny + is-a-directory checks and — on success — mints
    // the one-time, MAIN-OWNED ack token that pickRoot({ackToken}) later consumes.
    // INTERNAL: deliberately absent from PUBLIC_CHANNELS so an external origin can
    // never propose a read-scope-widening path (fail-closed default).
    dropPrepare: "ave:workspace:drop-prepare",
    // Composer `@file` autocomplete: main walks the CURRENT workspace roots with
    // the file tools' own walker (Layer-0 sensitive filter included) and returns
    // only paths that pass the read-scope guard. The query is the only renderer
    // input; a returned path is a reference the model reads via read_file.
    // INTERNAL: absent from PUBLIC_CHANNELS.
    searchFiles: "ave:workspace:search-files",
  },
  // ── Interactive PTY terminal (#1444, workspace rail) ──────────────────────
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. A terminal spawns arbitrary user commands, so
  // it must be unreachable from any external origin (local-api / cli / plugin
  // frame) — the fail-closed default (isPublicChannel === false) enforces that.
  // Each invoke handler additionally gates on validateHostRendererSender so a
  // plugin-ui-shell frame cannot reach them either. data/exit are main→renderer
  // events sent via safe-send/sendToWindow.
  terminal: {
    spawn: "ave:terminal:spawn", // invoke renderer→main → { ok, tabId } | { ok:false, reason }
    input: "ave:terminal:input", // invoke  (keystrokes → pty stdin)
    resize: "ave:terminal:resize", // invoke  (cols/rows)
    kill: "ave:terminal:kill", // invoke  (tab close / teardown)
    data: "ave:terminal:data", // event   main→renderer (pty output chunk)
    exit: "ave:terminal:exit", // event   main→renderer (pty exited)
    blocks: "ave:terminal:blocks", // invoke  command-block summaries of one tab (no output)
    block: "ave:terminal:block", // invoke  one command block with its output
  },
  // ── Browser tabs (agent browser tools) ────────────────────────────────────
  // ALL INTERNAL: absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. Binding a guest to a tab id decides what the
  // agent's browser tools can reach, so only the host renderer of the window
  // that hosts the guest may do it (validateHostRendererSender + host check in
  // main). Wire types: shared/browser-surface.ts.
  browser: {
    bindTab: "ave:browser:bind-tab", // invoke renderer→main  tab id ↔ guest webContents id
    stop: "ave:browser:stop", // invoke renderer→main  pause before user navigation
    pause: "ave:browser:pause", // invoke renderer→main  explicit persistent human takeover
    resume: "ave:browser:resume", // invoke renderer→main  explicit new agent control generation
    pausePopup: "ave:browser:pause-popup", // invoke renderer→main  main-issued native popup handle
    resumePopup: "ave:browser:resume-popup", // invoke renderer→main  main-issued native popup handle
    getState: "ave:browser:get-state", // invoke renderer→main  revisioned control snapshot
    getSessionBindings: "ave:browser:get-session-bindings",
    sessionBindingsChanged: "ave:browser:session-bindings-changed",
    tabOp: "ave:browser:tab-op", // event  main→renderer  new / select / close a tab
    control: "ave:browser:control", // event  main→renderer  which tabs the agent controls
  },
  // Host-renderer-only browser chrome. Remote pages and plugin frames cannot
  // read the library, choose site capabilities, or capture a guest preview.
  browserWorkspace: {
    getState: "ave:browser-workspace:get-state",
    setBookmark: "ave:browser-workspace:set-bookmark",
    clearHistory: "ave:browser-workspace:clear-history",
    setSitePermission: "ave:browser-workspace:set-site-permission",
    find: "ave:browser-workspace:find",
    stopFind: "ave:browser-workspace:stop-find",
    zoom: "ave:browser-workspace:zoom",
    preview: "ave:browser-workspace:preview",
    changed: "ave:browser-workspace:changed",
  },
  // ── Active workspace surface (a hint for agent tools) ─────────────────────
  // INTERNAL. The renderer reports which browser/terminal tab the user is
  // looking at in its window; tools default to it when no tab is named.
  surface: {
    setActive: "ave:surface:set-active", // invoke renderer→main  ActiveWorkspaceSurface | null
  },
  // ── Side chat (workspace rail) — 2nd, independently-streaming chat session ──
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. Side chat drives a SECOND ConversationLoop that
  // runs arbitrary tools just like the main chat, so it must be unreachable from
  // any external origin (local-api / cli / plugin frame) — the fail-closed
  // default (isPublicChannel === false) enforces that. Each invoke additionally
  // gates on validateHostRendererSender so a non-host frame is rejected. The `stream` /
  // `fallback` events are a DEDICATED channel pair (not `chat.stream`): the main
  // renderer's `onChatStream` subscriber never receives side-chat frames and vice
  // versa, so the two streams stay isolated by wire channel (No-Fallback: the
  // main path is never asked which session a frame belongs to).
  sidechat: {
    send: "ave:sidechat:send", // invoke renderer→main → TurnResult | { ok:false }
    new: "ave:sidechat:new", // invoke → { ok, sessionId }
    load: "ave:sidechat:load", // invoke (sessionId) → { ok, messages }
    abort: "ave:sidechat:abort", // invoke { sendRequestId } → { ok }
    listShellTasks: "ave:sidechat:list-shell-tasks",
    controlShellTask: "ave:sidechat:control-shell-task",
    paneHistory: "ave:sidechat:pane-history", // invoke { tabId } → { ok, sessionId|null, messages } (no session switch)
    endPaneChat: "ave:sidechat:end-pane-chat", // invoke { tabId, reason } → { ok, sessionId|null }
    getSubAgentTranscript: "ave:sidechat:get-sub-agent-transcript", // invoke → owner-scoped child transcript
    stream: "ave:sidechat:stream", // event main→renderer ({ streamId, ...frame })
    fallback: "ave:sidechat:fallback", // event main→renderer (provider fallback)
  },
} as const;

// ─── Versioned public contract ──────────────────────────────────────────────

/**
 * Wire-contract version. Bump when the public surface (PUBLIC_CHANNELS, gesture
 * classification, or a public channel's payload shape) changes in a way an
 * external SDK/CLI must react to. Read-first callers pin this.
 */
export const CONTRACT_VERSION = "2.0.0";

/**
 * The versioned allowlist of channels an external surface (SDK / CLI / local
 * API) MAY touch. Deliberately a small, mostly-read subset:
 *   - chat send + session list/history/get-history (renderer-parity reads + send)
 *   - plugin status/list
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
  [CHANNELS.app.relaunch]: "required",
  // ── public subset (reads + chat send) — gesture: none ──
  [CHANNELS.chat.send]: "none",
  [CHANNELS.chat.sessions]: "none",
  [CHANNELS.chat.getHistory]: "none",
  [CHANNELS.chat.sessionHistory]: "none",
  [CHANNELS.plugins.cards]: "none",
  [PERMISSIONS.getMode]: "none",
  [CHANNELS.usage.summary]: "none",
  [CHANNELS.usage.range]: "none",
  // ── mutating gesture-gated (permission / policy / sandbox-install) ──
  [PERMISSIONS.setMode]: "required",
  [PERMISSIONS.addRule]: "required",
  [PERMISSIONS.removeRule]: "required",
  [PERMISSIONS.removeScopedRule]: "required",
  [PERMISSIONS.policySet]: "required",
  [PERMISSIONS.dirDispatch]: "required",
  [PERMISSIONS.reviewerDispatch]: "required",
  [PERMISSIONS.judgeSet]: "required",
  [PERMISSIONS.deferredResolve]: "required",
  [PERMISSIONS.approvalSentenceSelect]: "required",
  [PERMISSIONS.userApprovalRecord]: "required",
  [PERMISSIONS.userApprovalRevoke]: "required",
  [PERMISSIONS.sandboxWindowsInstall]: "required",
  [PERMISSIONS.approveExtensionsWithoutIsolation]: "required",
  // Local-owner Tailnet sharing: all mutations are host-renderer-only and
  // require a current keyboard intent. The snapshot and change hint carry no
  // externally callable mutation capability, so they are deliberately omitted.
  [CHANNELS.tailnetSharing.createInvitation]: "required",
  [CHANNELS.tailnetSharing.activatePairing]: "required",
  [CHANNELS.tailnetSharing.createCurrentConversationShare]: "required",
  [CHANNELS.tailnetSharing.revokeShare]: "required",
  [CHANNELS.tailnetSharing.revokePairing]: "required",
  // Enabling the observer, moving its port, or widening its scope is an owner
  // decision made at this keyboard, exactly like a share.
  [CHANNELS.tailnetObserver.apply]: "required",
  // Running a binary for the owner is its own decision, made at this keyboard
  // against a command the surface has already shown in full.
  [CHANNELS.tailnetObserver.configureServe]: "required",
  // Installing the managed git downloads a binary the marketplace then runs.
  [CHANNELS.gitRuntime.install]: "required",
  // Waiving the approval click for a whole account, and taking that waiver
  // back, is a grant decision — gated exactly like the click it replaces.
  [CHANNELS.tailnetObserver.setOwnDeviceAdmission]: "required",
  // Local-owner Telegram connection: same rule. Saving a bot token, starting
  // the outbound connection, minting a pairing code, and sharing the open
  // conversation are each an owner decision made at this keyboard.
  [CHANNELS.telegramConnection.connect]: "required",
  [CHANNELS.telegramConnection.disconnect]: "required",
  [CHANNELS.telegramConnection.pause]: "required",
  [CHANNELS.telegramConnection.resume]: "required",
  [CHANNELS.telegramConnection.createPairingCode]: "required",
  [CHANNELS.telegramConnection.revokePairing]: "required",
  [CHANNELS.telegramConnection.approveCurrentConversation]: "required",
  [CHANNELS.telegramConnection.revokeApproval]: "required",
  // Away authority: arming is the gesture, so it needs the gesture. Disarming
  // is listed too — not because withdrawing authority is dangerous, but because
  // a caller that could disarm without a keyboard could disarm the owner's
  // grant out from under them and time the gap.
  [CHANNELS.awayAuthority.arm]: "required",
  [CHANNELS.awayAuthority.disarm]: "required",
};

// ─── Approval-mediated external mutation ─────────────────────────────────────

/**
 * The allowlist of gesture-gated channels an EXTERNAL origin
 * ({@link import("./trust-origin.js").ExternalOrigin} — local-api / cli /
 * plugin-frame) MAY reach, and ONLY via an in-app {@link ../permissions/approval-gate.js}
 * consent. Every member is a `CHANNEL_GESTURE:"required"` channel that is NOT
 * in {@link PUBLIC_CHANNELS}; it stays unreachable from external origins by the
 * fail-closed default, and this list is the single, explicit exception.
 *
 * CONSENT MODEL — there is NO token bypass. An external caller cannot present a
 * credential, a stored gesture token, or any header to satisfy the gesture
 * requirement. The ONLY thing that unblocks a channel listed here is the user's
 * own approval click inside the running app: the human pressing "Allow" on the
 * ApprovalGate dock IS the explicit user action that authorizes this single
 * mutation. If the user declines or the request times out, the caller receives
 * {@link EXTERNAL_MUTATION_DENIED}.
 *
 * Every OTHER `CHANNEL_GESTURE:"required"` channel (add/remove rule, policy set,
 * dir/reviewer dispatch, deferred resolve, user-approval record/revoke, sandbox
 * install) is deliberately absent here — those remain renderer-only by design
 * and are never reachable from an external origin under any consent.
 *
 * Initially EXACTLY ONE entry: `PERMISSIONS.setMode`.
 */
export const EXTERNAL_MUTATION_CHANNELS = [
  PERMISSIONS.setMode,
] as const;

/** A channel reachable from an external origin via ApprovalGate consent. */
export type ExternalMutationChannel = (typeof EXTERNAL_MUTATION_CHANNELS)[number];

/**
 * Fail-closed error returned to an external caller when an approval-mediated
 * external mutation ({@link EXTERNAL_MUTATION_CHANNELS}) is NOT authorized —
 * the user declined the ApprovalGate consent, or the request timed out.
 */
export const EXTERNAL_MUTATION_DENIED = "external-mutation-denied";

/**
 * Payload of the `plugins.installResult` / `plugins.uninstallResult` broadcasts
 * (main -> renderer). Single declaration for the channel: the preload bridge,
 * the renderer API type and the toast handler all read this one, so a field the
 * producer attaches cannot go missing on the way to the UI.
 *
 * `error` is the stable English IPC code when one exists (e.g.
 * `incompatible-app-version`) and the plain message otherwise; `message` is the
 * human detail that accompanies a code. Together they are exactly the pair
 * `formatIpcError(error, message)` consumes — pass both, never render `error`
 * raw, or the user sees the bare code.
 */
export interface PluginInstallResultPayload {
  slug: string;
  success: boolean;
  error?: string;
  message?: string;
}

/**
 * Payload of the `agents.installResult` / `agents.uninstallResult` broadcasts.
 *
 * Extends the plugin shape rather than restating it: the status-bar toast runs
 * one handler for all three package families, so the `error`/`message` pair has
 * to mean the same thing here. `agentId` is the success-only field — a failed
 * install never resolved one.
 */
export interface AgentInstallResultPayload extends PluginInstallResultPayload {
  agentId?: string;
}

/** Skill twin of {@link AgentInstallResultPayload}. */
export interface SkillInstallResultPayload extends PluginInstallResultPayload {
  skillId?: string;
}
