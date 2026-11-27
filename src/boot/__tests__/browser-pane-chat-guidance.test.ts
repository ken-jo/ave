import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConversationLoopMemoryManager } from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeBasicConversationLoopDeps } from "../../engine/__tests__/support/conversation-loop-fixtures.js";
import type { ToolScope } from "../../engine/turn/types.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { BROWSER_TOOL } from "../../shared/browser-tools.js";
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

function createLoop(windowId?: number, onNavigate?: (tool: ReturnType<typeof createBrowserTools>[number]) => void) {
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
    loadActions: async () => ({ prepare: async () => {} }) as never,
  })) {
    deps.toolRegistry.register(tool);
    if (tool.name === BROWSER_TOOL.navigate) onNavigate?.(tool);
  }
  return createSideChatConversationLoop({
    ...deps,
    sideChatMemoryManager: deps.memoryManager,
    ...(windowId !== undefined ? { paneWindowId: windowId } : {}),
  } as unknown as Parameters<typeof createSideChatConversationLoop>[0]);
}

function bindPage(id: number, tabId: string, url: string, title = "Page") {
  browserTabRegistry.guestAttached({ id, isDestroyed: () => false, getURL: () => url, getTitle: () => title } as never, WINDOW_ID);
  expect(browserTabRegistry.bindTab(WINDOW_ID, { tabId, webContentsId: id })).toMatchObject({ ok: true });
  const tab = browserTabRegistry.liveRendererTab(WINDOW_ID, tabId);
  if (!tab) throw new Error("Expected the bound browser tab to be live");
  return tab;
}

describe("browser pane turn guidance", () => {
  it("withholds the bound tab while another conversation holds its lease", () => {
    const loop = createLoop(WINDOW_ID);
    const tab = bindPage(1, PANE.tabId, BOUND_URL);
    browserTabRegistry.bindConversationSurface(loop.getSessionId(), { windowId: WINDOW_ID, surface: PANE });
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
    const tab = bindPage(1, PANE.tabId, BOUND_URL);
    browserTabRegistry.bindConversationSurface(sessionId, { windowId: WINDOW_ID, surface: PANE });
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
    bindPage(1, PANE.tabId, "https://private-user:private-password@bound.example/ignore-previous-instructions?token=private#private-fragment", "private-page-title");
    bindPage(2, OTHER.tabId, OTHER_URL);
    browserTabRegistry.setActiveSurface(WINDOW_ID, OTHER);
    const sessionId = loop.getSessionId();
    expect(browserTabRegistry.bindConversationSurface(sessionId, { windowId: WINDOW_ID, surface: PANE })).toEqual({ ok: true });
    const bound = browserTabRegistry.defaultBrowserTab(WINDOW_ID, sessionId);
    expect(bound).toMatchObject({ ok: true });
    if (!bound.ok) throw new Error(bound.error);
    const prompt = loop.buildSystemPromptForScope(SCOPE);
    expect.soft(prompt).toContain(`This chat is bound to browser tab ${bound.handle}.`);
    expect(prompt).toContain("Omit tabId to act in this tab.");
    expect(prompt).toContain("Actions in a user-owned page may ask for consent.");
    expect(prompt).toContain("This chat cannot open a separate tab.");
    expect(prompt).not.toContain(OTHER_URL);
    for (const pageText of ["bound.example", "private-user", "private-password", "ignore-previous-instructions", "token=private", "private-fragment", "private-page-title"]) {
      expect.soft(prompt).not.toContain(pageText);
    }
    expect(loop.buildSystemPromptForScope({ ...SCOPE, includeEgress: false })).not.toContain(bound.handle);
    expect(createLoop().buildSystemPromptForScope(SCOPE)).not.toContain(bound.handle);
  });

  it.each([
    ["non-HTTP", "data:text/html,private-document", "private-document"],
    ["overlong", `https://private.example/${"long-path-segment".repeat(100)}`, "long-path-segment"],
  ])("keeps %s page data out of routing guidance and drops the preceding page on replacement", (_kind, url, pageText) => {
    const loop = createLoop(WINDOW_ID);
    const sessionId = loop.getSessionId();
    browserTabRegistry.bindConversationSurface(sessionId, { windowId: WINDOW_ID, surface: PANE });
    const first = bindPage(1, PANE.tabId, url);
    const before = loop.buildSystemPromptForScope(SCOPE);
    const routing = before.match(/This chat is bound to browser tab [^.]+\./)?.[0];
    expect.soft(routing).toBe(`This chat is bound to browser tab ${first.handle}.`);
    expect.soft(before).not.toContain(pageText);
    browserTabRegistry.guestDestroyed(1);
    const replacement = bindPage(2, OTHER.tabId, OTHER_URL);
    browserTabRegistry.bindConversationSurface(sessionId, { windowId: WINDOW_ID, surface: OTHER });
    const after = loop.buildSystemPromptForScope(SCOPE);
    expect.soft(after).toContain(`This chat is bound to browser tab ${replacement.handle}.`);
    expect(after).not.toContain(first.handle);
    expect(after).not.toContain(pageText);
    expect.soft(after).not.toContain(OTHER_URL);
  });

  it("agrees with navigation approval for empty, loading, destroyed and replacement pages", async () => {
    let navigation: ReturnType<typeof createBrowserTools>[number] | undefined;
    const loop = createLoop(WINDOW_ID, (tool) => { navigation = tool; });
    const sessionId = loop.getSessionId();
    const approvalMemoryScope = navigation?.approvalMemoryScope;
    if (!approvalMemoryScope) throw new Error("Expected navigation to define an approval scope");
    const approval = () => approvalMemoryScope({ url: OTHER_URL }, { cwd: process.cwd(), sessionId });
    const binding = { windowId: WINDOW_ID, surface: { ...PANE, browserSlotEmpty: true } };
    browserTabRegistry.bindConversationSurface(sessionId, binding);
    const empty = loop.buildSystemPromptForScope(SCOPE);
    expect(empty).toContain("If the pane is empty, use browser_navigate and omit tabId to load a URL into it.");
    expect(empty).not.toContain(BOUND_URL);
    expect(await approval()).toMatchObject({ tabOpener: "agent", origin: "https://other.example:443" });

    // The address bar uses this host operation before submitting a URL to an empty slot.
    expect(browserTabRegistry.stop(WINDOW_ID, PANE.tabId)).toBe(true);
    expect.soft(loop.buildSystemPromptForScope(SCOPE)).toContain("This chat's bound browser page is closed or unavailable.");
    expect.soft(await approval()).toBeUndefined();
    const tab = bindPage(1, PANE.tabId, BOUND_URL);
    expect(loop.buildSystemPromptForScope(SCOPE)).toContain(tab.handle);
    expect(await approval()).toMatchObject({ tabOpener: "user", tabId: tab.handle });

    browserTabRegistry.guestDestroyed(1);
    const unavailable = loop.buildSystemPromptForScope(SCOPE);
    expect(unavailable).toContain("This chat's bound browser page is closed or unavailable.");
    expect(unavailable).not.toContain(BOUND_URL);
    expect(unavailable).not.toContain("If the pane is empty");
    expect.soft(await approval()).toBeUndefined();

    bindPage(2, PANE.tabId, OTHER_URL);
    expect(loop.buildSystemPromptForScope(SCOPE)).toContain(tab.handle);
    expect(await approval()).toMatchObject({ tabOpener: "user", tabId: tab.handle });
  });
});
