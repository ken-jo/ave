// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../shared/appearance-settings.js";
import { SETTINGS } from "../../shared/ipc-channels.js";
import { CHANNELS } from "../../contract/app-contract.js";

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
  const { useTheme } = await import("../../ui/renderer/theme/ThemeProvider.js");
  return { McpAppView: () => {
    const theme = useTheme();
    useEffect(() => { lifetime.mounts += 1; return () => { lifetime.unmounts += 1; }; }, []);
    return createElement("div", { "data-testid": "mounted-app", "data-terminal-font": theme.appearance.terminalFont.family });
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
    let status: unknown = { authenticated: false };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === CHANNELS.plugins.call) return status;
      if (channel === CHANNELS.settings.get) return { appearance: { ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont, family: "Dock Mono, monospace" } } };
      if (channel === CHANNELS.host.pluginThemeNotify) return { ok: true };
      deniedAudit(channel);
      throw new Error("Unexpected app tool call");
    });
    document.body.innerHTML = '<div id="slots"></div><div id="activity"></div><div id="bar"><i></i></div><div id="conversation"></div><div id="summary"></div><div id="detail"></div><button id="close"></button>';
    vi.resetModules();
    await import("../../floating-dock-preload.js");
    await import("../../floating-dock-window.js");
    await act(async () => listeners.get(CHANNELS.dock.mount)?.({}, {
      panelId: "panel", title: "Auth panel", height: 200, authStatusTool: "fixture_status",
      payload: { serverId: "fixture", generationId: "generation", resourceUri: "ui://fixture/panel" },
    }));
    expect(invoke).toHaveBeenCalledWith(CHANNELS.plugins.call, "fixture_status", undefined, { userAction: false });
    expect(lifetime.mounts).toBe(1);
    expect(lifetime.unmounts).toBe(0);
    expect(document.querySelector("[data-terminal-font]")?.getAttribute("data-terminal-font")).toBe("Dock Mono, monospace");
    await act(async () => listeners.get(SETTINGS.updated)?.({}, { appearance: { ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont, family: "Updated Mono, monospace" } } }));
    expect(document.querySelector("[data-terminal-font]")?.getAttribute("data-terminal-font")).toBe("Updated Mono, monospace");
    expect(lifetime.mounts).toBe(1);
    status = { authenticated: true, account: "account-a" };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(lifetime.mounts).toBe(2);
    expect(lifetime.unmounts).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(lifetime.mounts).toBe(2);
    expect(deniedAudit).not.toHaveBeenCalled();
    await act(async () => listeners.get(CHANNELS.dock.unmount)?.({}, { panelId: "panel" }));
    const calls = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(invoke).toHaveBeenCalledTimes(calls);
    const bridge = (window as unknown as { aveDock: { readAuthStatus: (id: string) => Promise<unknown> } }).aveDock;
    expect(() => bridge.readAuthStatus("panel")).toThrow("no auth status source");
  });
});
