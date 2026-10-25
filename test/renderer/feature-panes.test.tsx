// Routed views share pane framing, title and controls without duplicate headings or padding.
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { atHome, renderApp } from "./render-app.js";
import {
  activeSettingsTab,
  clickSettingsTab,
  clickSidebarNavRow,
  settingsWithActiveView,
  splitIntoTwoTiles,
} from "./helpers.js";
import { t } from "../../src/i18n/runtime.js";
import { BUILTIN_LABEL_KEYS, type PaneViewKey } from "../../src/ui/renderer/utils/view-location.js";

afterEach(() => vi.restoreAllMocks());

// Identify routed panes by data-view; hidden conversation panes remain mounted too.
function pane(container: HTMLElement): HTMLElement | null {
  return container.querySelector(
    '[data-testid="main-pane-shell"][data-view] [data-testid="pane"]',
  );
}

function paneTitle(container: HTMLElement): string | null {
  return pane(container)
    ?.querySelector('[data-testid="pane-header"] h2')
    ?.textContent
    ?.trim() ?? null;
}

async function openView(view: PaneViewKey, bodyTestId: string) {
  const rendered = await renderApp({
    hasApiKey: true,
    settings: settingsWithActiveView(view),
  });
  await waitFor(() => {
    expect(pane(rendered.container)).not.toBeNull();
    expect(rendered.container.querySelector(`[data-testid="${bodyTestId}"]`)).not.toBeNull();
  });
  return rendered;
}

const VIEWS: ReadonlyArray<readonly [PaneViewKey, string]> = [
  ["work-board", "work-board-panel"],
  ["routines", "routine-panel"],
  ["insights", "insights-scroll-root"],
  ["memory", "memory-search-panel"],
];

describe("built-in views are pane bodies", () => {
  it.each(VIEWS)("draws %s inside a pane whose header carries its own label", async (view, bodyTestId) => {
    const { container } = await openView(view, bodyTestId);

    // Read titles from the shared navigation map to prevent pane/sidebar naming drift.
    expect(paneTitle(container)).toBe(t(BUILTIN_LABEL_KEYS[view]));
    // Check for an icon without duplicating the shared glyph mapping.
    expect(
      pane(container)?.querySelector('[data-testid="pane-header"] svg'),
    ).not.toBeNull();
  });

  it.each(VIEWS)("leaves no heading of its own inside the %s body", async (view, bodyTestId) => {
    const { container } = await openView(view, bodyTestId);

    // Only the frame supplies the pane heading.
    expect(pane(container)?.querySelectorAll("h2").length).toBe(1);
    expect(
      container.querySelector(`[data-testid="${bodyTestId}"]`)?.querySelector("h2"),
    ).toBeNull();
  });

  it.each(VIEWS)("insets the %s body once, from the frame", async (view, bodyTestId) => {
    const { container } = await openView(view, bodyTestId);

    // The frame owns page padding; bodies must not add another inset.
    const inset = pane(container)?.querySelectorAll('[data-body-inset="page"]') ?? [];
    expect(inset.length).toBe(1);
    expect(inset[0]?.className).toContain("p-4");
    expect(container.querySelector('[data-testid="main-pane-shell"][data-view]')?.className)
      .not.toContain("p-4");
  });
});

describe("a view's global actions live in the pane header", () => {
  it("carries the work board's new-item and refresh controls", async () => {
    const { container } = await openView("work-board", "work-board-panel");
    const header = pane(container)?.querySelector('[data-testid="pane-header"]');

    const add = header?.querySelector('[data-testid="pane-action-work-board-add"]');
    expect(add).not.toBeNull();
    expect(add?.getAttribute("aria-label")).toBe(t("workBoard.addItemButton"));
    expect(header?.querySelector('[data-testid="pane-action-work-board-refresh"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(add as HTMLElement);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="work-board-create-dialog"]')).not.toBeNull();
    });
  });

  it("carries the routines' new-routine and refresh controls", async () => {
    const { container } = await openView("routines", "routine-panel");
    const header = pane(container)?.querySelector('[data-testid="pane-header"]');

    expect(header?.querySelector('[data-testid="pane-action-routine-add"]')).not.toBeNull();
    expect(header?.querySelector('[data-testid="pane-action-routine-refresh"]')).not.toBeNull();
  });

  it("carries the insights' refresh control", async () => {
    const { container } = await openView("insights", "insights-scroll-root");
    const header = pane(container)?.querySelector('[data-testid="pane-header"]');

    expect(header?.querySelector('[data-testid="pane-action-insights-refresh"]')).not.toBeNull();
  });

  it("gives memory no action it does not have", async () => {
    const { container } = await openView("memory", "memory-search-panel");
    const header = pane(container)?.querySelector('[data-testid="pane-header"]');

    expect(header?.querySelector('[data-testid^="pane-action-"]')).toBeNull();
    expect(container.querySelector('[data-testid="memory-search-panel"] input')).not.toBeNull();
  });
});

describe("a plugin view is a pane body", () => {
  const PLUGIN_ID = "token-plugin";
  const PLUGIN_VIEW_KEY = `plugin:${PLUGIN_ID}:main`;
  const PLUGIN_LABEL = "Token Plugin";
  const PLUGIN_DESCRIPTION = "What this extension is for";

  const pluginFixture = {
    pluginCards: [{
      id: PLUGIN_ID,
      name: PLUGIN_LABEL,
      description: PLUGIN_DESCRIPTION,
      sampleTools: [],
      capabilities: [],
      tools: [],
      loadStatus: "loaded" as const,
    }],
    pluginUiExtensions: [{
      pluginId: PLUGIN_ID,
      extension: {
        id: "main",
        slot: "sidebar",
        kind: "embedded-module",
        title: PLUGIN_LABEL,
        description: PLUGIN_DESCRIPTION,
        entry: "dist/ui.js",
      },
      entryUrl: "file:///token-plugin/dist/ui.js",
    }],
  };

  async function openPluginView() {
    const rendered = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      ...pluginFixture,
    });
    await waitFor(() => {
      expect(pane(rendered.container)).not.toBeNull();
      expect(rendered.container.querySelector('[data-testid="plugin-page-shell"]')).not.toBeNull();
    });
    return rendered;
  }

  it("frames the plugin under its manifest label, with its description on the title", async () => {
    const { container } = await openPluginView();

    expect(paneTitle(container)).toBe(PLUGIN_LABEL);
    // Keep descriptions in tooltips without adding a second row of pane chrome.
    expect(
      pane(container)?.querySelector('[data-testid="pane-header"] h2')?.getAttribute("title"),
    ).toBe(PLUGIN_DESCRIPTION);
    // Verify an icon exists without restating the shared manifest resolver.
    expect(
      pane(container)?.querySelector('[data-testid="pane-header"] svg'),
    ).not.toBeNull();
  });

  it("draws one box — the frame's — around the plugin surface", async () => {
    const { container } = await openPluginView();

    // Plugin bodies sit inside one host frame without a nested page shell.
    const shell = container.querySelector('[data-testid="plugin-page-shell"]');
    expect(pane(container)?.contains(shell as Node)).toBe(true);
    expect(shell?.querySelector("h2")).toBeNull();
    expect(pane(container)?.querySelectorAll("h2").length).toBe(1);
  });

  it("unmounts the plugin surface when the pane goes back to the conversation", async () => {
    // Hide conversations to preserve streams and drafts; plugin guests unmount with their panes.
    const { container } = await openPluginView();
    expect(atHome(container)).toBe(false);

    await act(async () => {
      fireEvent.click(pane(container)?.querySelector('[data-testid="pane-close"]') as HTMLElement);
    });

    await waitFor(() => {
      expect(atHome(container)).toBe(true);
      expect(container.querySelector('[data-testid="plugin-page-shell"]')).toBeNull();
    });
    expect(pane(container)).toBeNull();
  });
});

describe("closing a view's pane", () => {
  it("hands the pane back to the conversation instead of closing it", async () => {
    const { container } = await openView("routines", "routine-panel");
    expect(atHome(container)).toBe(false);

    const close = pane(container)?.querySelector('[data-testid="pane-close"]');
    expect(close).not.toBeNull();
    // Closing a view preserves its pane; accessible labels must describe that action.
    expect(close?.getAttribute("aria-label"))
      .toBe(t("pane.closeView", { view: t(BUILTIN_LABEL_KEYS.routines) }));
    expect(close?.getAttribute("aria-label")).not.toBe(t("pane.close"));

    await act(async () => {
      fireEvent.click(close as HTMLElement);
    });

    await waitFor(() => {
      expect(atHome(container)).toBe(true);
      expect(pane(container)).toBeNull();
    });
    expect(container.querySelector('[data-testid="view-path-current-home"]')).not.toBeNull();
  });
});

// Settings owns its two layout regions; the outer pane must not duplicate their padding or headings.
const SETTINGS_SHELL = "[data-settings-layout]";

async function openSettingsPane(settingsTab?: string) {
  const rendered = await renderApp({
    hasApiKey: true,
    settings: settingsWithActiveView("settings", settingsTab),
  });
  await waitFor(() => {
    expect(pane(rendered.container)).not.toBeNull();
    expect(rendered.container.querySelector(SETTINGS_SHELL)).not.toBeNull();
  });
  return rendered;
}

describe("settings is a pane body", () => {
  it("draws it inside a pane whose header carries its label and glyph", async () => {
    const { container } = await openSettingsPane();

    expect(container.querySelector('[data-testid="main-pane-shell"][data-view="settings"]')).not.toBeNull();
    expect(paneTitle(container)).toBe(t(BUILTIN_LABEL_KEYS.settings));
    expect(
      pane(container)?.querySelector('[data-testid="pane-header"] svg'),
    ).not.toBeNull();
  });

  it("names the place once — the panel keeps no title of its own", async () => {
    const { container } = await openSettingsPane();
    const label = t(BUILTIN_LABEL_KEYS.settings);

    // The pane heading appears once, supplied by the frame.
    const named = [...(pane(container)?.querySelectorAll("h2") ?? [])]
      .filter((h) => h.textContent?.trim() === label);
    expect(named.length).toBe(1);
    expect(named[0]?.closest('[data-testid="pane-header"]')).not.toBeNull();
    // Keep the active tab heading as the next navigation depth.
    expect(container.querySelector(`${SETTINGS_SHELL} h2`)).not.toBeNull();
  });

  it("insets the body by nothing, so its two regions reach the frame", async () => {
    const { container } = await openSettingsPane();

    const body = pane(container)?.querySelector('[data-body-inset]');
    expect(body?.getAttribute("data-body-inset")).toBe("none");
    expect(pane(container)?.querySelector('[data-body-inset="page"]')).toBeNull();
    // Let settings regions own padding without intervening page wrappers.
    const shell = container.querySelector<HTMLElement>(SETTINGS_SHELL);
    const between: HTMLElement[] = [];
    for (let el = shell?.parentElement ?? null; el && el !== body; el = el.parentElement) between.push(el);
    expect(between.length).toBe(1);
    expect(between.every((el) => !/(?:^|\s)-?p[xytblre]?-/.test(el.className))).toBe(true);
  });

  it("keeps the tab the user picks, and reports it outward", async () => {
    const { container, api } = await openSettingsPane();
    expect(activeSettingsTab(container)).toBe("llm");

    await act(async () => {
      clickSettingsTab(container, "permissions");
    });

    await waitFor(() => {
      expect(activeSettingsTab(container)).toBe("permissions");
      expect(api.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ system: expect.objectContaining({ settingsTab: "permissions" }) }),
      );
      expect(container.querySelector('[data-testid="view-path-current-settings:permissions"]')).not.toBeNull();
    });
  });

  it("draws the view in the pane that holds it and leaves its neighbour alone", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    const [left, right] = await splitIntoTwoTiles(container);
    const cell = (chatGroupId: string) =>
      container.querySelector<HTMLElement>(`[data-testid="pane-cell:${chatGroupId}"]`)!;

    await clickSidebarNavRow("features", "toolbar-work-board");

    await waitFor(() => {
      expect(cell(right!.chatGroupId)
        .querySelector('[data-testid="main-pane-shell"][data-view="work-board"]')).not.toBeNull();
    });
    // Routing changes only the focused tile; neighboring conversations remain visible.
    expect(cell(left!.chatGroupId)
      .querySelector('[data-testid="main-pane-shell"][data-view]')).toBeNull();
    expect(cell(left!.chatGroupId).querySelector('[data-testid="pane"]')).not.toBeNull();

    // Keep the covered conversation mounted so its turn, draft and scroll position survive.
    expect(cell(right!.chatGroupId).querySelectorAll('[data-testid="pane"]')).toHaveLength(2);
  });

  it("hands the pane back to the conversation when closed", async () => {
    const { container } = await openSettingsPane();
    expect(atHome(container)).toBe(false);

    await act(async () => {
      fireEvent.click(pane(container)?.querySelector('[data-testid="pane-close"]') as HTMLElement);
    });

    await waitFor(() => {
      expect(atHome(container)).toBe(true);
      expect(container.querySelector(SETTINGS_SHELL)).toBeNull();
    });
  });
});
