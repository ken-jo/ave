/**
 * IPC channel name constants — single source of truth.
 *
 * All main-process handlers, preload bridges, and renderer callers
 * reference these constants so hardcoded channel strings are eliminated.
 */

/**
 * Overlay IPC channels for main→renderer overlay state sync.
 *
 * main → renderer: show / update / dismiss (pushed from plugin-runtime overlay runner)
 */
export const OVERLAY_V1 = {
  /** main → renderer: push a new OverlayItem into the renderer queue */
  show: "ave:overlay:show",
  /** main → renderer: patch an existing OverlayItem (e.g. running→done) */
  update: "ave:overlay:update",
  /** main → renderer: remove an item by id */
  dismiss: "ave:overlay:dismiss",
} as const;

export const ROUTINES_V2 = {
  list: "ave:routines:v2:list",
  add: "ave:routines:v2:add",
  dismiss: "ave:routines:v2:dismiss",
  remove: "ave:routines:v2:remove",
  triggerNow: "ave:routines:v2:trigger-now",
  fired: "ave:routines:v2:fired",
  pendingResults: "ave:routines:v2:pending-results",
  acknowledgeResult: "ave:routines:v2:ack-result",
  listSessions: "ave:routines:v2:list-sessions",
  // Running indicator events (renderer reflects LLM session progress)
  runningStarted: "ave:routines:v2:running-started",
  runningFinished: "ave:routines:v2:running-finished",
  // Emitted when an LLM session errors out so renderer can clear running state
  failed: "ave:routines:v2:failed",
} as const;

export const PERMISSIONS = {
  getMode: "ave:permission:get-mode",
  setMode: "ave:permission:set-mode",
  modeChanged: "ave:permissions:mode-changed",
  listRules: "ave:permission:list-rules",
  addRule: "ave:permission:add-rule",
  removeRule: "ave:permission:remove-rule",
  approvalRespond: "ave:approval:respond",
  policyGet: "ave:policy:get",
  policySet: "ave:policy:set",
  dirDispatch: "ave:permissions:dir-dispatch",
  reviewerDispatch: "ave:permissions:reviewer-dispatch",
  reviewerProviderHasKey: "ave:permissions:reviewer-provider-has-key",
  deferredList: "ave:permissions:deferred-list",
  deferredResolve: "ave:permissions:deferred-resolve",
  deferredPending: "ave:permissions:deferred-pending",
  auditShow: "ave:permissions:audit-show",
  auditVerify: "ave:permissions:audit-verify",
  hookTrustList: "ave:permissions:hook-trust-list",
  manifestViolation: "ave:permissions:manifest-violation",
  // User-approval store
  userApprovalRecord: "ave:permissions:user-approval-record",
  userApprovalRevoke: "ave:permissions:user-approval-revoke",
  userApprovalList: "ave:permissions:user-approval-list",
  // 4.1: memory-hit auto-approve disclosure (main → renderer)
  userApprovalHit: "ave:permissions:user-approval-hit",
  // Broadcast: directory config changed (main → all renderers). Emitted
  // when allowed-directories list mutates (session-add, slash-allow,
  // PermissionsTab dirDispatch). Multi-window PermissionsTab subscribes
  // to refresh its "session additions" view without manual reload.
  configChanged: "ave:permissions:config-changed",
} as const;

export const SETTINGS = {
  updated: "ave:settings:updated",
} as const;

export const UI = {
  assistantContextMenu: "ave:ui:assistant-context-menu",
  assistantContextAction: "ave:ui:assistant-context-action",
} as const;

export const SUGGESTED_REPLIES = {
  updated: "ave:chat:suggested-replies-updated",
} as const;
