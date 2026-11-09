import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { DownloadItem, IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { ObservationDaemon } from "../../observation/daemon.js";
import { OBSERVATION_LIMITS, type BrowserObservationEvent } from "../../shared/agent-observation.js";
import { observeAgentBrowserCommand, endAgentBrowserObservationSessions } from "../../tools/agent-browser-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";
import { openAgentObservationTurn } from "../../__tests__/support/agent-observation-admission.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { browserTabRegistry, type BrowserGuest, type BrowserTabRecord } from "../browser/browser-tab-registry.js";

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
const turns = new Map<string, ReturnType<typeof openAgentObservationTurn>>();
function admitted<T>(run: () => Promise<T>, sessionId = identity.sessionId) {
  let turn = turns.get(sessionId);
  if (!turn) { turn = openAgentObservationTurn({ ...identity, sessionId }); turns.set(sessionId, turn); }
  return turn.run(identity, run);
}
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
afterEach(async () => {
  await Promise.all([...turns.values()].map((turn) => turn.finish()));
  turns.clear();
  runtime.dispose(); browserTabRegistry.__reset(); daemon.dispose(); vi.useRealTimers();
});

describe("browser observation desktop boundary", () => {
  it.each(["main", "child"].flatMap((kind) => ["completed", "interrupted", "errored"].flatMap((outcome) => ["live", "released", "unobserved"].map((presentation) => [kind, outcome, presentation] as const))))("retires a %s session's control when its turn is %s with %s presentation", async (kind, outcome, presentation) => {
    const actor = kind === "main" ? { sessionId: identity.sessionId } : { sessionId: "browser-child", directParentSessionId: identity.sessionId };
    const turnIdentity = { ...identity, sessionId: actor.sessionId };
    runtime.dispose();
    daemon.dispose();
    daemon = new ObservationDaemon();
    const stop = vi.fn(async () => {});
    runtime = new BrowserObservationRuntime(deps, daemon, {
      lookupTab: (handle, windowId) => browserTabRegistry.liveTabInWindow(handle, windowId),
      start: () => ({ rendered: () => {}, stop }),
      isBlank: () => false,
    });
    let guestUrl = "about:blank";
    const guest = Object.assign(new EventEmitter(), { id: 43, isDestroyed: () => false,
      getURL: () => guestUrl, getTitle: () => "Page" });
    browserTabRegistry.setRendererLink({
      sendTabOp: (_windowId, request) => {
        if (request.op === "new") {
          browserTabRegistry.guestAttached(guest as unknown as WebContents, 1);
          browserTabRegistry.bindTab(1, { tabId: "main-agent-page", webContentsId: guest.id, requestId: request.requestId });
        }
        return true;
      },
      sendControl: () => {},
    });
    const opened = await browserTabRegistry.requestTabOp(1, { op: "new", url: "https://example.test/page", actor });
    if (!opened.ok) throw new Error("Missing owned tab");
    guestUrl = "https://example.test/page";
    const owned = browserTabRegistry.liveTab(opened.tabId);
    if (!owned) throw new Error("Missing live tab");
    await runWithAgentObservationTurn(turnIdentity, async () => {
      const lease = browserTabRegistry.acquireControl(owned, actor);
      if (presentation !== "unobserved") await runWithAgentObservationInvocation(turnIdentity, () => observeAgentBrowserCommand(owned, "snapshot", async () => 1));
      browserTabRegistry.releaseControl(owned.handle, lease.id);
      await flush();
      if (presentation !== "unobserved") {
        const action = events().at(-1);
        if (!action) throw new Error("Missing real observation event");
        expect(runtime.previewRequest(event, { action: "start", targetId: action.target.id,
          sessionId: actor.sessionId, tabId: owned.handle, frame: 0 })).toEqual({ ok: true });
        if (presentation === "released") expect(runtime.acknowledge(event, { action: "release", targetId: action.target.id,
          sessionId: actor.sessionId, seq: action.seq })).toEqual({ ok: true });
      }
      expect(owned.controlMode).toBe("agent-active");
      if (outcome === "interrupted") { const controller = new AbortController(); controller.abort(); controller.signal.throwIfAborted(); }
      if (outcome === "errored") throw new Error(outcome);
    }).catch((error) => { if (outcome === "completed") throw error; });
    await flush();
    if (presentation === "live") expect(events().at(-1)).toMatchObject({ kind: "status", after: { code: "session-cleared" } });
    expect(stop).toHaveBeenCalledTimes(presentation === "unobserved" ? 0 : 1);
    expect(browserTabRegistry.controlState(1).tabs).toMatchObject([{ mode: "human", owner: actor }]);
    expect(browserTabRegistry.liveTab(owned.handle)).toBe(owned);
    expect(owned.guest).toBe(guest);
    expect(owned.opener).toBe("agent");
    const next = browserTabRegistry.acquireControl(owned, actor);
    expect(owned.controlMode).toBe("agent-active");
    browserTabRegistry.releaseControl(owned.handle, next.id);
  });
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
  it("does not clear a newer turn when an older turn's cleanup arrives late", async () => {
    const older = openAgentObservationTurn({ ...identity, turnId: "older" });
    let newer: ReturnType<typeof openAgentObservationTurn> | undefined;
    try {
      await older.run(identity, () => observeAgentBrowserCommand(tab, "snapshot", async () => 1));
      await flush();
      newer = openAgentObservationTurn({ ...identity, turnId: "newer" });
      await newer.run(identity, () => observeAgentBrowserCommand(tab, "snapshot", async () => 1));
      await flush();
      const cleared = events().filter((entry) => entry.kind === "status").length;
      await older.finish();
      expect(events().filter((entry) => entry.kind === "status")).toHaveLength(cleared);
      await newer.finish();
      expect(events().at(-1)).toMatchObject({ kind: "status", after: { code: "session-cleared" } });
    } finally { await older.finish(); await newer?.finish(); }
  });
  it("does not carry an older turn's download listener into a newer browser target", async () => {
    const older = openAgentObservationTurn({ ...identity, turnId: "older-download" });
    let newer: ReturnType<typeof openAgentObservationTurn> | undefined;
    const item = download();
    try {
      await older.run(identity, () => observeAgentBrowserCommand(tab, "click", async () => {
        runtime.observeDownload(tab.guest as WebContents, item);
      }, undefined, "https://example.test/file.zip"));
      await flush();
      const original = events().at(-1)?.target.id;
      expect(item.listenerCount("done")).toBe(1);
      newer = openAgentObservationTurn({ ...identity, turnId: "newer-download" });
      await newer.run(identity, () => observeAgentBrowserCommand(tab, "snapshot", async () => 1));
      await flush();
      expect(events().at(-1)?.target.id).not.toBe(original);
      await older.finish();
      const count = events().length;
      expect(item.listenerCount("done")).toBe(0);
      item.emit("done", {}, "completed");
      await flush();
      expect(events()).toHaveLength(count);
    } finally { await older.finish(); await newer?.finish(); }
  });
  it("retires an older held lease across a newer same-session turn before delayed settlement", async () => {
    let requestId = "";
    browserTabRegistry.setRendererLink({ sendTabOp: (_window, request) => { requestId = request.requestId; return true; }, sendControl: () => {} });
    const opening = browserTabRegistry.requestTabOp(1, { op: "new", url: "https://example.test/", actor: { sessionId: identity.sessionId } });
    const guest = { id: 44, isDestroyed: () => false, getURL: () => "about:blank", getTitle: () => "Page" } as unknown as WebContents;
    browserTabRegistry.guestAttached(guest, 1);
    browserTabRegistry.bindTab(1, { tabId: "overlapping-turns", webContentsId: guest.id, requestId });
    const opened = await opening;
    if (!opened.ok) throw new Error("Missing owned tab");
    const owned = browserTabRegistry.liveTab(opened.tabId);
    if (!owned) throw new Error("Missing live tab");
    const settlement = deferred<void>();
    const older = openAgentObservationTurn({ ...identity, turnId: "older-held" });
    let newer: ReturnType<typeof openAgentObservationTurn> | undefined;
    let pending: Promise<void> | undefined;
    try {
      pending = older.run(identity, async () => {
        const lease = browserTabRegistry.acquireControl(owned, { sessionId: identity.sessionId });
        try { await settlement.promise; }
        finally { browserTabRegistry.releaseControl(owned.handle, lease.id); }
      });
      newer = openAgentObservationTurn({ ...identity, turnId: "newer-no-browser" });
      await older.finish();
      await newer.finish();
      expect(owned.controlMode).toBe("human");
      expect(owned.lease).toBeNull();
      expect(() => browserTabRegistry.acquireControl(owned, { sessionId: identity.sessionId })).toThrow("settling");
      settlement.resolve();
      await pending;
      expect(owned.controlMode).toBe("human");
      expect(owned.lease).toBeNull();
    } finally { settlement.resolve(); await pending; await older.finish(); await newer?.finish(); }
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
  it("keeps a child target and admitted download alive between commands in its active turn", async () => {
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
