// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitEvent, onEvent } from "../../boot/types.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { translate } from "../../i18n/translate.js";

const { listeners, invoke, lifetime, deniedAudit } = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  invoke: vi.fn(),
  lifetime: { mounts: 0, unmounts: 0 },
  deniedAudit: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { (window as unknown as Record<string, unknown>)[name] = api; } },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
    invoke,
    send: vi.fn(),
  },
}));
vi.mock("../../ui/renderer/components/McpAppView.js", async () => {
  const { useEffect, createElement } = await import("react");
  const { useHostAppearance } = await import("../../ui/renderer/theme/HostAppearanceProvider.js");
  const { useTranslation } = await import("../../i18n/react.js");
  return { McpAppView: () => {
    const theme = useHostAppearance();
    // McpAppView puts this `locale` into the app's host context and renders its badge with this `t`.
    const { locale, t } = useTranslation();
    useEffect(() => { lifetime.mounts += 1; return () => { lifetime.unmounts += 1; }; }, []);
    return createElement("div", { "data-testid": "mounted-app", "data-terminal-font": theme.terminalFontFamily, "data-shell": theme.shell, "data-locale": locale }, t("mcpAppView.sandboxBadge"));
  } };
});

afterEach(async () => {
  await act(async () => listeners.get(CHANNELS.dock.unmount)?.({}, { panelId: "panel" }));
  listeners.clear();
  invoke.mockReset();
  deniedAudit.mockReset();
  lifetime.mounts = 0;
  lifetime.unmounts = 0;
  vi.useRealTimers();
});

describe("dock host auth observation", () => {
  it("reads status through trusted host dispatch, remounts after an identity change, and produces no app-call audit denial", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const broadcasts: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (value) => broadcasts.push(value));
    let status: unknown = { authenticated: false };
    invoke.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === CHANNELS.plugins.call) return status;
      if (channel === CHANNELS.host.pluginThemeNotify) { emitEvent("host.theme.changed", payload); return { ok: true }; }
      deniedAudit(channel);
      throw new Error("Unexpected app tool call");
    });
    document.body.innerHTML = '<div id="slots"></div><div id="activity"></div><div id="bar"><i></i></div><div id="conversation"></div><div id="summary"></div><div id="detail"></div><button id="close"></button><div id="empty" hidden></div>';
    vi.resetModules();
    await import("../../floating-dock-preload.js");
    await import("../../floating-dock-window.js");
    await act(async () => listeners.get(CHANNELS.dock.mount)?.({}, {
      panelId: "panel", title: "Auth panel", height: 200, authStatusTool: "fixture_status",
      payload: { serverId: "fixture", generationId: "generation", resourceUri: "ui://fixture/panel" },
    }));
    expect(lifetime.mounts).toBe(0);
    const theme = { bundleId: "nord", shell: "dark", tokens: { "--ave-bg": "#123456" } };
    await act(async () => listeners.get(CHANNELS.dock.theme)?.({}, { theme, terminalFontFamily: "Dock Mono, monospace", locale: "en" }));
    expect(invoke).toHaveBeenCalledWith(CHANNELS.plugins.call, "fixture_status", undefined, { userAction: false });
    expect(lifetime.mounts).toBe(1);
    expect(lifetime.unmounts).toBe(0);
    expect(document.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("dark");
    expect(invoke.mock.calls.some(([channel]) => channel === CHANNELS.host.pluginThemeNotify || channel === CHANNELS.settings.update || channel === CHANNELS.settings.get)).toBe(false);
    expect(broadcasts).toEqual([]);
    expect(document.querySelector("[data-terminal-font]")?.getAttribute("data-terminal-font")).toBe("Dock Mono, monospace");
    await act(async () => listeners.get(CHANNELS.dock.theme)?.({}, { theme, terminalFontFamily: "Updated Mono, monospace", locale: "en" }));
    expect(document.querySelector("[data-terminal-font]")?.getAttribute("data-terminal-font")).toBe("Updated Mono, monospace");
    expect(lifetime.mounts).toBe(1);
    status = { authenticated: true, account: "account-a" };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(lifetime.mounts).toBe(2);
    expect(lifetime.unmounts).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(lifetime.mounts).toBe(2);
    expect(deniedAudit).not.toHaveBeenCalled();
    // An unknown scheme id is a contract violation: it throws clearly and leaves every piece of dock state as it was.
    const root = document.documentElement;
    const snapshot = () => ({ style: root.getAttribute("style"), scheme: root.getAttribute("data-scheme"), shell: document.querySelector("[data-shell]")?.getAttribute("data-shell"), font: document.querySelector("[data-terminal-font]")?.getAttribute("data-terminal-font") });
    const before = snapshot();
    expect(before).toMatchObject({ scheme: "nord", shell: "dark", font: "Updated Mono, monospace" });
    expect(() => listeners.get(CHANNELS.dock.theme)?.({}, { theme: { bundleId: "not-a-scheme", shell: "light", tokens: { "--ave-bg": "#ffffff" } }, terminalFontFamily: "Other Mono", locale: "en" }))
      .toThrow("Unknown color scheme: not-a-scheme");
    // A later render (another slot mounting) must still paint the last good appearance, not the refused one.
    await act(async () => listeners.get(CHANNELS.dock.mount)?.({}, {
      panelId: "second", title: "Second", height: 120,
      payload: { serverId: "fixture", generationId: "generation", resourceUri: "ui://fixture/second" },
    }));
    expect(snapshot()).toEqual(before);
    const shells = [...document.querySelectorAll("#slot-second [data-shell]")].map((node) => node.getAttribute("data-shell"));
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.every((shell) => shell === "dark")).toBe(true);
    await act(async () => listeners.get(CHANNELS.dock.unmount)?.({}, { panelId: "second" }));
    // Language: the cards render in the snapshot's locale (what McpAppView puts in host context and its badge), not the runtime default.
    const app = () => document.querySelector("[data-testid=mounted-app]");
    expect(app()?.getAttribute("data-locale")).toBe("en");
    await act(async () => listeners.get(CHANNELS.dock.theme)?.({}, { theme, terminalFontFamily: "Updated Mono, monospace", locale: "ko" }));
    expect(app()?.getAttribute("data-locale")).toBe("ko");
    expect(app()?.textContent).toBe(translate("ko", "mcpAppView.sandboxBadge"));
    expect(app()?.textContent).not.toBe(translate("en", "mcpAppView.sandboxBadge"));
    expect(document.documentElement.lang).toBe("ko");
    await act(async () => listeners.get(CHANNELS.dock.theme)?.({}, { theme, terminalFontFamily: "Updated Mono, monospace", locale: "en" }));
    expect(app()?.getAttribute("data-locale")).toBe("en");
    expect(app()?.textContent).toBe(translate("en", "mcpAppView.sandboxBadge"));
    // A payload whose locale is not one at all is a contract violation: it throws and the cards keep the last good language.
    expect(() => listeners.get(CHANNELS.dock.theme)?.({}, { theme, terminalFontFamily: "Updated Mono, monospace", locale: 42 }))
      .toThrow("Unknown dock locale: 42");
    await act(async () => {});
    expect(app()?.getAttribute("data-locale")).toBe("en");
    await act(async () => listeners.get(CHANNELS.dock.unmount)?.({}, { panelId: "panel" }));
    const calls = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(invoke).toHaveBeenCalledTimes(calls);
    const bridge = (window as unknown as { aveDock: { readAuthStatus: (id: string) => Promise<unknown> } }).aveDock;
    expect(() => bridge.readAuthStatus("panel")).toThrow("no auth status source");
    expect(invoke.mock.calls.some(([channel]) => channel === CHANNELS.host.pluginThemeNotify || channel === CHANNELS.settings.update || channel === CHANNELS.settings.get)).toBe(false);
    expect(broadcasts).toEqual([]);
    unsubscribe();
  });
});

describe("dock slot chrome", () => {
  it("draws each slot's host title inside the .slot-head drag band and retitles it in place", async () => {
    document.body.innerHTML = '<div id="slots"></div><div id="activity"></div><div id="bar"><i></i></div><div id="conversation"></div><div id="summary"></div><div id="detail"></div><button id="close"></button><div id="empty" hidden></div>';
    vi.resetModules();
    await import("../../floating-dock-preload.js");
    await import("../../floating-dock-window.js");
    await act(async () => listeners.get(CHANNELS.dock.mount)?.({}, {
      panelId: "panel", title: "Recorder", height: 200,
      payload: { serverId: "fixture", generationId: "generation", resourceUri: "ui://fixture/panel" },
    }));
    const slot = document.getElementById("slot-panel");
    const head = slot?.firstElementChild;
    // The html stylesheet gives `.slot-head` the padding and the drag region; the title alone only truncates.
    expect(head?.className).toBe("slot-head");
    expect(head?.querySelector(":scope > .slot-title")?.textContent).toBe("Recorder");
    await act(async () => listeners.get(CHANNELS.dock.retitle)?.({}, { panelId: "panel", title: "Renamed" }));
    expect(head?.querySelector(".slot-title")?.textContent).toBe("Renamed");
    expect(slot?.querySelectorAll(".slot-head")).toHaveLength(1);
    // The requested height is the WHOLE slot (public-contract AttachFloatingPanelRequest.height; the dock's height is chrome + every slot):
    // the host head and the card body share it, and a resize changes the same box.
    expect(slot?.style.height).toBe("200px");
    expect(slot?.children).toHaveLength(2);
    await act(async () => listeners.get(CHANNELS.dock.resize)?.({}, { panelId: "panel", height: 240 }));
    expect(slot?.style.height).toBe("240px");
  });
});
