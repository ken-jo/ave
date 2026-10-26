import "./setup.js";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "./render-app.js";
import { MOCK_DEFAULT_SESSION_ID } from "./mock-ave-api.js";
import { t } from "../../src/i18n/runtime.js";
import type { BrowserWorkspaceApi, BrowserWorkspaceState } from "../../src/shared/browser-workspace.js";
import { TEST_IDS, testIdSelector } from "../../src/shared/test-ids.js";
import { resetMainLayoutRestoreForTest } from "../../src/ui/renderer/preview/main-layout-restore.js";

describe("chat columns", () => {
  it("opens the selected browser tab in the work panel and closes it through the existing tab store", async () => {
    const view = await renderApp({ hasApiKey: true, browserTabs: true });
    const browserTabs = view.api.browserTabs as unknown as {
      emitBrowserTabOp: (request: unknown) => void;
      getState: ReturnType<typeof vi.fn>;
    };
    await act(async () => {
      browserTabs.emitBrowserTabOp({ requestId: "page-one", op: "new", url: "https://one.example/", active: true });
      browserTabs.emitBrowserTabOp({ requestId: "page-two", op: "new", url: "https://two.example/", active: true });
    });
    const hosts = await waitFor(() => {
      const hosts = [...view.container.querySelectorAll<HTMLElement>('[data-testid="chat-side-panel-browser-tab-host"]')];
      expect(hosts).toHaveLength(2);
      return hosts;
    });
    const tabs = hosts.map((host, index) => ({ tabId: host.dataset.tabId!, documentGeneration: 1, url: `https://${index === 0 ? "one" : "two"}.example/`, title: `Page ${index + 1}`, zoomFactor: 1 }));
    let workspaceState: BrowserWorkspaceState = { revision: 1, bookmarks: [], history: [], sitePermissions: [], downloads: [], tabs, storageStatus: "ready", capabilities: { fullscreen: false } };
    const workspaceListeners = new Set<(state: BrowserWorkspaceState) => void>();
    browserTabs.getState.mockResolvedValue({ revision: 1, tabs: tabs.map((tab) => ({ ...tab, rendererTabId: tab.tabId,
      owner: { sessionId: MOCK_DEFAULT_SESSION_ID }, lease: null, generation: 1, kind: "embedded", openerTabId: null, mode: "human-paused" })) });
    Object.assign(view.api, { browserWorkspace: {
      getState: vi.fn(async () => ({ ok: true, value: workspaceState })),
      onChanged: vi.fn((handler: (state: BrowserWorkspaceState) => void) => { workspaceListeners.add(handler); return () => { workspaceListeners.delete(handler); }; }), preview: vi.fn(async () => ({ ok: false, error: "capture-unavailable" })),
    } as unknown as BrowserWorkspaceApi });
    fireEvent.click(view.container.querySelector(testIdSelector(TEST_IDS.paneThumbnailToggle))!);
    const column = view.container.querySelector<HTMLElement>('[data-testid="chat-thumbnail-column"]')!;
    const firstCard = await waitFor(() => {
      const card = column.querySelector<HTMLElement>(`[data-tab-id="${tabs[0]!.tabId}"]`);
      expect(card).not.toBeNull();
      return card!;
    });
    expect(firstCard.dataset.active).toBe("false");
    expect(column.querySelector(`[data-tab-id="${tabs[1]!.tabId}"]`)?.getAttribute("data-active")).toBe("true");
    const canvas = view.container.querySelector('[data-testid="pane-canvas"]')!;
    Object.defineProperties(canvas, { clientWidth: { configurable: true, value: 3000 }, clientHeight: { configurable: true, value: 1000 } });
    fireEvent.click(view.container.querySelector(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${tabs[0]!.tabId}"] [data-testid="chat-side-panel-move-to-main"]`)!);
    await waitFor(() => expect(view.container.querySelector(`[data-testid="surface-pane"][data-tab-id="${tabs[0]!.tabId}"]`)).not.toBeNull());
    expect(column.querySelector(`[data-tab-id="${tabs[0]!.tabId}"]`)).toBe(firstCard);
    fireEvent.click(view.container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!);
    fireEvent.click(within(firstCard).getByRole("button", { name: "Page 1" }));
    await waitFor(() => expect(view.container.querySelector(`[data-testid="surface-pane"][data-tab-id="${tabs[0]!.tabId}"]`)).toBeNull());
    expect(view.container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))?.getAttribute("aria-pressed")).toBe("true");
    expect(firstCard.dataset.active).toBe("true");
    expect(view.container.querySelector(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${tabs[0]!.tabId}"] [role="tab"]`)?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(firstCard).getByRole("button", { name: t("chatPreviewRail.closeTab") }));
    act(() => { workspaceState = { ...workspaceState, revision: 2, tabs: tabs.slice(1) }; for (const listener of workspaceListeners) listener(workspaceState); });
    await waitFor(() => expect(column.querySelector(`[data-tab-id="${tabs[0]!.tabId}"]`)).toBeNull());
    expect(view.container.querySelector(`[data-testid="chat-side-panel-browser-tab-host"][data-tab-id="${tabs[0]!.tabId}"]`)).toBeNull();
    expect(column.querySelector(`[data-tab-id="${tabs[1]!.tabId}"]`)?.getAttribute("data-active")).toBe("true");
  });

  it("toggles each column independently and restores both preferences after remount", async () => {
    const first = await renderApp({ hasApiKey: true });
    await act(async () => {});
    const thumbnailToggle = first.container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.paneThumbnailToggle))!;
    const panelToggle = first.container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.panePanelToggle))!;
    expect(thumbnailToggle.getAttribute("aria-pressed")).toBe("false");
    expect(panelToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(thumbnailToggle);
    await waitFor(() => expect(first.container.querySelector('[data-testid="chat-thumbnail-column"]')).not.toBeNull());
    expect(panelToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(panelToggle);
    await waitFor(() => expect(first.container.querySelector('[data-testid="chat-side-panel-motion"]')?.getAttribute("aria-hidden")).toBe("false"));
    expect(thumbnailToggle.getAttribute("aria-pressed")).toBe("true");
    expect(first.container.querySelector<HTMLElement>('[data-testid="chat-thumbnail-column"]')?.style.order).toBe("1");
    expect(first.container.querySelector<HTMLElement>('[data-testid="chat-side-panel-motion"]')?.style.order).toBe("2");
    fireEvent.click(thumbnailToggle);
    expect(first.container.querySelector('[data-testid="chat-thumbnail-column"]')).toBeNull();
    expect(panelToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(thumbnailToggle);
    fireEvent.click(panelToggle);
    // pagehide flushes pending saves without a real-time delay.
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    const layout = vi.mocked(first.api.updateSettings).mock.calls
      .map(([patch]) => (patch as { system?: { mainLayout?: { thumbnailOpenIds: string[]; panelOpenIds: string[] } } }).system?.mainLayout)
      .filter((each) => each !== undefined)
      .at(-1);
    expect(layout?.thumbnailOpenIds).toEqual(["main"]);
    expect(layout?.panelOpenIds).toEqual([]);
    const settings = await first.api.getSettings();
    expect(settings.system?.mainLayout).toEqual(layout);
    first.unmount();
    resetMainLayoutRestoreForTest();
    const second = await renderApp({ hasApiKey: true, settings });
    await waitFor(() => expect(second.container.querySelector(testIdSelector(TEST_IDS.paneThumbnailToggle))?.getAttribute("aria-pressed")).toBe("true"));
    expect(second.container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))?.getAttribute("aria-pressed")).toBe("false");
    expect(second.container.querySelector('[data-testid="chat-thumbnail-column"]')).not.toBeNull();
  });

  it("hides thumbnails when space is tight, keeps the panel available as an overlay, and restores preferences", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 1600, canvasWidth: 1600 });
    const thumbnailToggle = view.container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.paneThumbnailToggle))!;
    const panelToggle = view.container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.panePanelToggle))!;
    fireEvent.click(thumbnailToggle);
    fireEvent.click(panelToggle);
    await view.resizeContainers({ canvasWidth: 950 });
    expect(thumbnailToggle.getAttribute("aria-disabled")).toBe("true");
    expect(thumbnailToggle.getAttribute("aria-pressed")).toBe("false");
    expect(thumbnailToggle.title).toBe(t("chatThumbnails.hiddenForWidth"));
    expect(view.container.querySelector('[data-testid="chat-thumbnail-column"]')).toBeNull();
    fireEvent.click(thumbnailToggle);
    expect(thumbnailToggle.getAttribute("aria-pressed")).toBe("false");

    await view.resizeContainers({ canvasWidth: 600 });
    const motion = await waitFor(() => {
      const found = view.container.querySelector('[data-testid="chat-side-panel-motion"]');
      expect(found?.getAttribute("data-panel-mode")).toBe("overlay");
      expect(found?.getAttribute("aria-hidden")).toBe("false");
      return found!;
    });
    expect(motion.getAttribute("aria-hidden")).toBe("false");
    expect(panelToggle.getAttribute("aria-disabled")).not.toBe("true");
    expect(panelToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(panelToggle);
    expect(panelToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(panelToggle);
    expect(panelToggle.getAttribute("aria-pressed")).toBe("true");

    await view.resizeContainers({ canvasWidth: 1600 });
    await waitFor(() => expect(view.container.querySelector('[data-testid="chat-thumbnail-column"]')).not.toBeNull());
    expect(thumbnailToggle.getAttribute("aria-pressed")).toBe("true");
    expect(thumbnailToggle.getAttribute("aria-disabled")).not.toBe("true");
    expect(panelToggle.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector('[data-testid="chat-side-panel-motion"]')?.getAttribute("data-panel-mode")).toBe("docked");
  });
});
