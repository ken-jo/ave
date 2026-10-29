/** IPC channel name constants; single source of truth. All main-process handlers, preload
 * bridges, and renderer callers reference these constants so hardcoded channel strings are eliminated. */

/** Overlay IPC channels for main→renderer overlay state sync. main → renderer: show / update / dismiss (pushed from plugin-runtime overlay runner) */
export const OVERLAY_V1 = {
  /** main → renderer: push a new OverlayItem into the renderer queue */
  show: "ave:overlay:show",
  /** main → renderer: patch an existing OverlayItem (e.g. running→done) */
  update: "ave:overlay:update",
  /** main → renderer: remove an item by id */
  dismiss: "ave:overlay:dismiss",
} as const;

/**
 * Host-renderer alert Settings and card lifecycle. The cards travel on
 * {@link OVERLAY_V1}; a window that appeared late can pull staged cards.
 */
export const ALERTS = {
  listKinds: "ave:alerts:list-kinds",
  removePredecessor: "ave:alerts:remove-predecessor",
  setKind: "ave:alerts:set-kind",
  setOsNotificationsEnabled: "ave:alerts:set-os-notifications-enabled",
  /** main → renderer: re-read registered kinds and alert settings. */
  kindsChanged: "ave:alerts:kinds-changed",
  /** invoke `(alertId, "accepted" | "dismissed")`: the identity stays closed for its lifetime. */
  cardClosed: "ave:alerts:card-closed",
  /** invoke → every staged alert card. */
  listOpen: "ave:alerts:list-open",
} as const;

export const ROUTINES = {
  list: "ave:routines:list",
  add: "ave:routines:add",
  dismiss: "ave:routines:dismiss",
  remove: "ave:routines:remove",
  triggerNow: "ave:routines:trigger-now",
  fired: "ave:routines:fired",
  pendingResults: "ave:routines:pending-results",
  acknowledgeResult: "ave:routines:ack-result",
  listSessions: "ave:routines:list-sessions",
  // Running indicator events (renderer reflects LLM session progress)
  runningStarted: "ave:routines:running-started",
  runningFinished: "ave:routines:running-finished",
  // Emitted when an LLM session errors out so renderer can clear running state
  failed: "ave:routines:failed",
} as const;

export const WORK_BOARD = {
  list: "ave:work-board:list",
  get: "ave:work-board:get",
  add: "ave:work-board:add",
  update: "ave:work-board:update",
  transition: "ave:work-board:transition",
  complete: "ave:work-board:complete",
  reopen: "ave:work-board:reopen",
  remove: "ave:work-board:remove",
  // Emitted by the work-board IPC domain after any successful mutation
  // (created/updated/transitioned/completed/reopened/removed) so the renderer board view re-lists without polling.
  itemChanged: "ave:work-board:item-changed",
  // Renderer → main: kick off a plan→approve→execute run for one item. Fire-and-forget; the renderer
  // tracks completion via the run-progress events below (mirroring the ROUTINES running-* pattern).
  run: "ave:work-board:run",
  // Main → renderer: per-phase liveness for an in-flight run (WorkBoardRunEvent).
  runProgress: "ave:work-board:run-progress",
  // Main → renderer: terminal markers so the renderer can clear running state.
  runStarted: "ave:work-board:run-started",
  runFinished: "ave:work-board:run-finished",
  runFailed: "ave:work-board:run-failed",
  // Renderer → main: generate a daily / weekly personal work report from the board state + activity log + learned memory. Returns the markdown.
  generateReport: "ave:work-board:generate-report",
  // Renderer → main: run the daily / weekly briefing; a read-only sub-agent survey of the user's work whose findings are filed
  // back onto the board as proposals. The opposite direction from generateReport, which summarizes what the board already holds.
  runBriefing: "ave:work-board:run-briefing",
  // Renderer → main: read a past run's persisted transcript (sessions/<itemId>/<runId>.jsonl) for the run-history view.
  runTranscript: "ave:work-board:run-transcript",
  // Renderer → main: list the open proposals, accept one (creating the work item it becomes), or dismiss one.
  listProposals: "ave:work-board:list-proposals",
  acceptProposal: "ave:work-board:accept-proposal",
  dismissProposal: "ave:work-board:dismiss-proposal",
  // Main → renderer: the proposal set moved; a plugin posted or withdrew one, or the user accepted or dismissed one; so the board re-lists.
  proposalChanged: "ave:work-board:proposal-changed",
} as const;

export const PERMISSIONS = {
  getMode: "ave:permission:get-mode",
  setMode: "ave:permission:set-mode",
  modeChanged: "ave:permissions:mode-changed",
  listRules: "ave:permission:list-rules",
  listScopedRules: "ave:permission:list-scoped-rules",
  removeScopedRule: "ave:permission:remove-scoped-rule",
  addRule: "ave:permission:add-rule",
  removeRule: "ave:permission:remove-rule",
  approvalRespond: "ave:approval:respond",
  approvalPending: "ave:approval:pending",
  policyGet: "ave:policy:get",
  policySet: "ave:policy:set",
  dirDispatch: "ave:permissions:dir-dispatch",
  reviewerDispatch: "ave:permissions:reviewer-dispatch",
  judgeGet: "ave:permissions:judge-get",
  judgeSet: "ave:permissions:judge-set",
  recentlyDeniedList: "ave:permissions:recently-denied-list",
  recentlyDeniedRerun: "ave:permissions:recently-denied-rerun",
  recentlyDeniedChanged: "ave:permissions:recently-denied-changed",
  auditShow: "ave:permissions:audit-show",
  auditVerify: "ave:permissions:audit-verify",
  hookTrustList: "ave:permissions:hook-trust-list",
  manifestViolation: "ave:permissions:manifest-violation",
  // Read-only: OS sandbox capability for the current platform; drives the

  sandboxCapability: "ave:permissions:sandbox-capability",
  // Read-only: Windows srt-win install readiness (group + WFP state) + the verbatim ASRT install
  // instructions. Drives the win32 consent panel in PermissionsTab. Non-win32 returns a clean "not-applicable" shape.
  sandboxWindowsStatus: "ave:permissions:sandbox-windows-status",
  // Read-only (sender-frame-guarded: audit data): the ASRT proxy denies of the last 24 h, read
  // back from the sandbox audit channel. Drives Settings → Permissions → Network "Recent denials".
  egressDenialsRecent: "ave:permissions:egress-denials-recent",
  // Read-only (sender-frame-guarded): the shell egress grants that outlive a conversation ("This workspace" and "Always"). Drives Settings → Permissions → Network "Allowed hosts".
  egressGrantsList: "ave:permissions:egress-grants-list",
  // MUTATING (sender-frame-guarded + user-keyboard intent): revoke one of those grants.
  egressGrantRevoke: "ave:permissions:egress-grant-revoke",
  // Read-only (sender-frame-guarded): the main-owned upstream proxy setting (no credential values), whether manual credentials are
  // stored, and the effective upstream for https://example.com. Drives Settings → Permissions → OS Tool Sandbox "Upstream proxy".
  upstreamProxyGet: "ave:permissions:upstream-proxy-get",
  // MUTATING (sender-frame-guarded + user-gesture intent): change it. The only writer of `upstreamProxy`; `settings:update` refuses the key.
  upstreamProxySet: "ave:permissions:upstream-proxy-set",
  // MUTATING (sender-frame-guarded): the ONLY user-consented privilege escalation entry point;
  // triggers ASRT installWindowsSandbox's single self-elevating UAC prompt. Never auto-triggered.
  sandboxWindowsInstall: "ave:permissions:sandbox-windows-install",
  approveExtensionsWithoutIsolation: "ave:permissions:approve-extensions-without-isolation",
  // `/allow <sentence>`; resolve a user sentence onto one of the PENDING approval's own scopes. Gesture-gated because only a keyboard-origin submission
  // may speak for the user, but it grants nothing on its own: the reply names a button the card already renders, and that button still has to be pressed.
  approvalSentenceSelect: "ave:permissions:approval-sentence-select",
  // User-approval store
  userApprovalRecord: "ave:permissions:user-approval-record",
  userApprovalRevoke: "ave:permissions:user-approval-revoke",
  userApprovalList: "ave:permissions:user-approval-list",
  // 4.1: memory-hit auto-approve disclosure (main → renderer)
  userApprovalHit: "ave:permissions:user-approval-hit",
  // Default-mode approval pattern hint (main → renderer)
  reviewSuggestion: "ave:permissions:review-suggestion",
  // Broadcast: directory config changed (main → all renderers). Emitted when allowed-directories list mutates (session-add, slash-allow,
  // PermissionsTab dirDispatch). Multi-window PermissionsTab subscribes to refresh its "session additions" view without manual reload.
  configChanged: "ave:permissions:config-changed",
} as const;

export const SETTINGS = {
  updated: "ave:settings:updated",
} as const;

export const MARKETPLACE = {
  announcements: "ave:marketplace:announcements",
} as const;

export const UI = {
  nativeContextMenu: "ave:ui:native-context-menu",
  nativeContextAction: "ave:ui:native-context-action",
  dynamicMenu: "ave:ui:dynamic-menu",
  dynamicMenuAction: "ave:ui:dynamic-menu-action",
} as const;
