import { randomUUID } from "node:crypto";
import type { DownloadItem, IpcMainInvokeEvent, WebContents } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { IpcDeps } from "../ipc/types.js";
import { validateAppWindowMainFrameSender } from "../ipc/app-window-sender.js";
import { BrowserObservationAdapter, sanitizeBrowserObservationDetail } from "../observation/browser-adapter.js";
import type { ObservationDaemon } from "../observation/daemon.js";
import { OBSERVATION_LIMITS, type BrowserObservationDetail, type ObservationAck, type ObservationIdentity } from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { setAgentBrowserObservationSink, type AgentBrowserCommandReceipt, type AgentBrowserObservationSink } from "../tools/agent-browser-observation.js";
import type { BrowserGuest, BrowserTabRecord } from "./browser/browser-tab-registry.js";
import { findSessionMainWindowContents } from "./app-state.js";
import { resolveSessionWindow } from "../tools/session-window-scope.js";

interface BrowserView {
  id: string;
  sessionId: string;
  hostSessionId: string;
  event: IpcMainInvokeEvent;
  stop(): void;
}
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
  private disposed = false;

  constructor(private readonly deps: IpcDeps, daemon: ObservationDaemon) {
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
    const view: BrowserView = { id, sessionId: identity.sessionId, hostSessionId: host!.hostSessionId, event, stop: () => {
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
    timer = setInterval(() => { if (!this.current(view)) this.release(view, true); }, PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
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
    let completed = false;
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
