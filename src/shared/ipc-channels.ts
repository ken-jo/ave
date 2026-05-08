/**
 * IPC channel name constants — single source of truth.
 *
 * All main-process handlers, preload bridges, and renderer callers
 * reference these constants so hardcoded channel strings are eliminated.
 */

/**
 * Q11 — Overlay IPC channels for main↔renderer overlay state sync.
 *
 * main → renderer: show / update / dismiss (pushed from plugin-runtime overlay runner)
 * renderer → main: primaryAction (user confirm — audit log + plugin notification)
 */
export const OVERLAY_V1 = {
  /** main → renderer: push a new OverlayItem into the renderer queue */
  show: "ave:overlay:show",
  /** main → renderer: patch an existing OverlayItem (e.g. running→done) */
  update: "ave:overlay:update",
  /** main → renderer: remove an item by id */
  dismiss: "ave:overlay:dismiss",
  /** renderer → main: user confirmed (primary action) a plugin overlay item */
  primaryAction: "ave:overlay:primary-action",
} as const;

export const ROUTINES_V2 = {
  list: "ave:routines:v2:list",
  add: "ave:routines:v2:add",
  dismiss: "ave:routines:v2:dismiss",
  remove: "ave:routines:v2:remove",
  triggerNow: "ave:routines:v2:trigger-now",
  fired: "ave:routines:v2:fired",
  listSessions: "ave:routines:v2:list-sessions",
  readSession: "ave:routines:v2:read-session",
  // Q10 — running indicator events (renderer reflects LLM session progress)
  runningStarted: "ave:routines:v2:running-started",
  runningFinished: "ave:routines:v2:running-finished",
  // M8 — emitted when an LLM session errors out so renderer can clear running state
  failed: "ave:routines:v2:failed",
} as const;
