/** Main owns tab authority; renderer-issued ids are unique per window and omit UI placement. */
import { hasOnlyKeys, isRecord } from "./is-record.js";

type WorkspaceSurfaceKind = "browser" | "terminal";

/** Active surface is a default-selection hint, never authority; explicit tab ids win. */
export interface ActiveWorkspaceSurface {
  readonly kind: WorkspaceSurfaceKind;
  readonly tabId: string;
}

/** Accept only live guests in the expected partition and sender window; requestId proves agent-created tab provenance. */
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

/** Complete operations from observed bind, activation, or destruction rather than renderer claims. */
export type BrowserTabOpRequest =
  /**
   * `sessionId` names the conversation the tab is opened for (a sub-agent's
   * parent), so a window with several chats opens it beside that one.
   */
  /** `inTabId` loads the page into that existing, still empty renderer tab (a pane chat's own page) instead of a new one. */
  | { readonly requestId: string; readonly op: "new"; readonly url: string; readonly active: boolean; readonly sessionId?: string; readonly inTabId?: string }
  | { readonly requestId: string; readonly op: "select"; readonly tabId: string }
  | { readonly requestId: string; readonly op: "close"; readonly tabId: string }
  /** Focus this existing renderer slot without selecting or moving another surface. */
  | { readonly requestId: string; readonly op: "focus"; readonly tabId: string }
  /** Restore the window’s prior keyboard focus after tool actions without awaiting a renderer acknowledgement. */
  | { readonly requestId: string; readonly op: "restore-focus"; readonly tabId: string };

export function parseBrowserTabOpRequest(value: unknown): BrowserTabOpRequest | null {
  if (!isRecord(value)) return null;
  const record = value as { requestId?: unknown; op?: unknown; url?: unknown; active?: unknown; tabId?: unknown };
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;
  if (record.op === "new") {
    if (!hasOnlyKeys(value, ["requestId", "op", "url", "active", "sessionId", "inTabId"])) return null;
    if (typeof record.url !== "string" || typeof record.active !== "boolean") return null;
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) return null;
    const inTabId = (value as { inTabId?: unknown }).inTabId;
    if (inTabId !== undefined && (typeof inTabId !== "string" || inTabId.length === 0)) return null;
    return {
      requestId: record.requestId,
      op: "new",
      url: record.url,
      active: record.active,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      ...(typeof inTabId === "string" ? { inTabId } : {}),
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

/** Durable tab facts. Creator identity and a pane's own chat are distinct roles. */
export interface SessionTabBindingMetadata {
  readonly owner?: BrowserSessionActor;
  readonly paneSessionId?: string;
}

interface SessionTabBinding {
  readonly sessionId: string;
  /** Renderer slot ids. A direct child's tab also appears under its existing parent identity. */
  readonly browserTabIds: readonly string[];
  readonly terminalTabIds: readonly string[];
}

/** Window-scoped full snapshot; subscribe before querying and compare revisions. */
export interface SessionTabBindingsState {
  readonly revision: number;
  readonly bindings: readonly SessionTabBinding[];
}

export function parseSessionTabBindingsState(value: unknown): SessionTabBindingsState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["revision", "bindings"])
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.bindings)) return null;
  const sessions = new Set<string>();
  const bindings: SessionTabBinding[] = [];
  for (const item of value.bindings) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["sessionId", "browserTabIds", "terminalTabIds"])
      || typeof item.sessionId !== "string" || item.sessionId.length === 0 || sessions.has(item.sessionId)) return null;
    const ids = (value: unknown): value is string[] => Array.isArray(value)
      && value.every((id) => typeof id === "string" && id.length > 0) && new Set(value).size === value.length;
    if (!ids(item.browserTabIds) || !ids(item.terminalTabIds)) return null;
    sessions.add(item.sessionId);
    bindings.push({ sessionId: item.sessionId, browserTabIds: [...item.browserTabIds], terminalTabIds: [...item.terminalTabIds] });
  }
  return { revision: value.revision as number, bindings };
}

export interface BrowserControlLease {
  readonly id: string;
  readonly actor: BrowserSessionActor;
  /** Owned follows the durable creator; a borrowed release never destroys the human resource. */
  readonly lifetime: "owned" | "borrowed";
}

export interface BrowserTabControlView {
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

/** Subscribe before fetching state and discard stale revisions; snapshots are authoritative only within their window. */
export interface BrowserTabControlState {
  readonly revision: number;
  readonly tabs: readonly BrowserTabControlView[];
}

/** Trusted window chrome only; page content never receives this API. */
export interface BrowserTabsApi {
  bindTab(request: BrowserTabBindRequest): Promise<BrowserTabBindResult>;
  getState(): Promise<BrowserTabControlState>;
  getSessionBindings(): Promise<SessionTabBindingsState>;
  onSessionBindingsChanged(handler: (state: SessionTabBindingsState) => void): () => void;
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

export function parseBrowserSessionActor(value: unknown): BrowserSessionActor | null {
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
    const owner = item.owner === null ? null : parseBrowserSessionActor(item.owner);
    if (item.owner !== null && owner === null) return null;
    let lease: BrowserControlLease | null = null;
    if (item.lease !== null) {
      if (!isRecord(item.lease) || !hasOnlyKeys(item.lease, ["id", "actor", "lifetime"])
        || typeof item.lease.id !== "string" || item.lease.id.length === 0
        || (item.lease.lifetime !== "owned" && item.lease.lifetime !== "borrowed")) return null;
      const actor = parseBrowserSessionActor(item.lease.actor);
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
