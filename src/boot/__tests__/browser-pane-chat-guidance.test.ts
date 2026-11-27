import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConversationLoopMemoryManager } from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeBasicConversationLoopDeps } from "../../engine/__tests__/support/conversation-loop-fixtures.js";
import type { ToolScope } from "../../engine/turn/types.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { createBrowserTools } from "../../tools/browser-tools.js";
import { createSideChatConversationLoop } from "../conversation.js";

const WINDOW_ID = 1;
const PANE = { kind: "browser", tabId: "browser:pane" } as const;
const OTHER = { kind: "browser", tabId: "browser:other" } as const;
const BOUND_URL = "https://bound.example/page";
const OTHER_URL = "https://other.example/page";
const SCOPE: ToolScope = {
  activePluginIds: new Set(), activeToolNames: new Set(), forcedToolNames: new Set(),
  includeBuiltins: true, includeEgress: true, includeMcp: true, deferral: false,
};

const previousLocale = getLocale();
beforeEach(() => setLocale("en"));
afterEach(() => {
  browserTabRegistry.__reset();
  setLocale(previousLocale);
});

function createLoop(windowId?: number) {
  const deps = makeBasicConversationLoopDeps({
    pluginRuntime: { listPluginCards: () => [] },
    memoryManager: makeConversationLoopMemoryManager(),
  });
  for (const tool of createBrowserTools({
    tabs: browserTabRegistry,
    windowIdForHostedSession: () => WINDOW_ID,
    liveOriginSessionId: () => undefined,
    opensAgentTabs: () => false,
    pickUploadFiles: async () => null,
    loadActions: async () => { throw new Error("prompt build does not load page actions"); },
  })) deps.toolRegistry.register(tool);
  return createSideChatConversationLoop({
    ...deps,
    sideChatMemoryManager: deps.memoryManager,
    ...(windowId !== undefined ? { paneWindowId: windowId } : {}),
  } as unknown as Parameters<typeof createSideChatConversationLoop>[0]);
}

function bindPage(id: number, tabId: string, url: string) {
  browserTabRegistry.guestAttached({ id, isDestroyed: () => false, getURL: () => url, getTitle: () => "Page" } as never, WINDOW_ID);
  expect(browserTabRegistry.bindTab(WINDOW_ID, { tabId, webContentsId: id })).toMatchObject({ ok: true });
}

describe("browser pane turn guidance", () => {
  it("withholds the bound tab while another conversation holds its lease", () => {
    const loop = createLoop(WINDOW_ID);
    bindPage(1, PANE.tabId, BOUND_URL);
    browserTabRegistry.bindConversationSurface(loop.getSessionId(), { windowId: WINDOW_ID, surface: PANE });
    const tab = browserTabRegistry.liveRendererTab(WINDOW_ID, PANE.tabId)!;
    const lease = browserTabRegistry.acquireControl(tab, { sessionId: "other-session" });
    const blocked = loop.buildSystemPromptForScope(SCOPE);
    expect(blocked).toContain("This chat cannot access its bound browser tab.");
    expect(blocked).not.toContain(tab.handle);
    expect(blocked).not.toContain(BOUND_URL);
    browserTabRegistry.releaseControl(tab.handle, lease.id);
    expect(loop.buildSystemPromptForScope(SCOPE)).toContain(`This chat is bound to browser tab ${tab.handle}`);
  });

  it("asks the user to resume paused control before advertising browser actions again", () => {
    const loop = createLoop(WINDOW_ID);
    const sessionId = loop.getSessionId();
    bindPage(1, PANE.tabId, BOUND_URL);
    browserTabRegistry.bindConversationSurface(sessionId, { windowId: WINDOW_ID, surface: PANE });
    const tab = browserTabRegistry.liveRendererTab(WINDOW_ID, PANE.tabId)!;
    browserTabRegistry.acquireControl(tab, { sessionId });
    expect(browserTabRegistry.pause(WINDOW_ID, PANE.tabId)).toBe(true);
    const paused = loop.buildSystemPromptForScope(SCOPE);
    expect(paused).toContain("Browser control is paused. Ask the user to resume");
    expect(paused).not.toContain("Omit tabId to act in this tab.");
    expect(browserTabRegistry.resume(WINDOW_ID, PANE.tabId)).toBe(true);
    expect(loop.buildSystemPromptForScope(SCOPE)).toContain("Omit tabId to act in this tab.");
  });

  it("names the bound page in a pane turn even when another tab is active", () => {
    const loop = createLoop(WINDOW_ID);
    bindPage(1, PANE.tabId, `${BOUND_URL}?token=private#fragment`);
    bindPage(2, OTHER.tabId, OTHER_URL);
    browserTabRegistry.setActiveSurface(WINDOW_ID, OTHER);
    const sessionId = loop.getSessionId();
    expect(browserTabRegistry.bindConversationSurface(sessionId, { windowId: WINDOW_ID, surface: PANE })).toEqual({ ok: true });
    const bound = browserTabRegistry.defaultBrowserTab(WINDOW_ID, sessionId);
    expect(bound).toMatchObject({ ok: true });
    if (!bound.ok) throw new Error(bound.error);
    const prompt = loop.buildSystemPromptForScope(SCOPE);
    expect(prompt).toContain(`This chat is bound to browser tab ${bound.handle} (${BOUND_URL}).`);
    expect(prompt).toContain("Omit tabId to act in this tab.");
    expect(prompt).toContain("Actions in a user-owned page may ask for consent.");
    expect(prompt).toContain("This chat cannot open a separate tab.");
    expect(prompt).not.toContain(OTHER_URL);
    expect(prompt).not.toContain("token=private");
    expect(loop.buildSystemPromptForScope({ ...SCOPE, includeEgress: false })).not.toContain(BOUND_URL);
    expect(createLoop().buildSystemPromptForScope(SCOPE)).not.toContain(BOUND_URL);
  });

  it("refreshes the pane guidance from empty to live to unavailable across builds", () => {
    const loop = createLoop(WINDOW_ID);
    browserTabRegistry.bindConversationSurface(loop.getSessionId(), { windowId: WINDOW_ID, surface: PANE });
    const empty = loop.buildSystemPromptForScope(SCOPE);
    expect(empty).toContain("If the pane is empty, use browser_navigate and omit tabId to load a URL into it.");
    expect(empty).not.toContain(BOUND_URL);

    bindPage(1, PANE.tabId, BOUND_URL);
    expect(loop.buildSystemPromptForScope(SCOPE)).toContain(BOUND_URL);

    browserTabRegistry.guestDestroyed(1);
    const unavailable = loop.buildSystemPromptForScope(SCOPE);
    expect(unavailable).toContain("This chat's bound browser page is closed or unavailable.");
    expect(unavailable).not.toContain(BOUND_URL);
    expect(unavailable).not.toContain("If the pane is empty");
  });
});
