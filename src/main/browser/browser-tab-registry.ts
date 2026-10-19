/**
 * Main-process registry of the browser tabs each main window hosts — the one
 * authority on what the agent browser tools may touch.
 *
 * FEED. Every guest `<webview>` on the side browser's partition that a main
 * window attaches is recorded here with its window (`did-attach-webview` in
 * main-window.ts), wherever the renderer mounted it. The renderer then BINDS
 * its own tab id to that guest (`ave:browser:bind-tab`); main accepts the bind
 * only for a guest it saw attach to the sender's own window, so a renderer
 * cannot point a tab id at another window's page. A tab that is remounted
 * with a new guest is bound again and keeps its handle and provenance.
 *
 * HANDLES. Tools name a tab by an opaque handle main mints (`tab-<n>`), unique
 * across windows. The approval hooks see only a tool's input — no session, no
 * window — so they resolve a handle to its origin here; execute then enforces
 * the window scope, and a handle of another window answers exactly like one
 * that does not exist.
 *
 * PROVENANCE. A tab is the agent's only when main created it for
 * `browser_tab_new` and the renderer's bind echoes that request's id. The
 * badge's stop button releases it to the user for good.
 *
 * USER INPUT. Keyboard or mouse input the user gives an agent-controlled tab
 * aborts the tab's pending tool actions. Input the tools inject themselves is
 * fenced off with {@link BrowserTabRegistry.withAgentInput}.
 *
 * ACTIVE SURFACE. Per window, the browser/terminal tab the user is looking at
 * — a hint tools default to when no tab is named, never an authority.
 */
import type { WebContents } from "electron";
import type {
  ActiveWorkspaceSurface,
  BrowserTabBindRequest,
  BrowserTabBindResult,
  BrowserTabControlState,
  BrowserTabOpRequest,
} from "../../shared/browser-surface.js";
import type { BrowserTabOpener } from "../../shared/permissions-events.js";
import { browserOrigin } from "../../shared/browser-tools.js";

/** What the registry needs of a guest. Production passes Electron `WebContents`. */
export interface BrowserGuest {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
}

export interface BrowserTabRecord<G extends BrowserGuest> {
  readonly handle: string;
  readonly windowId: number;
  readonly rendererTabId: string;
  guest: G | null;
  opener: BrowserTabOpener;
  documentId: number;
  agentOrigin: string | null;
  /** Aborted (and replaced) on user input into an agent tab, on stop, and on unbind. */
  actions: AbortController;
}

/** One tab as a tool sees it. */
export interface BrowserTabView {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly openedBy: BrowserTabOpener;
  readonly active: boolean;
}

/** How the registry reaches a window's renderer. Installed by the browser IPC domain. */
export interface BrowserTabRendererLink {
  sendTabOp(windowId: number, request: BrowserTabOpRequest): boolean;
  sendControl(windowId: number, state: BrowserTabControlState): void;
}

export type BrowserTabOpOutcome =
  | { readonly ok: true; readonly tabId: string }
  | { readonly ok: false; readonly error: "no-window-renderer" | "timeout" | "aborted" | "no-such-tab" };

interface PendingTabOp {
  readonly windowId: number;
  readonly request: BrowserTabOpRequest;
  readonly attachmentSequence: number;
  readonly settle: (outcome: BrowserTabOpOutcome) => void;
}

/** How long the renderer has to carry out a tab operation. */
const BROWSER_TAB_OP_TIMEOUT_MS = 15_000;

const AGENT_INPUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "keyDown",
  "rawKeyDown",
  "char",
  "mouseDown",
  "mouseWheel",
]);

const DEBUGGER_INPUT_MODIFIER = 1 << 23;
const DERIVED_TAP_MODIFIERS = 1 << 25;

/**
 * Whether a tap gesture's modifiers fit one derived from an injected touch.
 * The derived gestures do not carry the debugger bit; measured in the app,
 * they arrive with either the derived-tap bit or no modifiers at all. Any
 * other bit (a held key) is not part of the injected sequence. The sequence
 * itself — a marked touch first, each gesture once, in order — is what
 * attributes them; a user's own tap starts with an unmarked touch.
 */
function isDerivedTapModifiers(modifiers: number): boolean {
  return modifiers === 0 || modifiers === DERIVED_TAP_MODIFIERS;
}

/** Whether an input event type is the user acting on the page (not hovering). */
export function isUserActionInputType(type: string): boolean {
  return AGENT_INPUT_EVENT_TYPES.has(type);
}

export class BrowserTabRegistry<G extends BrowserGuest> {
  private readonly attached = new Map<number, { guest: G; windowId: number; sequence: number }>();
  private readonly tabs = new Map<string, BrowserTabRecord<G>>();
  private readonly handleByWindowTab = new Map<string, string>();
  // A takeover before bind must also prevent a pending new-tab request from granting ownership later.
  private readonly userOwnedTabs = new Set<string>();
  private readonly activeSurface = new Map<number, ActiveWorkspaceSurface>();
  private readonly pending = new Map<string, PendingTabOp>();
  private nextAttachment = 0;
  private readonly injectedTouches = new Map<number, { pressed: boolean; down: boolean; shown: boolean }>();
  private link: BrowserTabRendererLink | null = null;
  private nextHandle = 1;
  private nextRequest = 1;

  setRendererLink(link: BrowserTabRendererLink | null): void {
    this.link = link;
  }

  // ── feed ────────────────────────────────────────────────────────────────

  /** A browser guest attached to `windowId`. Call `guestDestroyed` when it goes. */
  guestAttached(guest: G, windowId: number): void {
    this.attached.set(guest.id, { guest, windowId, sequence: ++this.nextAttachment });
  }

  guestDestroyed(guestId: number): void {
    this.attached.delete(guestId);
    this.injectedTouches.delete(guestId);
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      tab.guest = null;
      tab.actions.abort(new Error("the tab's page was closed"));
      tab.actions = new AbortController();
      this.settlePending((op) => op.request.op === "close" && op.request.tabId === tab.handle, { ok: true, tabId: tab.handle });
      this.broadcastControl(tab.windowId);
    }
  }

  /** Bind a renderer tab id to an attached guest of the sender's window. */
  bindTab(senderWindowId: number, request: BrowserTabBindRequest): BrowserTabBindResult {
    const entry = this.attached.get(request.webContentsId);
    if (!entry || entry.guest.isDestroyed()) return { ok: false, error: "guest-not-live" };
    if (entry.windowId !== senderWindowId) return { ok: false, error: "guest-not-hosted" };
    const key = windowTabKey(senderWindowId, request.tabId);
    const takenOver = this.userOwnedTabs.has(key);
    let handle = this.handleByWindowTab.get(key);
    let tab = handle === undefined ? undefined : this.tabs.get(handle);
    const pendingNew = request.requestId === undefined ? undefined : this.pending.get(request.requestId);
    if (pendingNew?.request.op === "new" && pendingNew.windowId === senderWindowId) {
      if (entry.sequence <= pendingNew.attachmentSequence || tab?.guest
        || [...this.tabs.values()].some((other) => other.guest?.id === entry.guest.id)) {
        return { ok: false, error: "guest-not-hosted" };
      }
      if (entry.guest.getURL() === "") return { ok: false, error: "guest-not-live" };
      // A taken-over bootstrap may already show the user's page; it receives no agent authority.
      if (!takenOver && entry.guest.getURL() !== "about:blank") return { ok: false, error: "guest-not-hosted" };
    }
    if (!tab) {
      handle = `tab-${this.nextHandle++}`;
      tab = {
        handle,
        windowId: senderWindowId,
        rendererTabId: request.tabId,
        guest: null,
        opener: "user",
        documentId: 1,
        agentOrigin: null,
        actions: new AbortController(),
      };
      this.tabs.set(handle, tab);
      this.handleByWindowTab.set(key, handle);
    }
    // A guest moves to exactly one tab: unbind it from any other.
    for (const other of this.tabs.values()) {
      if (other !== tab && other.guest?.id === entry.guest.id) {
        other.guest = null;
        other.documentId++;
        other.actions.abort(new Error("the tab's page moved"));
        other.actions = new AbortController();
        this.broadcastControl(other.windowId);
      }
    }
    if (tab.guest !== entry.guest) {
      tab.documentId++;
      tab.actions.abort(new Error("the tab's page was replaced"));
      tab.actions = new AbortController();
    }
    tab.guest = entry.guest;
    if (pendingNew && pendingNew.windowId === senderWindowId && pendingNew.request.op === "new") {
      tab.opener = takenOver ? "user" : "agent";
      tab.agentOrigin = takenOver ? null : browserOrigin(pendingNew.request.url);
      this.pending.delete(request.requestId!);
      pendingNew.settle(takenOver ? { ok: false, error: "aborted" } : { ok: true, tabId: tab.handle });
    }
    this.settleSelectIfShown(senderWindowId);
    this.broadcastControl(senderWindowId);
    return { ok: true };
  }

  /** Stop or user navigation: revoke authority even before the tab's first bind. */
  stop(senderWindowId: number, rendererTabId: string): boolean {
    const key = windowTabKey(senderWindowId, rendererTabId);
    this.userOwnedTabs.add(key);
    const handle = this.handleByWindowTab.get(key);
    const tab = handle === undefined ? undefined : this.tabs.get(handle);
    if (!tab) return true;
    tab.opener = "user";
    tab.agentOrigin = null;
    tab.actions.abort(new Error("the user stopped the agent in this tab"));
    tab.actions = new AbortController();
    this.broadcastControl(senderWindowId);
    return true;
  }

  /**
   * The user gave a guest keyboard or mouse input. In an agent-controlled tab
   * this cancels the pending tool actions; input the tools inject is ignored.
   */
  userInput(guestId: number, input?: { type: string; _modifiers?: number }): void {
    const modifiers = input?._modifiers ?? 0;
    // Native provenance marks the raw injected touch and key events.
    if (input && input.type !== "mouseDown" && (modifiers & DEBUGGER_INPUT_MODIFIER) !== 0) {
      if (input.type === "touchStart") this.injectedTouches.set(guestId, { pressed: true, down: false, shown: false });
      if (input.type === "touchEnd") {
        const touch = this.injectedTouches.get(guestId);
        if (touch) touch.pressed = false;
      }
      if (input.type === "touchCancel") this.injectedTouches.delete(guestId);
      return;
    }
    const touch = this.injectedTouches.get(guestId);
    // Match only the native tap sequence derived from that marked contact.
    // An unmarked contact, key, mouse or other gesture still cancels below.
    if (touch && isDerivedTapModifiers(modifiers)) {
      if (input?.type === "gestureTapDown" && touch.pressed && !touch.down) {
        touch.down = true;
        return;
      }
      if (input?.type === "gestureShowPress" && touch.down && !touch.shown) {
        touch.shown = true;
        return;
      }
      if (input?.type === "gestureTap" && touch.down && !touch.pressed) {
        this.injectedTouches.delete(guestId);
        return;
      }
    }
    this.injectedTouches.delete(guestId);
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      tab.actions.abort(new Error("the user took over this tab"));
      tab.actions = new AbortController();
    }
  }

  /**
   * The agent's action in `guestId`'s tab is done: ask the window's renderer
   * to give keyboard focus back to what held it before. Fire-and-forget; the
   * page actions watch the page lose focus.
   */
  releaseFocus(guestId: number): void {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      this.link?.sendTabOp(tab.windowId, {
        requestId: `browser-op-${this.nextRequest++}`,
        op: "restore-focus",
        tabId: tab.rendererTabId,
      });
      return;
    }
  }

  /** Group an operation; native event provenance owns its individual inputs. */
  async withAgentInput<T>(_guestId: number, inject: () => Promise<T>): Promise<T> {
    return inject();
  }

  /** Invalidate document authority before the next main-frame load commits. */
  navigationStarted(guestId: number, url: string): void {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      tab.documentId++;
      this.checkProvenance(tab, url);
    }
  }

  documentChanged(guestId: number): void {
    for (const tab of this.tabs.values()) if (tab.guest?.id === guestId) tab.documentId++;
  }

  // ── active surface ─────────────────────────────────────────────────────

  setActiveSurface(windowId: number, surface: ActiveWorkspaceSurface | null): void {
    if (surface === null) this.activeSurface.delete(windowId);
    else this.activeSurface.set(windowId, surface);
    this.settleSelectIfShown(windowId);
  }

  getActiveSurface(windowId: number): ActiveWorkspaceSurface | undefined {
    return this.activeSurface.get(windowId);
  }

  /** The renderer id of the window's active terminal tab, if a terminal is the active surface. */
  activeTerminalTabId(windowId: number): string | undefined {
    const surface = this.activeSurface.get(windowId);
    return surface?.kind === "terminal" ? surface.tabId : undefined;
  }

  /** The handle of the window's active browser tab, if one is shown and bound. */
  activeBrowserTab(windowId: number): string | undefined {
    const surface = this.activeSurface.get(windowId);
    if (surface?.kind !== "browser") return undefined;
    const handle = this.handleByWindowTab.get(windowTabKey(windowId, surface.tabId));
    const tab = handle === undefined ? undefined : this.tabs.get(handle);
    return tab && this.isLive(tab) ? tab.handle : undefined;
  }

  // ── lookups ────────────────────────────────────────────────────────────

  /** A live tab by handle, in any window. For approval hooks, which have no session. */
  liveTab(handle: string): BrowserTabRecord<G> | undefined {
    const tab = this.tabs.get(handle);
    if (tab?.guest) this.checkProvenance(tab, tab.guest.getURL());
    return tab && this.isLive(tab) ? tab : undefined;
  }

  /** A live tab of `windowId`. Another window's tab answers like a missing one. */
  liveTabInWindow(handle: string, windowId: number): BrowserTabRecord<G> | undefined {
    const tab = this.liveTab(handle);
    return tab && tab.windowId === windowId ? tab : undefined;
  }

  listTabs(windowId: number): BrowserTabView[] {
    const active = this.activeBrowserTab(windowId);
    return [...this.tabs.values()]
      .filter((tab) => tab.windowId === windowId && this.isLive(tab))
      .map((tab) => ({
        tabId: tab.handle,
        url: tab.guest!.getURL(),
        title: tab.guest!.getTitle(),
        openedBy: tab.opener,
        active: tab.handle === active,
      }));
  }

  // ── tab UI operations ──────────────────────────────────────────────────

  /**
   * Ask the window's renderer to open, select or close a tab, and resolve
   * when main observes it done (a bind echoing the request, the tab shown, the
   * guest gone). Never resolves `ok` on the renderer's say-so alone.
   */
  requestTabOp(
    windowId: number,
    op: { op: "new"; url: string; sessionId?: string } | { op: "select" | "close"; tabId: string },
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BrowserTabOpOutcome> {
    if (op.op !== "new" && !this.liveTabInWindow(op.tabId, windowId)) {
      return Promise.resolve({ ok: false, error: "no-such-tab" });
    }
    const requestId = `browser-op-${this.nextRequest++}`;
    const request: BrowserTabOpRequest = op.op === "new"
      ? { requestId, op: "new", url: "about:blank", ...(op.sessionId === undefined ? {} : { sessionId: op.sessionId }) }
      : { requestId, op: op.op, tabId: this.tabs.get(op.tabId)!.rendererTabId };
    return new Promise<BrowserTabOpOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ ok: false, error: "aborted" });
      const settle = (outcome: BrowserTabOpOutcome) => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        resolve(outcome);
      };
      // Keep the handle main knows (not the renderer id) for close/select.
      const pendingRequest: BrowserTabOpRequest = op.op === "new" ? { ...request, ...op } : { requestId, op: op.op, tabId: op.tabId };
      this.pending.set(requestId, { windowId, request: pendingRequest, attachmentSequence: this.nextAttachment, settle });
      if (options.signal?.aborted) {
        settle({ ok: false, error: "aborted" });
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle({ ok: false, error: "timeout" }), options.timeoutMs ?? BROWSER_TAB_OP_TIMEOUT_MS);
      if (!this.link || !this.link.sendTabOp(windowId, request)) {
        settle({ ok: false, error: "no-window-renderer" });
        return;
      }
      if (op.op === "select") this.settleSelectIfShown(windowId);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private isLive(tab: BrowserTabRecord<G>): boolean {
    return tab.guest !== null && !tab.guest.isDestroyed();
  }

  private checkProvenance(tab: BrowserTabRecord<G>, url: string): void {
    // The initial empty document is never an independently approved site.
    if (url === "" || url === "about:blank") return;
    if (tab.opener !== "agent" || browserOrigin(url) === tab.agentOrigin) return;
    tab.opener = "user";
    tab.agentOrigin = null;
    this.broadcastControl(tab.windowId);
  }

  private settleSelectIfShown(windowId: number): void {
    const active = this.activeBrowserTab(windowId);
    if (active === undefined) return;
    this.settlePending(
      (op) => op.windowId === windowId && op.request.op === "select" && op.request.tabId === active,
      { ok: true, tabId: active },
    );
  }

  private settlePending(match: (op: PendingTabOp) => boolean, outcome: BrowserTabOpOutcome): void {
    for (const op of [...this.pending.values()]) {
      if (match(op)) op.settle(outcome);
    }
  }

  private broadcastControl(windowId: number): void {
    const agentControlledTabIds = [...this.tabs.values()]
      .filter((tab) => tab.windowId === windowId && tab.opener === "agent" && this.isLive(tab))
      .map((tab) => tab.rendererTabId);
    this.link?.sendControl(windowId, { agentControlledTabIds });
  }

  /** Test-only. */
  __reset(): void {
    this.attached.clear();
    this.tabs.clear();
    this.handleByWindowTab.clear();
    this.userOwnedTabs.clear();
    this.activeSurface.clear();
    this.pending.clear();
    this.injectedTouches.clear();
    this.link = null;
    this.nextHandle = 1;
    this.nextRequest = 1;
    this.nextAttachment = 0;
  }
}

function windowTabKey(windowId: number, tabId: string): string {
  return `${windowId}\u0000${tabId}`;
}

/** The process-wide registry of the main windows' browser tabs. */
export const browserTabRegistry = new BrowserTabRegistry<WebContents>();
