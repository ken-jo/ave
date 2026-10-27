import { randomUUID } from "node:crypto";
import { nativeImage, type DownloadItem, type IpcMainInvokeEvent, type WebContents } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { IpcDeps } from "../ipc/types.js";
import { validateAppWindowMainFrameSender } from "../ipc/app-window-sender.js";
import { BrowserObservationAdapter, sanitizeBrowserObservationDetail } from "../observation/browser-adapter.js";
import type { ObservationDaemon } from "../observation/daemon.js";
import {
  OBSERVATION_LIMITS, isBrowserObservationPreviewRequest, type BrowserObservationDetail, type BrowserObservationPreviewMessage,
  type ObservationAck, type ObservationIdentity,
} from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { setAgentBrowserObservationSink, type AgentBrowserCommandReceipt, type AgentBrowserObservationSink } from "../tools/agent-browser-observation.js";
import { browserTabRegistry, type BrowserGuest, type BrowserTabRecord } from "./browser/browser-tab-registry.js";
import { ScreencastClosedError } from "../observation/browser-screencast.js";
import { createLogger } from "../lib/logger.js";
import { isUniformJpeg, startBrowserPreview, type BrowserPreviewHandle, type PreviewGuest } from "./browser-observation-preview.js";
import { findSessionMainWindowContents } from "./app-state.js";
import { resolveSessionWindow } from "../tools/session-window-scope.js";

const logger = createLogger("browser-observation");

interface BrowserView {
  id: string;
  sessionId: string;
  hostSessionId: string;
  windowId: number;
  event: IpcMainInvokeEvent;
  stop(): void;
}
interface ActivePreview {
  view: BrowserView;
  tab: BrowserTabRecord<BrowserGuest>;
  guest: BrowserGuest;
  handle: BrowserPreviewHandle;
}
/** The acting session's latest command on a tab; a preview parks once it has been idle for `previewIdleMs`. */
interface TabActivity { sessionId: string; active: number; endedAt: number }
export interface BrowserPreviewDeps {
  lookupTab(handle: string, windowId: number): BrowserTabRecord<BrowserGuest> | undefined;
  start(guest: BrowserGuest, callbacks: Parameters<typeof startBrowserPreview>[1]): BrowserPreviewHandle;
  isBlank(data: string): boolean;
}
const NATIVE_PREVIEW: BrowserPreviewDeps = {
  lookupTab: (handle, windowId) => browserTabRegistry.liveTabInWindow(handle, windowId),
  start: (guest, callbacks) => startBrowserPreview(guest as unknown as PreviewGuest, callbacks),
  isBlank: (data) => isUniformJpeg(data, (buffer) => {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const small = image.resize({ width: 48, quality: "good" });
    const size = small.getSize();
    return { bitmap: small.toBitmap(), width: size.width, height: size.height };
  }),
};
interface ActiveCommand {
  guest: BrowserGuest;
  view: BrowserView;
  detail: BrowserObservationDetail;
  expectedDownloadUrl?: string;
  isCurrent(): boolean;
  downloads: Set<() => void>;
  overflowed: boolean;
}

/** Browser metadata shares the private observation transport and daemon. */
export class BrowserObservationRuntime implements AgentBrowserObservationSink {
  private readonly adapter: BrowserObservationAdapter;
  private readonly views = new Map<string, BrowserView>();
  private readonly commands = new Map<number, ActiveCommand>();
  private readonly downloads = new Map<() => void, BrowserView>();
  private readonly previews = new Map<string, ActivePreview>();
  private readonly activity = new Map<string, TabActivity>();
  private disposed = false;

  constructor(private readonly deps: IpcDeps, daemon: ObservationDaemon, private readonly preview: BrowserPreviewDeps = NATIVE_PREVIEW) {
    this.adapter = new BrowserObservationAdapter(daemon);
    setAgentBrowserObservationSink(this);
  }

  private current(view: BrowserView): boolean {
    return !this.disposed && this.views.get(view.sessionId) === view
      && validateAppWindowMainFrameSender(view.event, this.deps)
      && findSessionMainWindowContents(view.hostSessionId) === view.event.sender;
  }

  private hostFor(sessionId: string) {
    return resolveSessionWindow(sessionId, {
      windowIdForHostedSession: (id) => {
        const sender = findSessionMainWindowContents(id);
        const windows = this.deps.getAppWindows?.() ?? [this.deps.getMainWindow()];
        return windows.find((candidate) => candidate && !candidate.isDestroyed() && candidate.webContents === sender)?.id ?? null;
      },
      liveOriginSessionId: (id) => this.deps.getSubAgentRunner?.()?.liveOriginSessionId(id),
    });
  }

  private viewFor(identity: ObservationIdentity, tab: BrowserTabRecord<BrowserGuest>): BrowserView {
    const host = this.hostFor(identity.sessionId);
    const sender = host ? findSessionMainWindowContents(host.hostSessionId) : null;
    if (!sender) throw new Error("Browser observation session has no window.");
    const window = this.deps.getAppWindows?.().find((candidate) => candidate && !candidate.isDestroyed()
      && candidate.webContents === sender) ?? this.deps.getMainWindow();
    if (!window || window.isDestroyed() || window.id !== tab.windowId || window.webContents !== sender) {
      throw new Error("Browser observation window identity mismatch.");
    }
    const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
    if (!validateAppWindowMainFrameSender(event, this.deps)) throw new Error("Unauthorized browser observation frame.");
    const existing = this.views.get(identity.sessionId);
    if (existing && this.current(existing) && existing.event.senderFrame === event.senderFrame) return existing;
    if (existing) this.release(existing, true);
    for (const view of this.views.values()) if (!this.current(view)) this.release(view, true);
    const id = randomUUID();
    const release = (): void => this.release(view);
    const navigate = (_event: unknown, _url: string, _status: number, _text: string, mainFrame: boolean): void => { if (mainFrame) release(); };
    let timer: ReturnType<typeof setInterval> | undefined;
    const view: BrowserView = { id, sessionId: identity.sessionId, hostSessionId: host!.hostSessionId, windowId: window.id, event, stop: () => {
      if (timer) clearInterval(timer);
      sender.removeListener("destroyed", release);
      sender.removeListener("render-process-gone", release);
      sender.removeListener("did-frame-navigate", navigate);
    } };
    this.adapter.registerView({ id, sessionId: view.sessionId, hostSessionId: view.hostSessionId, isCurrent: () => this.current(view), onEvents: (events) => {
      const ended = events.length === 1 && events[0].kind === "status" && events[0].after.code === "session-cleared";
      if (ended ? !validateAppWindowMainFrameSender(view.event, this.deps) : !this.current(view)) { this.release(view); return; }
      sender.send(CHANNELS.preview.observationEvents, events);
    } });
    this.views.set(view.sessionId, view);
    timer = setInterval(() => {
      if (!this.current(view)) { this.release(view, true); return; }
      const preview = this.previews.get(view.id);
      if (preview && !this.previewAllowed(view, preview.tab, preview.guest)) this.stopPreview(preview, "stopped");
    }, PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
    timer.unref();
    sender.once("destroyed", release);
    sender.once("render-process-gone", release);
    sender.on("did-frame-navigate", navigate);
    return view;
  }

  begin(identity: ObservationIdentity, tab: BrowserTabRecord<BrowserGuest>, _action: BrowserObservationDetail["action"],
    isCurrent: () => boolean, detail: BrowserObservationDetail, downloadUrl?: string): AgentBrowserCommandReceipt {
    if (this.disposed || !isCurrent() || !tab.guest) throw new Error("Browser observation command is unavailable.");
    const guestId = tab.guest.id;
    if (this.commands.has(guestId)) throw new Error("Browser observation command already active.");
    if (this.commands.size >= OBSERVATION_LIMITS.maxViews) throw new Error("Browser observation command limit exceeded.");
    const view = this.viewFor(identity, tab);
    const command: ActiveCommand = { guest: tab.guest, view, detail: sanitizeBrowserObservationDetail(detail),
      expectedDownloadUrl: downloadUrl, isCurrent, downloads: new Set(), overflowed: false };
    this.commands.set(guestId, command);
    const activity = this.activity.get(tab.handle);
    const tracked: TabActivity = activity?.sessionId === identity.sessionId ? activity : { sessionId: identity.sessionId, active: 0, endedAt: 0 };
    tracked.active += 1;
    this.activity.set(tab.handle, tracked);
    let completed = false;
    let ended = false;
    return {
      target: (element, expected) => {
        if (!isCurrent() || this.commands.get(guestId) !== command) throw new Error("Browser observation command expired.");
        command.detail = sanitizeBrowserObservationDetail({ ...command.detail, element });
        if (expected !== undefined) command.expectedDownloadUrl = expected;
      },
      complete: () => {
        if (completed || this.commands.get(guestId) !== command || !isCurrent()) throw new Error("Browser observation command expired.");
        completed = true;
        if (this.current(view)) {
          const guest = tab.guest;
          if (guest && !guest.isDestroyed()) command.detail = sanitizeBrowserObservationDetail({ ...command.detail,
            url: guest.getURL(), title: guest.getTitle() });
          this.adapter.record(view.id, command.detail);
          if (command.overflowed) this.adapter.requireResync(view.id);
        }
      },
      dispose: () => {
        if (!ended) {
          ended = true;
          tracked.active -= 1;
          tracked.endedAt = Date.now();
        }
        if (this.commands.get(guestId) === command) this.commands.delete(guestId);
        command.expectedDownloadUrl = undefined;
        // A download that started under a valid receipt retains only its own session-bound status listener.
        command.downloads.clear();
      },
    };
  }

  observeDownload(contents: WebContents, item: DownloadItem): void {
    const command = this.commands.get(contents.id);
    if (!command || command.guest !== contents || !command.isCurrent() || !this.current(command.view) || !command.expectedDownloadUrl
      || !item.getURLChain().includes(command.expectedDownloadUrl)) return;
    if (command.detail.action !== "navigate" && command.detail.action !== "tab-open" && !item.hasUserGesture()) return;
    if (this.downloads.size >= OBSERVATION_LIMITS.maxViews) {
      if (!command.overflowed) this.adapter.requireResync(command.view.id);
      command.overflowed = true;
      return;
    }
    const detail: BrowserObservationDetail = { ...command.detail, action: "download" };
    delete detail.element;
    const record = (state: NonNullable<BrowserObservationDetail["download"]>["state"]): void => {
      if (this.current(command.view)) this.adapter.record(command.view.id, { ...detail, download: { state } });
    };
    const dispose = (): void => { item.removeListener("done", done); this.downloads.delete(dispose); command.downloads.delete(dispose); };
    const done = (_event: unknown, state: "completed" | "cancelled" | "interrupted"): void => { dispose(); record(state); };
    this.downloads.set(dispose, command.view);
    command.downloads.add(dispose);
    item.once("done", done);
    record("started");
  }

  /**
   * Live preview of the exact tab named by an agent action event. It binds only to that handle in the hosting window
   * and never substitutes another tab. User-owned, paused, user-navigated and idle tabs are refused or parked.
   */
  previewRequest(event: IpcMainInvokeEvent, raw: unknown): { ok: boolean; error?: string } {
    if (!validateAppWindowMainFrameSender(event, this.deps)) return { ok: false, error: "unauthorized" };
    if (!isBrowserObservationPreviewRequest(raw)) return { ok: false, error: "bad-request" };
    const view = this.views.get(raw.sessionId);
    if (!view || view.id !== raw.targetId || !this.current(view)
      || event.sender !== view.event.sender || event.senderFrame !== view.event.senderFrame) {
      return { ok: false, error: "unauthorized" };
    }
    const active = this.previews.get(view.id);
    if (raw.action === "stop") {
      if (active?.tab.handle === raw.tabId) this.stopPreview(active);
      return { ok: true };
    }
    if (raw.action === "rendered") {
      if (active?.tab.handle !== raw.tabId) return { ok: false, error: "not-previewing" };
      active.handle.rendered(raw.frame);
      return { ok: true };
    }
    const tab = this.preview.lookupTab(raw.tabId, view.windowId);
    const guest = tab?.guest;
    if (!tab || !guest || tab.handle !== raw.tabId || !this.previewAllowed(view, tab, guest)) return { ok: false, error: "not-agent-tab" };
    if (active?.tab === tab && active.guest === guest) return { ok: true };
    if (active) this.stopPreview(active);
    if (this.previews.size >= OBSERVATION_LIMITS.maxPreviews) return { ok: false, error: "preview-limit" };
    const base = { targetId: view.id, sessionId: view.sessionId, tabId: tab.handle };
    let preview: ActivePreview | undefined;
    const handle = this.preview.start(guest, {
      isBlank: (data) => this.preview.isBlank(data),
      frame: (frame) => {
        if (!preview || this.previews.get(view.id) !== preview) return;
        if (!this.current(view) || !this.previewAllowed(view, tab, guest)) { this.stopPreview(preview, "stopped"); return; }
        this.sendPreview(view, { ...base, kind: "frame", mimeType: "image/jpeg", ...frame, ts: Date.now() });
      },
      updating: () => { if (preview && this.previews.get(view.id) === preview) this.sendPreview(view, { ...base, kind: "state", state: "updating" }); },
      ended: (error) => {
        if (!preview || this.previews.get(view.id) !== preview) return;
        this.previews.delete(view.id);
        // A closed page session (guest destroyed, debugger detached) is an ordinary end; any other failure is an error.
        this.sendPreview(view, { ...base, kind: "state", state: error instanceof ScreencastClosedError ? "stopped" : "error" });
        if (!(error instanceof ScreencastClosedError)) logger.error({ err: error }, "Browser preview failed.");
      },
    });
    preview = { view, tab, guest, handle };
    this.previews.set(view.id, preview);
    return { ok: true };
  }

  private previewAllowed(view: BrowserView, tab: BrowserTabRecord<BrowserGuest>, guest: BrowserGuest): boolean {
    if (this.disposed || tab.guest !== guest || guest.isDestroyed() || tab.windowId !== view.windowId) return false;
    // Any recognized user input, address-bar navigation or Stop pauses an agent-owned tab. The agent's own
    // cross-origin navigation clears the tab's original-origin provenance but is not user browsing.
    if (tab.controlMode === "human-paused") return false;
    const leased = tab.lease?.actor.sessionId === view.sessionId;
    const owned = tab.owner?.sessionId === view.sessionId;
    if (!leased && !owned) return false;
    const activity = this.activity.get(tab.handle);
    if (!activity || activity.sessionId !== view.sessionId) return false;
    return activity.active > 0 || Date.now() - activity.endedAt < OBSERVATION_LIMITS.previewIdleMs;
  }

  private stopPreview(preview: ActivePreview, notify?: "stopped"): void {
    if (this.previews.get(preview.view.id) !== preview) return;
    this.previews.delete(preview.view.id);
    if (notify) this.sendPreview(preview.view, { targetId: preview.view.id, sessionId: preview.view.sessionId,
      tabId: preview.tab.handle, kind: "state", state: notify });
    preview.handle.stop().then(undefined, (error: unknown) => logger.error({ err: error }, "Browser preview stop failed."));
  }

  private sendPreview(view: BrowserView, message: BrowserObservationPreviewMessage): void {
    if (!validateAppWindowMainFrameSender(view.event, this.deps)) return;
    view.event.sender.send(CHANNELS.preview.observationPreviewFrames, message);
  }

  acknowledge(event: IpcMainInvokeEvent, ack: ObservationAck): { ok: boolean; error?: string } | undefined {
    const view = this.views.get(ack.sessionId);
    if (!view || view.id !== ack.targetId) return undefined;
    if (!this.current(view) || event.sender !== view.event.sender || event.senderFrame !== view.event.senderFrame) {
      return { ok: false, error: "unauthorized" };
    }
    if (ack.action === "release") this.release(view);
    else this.adapter.acknowledge(view.id, ack.seq);
    return { ok: true };
  }

  endSessions(ended: (sessionId: string) => boolean): void {
    const errors: unknown[] = [];
    for (const view of this.views.values()) if (ended(view.sessionId)) {
      try { this.release(view, true); }
      catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Browser observation session cleanup failed.");
  }

  private release(view: BrowserView, notify = false): void {
    if (this.views.get(view.sessionId) !== view) return;
    try {
      if (notify && validateAppWindowMainFrameSender(view.event, this.deps)) this.adapter.clear(view.id);
    } finally {
      this.views.delete(view.sessionId);
      for (const [id, command] of this.commands) if (command.view === view) {
        command.expectedDownloadUrl = undefined;
        this.commands.delete(id);
      }
      for (const [dispose, owner] of this.downloads) if (owner === view) dispose();
      const preview = this.previews.get(view.id);
      if (preview) this.stopPreview(preview);
      for (const [handle, activity] of this.activity) if (activity.sessionId === view.sessionId && activity.active === 0) this.activity.delete(handle);
      view.stop();
      this.adapter.release(view.id);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const view of this.views.values()) {
      try { this.release(view, true); }
      catch (error) { errors.push(error); }
    }
    this.commands.clear();
    this.activity.clear();
    setAgentBrowserObservationSink(undefined);
    this.adapter.dispose();
    if (errors.length > 0) throw new AggregateError(errors, "Browser observation cleanup failed.");
  }
}

let browserObservation: BrowserObservationRuntime | undefined;
export function installBrowserObservation(deps: IpcDeps, daemon: ObservationDaemon): BrowserObservationRuntime {
  browserObservation?.dispose();
  browserObservation = new BrowserObservationRuntime(deps, daemon);
  return browserObservation;
}
export function observeAgentBrowserDownload(contents: WebContents, item: DownloadItem): void { browserObservation?.observeDownload(contents, item); }
