// Verify restored navigation persists across launches without overwriting invalid or pending locations.
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { atHome, renderApp } from "./render-app.js";
import {
  activeSettingsTab,
  clickSidebarNavRow,
  closeSidebarGroup,
  deferred,
  openSidebarGroup,
  settingsWithActiveView,
  sidebarNavRowActive,
  type SidebarNavGroup,
} from "./helpers.js";
import { sidebarViewTestId } from "../../src/ui/renderer/components/Sidebar.js";

afterEach(() => vi.restoreAllMocks());

const PLUGIN_ID = "example-plugin";
const VIEW_ID = "MainView";
const PLUGIN_VIEW_KEY = `plugin:${PLUGIN_ID}:${VIEW_ID}`;
const PLUGIN_NAV_TESTID = sidebarViewTestId(PLUGIN_VIEW_KEY);

function sidebarView(pluginId: string, viewId: string) {
  return {
    pluginId,
    extension: {
      id: viewId,
      slot: "sidebar",
      kind: "embedded-module",
      title: "Example",
      entry: "ui/index.js",
      exportName: "mount",
    },
    entryUrl: "file:///c:/plugins/example/dist/ui/index.js",
  };
}


// Navigation rows exist only in flyouts; static DOM reports the group trigger.
function groupOf(testId: string): SidebarNavGroup {
  return testId === PLUGIN_NAV_TESTID ? "plugins" : "features";
}

async function isActive(_container: HTMLElement, testId: string): Promise<boolean> {
  return sidebarNavRowActive(groupOf(testId), testId);
}

async function waitForActive(container: HTMLElement, testId: string): Promise<void> {
  await waitFor(() =>
    expect(
      container.querySelector(`[data-testid="sidebar-group-${groupOf(testId)}"]`)?.getAttribute("data-active"),
    ).toBe("true"));
  expect(await isActive(container, testId)).toBe(true);
}


// Await settings, plugin views and committed effects before concluding restoration did not happen.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

describe("restoring activeView on launch", () => {
  it("opens on the built-in view the user left, not home", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("work-board"),
    });

    await waitForActive(container, "toolbar-work-board");
    expect(atHome(container)).toBe(false);
  });

  it("round-trips: the location this run persists is where the next run opens", async () => {
    const first = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(atHome(first.container)).toBe(true));

    await act(async () => {
      first.emitViewActivate("work-board");
    });
    await waitForActive(first.container, "toolbar-work-board");
    await waitFor(() =>
      expect(first.api.updateSettings).toHaveBeenCalledWith({
        system: { activeView: "work-board" },
      }),
    );
    const persisted = await first.api.getSettings();
    first.unmount();

    const second = await renderApp({ hasApiKey: true, settings: persisted });
    await waitForActive(second.container, "toolbar-work-board");
  });

  it("opens on a restored plugin view once its plugin is loaded", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      pluginUiExtensions: [sidebarView(PLUGIN_ID, VIEW_ID)],
    });

    await waitForActive(container, PLUGIN_NAV_TESTID);
    expect(atHome(container)).toBe(false);
  });

  it("falls back to home when the stored plugin view is no longer installed", async () => {
    const { container, api } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      // A well-formed stored plugin key still needs a loaded view before restoration.
      pluginUiExtensions: [],
    });

    await settle();
    expect(atHome(container)).toBe(true);
    expect(container.querySelector('[data-testid="sidebar-group-plugins"]')).toBeNull();

    // Missing plugin views must leave the stored location intact for a later successful load.
    expect(api.updateSettings).not.toHaveBeenCalledWith({ system: { activeView: "home" } });
  });

  it("falls back to home for a key a previous build could produce but this one cannot", async () => {
    // Validate stored keys against the current view table; string shape alone admits retired locations.
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("reminders"),
    });

    await settle();
    expect(atHome(container)).toBe(true);
  });

  it("falls back to home for a key that is not a view key at all", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("plugin:"),
    });

    await settle();
    expect(atHome(container)).toBe(true);
  });

  it("restores the settings page the user left, not the default one", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("settings", "permissions"),
    });

    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
  });
});

// Hold settings and plugin-view loads separately to test both user-navigation races.
describe("a launch whose stored location has not arrived yet", () => {
  function heldLaunch(stored: ReturnType<typeof settingsWithActiveView>) {
    const gate = deferred<void>();
    return {
      release: () => gate.resolve(),
      opts: {
        hasApiKey: true,
        settings: stored,
        getSettings: async () => {
          await gate.promise;
          return stored;
        },
      },
    };
  }

  async function clickNav(container: HTMLElement, testId: string) {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    expect(el, `missing [data-testid="${testId}"]`).not.toBeNull();
    await act(async () => {
      el!.click();
    });
  }

  it("still lands on the stored view when nobody touches the app", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const { container } = await renderApp(opts);
    await waitFor(() => expect(atHome(container)).toBe(true));

    await act(async () => {
      release();
    });

    await waitForActive(container, "toolbar-work-board");
  });

  it("keeps the view the user picked while the read was still in flight", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const { container } = await renderApp(opts);
    await waitFor(() => expect(atHome(container)).toBe(true));

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitForActive(container, "sidebar-routines");

    // A late restore must not replace a newer user navigation.
    await act(async () => {
      release();
    });
    await settle();

    expect(await isActive(container, "sidebar-routines")).toBe(true);
    expect(await isActive(container, "toolbar-work-board")).toBe(false);
  });

  it("holds a restored PLUGIN view back for good once the user has picked a view", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView(PLUGIN_VIEW_KEY));
    const { container } = await renderApp({
      ...opts,
      // Delayed plugin views must also respect user navigation after the settings read.
      pluginUiExtensions: [sidebarView(PLUGIN_ID, VIEW_ID)],
    });
    await waitFor(() => expect(atHome(container)).toBe(true));

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitForActive(container, "sidebar-routines");

    await act(async () => {
      release();
    });
    await settle();

    expect(await isActive(container, "sidebar-routines")).toBe(true);
    expect(await isActive(container, PLUGIN_NAV_TESTID)).toBe(false);
  });

  it("drops a restore ALREADY waiting on its plugin when the list finally loads", async () => {
    // Once a stored key is held, user navigation must discard that pending key independently of the read.
    const lateViews: unknown[] = [];
    const { container, emitPluginRuntimeUpdated } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      pluginUiExtensions: lateViews,
    });
    await settle();
    expect(atHome(container)).toBe(true);

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitForActive(container, "sidebar-routines");

    lateViews.push(sidebarView(PLUGIN_ID, VIEW_ID));
    await act(async () => {
      emitPluginRuntimeUpdated({ pluginId: PLUGIN_ID });
    });
    await settle();

    expect((await openSidebarGroup("plugins")).querySelector(`[data-testid="${PLUGIN_NAV_TESTID}"]`)).not.toBeNull();
    await closeSidebarGroup("plugins");
    expect(await isActive(container, "sidebar-routines")).toBe(true);
    expect(await isActive(container, PLUGIN_NAV_TESTID)).toBe(false);
  });

  it("records a pick that changes nothing on screen, since it still supersedes the stored one", async () => {
    // Starting a new chat supersedes stored location even when the active view key does not change.
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const { container, api } = await renderApp(opts);
    await waitFor(() => expect(atHome(container)).toBe(true));

    await clickNav(container, "sidebar-new-chat");
    await act(async () => {
      release();
    });
    await settle();

    // Assert both discard and persistence; either can pass while the other is broken.
    expect(atHome(container)).toBe(true);
    expect(await isActive(container, "toolbar-work-board")).toBe(false);
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ system: { activeView: "home" } }),
    );
    expect(api.updateSettings).not.toHaveBeenCalledWith({
      system: { activeView: "work-board" },
    });
  });

  it("makes that pick the location the NEXT launch restores, not the superseded one", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const first = await renderApp(opts);
    await waitFor(() => expect(atHome(first.container)).toBe(true));

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitForActive(first.container, "sidebar-routines");
    await act(async () => {
      release();
    });
    await settle();

    // Persist the user choice so the overridden restore cannot return on the next launch.
    await waitFor(() =>
      expect(first.api.updateSettings).toHaveBeenCalledWith({
        system: { activeView: "routines" },
      }),
    );
    expect(first.api.updateSettings).not.toHaveBeenCalledWith({
      system: { activeView: "work-board" },
    });
    first.unmount();

    const second = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("routines"),
    });
    await waitForActive(second.container, "sidebar-routines");
  });
});
