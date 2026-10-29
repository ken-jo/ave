import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { browserControlFixture } from "../../__tests__/support/browser-control-fixture.js";
import { buildBrowserTabsApiSurface } from "../browser-api-surface.js";
import { buildBrowserWorkspaceApiSurface } from "../browser-workspace-api-surface.js";
import { buildTerminalApiSurface } from "../terminal-api-surface.js";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(), listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
}));
vi.mock("electron", () => ({ ipcRenderer: {
  invoke,
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => listeners.set(channel, listener),
  removeListener: (channel: string) => listeners.delete(channel),
} }));
beforeEach(() => { invoke.mockReset(); listeners.clear(); });

describe("private browser and terminal preload boundaries", () => {
  it("queries and subscribes to the same validated session binding shape", async () => {
    const api = buildBrowserTabsApiSurface();
    const state = { revision: 3, bindings: [{ sessionId: "main-session", browserTabIds: ["browser:one"], terminalTabIds: [] }] };
    invoke.mockResolvedValueOnce(state).mockResolvedValueOnce({ ...state, revision: -1 });
    await expect(api.getSessionBindings()).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith(CHANNELS.browser.getSessionBindings);
    await expect(api.getSessionBindings()).rejects.toThrow("invalid-session-tab-bindings");
    const receive = vi.fn();
    const off = api.onSessionBindingsChanged(receive);
    const listener = listeners.get(CHANNELS.browser.sessionBindingsChanged)!;
    listener({ sender: "private" }, state);
    expect(receive).toHaveBeenCalledExactlyOnceWith(state);
    expect(() => listener(undefined, { ...state, bindings: [{ sessionId: "x", browserTabIds: ["a", "a"], terminalTabIds: [] }] })).toThrow();
    expect(() => listener(undefined, { ...state, bindings: [{ ...state.bindings[0], owner: {} }] })).toThrow();
    off();
    expect(listeners.has(CHANNELS.browser.sessionBindingsChanged)).toBe(false);
  });
  it("accepts revisioned browser state and rejects old mixed-version authority", async () => {
    const api = buildBrowserTabsApiSurface();
    const state = browserControlFixture(["browser:1"], "human-paused", 7);
    invoke.mockResolvedValueOnce(state).mockResolvedValueOnce({ agentControlledTabIds: ["browser:1"] });
    await expect(api.getState()).resolves.toEqual(state);
    await expect(api.getState()).rejects.toThrow("invalid-browser-control-state");
    const receive = vi.fn();
    const off = api.onControl(receive);
    listeners.get(CHANNELS.browser.control)!(undefined, state);
    expect(receive).toHaveBeenCalledWith(state);
    expect(() => listeners.get(CHANNELS.browser.control)!(undefined, { tabs: [] })).toThrow();
    expect(receive).toHaveBeenCalledOnce();
    off();
    expect(listeners.has(CHANNELS.browser.control)).toBe(false);
  });

  it("separates renderer tab controls from popup handles", async () => {
    const api = buildBrowserTabsApiSurface();
    invoke.mockResolvedValue({ ok: true });
    await api.pause("browser:1");
    await api.resumePopup("native-handle");
    expect(invoke.mock.calls).toEqual([
      [CHANNELS.browser.pause, { tabId: "browser:1" }],
      [CHANNELS.browser.resumePopup, { tabId: "native-handle" }],
    ]);
    const receive = vi.fn();
    api.onTabOp(receive);
    expect(() => listeners.get(CHANNELS.browser.tabOp)!(undefined, { op: "new", url: "https://a.example/" })).toThrow();
    expect(receive).not.toHaveBeenCalled();
  });

  it("preserves lane and incarnation on writes and rejects unaddressed stream bytes", async () => {
    const api = buildTerminalApiSurface();
    const ref = { tabId: "terminal:1", lane: "manual" as const, terminalSessionId: "incarnation-2" };
    await api.input(ref, "echo hello\r");
    expect(invoke).toHaveBeenCalledWith(CHANNELS.terminal.input, { ...ref, data: "echo hello\r" });
    await api.listFileReviews(ref);
    expect(invoke).toHaveBeenCalledWith(CHANNELS.terminal.fileReviews, ref);
    expect("reviewFiles" in api).toBe(false);
    const receive = vi.fn();
    const off = api.onData(receive);
    listeners.get(CHANNELS.terminal.data)!(undefined, { ...ref, chunk: "hello" });
    expect(receive).toHaveBeenCalledWith({ ...ref, chunk: "hello" });
    expect(() => listeners.get(CHANNELS.terminal.data)!(undefined, { ...ref, chunk: 1 })).toThrow("invalid-terminal-data-event");
    expect(() => listeners.get(CHANNELS.terminal.data)!(undefined, { ...ref, lane: "agent", chunk: "private" })).toThrow("invalid-terminal-data-event");
    expect(receive).toHaveBeenCalledOnce();
    off();
    expect(listeners.has(CHANNELS.terminal.data)).toBe(false);
  });

  it("rejects malformed terminal exits and workspace results instead of displaying success", async () => {
    const receive = vi.fn();
    buildTerminalApiSurface().onExit(receive);
    expect(() => listeners.get(CHANNELS.terminal.exit)!(undefined, {
      tabId: "terminal:1", lane: "manual", terminalSessionId: "a", exitCode: 0.5,
    })).toThrow("invalid-terminal-exit-event");
    expect(() => listeners.get(CHANNELS.terminal.exit)!(undefined, {
      tabId: "terminal:1", lane: "agent", terminalSessionId: "a", exitCode: 0,
    })).toThrow("invalid-terminal-exit-event");
    const api = buildBrowserWorkspaceApiSurface();
    invoke.mockResolvedValueOnce({ ok: false, error: "stale-document" })
      .mockResolvedValueOnce({ ok: true, value: { factor: 0 } })
      .mockResolvedValueOnce({ ok: false, error: "invented-error" });
    await expect(api.zoom({ tabId: "browser:1", documentGeneration: 1, factor: 1 })).resolves.toEqual({ ok: false, error: "stale-document" });
    await expect(api.zoom({ tabId: "browser:1", documentGeneration: 1, factor: 1 })).rejects.toThrow("invalid-browser-workspace-result");
    await expect(api.getState()).rejects.toThrow("invalid-browser-workspace-result");
    api.onChanged(receive);
    expect(() => listeners.get(CHANNELS.browserWorkspace.changed)!(undefined, {})).toThrow("invalid-browser-workspace-state");
    expect(receive).not.toHaveBeenCalled();
  });
});
