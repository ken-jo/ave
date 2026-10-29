// Bind tabs only to guests observed in the sender’s window; opaque handles never bypass window scope.
// Human input pauses mutation; active-surface hints are not authority and missing bound tabs must fail.
// Layout restores creator and pane-conversation identity, never control leases or origin approvals.
import type { WebContents } from "electron";
import type {
  ActiveWorkspaceSurface,
  BrowserTabBindRequest,
  BrowserTabBindResult,
  BrowserTabControlState,
  BrowserControlMode,
  BrowserControlLease,
  BrowserSessionActor,
  BrowserTabControlView,
  BrowserTabOpRequest,
  SessionTabBindingsState,
} from "../../shared/browser-surface.js";
import type { MainLayoutSnapshot, SavedSurface } from "../../shared/main-layout.js";
import { createLogger } from "../../lib/logger.js";
import type { BrowserTabOpener } from "../../shared/permissions-events.js";
import { browserOrigin } from "../../shared/browser-tools.js";

const log = createLogger("session-tab-bindings");

interface WorkspaceTabBinding {
  readonly windowId: number;
  readonly surface: ActiveWorkspaceSurface;
  owner: BrowserSessionActor | null;
  paneSessionId?: string;
  // Keep a closing pane turn addressed to its missing tab until its loop ends.
  closed?: boolean;
}

export interface SessionTabBindingPersistence {
  savedWindowId(): number | undefined;
  // Only the primary window owns the saved layout.
  load(windowId: number): MainLayoutSnapshot | undefined;
  save(windowId: number, layout: MainLayoutSnapshot): Promise<void>;
  sessionExists(sessionId: string): boolean;
  // Read only when a saved slot predates binding persistence.
  legacyPaneSession?(tabId: string): string | undefined;
}

// What one injected press's touch input did, by the guests' own native input events.
export interface TouchDeliveryReport {
  started: boolean;
  ended: boolean;
  tapped: boolean;
  elsewhere: number;
}

export interface MouseDeliveryReport {
  pressed: boolean;
  released: boolean;
  elsewhere: number;
}

export interface WheelDeliveryReport {
  started: boolean;
  ended: boolean;
  elsewhere: number;
}

export interface BrowserMouseExpectation {
  readonly type: "mouseDown" | "mouseUp";
  readonly x: number;
  readonly y: number;
  readonly button: "left";
  readonly clickCount: 1;
}

interface NativeBrowserInput {
  readonly type: string;
  readonly _modifiers?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: string;
  readonly clickCount?: number;
}

interface PointerWatchState {
  readonly guestId: number;
  readonly windowId: number;
  readonly deadline: number;
  invalid: boolean;
}

interface MouseWatchState extends PointerWatchState {
  readonly report: MouseDeliveryReport;
  expected: { input: BrowserMouseExpectation; deadline: number } | null;
}

interface WheelWatchState extends PointerWatchState {
  readonly report: WheelDeliveryReport;
  markers: number;
  phase: "waiting" | "marked" | "begun" | "updated" | "ended";
}

interface TouchWatchState {
  readonly guestId: number;
  readonly windowId: number | undefined;
  readonly report: TouchDeliveryReport;
}

// What the registry needs of a guest. Production passes Electron `WebContents`.
export interface BrowserGuest {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  // Native focus capability; operations that require it reject when unavailable.
  isFocused?(): boolean;
}

// A document transition invalidated the old page; it grants no further input authority.
export class BrowserDocumentChangedError extends Error {
  readonly code = "browser-document-changed";

  constructor() {
    super("the browser document changed");
    this.name = "BrowserDocumentChangedError";
  }
}

export interface BrowserTabRecord<G extends BrowserGuest> {
  readonly handle: string;
  readonly windowId: number;
  readonly rendererTabId: string | null;
  guest: G | null;
  opener: BrowserTabOpener;
  documentId: number;
  agentOrigin: string | null;
  controlMode: BrowserControlMode;
  controlGeneration: number;
  readonly targetKind: "embedded" | "popup";
  readonly openerTabId: string | null;
  owner: BrowserSessionActor | null;
  // Embedded records retain this same object through temporary guest remounts.
  readonly binding?: WorkspaceTabBinding;
  lease: BrowserControlLease | null;
  // Aborted on pause; only explicit Resume may replace a paused controller.
  actions: AbortController;
}

// One tab as a tool sees it.
export interface BrowserTabView extends BrowserTabControlView {
  readonly openedBy: BrowserTabOpener;
  readonly active: boolean;
}

// How the registry reaches a window's renderer. Installed by the browser IPC domain.
export interface BrowserTabRendererLink {
  sendTabOp(windowId: number, request: BrowserTabOpRequest): boolean;
  sendControl(windowId: number, state: BrowserTabControlState): void;
  sendSessionBindings?(windowId: number, state: SessionTabBindingsState): void;
  // Native window visibility proof, required before any explicit focus request.
  isWindowVisible?(windowId: number): boolean;
}

// The tab a conversation's browser tools act on when none is named — or why there is none.
export type DefaultBrowserTab =
  | { readonly ok: true; readonly handle: string }
  | { readonly ok: false; readonly error: string };

const NO_SHOWN_BROWSER_TAB = "no browser tab is shown; pass a tabId from browser_tabs or open one with browser_tab_new";

export type BrowserTabOpOutcome =
  | { readonly ok: true; readonly tabId: string; readonly retained?: true }
  | { readonly ok: false; readonly error: "no-window-renderer" | "timeout" | "aborted" | "no-such-tab" | "not-authorized" | "control-paused" | "native-operation-failed" };

type RequestedTabOp =
  | { readonly op: "new"; readonly url: string; readonly sessionId?: string; readonly actor?: BrowserSessionActor; readonly active?: boolean }
  | { readonly op: "select" | "close"; readonly tabId: string; readonly actor?: BrowserSessionActor };

interface PendingTabOp {
  readonly windowId: number;
  readonly request: BrowserTabOpRequest;
  readonly attachmentSequence: number;
  readonly actor: BrowserSessionActor | undefined;
  readonly settle: (outcome: BrowserTabOpOutcome) => void;
}

// How long the renderer has to carry out a tab operation.
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
const POINTER_SEQUENCE_MAX_MS = 5_000;
const MOUSE_RECEIPT_MAX_MS = 1_000;
const FOCUS_RECEIPT_MAX_MS = 1_000;
const FOCUS_RECEIPT_POLL_MS = 20;

// Derived taps may omit debugger modifiers; attribute them by an ordered marked touch sequence, rejecting any unrelated held-key bits.
function isDerivedTapModifiers(modifiers: number): boolean {
  return modifiers === 0 || modifiers === DERIVED_TAP_MODIFIERS;
}

// Whether an input event type is the user acting on the page (not hovering).
export function isUserActionInputType(type: string): boolean {
  return AGENT_INPUT_EVENT_TYPES.has(type);
}

export class BrowserTabRegistry<G extends BrowserGuest> {
  private readonly attached = new Map<number, { guest: G; windowId: number; sequence: number }>();
  private readonly tabs = new Map<string, BrowserTabRecord<G>>();
  private readonly handleByWindowTab = new Map<string, string>();
  // A takeover before bind must also prevent a pending new-tab request from granting control later.
  private readonly userOwnedTabs = new Set<string>();
  private readonly pausedControllers = new Map<string, BrowserSessionActor>();
  private readonly nativeTabs = new Map<string, { select(): boolean | Promise<boolean>; close(): void }>();
  private readonly activePopup = new Map<number, string>();
  private readonly revisions = new Map<number, number>();
  private readonly activeSurface = new Map<number, ActiveWorkspaceSurface>();
  private readonly workspaceBindings = new Map<string, WorkspaceTabBinding>();
  // Final logical closes reject delayed guest binds and pane sends until the window resets.
  private readonly retiredWorkspaceTabs = new Set<string>();
  private readonly bindingRevisions = new Map<number, number>();
  private readonly restoredBindingWindows = new Set<number>();
  private bindingPersistence: SessionTabBindingPersistence | null = null;
  private bindingWrites: Promise<void> = Promise.resolve();
  // Pane tabs an agent asked to close while a conversation was bound to them.
  private readonly closingByAgent = new Set<string>();
  private readonly pending = new Map<string, PendingTabOp>();
  private nextAttachment = 0;
  private readonly injectedTouches = new Map<number, { pressed: boolean; down: boolean; shown: boolean }>();
  private readonly touchWatches = new Set<TouchWatchState>();
  private readonly mouseWatches = new Set<MouseWatchState>();
  private readonly wheelWatches = new Set<WheelWatchState>();
  private link: BrowserTabRendererLink | null = null;
  private nextHandle = 1;
  private nextRequest = 1;
  private nextLease = 1;

  setRendererLink(link: BrowserTabRendererLink | null): void {
    this.link = link;
  }

  setBindingPersistence(persistence: SessionTabBindingPersistence): void {
    this.bindingPersistence = persistence;
  }

  // Await durable writes at shutdown and in restart validation.
  async flushBindingWrites(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.bindingWrites;
      await pending;
    } while (pending !== this.bindingWrites);
  }

  // Layout writes carry bindings too, including geometry-only renderer updates.
  trackBindingWrite(write: Promise<unknown>): void {
    this.bindingWrites = Promise.all([this.bindingWrites.catch(() => undefined), write]).then(() => undefined);
    void this.bindingWrites.catch((error: unknown) => log.error("Tab binding persistence failed: %s", error));
  }

  private workspaceBinding(windowId: number, surface: ActiveWorkspaceSurface): WorkspaceTabBinding {
    const key = windowTabKey(windowId, surface.tabId);
    let binding = this.workspaceBindings.get(key);
    if (!binding) {
      const handle = this.handleByWindowTab.get(key);
      binding = (handle === undefined ? undefined : this.tabs.get(handle)?.binding)
        ?? { windowId, surface: { ...surface }, owner: null };
      this.workspaceBindings.set(key, binding);
    }
    return binding;
  }

  private restoreBindings(windowId: number): void {
    if (!this.bindingPersistence || this.restoredBindingWindows.has(windowId)) return;
    const layout = this.bindingPersistence.load(windowId);
    if (!layout) { this.restoredBindingWindows.add(windowId); return; }
    let changed = false;
    for (const surface of [...Object.values(layout.surfaces), ...Object.values(layout.sideTabs).flat()]) {
      const binding = this.workspaceBinding(windowId, { kind: surface.kind, tabId: surface.tabId });
      const owner = surface.binding?.owner;
      // Absence is the old layout format; an empty binding is an explicit clear.
      const paneSessionId = surface.binding === undefined
        ? this.bindingPersistence.legacyPaneSession?.(surface.tabId)
        : surface.binding.paneSessionId;
      if (surface.binding === undefined) changed = true;
      if (owner) {
        if (this.bindingPersistence.sessionExists(owner.sessionId)) {
          if (owner.directParentSessionId !== undefined && !this.bindingPersistence.sessionExists(owner.directParentSessionId)) {
            binding.owner = copyActor({ sessionId: owner.sessionId });
            changed = true;
            log.info("Pruned tab binding: session-missing (tab=%s, session=%s)", surface.tabId, owner.directParentSessionId);
          } else binding.owner = copyActor(owner);
        } else {
          changed = true;
          log.info("Pruned tab binding: session-missing (tab=%s, session=%s)", surface.tabId, owner.sessionId);
        }
      }
      if (paneSessionId) {
        if (this.bindingPersistence.sessionExists(paneSessionId)) binding.paneSessionId = paneSessionId;
        else {
          changed = true;
          log.info("Pruned tab binding: session-missing (tab=%s, session=%s)", surface.tabId, paneSessionId);
        }
      }
    }
    this.restoredBindingWindows.add(windowId);
    if (changed) this.bindingsChanged(windowId);
    else this.publishBindings(windowId);
  }

  private restoreSavedBindings(): void {
    const windowId = this.bindingPersistence?.savedWindowId();
    if (windowId !== undefined) this.restoreBindings(windowId);
  }

  // Main decorates renderer geometry; renderer-supplied ownership is never accepted.
  prepareLayoutBindings(windowId: number, layout: MainLayoutSnapshot): MainLayoutSnapshot {
    this.restoreBindings(windowId);
    const surfaces = [...Object.values(layout.surfaces), ...Object.values(layout.sideTabs).flat()];
    const ids = new Set(surfaces.map((surface) => surface.tabId));
    for (const surface of surfaces) {
      if (!this.retiredWorkspaceTabs.has(windowTabKey(windowId, surface.tabId))) {
        this.workspaceBinding(windowId, { kind: surface.kind, tabId: surface.tabId });
      }
    }
    let changed = false;
    for (const [key, binding] of this.workspaceBindings) {
      if (binding.windowId !== windowId) continue;
      if (ids.has(binding.surface.tabId)) {
        if (binding.closed) { delete binding.closed; changed = true; }
        continue;
      }
      if (!binding.closed && (binding.owner || binding.paneSessionId)) {
        log.info("Pruned tab binding: tab-missing (tab=%s)", binding.surface.tabId);
        changed = true;
      }
      binding.closed = true;
      // Ending pane turns still need their original target. Browser records retain creator identity themselves until remount or final close.
      if (!binding.paneSessionId) this.workspaceBindings.delete(key);
      else if (!this.handleByWindowTab.has(key)) binding.owner = null;
    }
    if (changed) this.publishBindings(windowId);
    return this.layoutWithBindings(windowId, layout);
  }

  private layoutWithBindings(windowId: number, layout: MainLayoutSnapshot): MainLayoutSnapshot {
    const decorate = (surface: SavedSurface): SavedSurface => {
      const { binding: _ignored, ...geometry } = surface;
      const binding = this.workspaceBindings.get(windowTabKey(windowId, surface.tabId));
      if (!binding?.owner && !binding?.paneSessionId) return { ...geometry, binding: {} };
      return { ...geometry, binding: {
        ...(binding.owner ? { owner: copyActor(binding.owner) } : {}),
        ...(binding.paneSessionId ? { paneSessionId: binding.paneSessionId } : {}),
      } };
    };
    return { ...layout,
      surfaces: Object.fromEntries(Object.entries(layout.surfaces).map(([id, surface]) => [id, decorate(surface)])),
      sideTabs: Object.fromEntries(Object.entries(layout.sideTabs).map(([id, surfaces]) => [id, surfaces.map(decorate)])),
    };
  }

  sessionBindingsState(windowId: number): SessionTabBindingsState {
    this.restoreBindings(windowId);
    return this.bindingState(windowId);
  }

  private bindingState(windowId: number): SessionTabBindingsState {
    const bindings = new Map<string, { sessionId: string; browserTabIds: string[]; terminalTabIds: string[] }>();
    for (const binding of this.workspaceBindings.values()) {
      if (binding.windowId !== windowId || binding.closed) continue;
      for (const sessionId of new Set([binding.owner?.sessionId, binding.owner?.directParentSessionId, binding.paneSessionId])) {
        if (!sessionId) continue;
        let entry = bindings.get(sessionId);
        if (!entry) { entry = { sessionId, browserTabIds: [], terminalTabIds: [] }; bindings.set(sessionId, entry); }
        entry[binding.surface.kind === "browser" ? "browserTabIds" : "terminalTabIds"].push(binding.surface.tabId);
      }
    }
    return { revision: this.bindingRevisions.get(windowId) ?? 0, bindings: [...bindings.values()] };
  }

  private publishBindings(windowId: number): void {
    this.bindingRevisions.set(windowId, (this.bindingRevisions.get(windowId) ?? 0) + 1);
    this.link?.sendSessionBindings?.(windowId, this.bindingState(windowId));
  }

  private bindingsChanged(windowId: number): void {
    this.publishBindings(windowId);
    const persistence = this.bindingPersistence;
    const layout = persistence?.load(windowId);
    if (!persistence || !layout) return;
    // Invoke immediately: the settings service merges synchronously and serializes disk writes.
    const write = persistence.save(windowId, this.layoutWithBindings(windowId, layout));
    this.trackBindingWrite(write);
  }

  // A browser guest attached to `windowId`. Call `guestDestroyed` when it goes.
  guestAttached(guest: G, windowId: number): void {
    this.attached.set(guest.id, { guest, windowId, sequence: ++this.nextAttachment });
  }

  guestDestroyed(guestId: number): void {
    const guest = this.attached.get(guestId)?.guest;
    this.attached.delete(guestId);
    this.injectedTouches.delete(guestId);
    if (!guest) return;
    for (const tab of this.tabs.values()) {
      if (tab.guest !== guest) continue;
      tab.guest = null;
      this.invalidateActions(tab, "the tab's page was closed");
      tab.lease = null;
      if (this.activePopup.get(tab.windowId) === tab.handle) this.activePopup.delete(tab.windowId);
      this.nativeTabs.delete(tab.handle);
      this.settlePending((op) => op.request.op === "close" && op.request.tabId === tab.handle, { ok: true, tabId: tab.handle });
      if (tab.targetKind === "popup") {
        this.pausedControllers.delete(tab.handle);
        this.tabs.delete(tab.handle);
      }
      this.broadcastControl(tab.windowId);
    }
  }

  // Bind a renderer tab id to an attached guest of the sender's window.
  bindTab(senderWindowId: number, request: BrowserTabBindRequest): BrowserTabBindResult {
    this.restoreBindings(senderWindowId);
    const entry = this.attached.get(request.webContentsId);
    if (!entry || entry.guest.isDestroyed()) return { ok: false, error: "guest-not-live" };
    if (entry.windowId !== senderWindowId) return { ok: false, error: "guest-not-hosted" };
    if ([...this.tabs.values()].some((tab) => tab.targetKind === "popup" && tab.guest?.id === entry.guest.id)) {
      return { ok: false, error: "guest-not-hosted" };
    }
    const key = windowTabKey(senderWindowId, request.tabId);
    if (this.retiredWorkspaceTabs.has(key)) return { ok: false, error: "guest-not-hosted" };
    const takenOver = this.userOwnedTabs.has(key);
    let handle = this.handleByWindowTab.get(key);
    let tab = handle === undefined ? undefined : this.tabs.get(handle);
    const pendingNew = request.requestId === undefined ? undefined : this.pending.get(request.requestId);
    if (pendingNew?.request.op === "new" && pendingNew.windowId === senderWindowId) {
      if (entry.sequence <= pendingNew.attachmentSequence || tab?.guest || tab?.owner || this.workspaceBindings.get(key)?.owner
        || [...this.tabs.values()].some((other) => other.guest?.id === entry.guest.id)) {
        return { ok: false, error: "guest-not-hosted" };
      }
      if (entry.guest.getURL() === "") return { ok: false, error: "guest-not-live" };
      // A taken-over bootstrap may already show the user's page; it receives no agent authority.
      if (!takenOver && entry.guest.getURL() !== "about:blank") return { ok: false, error: "guest-not-hosted" };
    }
    const knownBinding = this.workspaceBindings.has(key);
    const binding = this.workspaceBinding(senderWindowId, { kind: "browser", tabId: request.tabId });
    if (!knownBinding && (binding.owner || binding.paneSessionId)) this.bindingsChanged(senderWindowId);
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
        // A restored creator must not revive control that the user may have paused.
        controlMode: binding.owner === null ? "human" : "human-paused",
        controlGeneration: 1,
        targetKind: "embedded",
        openerTabId: null,
        get owner() { return binding.owner; },
        set owner(owner: BrowserSessionActor | null) { binding.owner = owner; },
        binding,
        lease: null,
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
        this.invalidateActions(other, "the tab's page moved");
        other.lease = null;
        this.broadcastControl(other.windowId);
      }
    }
    if (tab.guest !== entry.guest) {
      tab.documentId++;
      this.invalidateActions(tab, "the tab's page was replaced");
      tab.lease = null;
    }
    tab.guest = entry.guest;
    if (pendingNew && pendingNew.windowId === senderWindowId && pendingNew.request.op === "new") {
      const actor = pendingNew.actor;
      tab.owner = actor ?? null;
      this.bindingsChanged(senderWindowId);
      tab.opener = takenOver || actor === undefined ? "user" : "agent";
      tab.agentOrigin = takenOver || actor === undefined ? null : browserOrigin(pendingNew.request.url);
      tab.controlMode = actor === undefined ? "human" : takenOver ? "human-paused" : "agent-active";
      if (takenOver && actor) {
        this.pausedControllers.set(tab.handle, actor);
        tab.actions.abort(new Error("the user stopped the agent in this tab"));
      }
      this.pending.delete(request.requestId!);
      pendingNew.settle(takenOver ? { ok: false, error: "aborted" } : { ok: true, tabId: tab.handle });
    }
    this.settleSelectIfShown(senderWindowId);
    this.broadcastControl(senderWindowId);
    return { ok: true };
  }

  // Stop or user navigation clears origin approval, retaining the durable creator.
  stop(senderWindowId: number, rendererTabId: string): boolean {
    const key = windowTabKey(senderWindowId, rendererTabId);
    this.userOwnedTabs.add(key);
    const handle = this.handleByWindowTab.get(key);
    const tab = handle === undefined ? undefined : this.tabs.get(handle);
    if (!tab) return true;
    return this.pauseRecord(tab, true);
  }

  liveRendererTab(windowId: number, rendererTabId: string): BrowserTabRecord<G> | null {
    const handle = this.handleByWindowTab.get(windowTabKey(windowId, rendererTabId));
    return handle === undefined ? null : this.liveTabInWindow(handle, windowId) ?? null;
  }

  // A trusted chrome pause may precede the first blank bind.
  pause(windowId: number, rendererTabId: string): boolean {
    this.userOwnedTabs.add(windowTabKey(windowId, rendererTabId));
    const tab = this.liveRendererTab(windowId, rendererTabId);
    return tab === null ? false : this.pauseRecord(tab, false);
  }

  resume(windowId: number, rendererTabId: string): boolean {
    const tab = this.liveRendererTab(windowId, rendererTabId);
    return tab === null ? false : this.resumeRecord(tab);
  }

  pausePopup(windowId: number, handle: string): boolean {
    const tab = this.liveTabInWindow(handle, windowId);
    return !tab || tab.targetKind !== "popup" ? false : this.pauseRecord(tab, false);
  }

  resumePopup(windowId: number, handle: string): boolean {
    const tab = this.liveTabInWindow(handle, windowId);
    return !tab || tab.targetKind !== "popup" ? false : this.resumeRecord(tab);
  }

  private resumeRecord(tab: BrowserTabRecord<G>): boolean {
    if (!tab || tab.controlMode !== "human-paused" || (!tab.owner && !this.pausedControllers.has(tab.handle))) return false;
    const url = tab.guest!.getURL();
    if (url !== "about:blank" && browserOrigin(url) === null) return false;
    tab.actions.abort(new Error("browser control was resumed with new authority"));
    tab.actions = new AbortController();
    tab.controlGeneration++;
    tab.lease = null;
    tab.controlMode = "agent-active";
    if (tab.rendererTabId !== null) this.userOwnedTabs.delete(windowTabKey(tab.windowId, tab.rendererTabId));
    this.broadcastControl(tab.windowId);
    return true;
  }

  assertActorAccess(tab: BrowserTabRecord<G>, actor: BrowserSessionActor): void {
    validateActor(actor);
    if (this.tabs.get(tab.handle) !== tab || !this.isLive(tab)) throw new Error("no such live browser tab");
    if (tab.owner !== null && tab.owner.sessionId !== actor.sessionId
      && tab.owner.directParentSessionId !== actor.sessionId && actor.directParentSessionId !== tab.owner.sessionId) {
      throw new Error("this browser tab belongs to another conversation");
    }
    if (tab.lease !== null && tab.lease.actor.sessionId !== actor.sessionId) {
      throw new Error("this browser tab is controlled by another conversation");
    }
  }

  acquireControl(tab: BrowserTabRecord<G>, actor: BrowserSessionActor): BrowserControlLease {
    this.assertActorAccess(tab, actor);
    if (tab.controlMode === "human-paused") throw new Error("browser control is paused; ask the user to resume this tab");
    if (tab.lease !== null) throw new Error("another browser action is still controlling this tab");
    const lease: BrowserControlLease = Object.freeze({
      id: `browser-lease-${this.nextLease++}`,
      actor: copyActor(actor),
      lifetime: tab.owner === null ? "borrowed" : "owned",
    });
    tab.lease = lease;
    tab.controlMode = "agent-active";
    this.broadcastControl(tab.windowId);
    return lease;
  }

  releaseControl(tabId: string, leaseId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.lease?.id !== leaseId) return;
    tab.lease = null;
    if (tab.controlMode !== "human-paused") tab.controlMode = "human";
    tab.actions.abort(new Error("browser control was released"));
    if (tab.controlMode !== "human-paused") tab.actions = new AbortController();
    this.broadcastControl(tab.windowId);
  }

  // Only a validated native child callback may register a popup.
  registerPopup(openerGuestId: number, guest: G, native: { select(): boolean | Promise<boolean>; close(): void }): string | null {
    const opener = [...this.tabs.values()].find((tab) => tab.guest?.id === openerGuestId && this.isLive(tab));
    if (!opener || guest.isDestroyed() || [...this.tabs.values()].some((tab) => tab.guest?.id === guest.id)) return null;
    const attached = this.attached.get(guest.id);
    if (attached && attached.windowId !== opener.windowId) return null;
    if (!attached) this.guestAttached(guest, opener.windowId);
    const handle = `tab-${this.nextHandle++}`;
    const creator = opener.controlMode === "agent-active" ? opener.lease?.actor ?? opener.owner : null;
    this.tabs.set(handle, {
      handle, windowId: opener.windowId, rendererTabId: null, guest, opener: "user", documentId: 1,
      agentOrigin: null, controlMode: "human", controlGeneration: 1, targetKind: "popup",
      openerTabId: opener.handle, owner: creator, lease: null, actions: new AbortController(),
    });
    this.nativeTabs.set(handle, native);
    this.broadcastControl(opener.windowId);
    return handle;
  }

  // The user gave a guest keyboard or mouse input. In an agent-controlled tab this cancels the pending tool actions; input the tools inject is ignored.
  userInput(guestId: number, input?: NativeBrowserInput): void {
    const modifiers = input?._modifiers ?? 0;
    if (input) this.recordTouch(guestId, input.type, modifiers);
    const mouseWatched = [...this.mouseWatches].some((watch) => watch.guestId === guestId && !watch.invalid);
    if (input && this.recordMouse(guestId, input, modifiers)) return;
    if (input && this.recordWheel(guestId, input.type, modifiers)) return;
    if (input?.type === "mouseUp" && !mouseWatched) return;
    // Native provenance marks the raw injected touch and key events.
    if (input && input.type !== "mouseDown" && input.type !== "mouseWheel" && (modifiers & DEBUGGER_INPUT_MODIFIER) !== 0) {
      if (input.type === "touchStart") this.injectedTouches.set(guestId, { pressed: true, down: false, shown: false });
      if (input.type === "touchEnd") {
        const touch = this.injectedTouches.get(guestId);
        if (touch) touch.pressed = false;
      }
      if (input.type === "touchCancel") this.injectedTouches.delete(guestId);
      return;
    }
    const touch = this.injectedTouches.get(guestId);
    // Match only the native tap sequence derived from that marked contact. An unmarked contact, key, mouse or other gesture still cancels below.
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
    for (const watch of this.mouseWatches) {
      if (watch.guestId === guestId) { watch.invalid = true; watch.expected = null; }
    }
    for (const watch of this.wheelWatches) if (watch.guestId === guestId) watch.invalid = true;
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      this.pauseRecord(tab, false);
    }
  }

  // Observe all guests during the press to confirm its recipient and detect cross-page routing; drop unused press marks on stop.
  watchTouches(guestId: number): { delivery(): TouchDeliveryReport; stop(): void } {
    const state: TouchWatchState = {
      guestId,
      windowId: this.attached.get(guestId)?.windowId,
      report: { started: false, ended: false, tapped: false, elsewhere: 0 },
    };
    this.touchWatches.add(state);
    return {
      delivery: () => ({ ...state.report }),
      stop: () => {
        this.touchWatches.delete(state);
        // A press none of whose touch reached this guest leaves no mark to match a later tap; one that did keeps it for its own late gestures.
        if (!state.report.started) this.injectedTouches.delete(guestId);
      },
    };
  }

  // Watch one bounded press/release; each receipt requires a separately armed dispatch.
  watchMouse(guestId: number): { delivery(): MouseDeliveryReport; stop(): void } {
    const windowId = this.pointerWatchWindow(guestId);
    const state: MouseWatchState = {
      guestId, windowId, deadline: Date.now() + POINTER_SEQUENCE_MAX_MS, invalid: false,
      report: { pressed: false, released: false, elsewhere: 0 }, expected: null,
    };
    this.mouseWatches.add(state);
    return { delivery: () => ({ ...state.report }), stop: () => { this.mouseWatches.delete(state); } };
  }

  // The native mouse payload omits source marks; correlate only an exact one-shot dispatch.
  armMouse(guestId: number, input: BrowserMouseExpectation): void {
    const watch = [...this.mouseWatches].find((candidate) => candidate.guestId === guestId && !candidate.invalid);
    const now = Date.now();
    if (!watch || now >= watch.deadline || watch.expected !== null) throw new Error("no available native mouse dispatch expectation");
    if ((input.type !== "mouseDown" && input.type !== "mouseUp") || input.button !== "left" || input.clickCount !== 1
      || !Number.isFinite(input.x) || !Number.isFinite(input.y)
      || Math.abs(input.x) > 1_000_000 || Math.abs(input.y) > 1_000_000
      || (input.type === "mouseDown" ? watch.report.pressed : !watch.report.pressed || watch.report.released)) {
      throw new Error("invalid native mouse dispatch sequence");
    }
    watch.expected = { input: { ...input }, deadline: Math.min(watch.deadline, now + MOUSE_RECEIPT_MAX_MS) };
  }

  watchWheel(guestId: number): { delivery(): WheelDeliveryReport; stop(): void } {
    const windowId = this.pointerWatchWindow(guestId);
    const state: WheelWatchState = {
      guestId, windowId, deadline: Date.now() + POINTER_SEQUENCE_MAX_MS, invalid: false,
      report: { started: false, ended: false, elsewhere: 0 }, markers: 0, phase: "waiting",
    };
    this.wheelWatches.add(state);
    return { delivery: () => ({ ...state.report }), stop: () => { this.wheelWatches.delete(state); } };
  }

  private pointerWatchWindow(guestId: number): number {
    const entry = this.attached.get(guestId);
    if (!entry || entry.guest.isDestroyed()) throw new Error("no live native pointer recipient");
    const now = Date.now();
    for (const watch of [...this.mouseWatches, ...this.wheelWatches]) {
      if (now >= watch.deadline) {
        watch.invalid = true;
        if ("expected" in watch) this.mouseWatches.delete(watch);
        else this.wheelWatches.delete(watch);
      } else if (watch.windowId === entry.windowId) throw new Error("another native pointer sequence is active in this window");
    }
    return entry.windowId;
  }

  private recordMouse(guestId: number, input: NativeBrowserInput, modifiers: number): boolean {
    if (input.type !== "mouseDown" && input.type !== "mouseUp") return false;
    const windowId = this.attached.get(guestId)?.windowId;
    for (const watch of this.mouseWatches) {
      if (watch.windowId !== windowId || watch.invalid || Date.now() >= watch.deadline) continue;
      if (guestId !== watch.guestId) {
        if (input.type === "mouseDown") watch.report.elsewhere++;
        continue;
      }
      const expected = watch.expected;
      if (!expected || Date.now() >= expected.deadline || (modifiers & ~DEBUGGER_INPUT_MODIFIER) !== 0
        || input.type !== expected.input.type || input.x !== expected.input.x || input.y !== expected.input.y
        || input.button !== expected.input.button || input.clickCount !== expected.input.clickCount) return false;
      watch.expected = null;
      if (input.type === "mouseDown") watch.report.pressed = true;
      else watch.report.released = true;
      return true;
    }
    return false;
  }

  private recordWheel(guestId: number, type: string, modifiers: number): boolean {
    const windowId = this.attached.get(guestId)?.windowId;
    for (const watch of this.wheelWatches) {
      if (watch.windowId !== windowId || watch.invalid || Date.now() >= watch.deadline) continue;
      if (guestId !== watch.guestId) {
        if (type === "mouseWheel") watch.report.elsewhere++;
        continue;
      }
      if (type === "mouseWheel" && (modifiers & DEBUGGER_INPUT_MODIFIER) !== 0
        && ((watch.markers === 0 && watch.phase === "waiting") || (watch.markers === 1 && watch.phase === "updated"))) {
        watch.markers++;
        if (watch.phase === "waiting") watch.phase = "marked";
        watch.report.started = true;
        return true;
      }
      if (modifiers !== 0) continue;
      if (type === "gestureScrollBegin" && watch.phase === "marked") { watch.phase = "begun"; return true; }
      if (type === "gestureScrollUpdate" && watch.phase === "begun") { watch.phase = "updated"; return true; }
      if (type === "gestureScrollEnd" && watch.phase === "updated") {
        watch.phase = "ended";
        watch.report.ended = true;
        return true;
      }
    }
    return false;
  }

  private recordTouch(guestId: number, type: string, modifiers: number): void {
    if (this.touchWatches.size === 0) return;
    const windowId = this.attached.get(guestId)?.windowId;
    const marked = (modifiers & DEBUGGER_INPUT_MODIFIER) !== 0;
    for (const watch of this.touchWatches) {
      if (watch.windowId === undefined || watch.windowId !== windowId) continue;
      if (guestId !== watch.guestId) {
        if (type === "touchStart") watch.report.elsewhere++;
        continue;
      }
      if (type === "touchStart" && marked) watch.report.started = true;
      if (type === "touchEnd" && marked && watch.report.started) watch.report.ended = true;
      if (type === "gestureTap" && watch.report.ended && isDerivedTapModifiers(modifiers)) watch.report.tapped = true;
    }
  }

  // The agent's action in `guestId`'s tab is done: ask the window's renderer to give keyboard focus back to what held it before. Fire-and-forget; the page
  // actions watch the page lose focus.
  releaseFocus(guestId: number): void {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      if (tab.rendererTabId === null) return;
      this.link?.sendTabOp(tab.windowId, {
        requestId: `browser-op-${this.nextRequest++}`,
        op: "restore-focus",
        tabId: tab.rendererTabId,
      });
      return;
    }
  }

  // Focus only the actual leased guest, through trusted chrome or its native popup.
  async focusGuest(guestId: number): Promise<void> {
    const tab = [...this.tabs.values()].find((candidate) => candidate.guest?.id === guestId && this.isLive(candidate));
    if (!tab || !tab.guest) throw new Error("no live browser focus target");
    const guest = tab.guest;
    if (typeof guest.isFocused !== "function") throw new Error("native browser focus proof is unavailable");
    const isFocused = guest.isFocused.bind(guest);
    const leaseId = tab.lease?.id;
    if (leaseId === undefined || tab.controlMode === "human-paused") throw new Error("browser focus requires active control");
    const signal = tab.actions.signal;
    const documentId = tab.documentId;
    const generation = tab.controlGeneration;
    const assertCurrent = () => {
      if (signal.aborted) throw signal.reason;
      if (this.tabs.get(tab.handle) !== tab || tab.guest !== guest || guest.isDestroyed()
        || tab.lease?.id !== leaseId || tab.documentId !== documentId || tab.controlGeneration !== generation) {
        throw new Error("the browser focus target changed");
      }
      if (this.link?.isWindowVisible?.(tab.windowId) !== true) throw new Error("browser input window is hidden or unavailable");
      if (tab.targetKind === "embedded" && this.activeBrowserTab(tab.windowId) !== tab.handle) {
        throw new Error("the browser focus target is not the active visible surface");
      }
    };
    assertCurrent();
    if (tab.targetKind === "popup") {
      const native = this.nativeTabs.get(tab.handle);
      if (!native) throw new Error("native browser focus is unavailable");
      const focused = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("native browser focus timed out")), FOCUS_RECEIPT_MAX_MS);
        try {
          void Promise.resolve(native.select()).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      assertCurrent();
      if (!focused || !isFocused()) throw new Error("native browser focus was not observed");
      this.activePopup.set(tab.windowId, tab.handle);
      return;
    }
    if (tab.rendererTabId === null || !this.link?.sendTabOp(tab.windowId, {
      requestId: `browser-op-${this.nextRequest++}`, op: "focus", tabId: tab.rendererTabId,
    })) throw new Error("no browser renderer can focus this guest");
    const deadline = Date.now() + FOCUS_RECEIPT_MAX_MS;
    for (;;) {
      assertCurrent();
      if (isFocused()) return;
      if (Date.now() >= deadline) throw new Error("native browser focus timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, FOCUS_RECEIPT_POLL_MS));
    }
  }

  // Group an operation; native event provenance owns its individual inputs.
  async withAgentInput<T>(_guestId: number, inject: () => Promise<T>): Promise<T> {
    return inject();
  }

  // Invalidate document authority before the next main-frame load commits.
  navigationStarted(guestId: number, url: string): void {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      tab.documentId++;
      this.invalidateActions(tab, new BrowserDocumentChangedError());
      this.checkProvenance(tab, url);
      this.broadcastControl(tab.windowId);
    }
  }

  documentChanged(guestId: number): void {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id !== guestId) continue;
      tab.documentId++;
      this.invalidateActions(tab, new BrowserDocumentChangedError());
      this.broadcastControl(tab.windowId);
    }
  }

  setActiveSurface(windowId: number, surface: ActiveWorkspaceSurface | null): void {
    this.activePopup.delete(windowId);
    if (surface === null) this.activeSurface.delete(windowId);
    else this.activeSurface.set(windowId, surface);
    this.settleSelectIfShown(windowId);
  }

  getActiveSurface(windowId: number): ActiveWorkspaceSurface | undefined {
    return this.activeSurface.get(windowId);
  }

  // The handle of the window's active browser tab, if one is shown and bound.
  activeBrowserTab(windowId: number): string | undefined {
    const popup = this.activePopup.get(windowId);
    if (popup && this.liveTabInWindow(popup, windowId)) return popup;
    const surface = this.activeSurface.get(windowId);
    if (surface?.kind !== "browser") return undefined;
    const handle = this.handleByWindowTab.get(windowTabKey(windowId, surface.tabId));
    const tab = handle === undefined ? undefined : this.tabs.get(handle);
    return tab && this.isLive(tab) ? tab.handle : undefined;
  }

  // Bind conversation `sessionId` to one tab of `windowId`: it is that pane's own chat. A pane holds one conversation at a time, so a conversation the
  // pane held before is released.
  bindConversationSurface(sessionId: string, binding: { windowId: number; surface: ActiveWorkspaceSurface }): { ok: true } | { ok: false; error: "pane-chat-ended" } {
    this.restoreSavedBindings();
    this.restoreBindings(binding.windowId);
    if (this.retiredWorkspaceTabs.has(windowTabKey(binding.windowId, binding.surface.tabId))) return { ok: false, error: "pane-chat-ended" };
    const target = this.workspaceBinding(binding.windowId, binding.surface);
    const affectedWindows = new Set([binding.windowId]);
    for (const entry of this.workspaceBindings.values()) {
      if (entry.paneSessionId === sessionId) {
        delete entry.paneSessionId;
        affectedWindows.add(entry.windowId);
      }
    }
    target.paneSessionId = sessionId;
    for (const windowId of affectedWindows) this.bindingsChanged(windowId);
    return { ok: true };
  }

  // The conversation the pane chat of `tabId` in `windowId` holds, if it has one.
  paneConversation(windowId: number, tabId: string): string | undefined {
    this.restoreBindings(windowId);
    return this.workspaceBindings.get(windowTabKey(windowId, tabId))?.paneSessionId;
  }

  isConversationSurfaceKnown(windowId: number, tabId: string): boolean {
    this.restoreBindings(windowId);
    const key = windowTabKey(windowId, tabId);
    // Imported slots own explicit clears; persistence alone says nothing about this tab.
    return this.workspaceBindings.has(key) || this.retiredWorkspaceTabs.has(key);
  }

  // Whether `sessionId` is a pane chat's conversation (bound to a pane's tab).
  isPaneConversation(sessionId: string): boolean {
    this.restoreSavedBindings();
    return [...this.workspaceBindings.values()].some((binding) => binding.paneSessionId === sessionId);
  }

  // The pane chat of `tabId` in `windowId` is over (its pane closed, or the user started it afresh): unbind its conversation and say which it was.
  releasePaneConversation(windowId: number, tabId: string, closed = false): string | undefined {
    this.closingByAgent.delete(windowTabKey(windowId, tabId));
    const sessionId = this.paneConversation(windowId, tabId);
    if (closed) {
      const binding = this.workspaceBindings.get(windowTabKey(windowId, tabId));
      if (binding) {
        delete binding.paneSessionId;
        binding.closed = true;
      }
      this.retiredWorkspaceTabs.add(windowTabKey(windowId, tabId));
      this.workspaceBindings.delete(windowTabKey(windowId, tabId));
      this.bindingsChanged(windowId);
    } else if (sessionId !== undefined) {
      const binding = this.workspaceBindings.get(windowTabKey(windowId, tabId))!;
      delete binding.paneSessionId;
      if (binding.closed) this.workspaceBindings.delete(windowTabKey(windowId, tabId));
      this.bindingsChanged(windowId);
    }
    return sessionId;
  }

  // An agent's `browser_tab_close` is closing pane tab `tabId`: the turn that asked keeps running to its end, and the pane chat ends after it.
  isClosedByAgent(windowId: number, tabId: string): boolean {
    return this.closingByAgent.has(windowTabKey(windowId, tabId));
  }

  // The windows that hold tab `tabId` now: as a page, or as a pane whose chat holds a conversation.
  windowsHoldingTab(tabId: string): number[] {
    this.restoreSavedBindings();
    const windows = new Set<number>();
    for (const key of this.handleByWindowTab.keys()) {
      const separator = key.indexOf("\u0000");
      if (key.slice(separator + 1) === tabId) windows.add(Number(key.slice(0, separator)));
    }
    for (const bound of this.workspaceBindings.values()) {
      if (bound.surface.tabId === tabId) windows.add(bound.windowId);
    }
    return [...windows];
  }

  // A window is gone: none of its panes holds a conversation any more.
  releaseWindow(windowId: number): void {
    for (const [key, bound] of this.workspaceBindings) {
      if (bound.windowId === windowId) this.workspaceBindings.delete(key);
    }
    for (const key of this.closingByAgent) {
      if (key.startsWith(`${windowId}\u0000`)) this.closingByAgent.delete(key);
    }
    for (const tab of this.tabs.values()) {
      if (tab.windowId !== windowId) continue;
      this.invalidateActions(tab, "the browser window was closed");
      tab.lease = null;
      const native = this.nativeTabs.get(tab.handle);
      this.nativeTabs.delete(tab.handle);
      native?.close();
      if (tab.rendererTabId !== null) this.handleByWindowTab.delete(windowTabKey(windowId, tab.rendererTabId));
      this.pausedControllers.delete(tab.handle);
      this.tabs.delete(tab.handle);
    }
    for (const [guestId, attached] of this.attached) {
      if (attached.windowId === windowId) {
        this.attached.delete(guestId);
        this.injectedTouches.delete(guestId);
      }
    }
    for (const key of this.userOwnedTabs) if (key.startsWith(`${windowId}\u0000`)) this.userOwnedTabs.delete(key);
    for (const key of this.retiredWorkspaceTabs) if (key.startsWith(`${windowId}\u0000`)) this.retiredWorkspaceTabs.delete(key);
    this.activeSurface.delete(windowId);
    this.activePopup.delete(windowId);
    this.settlePending((op) => op.windowId === windowId, { ok: false, error: "no-window-renderer" });
    this.broadcastControl(windowId);
    // Window teardown must not erase the primary layout that the next launch restores.
    this.publishBindings(windowId);
    this.restoredBindingWindows.delete(windowId);
  }

  // The surface conversation `sessionId` is bound to in `windowId`, if any.
  conversationSurface(windowId: number, sessionId: string): ActiveWorkspaceSurface | undefined {
    this.restoreBindings(windowId);
    return [...this.workspaceBindings.values()].find((binding) => binding.windowId === windowId && binding.paneSessionId === sessionId)?.surface;
  }

  // The tab a conversation's browser tools act on when the call names none: the tab its pane chat is bound to, else the window's active browser tab. A
  // binding that cannot be honoured is an error, never another tab.
  defaultBrowserTab(windowId: number, sessionId: string): DefaultBrowserTab {
    const bound = this.conversationSurface(windowId, sessionId);
    if (bound === undefined) {
      const active = this.activeBrowserTab(windowId);
      return active === undefined ? { ok: false, error: NO_SHOWN_BROWSER_TAB } : { ok: true, handle: active };
    }
    if (bound.kind !== "browser") {
      return { ok: false, error: "this chat is bound to a terminal, not a page; pass a tabId from browser_tabs to act on a page" };
    }
    const handle = this.handleByWindowTab.get(windowTabKey(windowId, bound.tabId));
    const tab = handle === undefined ? undefined : this.tabs.get(handle);
    if (!tab || !this.isLive(tab)) {
      return { ok: false, error: "the page this chat is bound to is closed or has not loaded; nothing was done" };
    }
    return { ok: true, handle: tab.handle };
  }

  // A live tab by handle, in any window. For approval hooks, which have no session.
  liveTab(handle: string): BrowserTabRecord<G> | undefined {
    const tab = this.tabs.get(handle);
    if (tab?.guest) this.checkProvenance(tab, tab.guest.getURL());
    return tab && this.isLive(tab) ? tab : undefined;
  }

  // A live tab of `windowId`. Another window's tab answers like a missing one.
  liveTabInWindow(handle: string, windowId: number): BrowserTabRecord<G> | undefined {
    const tab = this.tabs.get(handle);
    return tab?.windowId === windowId ? this.liveTab(handle) : undefined;
  }

  listTabs(windowId: number): BrowserTabView[] {
    const active = this.activeBrowserTab(windowId);
    return [...this.tabs.values()]
      .filter((tab) => tab.windowId === windowId && this.isLive(tab))
      .map((tab) => ({
        ...this.controlView(tab),
        openedBy: tab.opener,
        active: tab.handle === active,
      }));
  }

  listSessionTabs(windowId: number, actor: BrowserSessionActor, includeDirectChildren: boolean): BrowserTabView[] {
    validateActor(actor);
    return this.listTabs(windowId).filter((tab) => {
      const belongs = (candidate: BrowserSessionActor | null | undefined) => candidate?.sessionId === actor.sessionId
        || (includeDirectChildren && candidate?.directParentSessionId === actor.sessionId);
      return belongs(tab.owner) || belongs(tab.lease?.actor);
    });
  }

  controlState(windowId: number): BrowserTabControlState {
    return {
      revision: this.revisions.get(windowId) ?? 0,
      tabs: [...this.tabs.values()].filter((tab) => tab.windowId === windowId && this.isLive(tab)).map((tab) => this.controlView(tab)),
    };
  }

  // Ask the window's renderer to open, select or close a tab, and resolve when main observes it done (a bind echoing the request, the tab shown, the guest
  // gone). Never resolves `ok` on the renderer's say-so alone.
  requestTabOp(
    windowId: number,
    op: RequestedTabOp,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BrowserTabOpOutcome> {
    if (op.actor !== undefined) validateActor(op.actor);
    const actor = op.actor === undefined ? undefined : copyActor(op.actor);
    if (options.signal?.aborted) return Promise.resolve({ ok: false, error: "aborted" });
    const target = op.op === "new" ? undefined : this.liveTabInWindow(op.tabId, windowId);
    if (op.op !== "new") {
      if (!target) return Promise.resolve({ ok: false, error: "no-such-tab" });
      if (actor) {
        try { this.assertActorAccess(target, actor); }
        catch { return Promise.resolve({ ok: false, error: "not-authorized" }); }
        if (op.op === "close" && target.owner === null) {
          if (target.lease?.actor.sessionId === actor.sessionId) this.releaseControl(target.handle, target.lease.id);
          return Promise.resolve({ ok: true, tabId: target.handle, retained: true });
        }
        if (op.op === "close" && target.controlMode === "human-paused") {
          return Promise.resolve({ ok: false, error: "control-paused" });
        }
      }
    }
    // Closing a pane's page from an agent turn ends that pane's chat only once the turn is over (see `isClosedByAgent`); a close that does not happen takes the mark back.
    let closingKey: string | undefined;
    if (op.op === "close" && target?.rendererTabId !== null) {
      const rendererTabId = target!.rendererTabId!;
      const key = windowTabKey(windowId, rendererTabId);
      if (this.paneConversation(windowId, rendererTabId) !== undefined && !this.closingByAgent.has(key)) {
        this.closingByAgent.add(key);
        closingKey = key;
      }
    }
    const requestId = `browser-op-${this.nextRequest++}`;
    const request: BrowserTabOpRequest = op.op === "new"
      ? { requestId, op: "new", url: "about:blank", active: op.active ?? false, ...(op.sessionId === undefined ? {} : { sessionId: op.sessionId }) }
      : { requestId, op: op.op, tabId: target!.rendererTabId ?? target!.handle };
    return new Promise<BrowserTabOpOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ ok: false, error: "aborted" });
      const settle = (outcome: BrowserTabOpOutcome) => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        if (!outcome.ok && closingKey !== undefined) this.closingByAgent.delete(closingKey);
        resolve(outcome);
      };
      // Keep the handle main knows (not the renderer id) for close/select.
      const pendingRequest: BrowserTabOpRequest = op.op === "new"
        ? { requestId, op: "new", url: op.url, active: op.active ?? false, ...(op.sessionId === undefined ? {} : { sessionId: op.sessionId }) }
        : { requestId, op: op.op, tabId: op.tabId };
      this.pending.set(requestId, { windowId, request: pendingRequest, actor, attachmentSequence: this.nextAttachment, settle });
      if (options.signal?.aborted) {
        settle({ ok: false, error: "aborted" });
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle({ ok: false, error: "timeout" }), options.timeoutMs ?? BROWSER_TAB_OP_TIMEOUT_MS);
      if (target?.targetKind === "popup" && op.op === "select") {
        try {
          const native = this.nativeTabs.get(target.handle);
          if (!native) { settle({ ok: false, error: "native-operation-failed" }); return; }
          void Promise.resolve(native.select()).then((focused) => {
            if (!this.pending.has(requestId)) return;
            if (!focused || !this.isLive(target)) { settle({ ok: false, error: "native-operation-failed" }); return; }
            if (actor) {
              try { this.assertActorAccess(target, actor); }
              catch { settle({ ok: false, error: "not-authorized" }); return; }
            }
            this.activePopup.set(windowId, target.handle);
            settle({ ok: true, tabId: target.handle });
          }, () => settle({ ok: false, error: "native-operation-failed" }));
        } catch { settle({ ok: false, error: "native-operation-failed" }); }
        return;
      }
      if (target?.targetKind === "popup" && op.op === "close") {
        try {
          const native = this.nativeTabs.get(target.handle);
          if (!native) { settle({ ok: false, error: "native-operation-failed" }); return; }
          const guestId = target.guest?.id;
          native.close();
          if (guestId !== undefined && target.guest?.isDestroyed()) this.guestDestroyed(guestId);
        } catch { settle({ ok: false, error: "native-operation-failed" }); }
        return;
      }
      if (!this.link || !this.link.sendTabOp(windowId, request)) {
        settle({ ok: false, error: "no-window-renderer" });
        return;
      }
      if (op.op === "select") this.settleSelectIfShown(windowId);
    });
  }

  private isLive(tab: BrowserTabRecord<G>): boolean {
    return tab.guest !== null && !tab.guest.isDestroyed();
  }

  private controlView(tab: BrowserTabRecord<G>): BrowserTabControlView {
    return {
      tabId: tab.handle, rendererTabId: tab.rendererTabId, url: tab.guest!.getURL(), title: tab.guest!.getTitle(),
      mode: tab.controlMode, owner: tab.owner === null ? null : copyActor(tab.owner),
      lease: tab.lease === null ? null : { ...tab.lease, actor: copyActor(tab.lease.actor) },
      generation: tab.controlGeneration, kind: tab.targetKind, openerTabId: tab.openerTabId,
    };
  }

  private invalidateActions(tab: BrowserTabRecord<G>, reason: string | Error): void {
    tab.actions.abort(typeof reason === "string" ? new Error(reason) : reason);
    tab.controlGeneration++;
    if (tab.controlMode !== "human-paused") tab.actions = new AbortController();
  }

  private pauseRecord(tab: BrowserTabRecord<G>, clearOrigin: boolean): boolean {
    const controller = tab.lease?.actor ?? tab.owner;
    if (controller) this.pausedControllers.set(tab.handle, controller);
    if (controller || tab.controlMode === "agent-active" || tab.controlMode === "human-paused") {
      tab.controlMode = "human-paused";
      if (tab.rendererTabId !== null) this.userOwnedTabs.add(windowTabKey(tab.windowId, tab.rendererTabId));
    }
    if (clearOrigin) {
      tab.opener = "user";
      tab.agentOrigin = null;
    }
    this.invalidateActions(tab, "browser control is paused; ask the user to resume this tab");
    this.broadcastControl(tab.windowId);
    return true;
  }

  private checkProvenance(tab: BrowserTabRecord<G>, url: string): void {
    // The initial empty document is never an independently approved site.
    if (url === "" || url === "about:blank") return;
    if (tab.opener !== "agent" || browserOrigin(url) === tab.agentOrigin) return;
    tab.opener = "user";
    tab.agentOrigin = null;
    this.invalidateActions(tab, "the approved page origin changed");
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
    this.revisions.set(windowId, (this.revisions.get(windowId) ?? 0) + 1);
    this.link?.sendControl(windowId, this.controlState(windowId));
  }

  __reset(): void {
    this.attached.clear();
    this.tabs.clear();
    this.handleByWindowTab.clear();
    this.userOwnedTabs.clear();
    this.pausedControllers.clear();
    this.nativeTabs.clear();
    this.activePopup.clear();
    this.revisions.clear();
    this.activeSurface.clear();
    this.workspaceBindings.clear();
    this.retiredWorkspaceTabs.clear();
    this.bindingRevisions.clear();
    this.restoredBindingWindows.clear();
    this.bindingPersistence = null;
    this.bindingWrites = Promise.resolve();
    this.closingByAgent.clear();
    this.pending.clear();
    this.injectedTouches.clear();
    this.touchWatches.clear();
    this.mouseWatches.clear();
    this.wheelWatches.clear();
    this.link = null;
    this.nextHandle = 1;
    this.nextRequest = 1;
    this.nextLease = 1;
    this.nextAttachment = 0;
  }
}

function validateActor(actor: BrowserSessionActor): void {
  if (!actor || typeof actor.sessionId !== "string" || actor.sessionId.length === 0
    || (actor.directParentSessionId !== undefined && (typeof actor.directParentSessionId !== "string"
      || actor.directParentSessionId.length === 0 || actor.directParentSessionId === actor.sessionId))) {
    throw new Error("invalid browser session actor");
  }
}

function copyActor(actor: BrowserSessionActor): BrowserSessionActor {
  return Object.freeze({ sessionId: actor.sessionId, ...(actor.directParentSessionId === undefined ? {} : { directParentSessionId: actor.directParentSessionId }) });
}

function windowTabKey(windowId: number, tabId: string): string {
  return `${windowId}\u0000${tabId}`;
}

// The process-wide registry of the main windows' browser tabs.
export const browserTabRegistry = new BrowserTabRegistry<WebContents>();
