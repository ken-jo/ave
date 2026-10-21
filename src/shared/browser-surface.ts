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
 *   stop         invoke  renderer→main  {@link BrowserTabStopRequest} (stop or user navigation)
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

/** The user stopped agent control or navigated, including before the tab's first bind. */
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
  | { readonly requestId: string; readonly op: "new"; readonly url: string; readonly active: boolean; readonly sessionId?: string }
  | { readonly requestId: string; readonly op: "select"; readonly tabId: string }
  | { readonly requestId: string; readonly op: "close"; readonly tabId: string }
  /** Focus this existing renderer slot without selecting or moving another surface. */
  | { readonly requestId: string; readonly op: "focus"; readonly tabId: string }
  /**
   * The agent's action in `tabId` is done: give keyboard focus back to what
   * held it in the window before the action took it. Not awaited by main;
   * main sees it land as the page losing focus.
   */
  | { readonly requestId: string; readonly op: "restore-focus"; readonly tabId: string };

/** Validate a main→renderer {@link BrowserTabOpRequest}; null when malformed. */
export function parseBrowserTabOpRequest(value: unknown): BrowserTabOpRequest | null {
  if (!isRecord(value)) return null;
  const record = value as { requestId?: unknown; op?: unknown; url?: unknown; active?: unknown; tabId?: unknown };
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;
  if (record.op === "new") {
    if (!hasOnlyKeys(value, ["requestId", "op", "url", "active", "sessionId"])) return null;
    if (typeof record.url !== "string" || typeof record.active !== "boolean") return null;
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) return null;
    return {
      requestId: record.requestId,
      op: "new",
      url: record.url,
      active: record.active,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
    };
  }
  if ((record.op === "select" || record.op === "close" || record.op === "focus" || record.op === "restore-focus") && typeof record.tabId === "string") {
    if (record.tabId.length === 0 || !hasOnlyKeys(value, ["requestId", "op", "tabId"])) return null;
    return { requestId: record.requestId, op: record.op, tabId: record.tabId };
  }
  return null;
}

/** Human pause blocks future mutation until trusted chrome explicitly resumes. */
export type BrowserControlMode = "human" | "agent-active" | "human-paused";

/** Actual caller identity, captured by main from the running session. */
export interface BrowserSessionActor {
  readonly sessionId: string;
  readonly directParentSessionId?: string;
}

export interface BrowserControlLease {
  readonly id: string;
  readonly actor: BrowserSessionActor;
  /** Owned follows the durable creator; a borrowed release never destroys the human resource. */
  readonly lifetime: "owned" | "borrowed";
}

export interface BrowserTabControlView {
  /** Main-issued tool handle. */
  readonly tabId: string;
  /** Embedded chrome slot id; native popup windows have no renderer slot. */
  readonly rendererTabId: string | null;
  readonly url: string;
  readonly title: string;
  readonly mode: BrowserControlMode;
  /** Durable creator, preserved across pause and release; null for a user resource. */
  readonly owner: BrowserSessionActor | null;
  readonly lease: BrowserControlLease | null;
  /** Security epoch for pause, resume, navigation and document changes; lease acquisition keeps it stable. */
  readonly generation: number;
  readonly kind: "embedded" | "popup";
  readonly openerTabId: string | null;
}

/**
 * Full authoritative snapshot scoped to the caller's main window. Revision
 * increases on each published change for that window's lifetime. Subscribe
 * before fetching and discard snapshots older than the latest received one.
 */
export interface BrowserTabControlState {
  readonly revision: number;
  readonly tabs: readonly BrowserTabControlView[];
}

/** Trusted window chrome only; page content never receives this API. */
export interface BrowserTabsApi {
  bindTab(request: BrowserTabBindRequest): Promise<BrowserTabBindResult>;
  getState(): Promise<BrowserTabControlState>;
  /** Embedded chrome operations take renderer slot ids, never tool handles. Stop also clears origin provenance. */
  stop(tabId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  pause(tabId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  resume(tabId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Native popup operations take main-issued handles and never renderer slot ids. */
  pausePopup(tabId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  resumePopup(tabId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Future requests only; main independently observes bind, active guest or destruction for completion. */
  onTabOp(handler: (request: BrowserTabOpRequest) => void): () => void;
  /** Future full snapshots only; use getState after subscribing for initial state. */
  onControl(handler: (state: BrowserTabControlState) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseActor(value: unknown): BrowserSessionActor | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sessionId", "directParentSessionId"])) return null;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return null;
  if (value.directParentSessionId !== undefined
    && (typeof value.directParentSessionId !== "string" || value.directParentSessionId.length === 0
      || value.directParentSessionId === value.sessionId)) return null;
  return { sessionId: value.sessionId, ...(value.directParentSessionId === undefined ? {} : { directParentSessionId: value.directParentSessionId }) };
}

/** Reject malformed or mixed-version state rather than guessing control authority. */
export function parseBrowserTabControlState(value: unknown): BrowserTabControlState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["revision", "tabs"])
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.tabs)) return null;
  const tabs: BrowserTabControlView[] = [];
  const handles = new Set<string>();
  const rendererIds = new Set<string>();
  for (const item of value.tabs) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["tabId", "rendererTabId", "url", "title", "mode", "owner", "lease", "generation", "kind", "openerTabId"])) return null;
    if (typeof item.tabId !== "string" || item.tabId.length === 0 || handles.has(item.tabId)
      || typeof item.url !== "string" || typeof item.title !== "string"
      || !Number.isSafeInteger(item.generation) || (item.generation as number) < 0
      || (item.mode !== "human" && item.mode !== "agent-active" && item.mode !== "human-paused")
      || (item.kind !== "embedded" && item.kind !== "popup")
      || (item.openerTabId !== null && (typeof item.openerTabId !== "string" || item.openerTabId.length === 0))) return null;
    if (item.kind === "embedded") {
      if (typeof item.rendererTabId !== "string" || item.rendererTabId.length === 0 || rendererIds.has(item.rendererTabId)
        || item.openerTabId !== null) return null;
      rendererIds.add(item.rendererTabId);
    } else if (item.rendererTabId !== null || item.openerTabId === null || item.openerTabId === item.tabId) return null;
    const owner = item.owner === null ? null : parseActor(item.owner);
    if (item.owner !== null && owner === null) return null;
    let lease: BrowserControlLease | null = null;
    if (item.lease !== null) {
      if (!isRecord(item.lease) || !hasOnlyKeys(item.lease, ["id", "actor", "lifetime"])
        || typeof item.lease.id !== "string" || item.lease.id.length === 0
        || (item.lease.lifetime !== "owned" && item.lease.lifetime !== "borrowed")) return null;
      const actor = parseActor(item.lease.actor);
      if (actor === null || (item.lease.lifetime === "owned") !== (owner !== null)
        || item.mode === "human"
        || (owner !== null && owner.sessionId !== actor.sessionId
          && owner.directParentSessionId !== actor.sessionId && actor.directParentSessionId !== owner.sessionId)) return null;
      lease = { id: item.lease.id, actor, lifetime: item.lease.lifetime };
    }
    handles.add(item.tabId);
    tabs.push({
      tabId: item.tabId, rendererTabId: item.rendererTabId as string | null, url: item.url, title: item.title,
      mode: item.mode, owner, lease, generation: item.generation as number, kind: item.kind,
      openerTabId: item.openerTabId as string | null,
    });
  }
  return { revision: value.revision as number, tabs };
}
