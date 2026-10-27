import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTabRegistry, type BrowserGuest } from "../browser-tab-registry.js";
import { SettingsService } from "../../../data/settings-store.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import type { MainLayoutSnapshot } from "../../../shared/main-layout.js";
import type { BrowserSessionActor, BrowserTabOpRequest, SessionTabBindingsState } from "../../../shared/browser-surface.js";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../../lib/logger.js", () => ({ createLogger: () => ({ info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const MAIN_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const PANE_SESSION = "bbbbbbbb-1111-2222-3333-444444444444";
const BROWSER_TAB = "browser:0000000a-1";
const TERMINAL_TAB = "terminal:0000000a-2";

function layout(): MainLayoutSnapshot {
  return {
    version: 1, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", surfaces: {}, panelOpenIds: ["main"], thumbnailOpenIds: [],
    sideTabs: { main: [
      { kind: "browser", tabId: BROWSER_TAB, ordinal: 1, cwd: null, url: "https://example.com/" },
      { kind: "terminal", tabId: TERMINAL_TAB, ordinal: 1, cwd: "/work", url: null },
    ] },
  };
}

function guest(id: number): BrowserGuest {
  return { id, isDestroyed: () => false, getURL: () => "about:blank", getTitle: () => "Page" };
}

let directory: string;
let memory: MemoryManager;
let settings: SettingsService;

function settingsFromDisk(): SettingsService {
  return new SettingsService({ userDataPath: join(directory, "settings"), encryption: unavailableSecretEncryption });
}

function saveLayout(store: SettingsService, snapshot: MainLayoutSnapshot) {
  return store.patch({ system: { ...store.get("system"), mainLayout: snapshot } });
}

function registryFor(store = settings, windowId = 1) {
  const registry = new BrowserTabRegistry<BrowserGuest>();
  const requests: BrowserTabOpRequest[] = [];
  const changes: SessionTabBindingsState[] = [];
  registry.setRendererLink({
    sendTabOp: (_windowId, request) => { requests.push(request); return true; }, sendControl: () => {},
    sendSessionBindings: (_windowId, state) => changes.push(state),
  });
  registry.setBindingPersistence({
    savedWindowId: () => windowId,
    load: (id) => id === windowId ? store.get("system").mainLayout : undefined,
    save: async (id, snapshot) => { if (id === windowId) await saveLayout(store, snapshot); },
    sessionExists: (id) => memory.hasSessionTranscript(id),
    legacyPaneSession: (tabId) => memory.findPaneSession(tabId),
  });
  return { registry, requests, changes };
}

async function openOwnedTab(registry: BrowserTabRegistry<BrowserGuest>, requests: BrowserTabOpRequest[], actor: BrowserSessionActor = { sessionId: MAIN_SESSION }) {
  const opened = registry.requestTabOp(1, { op: "new", url: "https://example.com/", actor });
  registry.guestAttached(guest(41), 1);
  expect(registry.bindTab(1, { tabId: BROWSER_TAB, webContentsId: 41, requestId: requests.at(-1)!.requestId })).toEqual({ ok: true });
  expect(await opened).toEqual({ ok: true, tabId: "tab-1" });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ave-tab-bindings-"));
  memory = new MemoryManager({ aveDir: join(directory, "sessions") });
  await memory.saveSession(MAIN_SESSION, [{ role: "user", content: "Open a page" }]);
  await memory.saveSession(PANE_SESSION, [{ role: "user", content: "Use this terminal" }]);
  settings = settingsFromDisk();
  await saveLayout(settings, layout());
  info.mockClear();
});

afterEach(async () => { await cleanupTmpDir(directory); });

describe("durable session tab bindings", () => {
  it.each(["sessions", "clear"])("does not rewrite identical restored bindings (%s)", async (state) => {
    const saved = layout();
    saved.sideTabs.main![0]!.binding = state === "sessions"
      ? { owner: { sessionId: MAIN_SESSION }, paneSessionId: PANE_SESSION }
      : {};
    saved.sideTabs.main![1]!.binding = {};
    await saveLayout(settings, saved);
    const patch = vi.spyOn(settings, "patch");
    const { registry, changes } = registryFor();
    registry.sessionBindingsState(1);
    registry.paneConversation(1, BROWSER_TAB);
    await registry.flushBindingWrites();
    expect(patch).not.toHaveBeenCalled();
    expect(changes).toHaveLength(1);
    expect(settings.get("system").mainLayout).toEqual(saved);
  });

  it("writes a legacy migration once and does not rewrite it on the next restore", async () => {
    await memory.saveSessionMetadata(PANE_SESSION, { sessionKind: "main", paneTabId: TERMINAL_TAB });
    const patch = vi.spyOn(settings, "patch");
    const first = registryFor();
    expect(first.registry.paneConversation(1, TERMINAL_TAB)).toBe(PANE_SESSION);
    await first.registry.flushBindingWrites();
    expect(patch).toHaveBeenCalledOnce();
    const restartedSettings = settingsFromDisk();
    const restartedPatch = vi.spyOn(restartedSettings, "patch");
    const restarted = registryFor(restartedSettings, 3);
    expect(restarted.registry.paneConversation(3, TERMINAL_TAB)).toBe(PANE_SESSION);
    await restarted.registry.flushBindingWrites();
    expect(restartedPatch).not.toHaveBeenCalled();
  });

  it("deletes an unmounted owner binding when its layout slot disappears", async () => {
    const saved = layout();
    saved.sideTabs.main![0]!.binding = { owner: { sessionId: MAIN_SESSION } };
    await saveLayout(settings, saved);
    const { registry } = registryFor();
    expect(registry.windowsHoldingTab(BROWSER_TAB)).toEqual([1]);
    registry.prepareLayoutBindings(1, { ...layout(), sideTabs: {} });
    expect(registry.windowsHoldingTab(BROWSER_TAB)).toEqual([]);
    expect(registry).toHaveProperty("workspaceBindings.size", 0);
    await registry.flushBindingWrites();
  });

  it("retains only the ending pane target when an unmounted owned slot disappears", async () => {
    const saved = layout();
    saved.sideTabs.main![0]!.binding = { owner: { sessionId: MAIN_SESSION }, paneSessionId: PANE_SESSION };
    await saveLayout(settings, saved);
    const { registry } = registryFor();
    registry.prepareLayoutBindings(1, { ...layout(), sideTabs: {} });
    const bindings = Reflect.get(registry, "workspaceBindings") as ReadonlyMap<string, unknown>;
    expect([...bindings.values()]).toEqual([{
      windowId: 1, surface: { kind: "browser", tabId: BROWSER_TAB }, owner: null,
      paneSessionId: PANE_SESSION, closed: true,
    }]);
    expect(registry.defaultBrowserTab(1, PANE_SESSION)).toMatchObject({ ok: false });
    expect(registry.isPaneConversation(PANE_SESSION)).toBe(true);
    registry.releasePaneConversation(1, BROWSER_TAB, true);
    expect(registry).toHaveProperty("workspaceBindings.size", 0);
    await registry.flushBindingWrites();
  });

  it("prunes the layout entry without allowing a pending request to replace a retained browser owner", async () => {
    const { registry, requests } = registryFor();
    await openOwnedTab(registry, requests);
    registry.prepareLayoutBindings(1, { ...layout(), sideTabs: {} });
    expect(registry).toHaveProperty("workspaceBindings.size", 0);
    registry.guestDestroyed(41);
    const abort = new AbortController();
    const pending = registry.requestTabOp(1, { op: "new", url: "https://example.com/", actor: { sessionId: PANE_SESSION } }, { signal: abort.signal });
    registry.guestAttached(guest(42), 1);
    try {
      expect(registry.bindTab(1, { tabId: BROWSER_TAB, webContentsId: 42, requestId: requests.at(-1)!.requestId }))
        .toEqual({ ok: false, error: "guest-not-hosted" });
      expect(registry.bindTab(1, { tabId: BROWSER_TAB, webContentsId: 42 })).toEqual({ ok: true });
      expect(registry.liveTab("tab-1")?.owner).toEqual({ sessionId: MAIN_SESSION });
      expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    } finally {
      abort.abort();
      await pending;
      await registry.flushBindingWrites();
    }
  });

  it("drains writes added while shutdown is waiting for persistence", async () => {
    const registry = new BrowserTabRegistry<BrowserGuest>();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    registry.trackBindingWrite(new Promise<void>((resolve) => { finishFirst = resolve; }));
    let flushed = false;
    const completed = registry.flushBindingWrites().then(() => { flushed = true; });
    registry.trackBindingWrite(new Promise<void>((resolve) => { finishSecond = resolve; }));
    finishFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(flushed).toBe(false);
    } finally {
      finishSecond();
      await completed;
    }
    expect(flushed).toBe(true);
  });

  it("round-trips main and pane sessions through the existing settings file under a new window id", async () => {
    const first = registryFor();
    await openOwnedTab(first.registry, first.requests);
    first.registry.bindConversationSurface(PANE_SESSION, { windowId: 1, surface: { kind: "terminal", tabId: TERMINAL_TAB } });
    await first.registry.flushBindingWrites();
    first.registry.releaseWindow(1);
    const restartedSettings = settingsFromDisk();
    memory = new MemoryManager({ aveDir: join(directory, "sessions") });
    const restarted = registryFor(restartedSettings, 9);
    expect(restarted.registry.sessionBindingsState(9).bindings).toEqual([
      { sessionId: MAIN_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] },
      { sessionId: PANE_SESSION, browserTabIds: [], terminalTabIds: [TERMINAL_TAB] },
    ]);
    expect(restarted.registry.defaultTerminalTabId(9, PANE_SESSION)).toBe(TERMINAL_TAB);
    restarted.registry.setActiveSurface(9, { kind: "terminal", tabId: "terminal:0000000a-99" });
    expect(restarted.registry.defaultTerminalTabId(9, PANE_SESSION)).toBe(TERMINAL_TAB);
    restarted.registry.guestAttached(guest(52), 9);
    restarted.registry.bindTab(9, { tabId: BROWSER_TAB, webContentsId: 52 });
    expect(restarted.registry.liveTab("tab-1")?.owner).toEqual({ sessionId: MAIN_SESSION });
    expect(restarted.registry.liveTab("tab-1")).toMatchObject({ controlMode: "human-paused", lease: null, agentOrigin: null, opener: "user" });
    expect(() => restarted.registry.acquireControl(restarted.registry.liveTab("tab-1")!, { sessionId: MAIN_SESSION })).toThrow("browser control is paused");
    expect(restarted.registry.resume(9, BROWSER_TAB)).toBe(true);
    expect(restarted.registry.liveTab("tab-1")?.agentOrigin).toBeNull();
    expect(() => restarted.registry.assertActorAccess(restarted.registry.liveTab("tab-1")!, { sessionId: PANE_SESSION })).toThrow("another conversation");
    await restarted.registry.flushBindingWrites();
  });

  it("binds an agent-opened page to its main session and publishes revisioned changes", async () => {
    const { registry, requests, changes } = registryFor();
    await openOwnedTab(registry, requests);
    expect(registry.isPaneConversation(MAIN_SESSION)).toBe(false);
    expect(registry.liveTab("tab-1")?.owner?.sessionId).toBe(MAIN_SESSION);
    expect(changes.at(-1)?.bindings).toEqual([{ sessionId: MAIN_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] }]);
    expect(registry.sessionBindingsState(2).bindings).toEqual([]);
    expect(changes.map((state) => state.revision)).toEqual([1, 2]);
    await registry.flushBindingWrites();
  });

  it("refuses to attribute a restored owned slot to a later new-tab request", async () => {
    const saved = layout();
    saved.sideTabs.main![0]!.binding = { owner: { sessionId: MAIN_SESSION } };
    await saveLayout(settings, saved);
    const { registry, requests } = registryFor();
    const abort = new AbortController();
    const pending = registry.requestTabOp(1, { op: "new", url: "https://example.com/", actor: { sessionId: PANE_SESSION } }, { signal: abort.signal });
    registry.guestAttached(guest(41), 1);
    expect(registry.bindTab(1, { tabId: BROWSER_TAB, webContentsId: 41, requestId: requests.at(-1)!.requestId }))
      .toEqual({ ok: false, error: "guest-not-hosted" });
    expect(registry.sessionBindingsState(1).bindings).toEqual([{ sessionId: MAIN_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] }]);
    abort.abort();
    expect(await pending).toEqual({ ok: false, error: "aborted" });
    await registry.flushBindingWrites();
  });

  it("removes missing sessions on restart and writes the pruned state with a reason", async () => {
    const saved = layout();
    const absent = "cccccccc-1111-2222-3333-444444444444";
    saved.sideTabs.main![0]!.binding = { owner: { sessionId: absent }, paneSessionId: PANE_SESSION };
    saved.sideTabs.main![1]!.binding = { paneSessionId: absent };
    await saveLayout(settings, saved);
    const { registry } = registryFor();
    expect(registry.sessionBindingsState(1).bindings).toEqual([{ sessionId: PANE_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] }]);
    await registry.flushBindingWrites();
    expect(settingsFromDisk().get("system").mainLayout?.sideTabs.main?.map((tab) => tab.binding)).toEqual([{ paneSessionId: PANE_SESSION }, {}]);
    expect(info.mock.calls.filter(([message]) => String(message).includes("session-missing"))).toHaveLength(2);
  });

  it("prunes a removed tab from the model and saved geometry with a reason", async () => {
    const { registry, requests } = registryFor();
    await openOwnedTab(registry, requests);
    const withoutBrowser = layout();
    withoutBrowser.sideTabs.main = withoutBrowser.sideTabs.main!.filter((tab) => tab.kind === "terminal");
    await saveLayout(settings, registry.prepareLayoutBindings(1, withoutBrowser));
    expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    expect(info.mock.calls.some(([message]) => String(message).includes("tab-missing"))).toBe(true);
    await registry.flushBindingWrites();
    const restarted = registryFor(settingsFromDisk(), 3);
    expect(restarted.registry.sessionBindingsState(3).bindings).toEqual([]);
    await restarted.registry.flushBindingWrites();
  });

  it("ignores renderer-authored ownership and preserves creator identity when a pane chat changes", async () => {
    const { registry, requests } = registryFor();
    await openOwnedTab(registry, requests);
    registry.bindConversationSurface(PANE_SESSION, { windowId: 1, surface: { kind: "browser", tabId: BROWSER_TAB } });
    const renderer = layout();
    renderer.sideTabs.main![0]!.binding = { owner: { sessionId: PANE_SESSION } };
    const prepared = registry.prepareLayoutBindings(1, renderer);
    expect(prepared.sideTabs.main![0]!.binding).toEqual({ owner: { sessionId: MAIN_SESSION }, paneSessionId: PANE_SESSION });
    registry.releasePaneConversation(1, BROWSER_TAB);
    expect(registry.sessionBindingsState(1).bindings).toEqual([{ sessionId: MAIN_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] }]);
    registry.releasePaneConversation(1, BROWSER_TAB, true);
    expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    await registry.flushBindingWrites();
  });

  it("publishes and persists both windows when moving a lazily restored pane conversation", async () => {
    const saved = layout();
    saved.sideTabs.main![1]!.binding = { paneSessionId: PANE_SESSION };
    await saveLayout(settings, saved);
    const { registry, changes } = registryFor();
    registry.bindConversationSurface(PANE_SESSION, { windowId: 2, surface: { kind: "terminal", tabId: "terminal:0000000b-1" } });
    expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    expect(registry.sessionBindingsState(2).bindings).toEqual([{ sessionId: PANE_SESSION, browserTabIds: [], terminalTabIds: ["terminal:0000000b-1"] }]);
    expect(changes.some((state) => state.bindings.length === 0)).toBe(true);
    await registry.flushBindingWrites();
    const restarted = registryFor(settingsFromDisk(), 3);
    expect(restarted.registry.isPaneConversation(PANE_SESSION)).toBe(false);
    await restarted.registry.flushBindingWrites();
  });

  it("recognizes a saved pane before its guest or terminal has remounted", async () => {
    const saved = layout();
    saved.sideTabs.main![1]!.binding = { paneSessionId: PANE_SESSION };
    await saveLayout(settings, saved);
    const { registry } = registryFor();
    expect(registry.windowsHoldingTab(TERMINAL_TAB)).toEqual([1]);
    expect(registry.isPaneConversation(PANE_SESSION)).toBe(true);
    await registry.flushBindingWrites();
  });

  it("migrates the legacy pane hint once and preserves an explicit clear across restart", async () => {
    await memory.saveSessionMetadata(PANE_SESSION, { sessionKind: "main", paneTabId: TERMINAL_TAB });
    const { registry } = registryFor();
    expect(registry.paneConversation(1, TERMINAL_TAB)).toBe(PANE_SESSION);
    registry.releasePaneConversation(1, TERMINAL_TAB);
    await registry.flushBindingWrites();
    expect(memory.findPaneSession(TERMINAL_TAB)).toBe(PANE_SESSION);
    const restarted = registryFor(settingsFromDisk(), 3);
    expect(restarted.registry.isConversationSurfaceKnown(3, TERMINAL_TAB)).toBe(true);
    expect(restarted.registry.paneConversation(3, TERMINAL_TAB)).toBeUndefined();
    expect(restarted.registry.sessionBindingsState(3).bindings).toEqual([]);
    await restarted.registry.flushBindingWrites();
  });

  it("keeps creator identity stable when a browser slot is rebound after layout pruning", async () => {
    const { registry, requests } = registryFor();
    await openOwnedTab(registry, requests);
    registry.prepareLayoutBindings(1, { ...layout(), sideTabs: {} });
    registry.guestDestroyed(41);
    registry.guestAttached(guest(42), 1);
    registry.bindTab(1, { tabId: BROWSER_TAB, webContentsId: 42 });
    expect(registry.liveTab("tab-1")?.owner).toEqual({ sessionId: MAIN_SESSION });
    expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    registry.prepareLayoutBindings(1, layout());
    expect(registry.sessionBindingsState(1).bindings).toEqual([{ sessionId: MAIN_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] }]);
    await registry.flushBindingWrites();
  });

  it("prunes closed tabs from discovery while an ending pane turn keeps its original default", async () => {
    const { registry } = registryFor();
    registry.bindConversationSurface(PANE_SESSION, { windowId: 1, surface: { kind: "terminal", tabId: TERMINAL_TAB } });
    registry.setActiveSurface(1, { kind: "terminal", tabId: "terminal:0000000a-99" });
    const pruned = registry.prepareLayoutBindings(1, { ...layout(), sideTabs: {} });
    await saveLayout(settings, pruned);
    expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    expect(registry.defaultTerminalTabId(1, PANE_SESSION)).toBe(TERMINAL_TAB);
    expect(registry.isPaneConversation(PANE_SESSION)).toBe(true);
    registry.releasePaneConversation(1, TERMINAL_TAB, true);
    expect(registry.isPaneConversation(PANE_SESSION)).toBe(false);
    await registry.flushBindingWrites();
    const restarted = registryFor(settingsFromDisk(), 3);
    expect(restarted.registry.sessionBindingsState(3).bindings).toEqual([]);
    await restarted.registry.flushBindingWrites();
  });

  it("does not let a delayed guest bind resurrect a finalized pane association", async () => {
    const { registry, requests } = registryFor();
    await openOwnedTab(registry, requests);
    registry.bindConversationSurface(PANE_SESSION, { windowId: 1, surface: { kind: "browser", tabId: BROWSER_TAB } });
    registry.releasePaneConversation(1, BROWSER_TAB, true);
    registry.guestDestroyed(41);
    registry.guestAttached(guest(42), 1);
    expect(registry.bindTab(1, { tabId: BROWSER_TAB, webContentsId: 42 })).toEqual({ ok: false, error: "guest-not-hosted" });
    expect(registry.bindConversationSurface(PANE_SESSION, { windowId: 1, surface: { kind: "browser", tabId: BROWSER_TAB } })).toEqual({ ok: false, error: "pane-chat-ended" });
    expect(registry.sessionBindingsState(1).bindings).toEqual([]);
    expect(registry.paneConversation(1, BROWSER_TAB)).toBeUndefined();
    await registry.flushBindingWrites();
  });

  it("projects a direct child's tab under its parent without replacing the actual owner", async () => {
    const child = "dddddddd-1111-2222-3333-444444444444";
    await memory.saveSession(child, [{ role: "user", content: "Child task" }]);
    const actor = { sessionId: child, directParentSessionId: MAIN_SESSION };
    const { registry, requests } = registryFor();
    await openOwnedTab(registry, requests, actor);
    expect(registry.sessionBindingsState(1).bindings).toEqual([
      { sessionId: child, browserTabIds: [BROWSER_TAB], terminalTabIds: [] },
      { sessionId: MAIN_SESSION, browserTabIds: [BROWSER_TAB], terminalTabIds: [] },
    ]);
    expect(registry.liveTab("tab-1")?.owner).toEqual(actor);
    await registry.flushBindingWrites();
    await memory.deleteSession(MAIN_SESSION);
    const restarted = registryFor(settingsFromDisk(), 3);
    expect(restarted.registry.sessionBindingsState(3).bindings).toEqual([{ sessionId: child, browserTabIds: [BROWSER_TAB], terminalTabIds: [] }]);
    expect(info.mock.calls.some(([message, , id]) => String(message).includes("session-missing") && id === MAIN_SESSION)).toBe(true);
    await restarted.registry.flushBindingWrites();
  });
});
