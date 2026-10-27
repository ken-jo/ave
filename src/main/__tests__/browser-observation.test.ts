import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { DownloadItem, IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { ObservationDaemon } from "../../observation/daemon.js";
import { OBSERVATION_LIMITS, type BrowserObservationEvent } from "../../shared/agent-observation.js";
import { observeAgentBrowserCommand, endAgentBrowserObservationSessions } from "../../tools/agent-browser-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";
import type { BrowserGuest, BrowserTabRecord } from "../browser/browser-tab-registry.js";

const state = vi.hoisted(() => ({ defaultSession: {}, holder: null as unknown, registered: true, childLive: true }));
vi.mock("electron", () => ({ session: { defaultSession: state.defaultSession } }));
vi.mock("../app-state.js", () => ({ findSessionMainWindowContents: (id: string) => id === "browser-session" ? state.holder : null }));
import { BrowserObservationRuntime } from "../browser-observation.js";

const identity = { sessionId: "browser-session", turnId: "turn", toolUseId: "tool" };
const frame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: () => false,
  getType: () => "window", session: state.defaultSession, send: vi.fn() });
const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const deps = { getAppWindows: () => state.registered ? [{ id: 1, isDestroyed: () => false, webContents: sender }] : [], getMainWindow: () => null,
  getSubAgentRunner: () => ({ liveOriginSessionId: (id: string) => state.childLive && id === "browser-child" ? identity.sessionId : undefined }) } as never;
let runtime: BrowserObservationRuntime;
let daemon: ObservationDaemon;
let tab: BrowserTabRecord<BrowserGuest>;
let url: string;
let title: string;
function admitted<T>(run: () => Promise<T>, sessionId = identity.sessionId) { return runWithAgentObservationTurn({ ...identity, sessionId }, () => runWithAgentObservationInvocation({ ...identity, sessionId }, run)); }
function events(): BrowserObservationEvent[] { return sender.send.mock.calls.filter(([channel]) => channel === CHANNELS.preview.observationEvents).flatMap(([, batch]) => batch as BrowserObservationEvent[]); }
async function flush() { await vi.advanceTimersByTimeAsync(1); }
function download(chain = ["https://example.test/file.zip"]) {
  return Object.assign(new EventEmitter(), { getURLChain: () => chain, hasUserGesture: () => true,
    getFilename: () => { throw new Error("Observation must not read the filename"); },
    getSavePath: () => { throw new Error("Observation must not read the save path"); } }) as unknown as DownloadItem;
}
beforeEach(() => {
  vi.useFakeTimers(); state.holder = sender; state.registered = true; state.childLive = true; sender.send.mockReset();
  url = "https://example.test/start"; title = "Start";
  const guest = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, getURL: () => url, getTitle: () => title });
  tab = { handle: "tab-1", rendererTabId: "browser-one", windowId: 1, guest,
    opener: "agent", documentId: 1, agentOrigin: "https://example.test", controlMode: "agent-active", controlGeneration: 1,
    targetKind: "embedded", openerTabId: null, owner: { sessionId: identity.sessionId },
    lease: { id: "lease", actor: { sessionId: identity.sessionId }, lifetime: "owned" }, actions: new AbortController() };
  daemon = new ObservationDaemon(); runtime = new BrowserObservationRuntime(deps, daemon);
});
afterEach(() => { runtime.dispose(); daemon.dispose(); vi.useRealTimers(); });

describe("browser observation desktop boundary", () => {
  it("delivers final navigation URL/title through the existing private channel and validates ACK owner", async () => {
    await admitted(() => observeAgentBrowserCommand(tab, "navigate", async () => { url = "https://example.test/done?secret=hidden#token"; title = "Done"; }));
    await flush();
    const observed = events()[0];
    expect(observed).toMatchObject({ source: "browser", actor: "agent", sessionId: identity.sessionId,
      target: { path: "browser" }, seq: 1, kind: "action", after: { action: "navigate", url: "https://example.test/done", title: "Done" } });
    const ack = { action: "rendered" as const, targetId: observed.target.id, sessionId: observed.sessionId, seq: observed.seq };
    expect(runtime.acknowledge({ ...event, senderFrame: { ...frame } } as never, ack)).toEqual({ ok: false, error: "unauthorized" });
    expect(runtime.acknowledge(event, ack)).toEqual({ ok: true });
    expect(() => runtime.acknowledge(event, { ...ack, seq: 99 })).toThrow("acknowledgement");
  });
  it("never observes user-only navigation, typing, title changes or passive page downloads", async () => {
    const guest = tab.guest as unknown as EventEmitter;
    guest.emit("did-navigate", {}, "https://private.test/"); guest.emit("input-event", {}, { type: "keyDown", key: "secret" });
    guest.emit("page-title-updated", {}, "Private");
    runtime.observeDownload(tab.guest as WebContents, download());
    await flush(); expect(events()).toEqual([]);
  });
  it("requires an exact expected download URL and the same native guest during a valid invocation", async () => {
    const native = new AsyncResource("native-download");
    const accepted = download(["https://example.test/file.zip", "https://cdn.example.test/object"]);
    await admitted(() => observeAgentBrowserCommand(tab, "click", async (onTarget) => {
      onTarget!({ ref: "e1", role: "link", name: "Download", redacted: false }, "https://example.test/file.zip");
      native.runInAsyncScope(() => {
        runtime.observeDownload({ id: 999 } as WebContents, download());
        runtime.observeDownload({ id: tab.guest!.id } as WebContents, download());
        runtime.observeDownload(tab.guest as WebContents, download(["https://example.test/spontaneous.zip"]));
        const withoutGesture = download();
        withoutGesture.hasUserGesture = () => false;
        runtime.observeDownload(tab.guest as WebContents, withoutGesture);
        runtime.observeDownload(tab.guest as WebContents, accepted);
      });
    }));
    native.emitDestroy();
    accepted.emit("done", {}, "completed");
    runtime.observeDownload(tab.guest as WebContents, download());
    await flush();
    expect(events().filter((entry) => entry.kind === "action" && entry.after.action === "download").map((entry) => entry.after))
      .toMatchObject([{ download: { state: "started" } }, { download: { state: "completed" } }]);
    expect(JSON.stringify(events())).not.toMatch(/spontaneous|file\.zip|object|filename|savePath/);
    expect(accepted.listenerCount("done")).toBe(0);
  });
  it("excludes a matching user download after takeover in the same tab", async () => {
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => {
      tab.controlMode = "human-paused";
      runtime.observeDownload(tab.guest as WebContents, download());
    }, undefined, "https://example.test/file.zip"));
    await flush(); expect(events()).toEqual([]);
  });
  it("clears already-delivered history and removes download listeners with the session", async () => {
    const item = download();
    await admitted(() => observeAgentBrowserCommand(tab, "navigate", async () => runtime.observeDownload(tab.guest as WebContents, item), undefined, "https://example.test/file.zip"));
    await flush();
    const previous = events().at(-1)!;
    endAgentBrowserObservationSessions((id) => id === identity.sessionId);
    expect(events().at(-1)).toMatchObject({ source: "browser", target: previous.target, kind: "status", after: { code: "session-cleared" } });
    expect(events().at(-1)!.seq).toBeGreaterThan(previous.seq);
    expect(item.listenerCount("done")).toBe(0);
    const count = events().length;
    item.emit("done", {}, "completed"); await flush(); expect(events()).toHaveLength(count);
    expect(runtime.acknowledge(event, { action: "rendered", targetId: previous.target.id, sessionId: identity.sessionId, seq: previous.seq })).toBeUndefined();
  });
  it("delivers a content-free invalidation to the original frame after its session is no longer hosted", async () => {
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => 1));
    await flush();
    const previous = events().at(-1)!;
    state.holder = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events().at(-1)).toMatchObject({ target: previous.target, kind: "status", after: { code: "session-cleared" } });
    expect(events().at(-1)!.seq).toBeGreaterThan(previous.seq);
    expect(events().filter((entry) => entry.kind === "action")).toHaveLength(1);
  });
  it.each(["did-frame-navigate", "render-process-gone", "destroyed"])("revokes pending work and item listeners on owner %s", async (reason) => {
    const item = download();
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => runtime.observeDownload(tab.guest as WebContents, item), undefined, "https://example.test/file.zip"));
    if (reason === "did-frame-navigate") sender.emit(reason, {}, "file:///new/index.html", 200, "OK", true); else sender.emit(reason);
    await flush(); expect(events()).toEqual([]); expect(item.listenerCount("done")).toBe(0);
  });
  it("retains actual child attribution while deriving its owning parent window from live host state", async () => {
    tab.owner = { sessionId: "browser-child", directParentSessionId: identity.sessionId };
    tab.lease = { ...tab.lease!, actor: tab.owner };
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => 1), "browser-child");
    await flush();
    expect(events()[0]).toMatchObject({ sessionId: "browser-child", target: { hostSessionId: identity.sessionId }, after: { tabId: "tab-1" } });
    expect(runtime.acknowledge(event, { action: "rendered", sessionId: "browser-child", targetId: events()[0].target.id, seq: 1 })).toEqual({ ok: true });
  });
  it("refuses unregistered windows and mismatched tab-window identities clearly", async () => {
    state.registered = false;
    await expect(admitted(() => observeAgentBrowserCommand(tab, "click", async () => 1))).rejects.toThrow("window");
    state.registered = true; tab = { ...tab, windowId: 2 };
    await expect(admitted(() => observeAgentBrowserCommand(tab, "click", async () => 1))).rejects.toThrow("identity");
    expect(events()).toEqual([]);
  });
  it("keeps a child session target and admitted download alive between agent runs", async () => {
    tab.owner = { sessionId: "browser-child", directParentSessionId: identity.sessionId };
    tab.lease = { ...tab.lease!, actor: tab.owner };
    const item = download();
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => runtime.observeDownload(tab.guest as WebContents, item),
      undefined, "https://example.test/file.zip"), "browser-child");
    await flush();
    const original = events()[0].target;
    state.childLive = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events().some((entry) => entry.kind === "status" && entry.after.code === "session-cleared")).toBe(false);
    expect(item.listenerCount("done")).toBe(1);
    item.emit("done", {}, "completed"); await flush();
    expect(events().at(-1)).toMatchObject({ target: original, after: { action: "download", download: { state: "completed" } } });
    state.childLive = true;
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => 1), "browser-child");
    await flush();
    expect(events().at(-1)!.target).toEqual(original);
  });
  it("finishes resource cleanup and surfaces a terminal delivery failure", async () => {
    const item = download();
    await admitted(() => observeAgentBrowserCommand(tab, "navigate", async () => runtime.observeDownload(tab.guest as WebContents, item),
      undefined, "https://example.test/file.zip"));
    await flush();
    sender.send.mockImplementationOnce(() => { throw new Error("Terminal delivery failed"); });
    expect(() => runtime.dispose()).toThrow("cleanup failed");
    expect(item.listenerCount("done")).toBe(0);
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(sender.listenerCount("did-frame-navigate")).toBe(0);
    const delivered = events().length;
    item.emit("done", {}, "completed"); await flush();
    expect(events()).toHaveLength(delivered);
  });
  it("bounds simultaneous download listeners and reports overflow without interrupting the native download", async () => {
    await admitted(() => observeAgentBrowserCommand(tab, "click", async () => {
      for (let index = 0; index < OBSERVATION_LIMITS.maxViews; index++) runtime.observeDownload(tab.guest as WebContents, download());
      const excess = download();
      expect(() => runtime.observeDownload(tab.guest as WebContents, excess)).not.toThrow();
      expect(excess.listenerCount("done")).toBe(0);
    }, undefined, "https://example.test/file.zip"));
    await flush();
    expect(events().at(-1)).toMatchObject({ kind: "status", after: { code: "resync-required" } });
  });
});
