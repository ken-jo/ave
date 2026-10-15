/**
 * Wire types between a main window's renderer and the main-process registry
 * of the browser tabs (guest `<webview>`s) and workspace surfaces it hosts.
 *
 * Main is authoritative for what agent tools may touch; the renderer mirrors
 * it. Tab ids are opaque strings the renderer mints and keeps unique within
 * its window; where a tab is mounted (side panel, main area) is the
 * renderer's business and never part of this contract.
 *
 * Channels (CHANNELS.browser / CHANNELS.surface in contract/app-contract.ts):
 *   bindTab      invoke  renderer→main  {@link BrowserTabBindRequest} → {@link BrowserTabBindResult}
 *   stop         invoke  renderer→main  {@link BrowserTabStopRequest} (badge stop button)
 *   tabOp        event   main→renderer  {@link BrowserTabOpRequest}
 *   control      event   main→renderer  {@link BrowserTabControlState}
 *   setActive    invoke  renderer→main  {@link ActiveWorkspaceSurface} | null
 */

/** The workspace surfaces a window can show and agent tools can default to. */
type WorkspaceSurfaceKind = "browser" | "terminal";

/**
 * The surface the user is looking at in one window — a HINT, not an
 * authority. A tool that is not told which tab to use defaults to the active
 * tab of its kind; an explicit tab id always wins, and every listing still
 * shows all tabs. `null` clears it.
 */
export interface ActiveWorkspaceSurface {
  readonly kind: WorkspaceSurfaceKind;
  readonly tabId: string;
}

/**
 * Bind a browser tab to the guest `<webview>` that renders it. Sent after the
 * webview attaches (its `getWebContentsId()`), and again whenever the tab is
 * remounted with a new guest. Main accepts only a live guest of the side
 * browser's partition hosted by the sender's own window.
 *
 * `requestId` is set when the tab was created in answer to a
 * {@link BrowserTabOpRequest} `new` — that is how main knows the agent
 * opened it. A renderer never claims agent provenance otherwise.
 */
export interface BrowserTabBindRequest {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly requestId?: string;
}

export type BrowserTabBindResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: "bad-request" | "unauthorized-frame" | "guest-not-live" | "guest-not-browser" | "guest-not-hosted";
    };

/** The user pressed stop on an agent-controlled tab's badge. */
export interface BrowserTabStopRequest {
  readonly tabId: string;
}

/**
 * Main asks the window's renderer to change its tab UI. Main resolves the
 * agent's request when it observes the result: a bind carrying `requestId`
 * (new), the guest going away (close), or the tab bound and active (select).
 */
export type BrowserTabOpRequest =
  /**
   * `sessionId` names the conversation the tab is opened for (a sub-agent's
   * parent), so a window with several chats opens it beside that one.
   */
  | { readonly requestId: string; readonly op: "new"; readonly url: string; readonly sessionId?: string }
  | { readonly requestId: string; readonly op: "select"; readonly tabId: string }
  | { readonly requestId: string; readonly op: "close"; readonly tabId: string }
  /**
   * The agent's action in `tabId` is done: give keyboard focus back to what
   * held it in the window before the action took it. Not awaited by main;
   * main sees it land as the page losing focus.
   */
  | { readonly requestId: string; readonly op: "restore-focus"; readonly tabId: string };

/** Validate a main→renderer {@link BrowserTabOpRequest}; null when malformed. */
export function parseBrowserTabOpRequest(value: unknown): BrowserTabOpRequest | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as { requestId?: unknown; op?: unknown; url?: unknown; tabId?: unknown };
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;
  if (record.op === "new") {
    if (typeof record.url !== "string") return null;
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    return {
      requestId: record.requestId,
      op: "new",
      url: record.url,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
    };
  }
  if ((record.op === "select" || record.op === "close" || record.op === "restore-focus") && typeof record.tabId === "string") {
    return { requestId: record.requestId, op: record.op, tabId: record.tabId };
  }
  return null;
}

/**
 * Which of a window's browser tabs the agent controls. Sent whenever it
 * changes; the renderer shows the "Agent is controlling this tab" badge with
 * a stop button on exactly these tabs.
 */
export interface BrowserTabControlState {
  readonly agentControlledTabIds: readonly string[];
}
