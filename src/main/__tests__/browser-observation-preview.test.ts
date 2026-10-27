import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { ObservationDaemon } from "../../observation/daemon.js";
import { ScreencastClosedError, type ScreencastCallbacks } from "../../observation/browser-screencast.js";
import { OBSERVATION_LIMITS, type BrowserObservationEvent, type BrowserObservationPreviewMessage } from "../../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { observeAgentBrowserCommand, endAgentBrowserObservationSessions } from "../../tools/agent-browser-observation.js";
import { runAdmittedAgentWork } from "../../__tests__/support/agent-observation-admission.js";
import type { BrowserGuest, BrowserTabRecord } from "../browser/browser-tab-registry.js";

const state = vi.hoisted(() => ({ defaultSession: {}, holder: null as unknown }));
vi.mock("electron", () => ({ session: { defaultSession: state.defaultSession } }));
vi.mock("../app-state.js", () => ({ findSessionMainWindowContents: (id: string) => id === "browser-session" ? state.holder : null }));
import { BrowserObservationRuntime, type BrowserPreviewDeps } from "../browser-observation.js";

const identity = { sessionId: "browser-session", turnId: "turn", toolUseId: "tool" };
const frame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: () => false,
  getType: () => "window", session: state.defaultSession, send: vi.fn() });
const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
// A second registered app window with its own main frame.
const otherFrame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
const otherSender = Object.assign(new EventEmitter(), { id: 2, mainFrame: otherFrame, isDestroyed: () => false,
  getType: () => "window", session: state.defaultSession, send: vi.fn() });
const otherEvent = { sender: otherSender, senderFrame: otherFrame } as unknown as IpcMainInvokeEvent;
const deps = { getAppWindows: () => [{ id: 1, isDestroyed: () => false, webContents: sender },
  { id: 2, isDestroyed: () => false, webContents: otherSender }], getMainWindow: () => null,
  getSubAgentRunner: () => ({ liveOriginSessionId: () => undefined }) } as never;

interface Started { guest: BrowserGuest; callbacks: ScreencastCallbacks; rendered: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
let started: Started[];
let tabs: Map<string, BrowserTabRecord<BrowserGuest>>;
let tab: BrowserTabRecord<BrowserGuest>;
let url: string;
let runtime: BrowserObservationRuntime;
let daemon: ObservationDaemon;
const preview: BrowserPreviewDeps = {
  lookupTab: (handle, windowId) => { const found = tabs.get(handle); return found?.windowId === windowId ? found : undefined; },
  start: (guest, callbacks) => {
    const entry = { guest, callbacks, rendered: vi.fn(), stop: vi.fn(async () => undefined) };
    started.push(entry);
    return { rendered: entry.rendered, stop: entry.stop };
  },
  isBlank: () => false,
};

function sent(channel: string) { return sender.send.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload); }
function messages() { return sent(CHANNELS.preview.observationPreviewFrames) as BrowserObservationPreviewMessage[]; }
function events() { return (sent(CHANNELS.preview.observationEvents) as BrowserObservationEvent[][]).flat(); }
function makeTab(handle: string, guestId: number, rendererTabId: string): BrowserTabRecord<BrowserGuest> {
  const guest = Object.assign(new EventEmitter(), { id: guestId, isDestroyed: () => false, getURL: () => url, getTitle: () => "Page" });
  return { handle, rendererTabId, windowId: 1, guest, opener: "agent", documentId: 1, agentOrigin: "https://example.test",
    controlMode: "agent-active", controlGeneration: 1, targetKind: "embedded", openerTabId: null, owner: { sessionId: identity.sessionId },
    lease: { id: `lease-${handle}`, actor: { sessionId: identity.sessionId }, lifetime: "owned" }, actions: new AbortController() };
}
/** One completed agent click on `tab`, as the observation stream delivers it. */
async function agentClick(target = tab) {
  await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(target, "click", async () => 1));
  await vi.advanceTimersByTimeAsync(1);
  // The lease ends with the command; ownership remains.
  target.controlMode = "human";
  target.lease = null;
  return events().at(-1)!;
}
function request(action: "start" | "stop" | "rendered", targetId: string, tabId = "tab-1", frameNumber = 0, sessionId = identity.sessionId) {
  return runtime.previewRequest(event, { action, targetId, sessionId, tabId, frame: frameNumber });
}

beforeEach(() => {
  vi.useFakeTimers();
  state.holder = sender;
  sender.send.mockReset();
  url = "https://example.test/start";
  started = [];
  tab = makeTab("tab-1", 10, "browser-one");
  tabs = new Map([[tab.handle, tab]]);
  daemon = new ObservationDaemon();
  runtime = new BrowserObservationRuntime(deps, daemon, preview);
});
afterEach(() => { runtime.dispose(); daemon.dispose(); vi.useRealTimers(); });

describe("agent browser live preview", () => {
  it("binds only to the exact agent tab handle and never falls back to another tab", async () => {
    const observed = await agentClick();
    const other = makeTab("tab-2", 11, "browser-two");
    other.owner = null; other.lease = null; other.opener = "user"; other.controlMode = "human";
    tabs.set(other.handle, other);
    expect(request("start", observed.target.id, "tab-2")).toEqual({ ok: false, error: "not-agent-tab" });
    expect(request("start", observed.target.id, "tab-9")).toEqual({ ok: false, error: "not-agent-tab" });
    expect(started).toEqual([]);
    expect(request("start", observed.target.id)).toEqual({ ok: true });
    expect(started).toHaveLength(1);
    expect(started[0]!.guest).toBe(tab.guest);
    // A repeated start for the same live guest keeps the one screencast.
    expect(request("start", observed.target.id)).toEqual({ ok: true });
    expect(started).toHaveLength(1);
  });

  it("refuses unknown targets, other sessions, foreign frames and malformed requests", async () => {
    const observed = await agentClick();
    expect(request("start", "11111111-1111-4111-8111-111111111111")).toEqual({ ok: false, error: "unauthorized" });
    expect(request("start", observed.target.id, "tab-1", 0, "another-session")).toEqual({ ok: false, error: "unauthorized" });
    expect(runtime.previewRequest({ ...event, senderFrame: { ...frame } } as never,
      { action: "start", targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1", frame: 0 })).toEqual({ ok: false, error: "unauthorized" });
    for (const raw of [{ action: "start", targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1" },
      { action: "start", targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1", frame: 3 },
      { action: "start", targetId: observed.target.id, sessionId: identity.sessionId, tabId: "first", frame: 0 },
      { action: "start", targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1", frame: 0, url: "x" }]) {
      expect(runtime.previewRequest(event, raw)).toEqual({ ok: false, error: "bad-request" });
    }
    expect(started).toEqual([]);
  });

  it("refuses another registered window's main frame for this window's preview", async () => {
    const observed = await agentClick();
    const request = { action: "start", targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1", frame: 0 };
    expect(runtime.previewRequest(otherEvent, request)).toEqual({ ok: false, error: "unauthorized" });
    expect(started).toEqual([]);
    expect(runtime.previewRequest(event, request)).toEqual({ ok: true });
    expect(runtime.previewRequest(otherEvent, { ...request, action: "stop" })).toEqual({ ok: false, error: "unauthorized" });
    expect(started[0]!.stop).not.toHaveBeenCalled();
    expect(otherSender.send).not.toHaveBeenCalled();
  });

  it("records tab operations and keeps the preview under one ownership rule after the agent's cross-origin navigation", async () => {
    const observed = await agentClick();
    // The agent's own navigation to a new origin clears original-origin provenance.
    tab.opener = "user"; tab.agentOrigin = null;
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "tab-switch", async () => 1));
    await vi.advanceTimersByTimeAsync(1);
    expect(events().at(-1)).toMatchObject({ kind: "action", after: { action: "tab-switch", tabId: "tab-1" } });
    expect(request("start", observed.target.id)).toEqual({ ok: true });
    // A user pause excludes both alike.
    tab.controlMode = "human-paused";
    const before = events().length;
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "tab-switch", async () => 1));
    await vi.advanceTimersByTimeAsync(PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
    expect(events()).toHaveLength(before);
    expect(started[0]!.stop).toHaveBeenCalledOnce();
  });

  it("refuses user tabs: unowned, another session's and user-paused tabs never preview", async () => {
    const observed = await agentClick();
    tab.owner = null;
    expect(request("start", observed.target.id)).toEqual({ ok: false, error: "not-agent-tab" });
    tab.owner = { sessionId: "another-session" };
    expect(request("start", observed.target.id)).toEqual({ ok: false, error: "not-agent-tab" });
    // User input, address-bar navigation and Stop all pause an agent-owned tab and clear its agent provenance.
    tab.owner = { sessionId: identity.sessionId }; tab.opener = "user"; tab.controlMode = "human-paused";
    expect(request("start", observed.target.id)).toEqual({ ok: false, error: "not-agent-tab" });
    expect(started).toEqual([]);
  });

  it("keeps previewing an owned tab after the agent's own cross-origin navigation", async () => {
    const observed = await agentClick();
    // The registry drops original-origin provenance on any new origin; the tab is still agent-owned and not paused.
    tab.opener = "user"; tab.agentOrigin = null;
    expect(request("start", observed.target.id)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs * 3);
    expect(started[0]!.stop).not.toHaveBeenCalled();
  });

  it("delivers frames only on the transient preview channel, never through the observation daemon", async () => {
    const observed = await agentClick();
    const before = events().length;
    request("start", observed.target.id);
    started[0]!.callbacks.frame({ frame: 1, data: "jpeg", width: 640, height: 400 });
    expect(messages()).toEqual([{ targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1", kind: "frame",
      mimeType: "image/jpeg", frame: 1, data: "jpeg", width: 640, height: 400, ts: expect.any(Number) }]);
    expect(events()).toHaveLength(before);
    expect(request("rendered", observed.target.id, "tab-1", 1)).toEqual({ ok: true });
    expect(started[0]!.rendered).toHaveBeenCalledWith(1);
    started[0]!.callbacks.updating();
    expect(messages().at(-1)).toMatchObject({ kind: "state", state: "updating" });
  });

  it("stops at once when the user takes over the tab, without forwarding another frame", async () => {
    const observed = await agentClick();
    request("start", observed.target.id);
    tab.controlMode = "human-paused";
    started[0]!.callbacks.frame({ frame: 1, data: "user-typing", width: 1, height: 1 });
    expect(messages()).toEqual([{ targetId: observed.target.id, sessionId: identity.sessionId, tabId: "tab-1", kind: "state", state: "stopped" }]);
    expect(started[0]!.stop).toHaveBeenCalledOnce();
  });

  it("parks a preview after the agent has been idle on the tab and resumes on the next agent action", async () => {
    const observed = await agentClick();
    request("start", observed.target.id);
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewIdleMs - 500);
    expect(started[0]!.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started[0]!.stop).toHaveBeenCalledOnce();
    expect(messages().at(-1)).toMatchObject({ kind: "state", state: "stopped" });
    expect(request("start", observed.target.id)).toEqual({ ok: false, error: "not-agent-tab" });
    tab.lease = { id: "lease-again", actor: { sessionId: identity.sessionId }, lifetime: "owned" };
    tab.controlMode = "agent-active";
    const next = await agentClick();
    expect(next.target.id).toBe(observed.target.id);
    expect(request("start", observed.target.id)).toEqual({ ok: true });
    expect(started).toHaveLength(2);
  });

  it("keeps running through a transient empty URL while a cross-site commit swaps processes", async () => {
    const observed = await agentClick();
    request("start", observed.target.id);
    url = "";
    await vi.advanceTimersByTimeAsync(160);
    started[0]!.callbacks.frame({ frame: 1, data: "committed", width: 640, height: 400 });
    url = "https://other.example.test/";
    await vi.advanceTimersByTimeAsync(PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs * 3);
    expect(started[0]!.stop).not.toHaveBeenCalled();
    expect(messages().map((message) => message.kind)).toEqual(["frame"]);
  });

  it("reports a closed page session as stopped and any other failure as an error", async () => {
    const observed = await agentClick();
    request("start", observed.target.id);
    started[0]!.callbacks.ended(new ScreencastClosedError("target-destroyed"));
    expect(messages().at(-1)).toMatchObject({ kind: "state", state: "stopped" });
    request("start", observed.target.id);
    started[1]!.callbacks.ended(new Error("Page.startScreencast failed"));
    expect(messages().at(-1)).toMatchObject({ kind: "state", state: "error" });
    expect(request("rendered", observed.target.id, "tab-1", 1)).toEqual({ ok: false, error: "not-previewing" });
  });

  it("stops on a hidden-panel stop request and on session end", async () => {
    const observed = await agentClick();
    request("start", observed.target.id);
    expect(request("stop", observed.target.id)).toEqual({ ok: true });
    expect(started[0]!.stop).toHaveBeenCalledOnce();
    request("start", observed.target.id);
    endAgentBrowserObservationSessions((id) => id === identity.sessionId);
    expect(started[1]!.stop).toHaveBeenCalledOnce();
    expect(request("start", observed.target.id)).toEqual({ ok: false, error: "unauthorized" });
  });

  it("stops every preview when the observation runtime is disposed", async () => {
    const observed = await agentClick();
    request("start", observed.target.id);
    runtime.dispose();
    expect(started[0]!.stop).toHaveBeenCalledOnce();
  });
});
