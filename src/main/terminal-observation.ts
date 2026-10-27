import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import type { IpcDeps } from "../ipc/types.js";
import { validateAppWindowMainFrameSender } from "../ipc/app-window-sender.js";
import { CHANNELS } from "../contract/app-contract.js";
import { findSessionMainWindowContents } from "./app-state.js";
import { TerminalObservationAdapter } from "../observation/terminal-adapter.js";
import type { ObservationDaemon } from "../observation/daemon.js";
import { isObservationAck, isTerminalObservationSubscription, type ObservationResponse } from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { setAgentTerminalObservationSink } from "../tools/agent-terminal-observation.js";

interface TerminalViewOwner {
  event: IpcMainInvokeEvent;
  sessionId: string;
  stop(): void;
}

/** Private main-frame delivery shares the daemon and its existing read-only channel. */
export class TerminalObservationRuntime {
  private readonly adapter: TerminalObservationAdapter;
  private readonly views = new Map<string, TerminalViewOwner>();
  private disposed = false;

  constructor(private readonly deps: IpcDeps, daemon: ObservationDaemon) {
    this.adapter = new TerminalObservationAdapter(daemon);
    setAgentTerminalObservationSink({
      start: (identity, input) => this.adapter.start(identity, input),
      egress: (token, decision) => this.adapter.recordEgress(token, decision),
      releaseSessions: (ended) => {
        for (const [id, view] of this.views) if (ended(view.sessionId)) this.release(id);
        this.adapter.releaseSessions(ended);
      },
    });
  }

  private isCurrent(view: Pick<TerminalViewOwner, "event" | "sessionId">): boolean {
    return !this.disposed && validateAppWindowMainFrameSender(view.event, this.deps)
      && findSessionMainWindowContents(view.sessionId) === view.event.sender;
  }

  acknowledge(event: IpcMainInvokeEvent, raw: unknown): ObservationResponse | undefined {
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    if (record?.action !== "subscribe-terminal" && !(typeof record?.targetId === "string" && this.views.has(record.targetId))) return undefined;
    if (!validateAppWindowMainFrameSender(event, this.deps)) return { ok: false, error: "unauthorized" };
    if (record?.action === "subscribe-terminal") {
      if (!isTerminalObservationSubscription(raw)) return { ok: false, error: "bad-request" };
      if (!this.isCurrent({ event, sessionId: raw.sessionId })) return { ok: false, error: "unauthorized" };
      for (const [id, view] of this.views) {
        if (!this.isCurrent(view) || view.event.sender === event.sender && view.event.senderFrame === event.senderFrame
          && view.sessionId === raw.sessionId) this.release(id);
      }
      const id = randomUUID();
      const release = (): void => this.release(id);
      const handleNavigation = (_event: unknown, _url: string, _status: number, _text: string, isMainFrame: boolean): void => {
        if (isMainFrame) release();
      };
      const prospective = { event, sessionId: raw.sessionId };
      const view: TerminalViewOwner = { ...prospective, stop: () => {
        clearInterval(timer);
        event.sender.removeListener("destroyed", release);
        event.sender.removeListener("render-process-gone", release);
        event.sender.removeListener("did-frame-navigate", handleNavigation);
      } };
      // Admission can fail at the shared view limit before any owner listeners are installed.
      this.adapter.registerView(id, raw.sessionId, () => this.isCurrent(view), (events) => {
        if (!this.isCurrent(view)) { this.release(id); return; }
        event.sender.send(CHANNELS.preview.observationEvents, events);
      });
      const timer = setInterval(() => { if (!this.isCurrent(view)) release(); }, PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
      timer.unref();
      event.sender.on("destroyed", release);
      event.sender.on("render-process-gone", release);
      event.sender.on("did-frame-navigate", handleNavigation);
      this.views.set(id, view);
      return { ok: true, observation: { targetId: id, sessionId: raw.sessionId, seq: 0 } };
    }
    if (!isObservationAck(raw)) return { ok: false, error: "bad-request" };
    const view = this.views.get(raw.targetId);
    if (!view || !this.isCurrent(view) || view.event.sender !== event.sender || view.event.senderFrame !== event.senderFrame
      || view.sessionId !== raw.sessionId) return { ok: false, error: "unauthorized" };
    if (raw.action === "release") this.release(raw.targetId);
    else this.adapter.acknowledge(raw.targetId, raw.seq);
    return { ok: true };
  }

  private release(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    view.stop();
    this.adapter.release(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setAgentTerminalObservationSink(undefined);
    for (const id of this.views.keys()) this.release(id);
    this.adapter.dispose();
  }
}
