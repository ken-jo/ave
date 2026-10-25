/** The plugin preload must expose only the narrow bridge, never host-level APIs. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const originalIsMainFrame = Object.getOwnPropertyDescriptor(process, "isMainFrame");

function setMainFrame(value: boolean): void {
  Object.defineProperty(process, "isMainFrame", { configurable: true, value });
}

// Named-only mock exports catch accidental default imports.
vi.mock("electron", () => {
  const contextBridge = {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value);
    },
  };
  const ipcRenderer = {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    on: (...args: unknown[]) => mockOn(...args),
    removeListener: (...args: unknown[]) => mockRemoveListener(...args),
  };
  return {
    contextBridge,
    ipcRenderer,
  };
});

beforeAll(async () => {
  // Emulate the top preload frame; child frames must not receive this bridge.
  setMainFrame(true);
  await import("../plugin-preload.js");
});

afterAll(() => {
  if (originalIsMainFrame) {
    Object.defineProperty(process, "isMainFrame", originalIsMainFrame);
  } else {
    Reflect.deleteProperty(process, "isMainFrame");
  }
});

beforeEach(() => {
  mockInvoke.mockReset();
  mockOn.mockReset();
  mockRemoveListener.mockReset();
  vi.unstubAllGlobals();
});

describe("plugin-preload bridge", () => {
  it("exposes window.avePlugin with calls, one-shot grants, and events", () => {
    expect(exposed.has("avePlugin")).toBe(true);
    const bridge = exposed.get("avePlugin") as Record<string, unknown>;
    expect(typeof bridge.callTool).toBe("function");
    expect(typeof bridge.requestOperationGrant).toBe("function");
    expect(typeof bridge.emitEvent).toBe("function");
    expect(typeof bridge.onEvent).toBe("function");
  });

  it("requests a host-owned operation grant and forwards only its opaque bearer", async () => {
    const bridge = exposed.get("avePlugin") as {
      requestOperationGrant: (name: string, args: unknown) => Promise<{ operationGrantToken: string }>;
      callTool: (name: string, args: unknown, options?: { operationGrantToken?: string }) => Promise<unknown>;
    };
    mockInvoke
      .mockResolvedValueOnce({ ok: true, result: { operationGrantToken: "opaque", grantId: "g", expiresAt: 9 } })
      .mockResolvedValueOnce({ ok: true, result: "saved" });
    const input = { operation: "save", employee: "not-authority" };
    const grant = await bridge.requestOperationGrant("domain_write", input);
    await bridge.callTool("domain_write", input, grant);
    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      "ave:plugin:request-operation-grant",
      "domain_write",
      input,
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      "ave:plugin:call-tool",
      "domain_write",
      input,
      { userAction: false, operationGrantToken: "opaque" },
    );
  });

  it("does NOT expose window.aveApi (host-level API)", () => {
    expect(exposed.has("aveApi")).toBe(false);
  });

  it("does NOT expose window.aveHost (marketplace install API)", () => {
    expect(exposed.has("aveHost")).toBe(false);
  });

  it("does NOT expose window.ave (host namespace)", () => {
    expect(exposed.has("ave")).toBe(false);
  });

  it("callTool invokes ave:plugin:call-tool IPC channel without pluginId arg", async () => {
    // Main resolves plugin identity from the sender; the renderer must not supply it.
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true, result: "pong" });

    await bridge.callTool("sample_plugin_status", { verbose: true });

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:call-tool",
      "sample_plugin_status",
      { verbose: true },
      { userAction: false },
    );
  });

  it("callTool forwards active user activation without letting plugin code supply pluginId", async () => {
    const bridge = exposed.get("avePlugin") as {
      callTool: (name: string, args?: unknown) => Promise<unknown>;
    };
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    mockInvoke.mockResolvedValueOnce({ ok: true, result: "ok" });

    await bridge.callTool("sample_plugin_run", { id: 1 });

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:call-tool",
      "sample_plugin_run",
      { id: 1 },
      { userAction: true },
    );
  });

  it("callTool unwraps { ok: true, result } and resolves to the raw result", async () => {
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true, result: { authenticated: true, cookieCount: 7 } });

    const value = await bridge.callTool("status", {});
    expect(value).toEqual({ authenticated: true, cookieCount: 7 });
  });

  it("callTool throws Error(message) when host returns { ok: false, error }", async () => {
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "cross-plugin-call-denied" });

    await expect(bridge.callTool("forbidden_tool", {})).rejects.toThrow(/cross-plugin-call-denied/);
  });

  it("callTool rejects non-envelope replies", async () => {
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ authenticated: true });

    await expect(bridge.callTool("status", {})).rejects.toThrow(/plugin-call-malformed-envelope/);
  });

  it("callTool rejects non-boolean ok envelopes", async () => {
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: "yes", result: "pong" });

    await expect(bridge.callTool("status", {})).rejects.toThrow(/plugin-call-malformed-envelope/);
  });

  it("emitEvent invokes ave:plugin:emit-event IPC channel without pluginId arg", async () => {
    const bridge = exposed.get("avePlugin") as { emitEvent: (type: string, data?: unknown) => Promise<void> };
    mockInvoke.mockResolvedValueOnce({ ok: true });

    const value = await bridge.emitEvent("my.custom.event", { foo: "bar" });

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:emit-event",
      "my.custom.event",
      { foo: "bar" },
    );
    // Successful fire-and-forget calls resolve to undefined rather than the host envelope.
    expect(value).toBeUndefined();
  });

  it("callTool resolves to undefined when host returns { ok: true } with no result field", async () => {
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true });

    expect(await bridge.callTool("fire_and_forget", {})).toBeUndefined();
  });

  it("emitEvent throws Error(message) when host returns { ok: false, error }", async () => {
    const bridge = exposed.get("avePlugin") as { emitEvent: (type: string, data?: unknown) => Promise<void> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "missing-capability:event-emit" });

    await expect(bridge.emitEvent("forbidden.event", {})).rejects.toThrow(/missing-capability/);
  });

  it("getEntryUrl invokes ave:plugin:get-entry-url and unwraps the success sentinel", async () => {
    const bridge = exposed.get("avePlugin") as { getEntryUrl: () => Promise<string> };
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      entryUrl: "ave-plugin://asset/dist/ui/sample-panel.js",
    });

    const url = await bridge.getEntryUrl();

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugin:get-entry-url");
    expect(url).toBe("ave-plugin://asset/dist/ui/sample-panel.js");
  });

  it("getEntryUrl throws when main returns a rejection sentinel", async () => {
    const bridge = exposed.get("avePlugin") as { getEntryUrl: () => Promise<string> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unauthorized-frame" });

    await expect(bridge.getEntryUrl()).rejects.toThrow(/unauthorized-frame/);
  });

  // An unregistered webview fails immediately; the shell must not retry.
  it("getEntryUrl surfaces the not-registered error verbatim", async () => {
    const bridge = exposed.get("avePlugin") as { getEntryUrl: () => Promise<string> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "not-registered" });

    await expect(bridge.getEntryUrl()).rejects.toThrow(/not-registered/);
  });

  it("getTheme invokes ave:plugin:get-theme and unwraps the cached payload", async () => {
    const bridge = exposed.get("avePlugin") as { getTheme: () => Promise<unknown> };
    const payload = {
      bundleId: "violet-dark",
      shell: "dark",
      tokens: { "--ave-bg": "hsl(0,0%,100%)", "--ave-fg": "hsl(222,47%,11%)" },
    };
    mockInvoke.mockResolvedValueOnce({ ok: true, theme: payload });

    const theme = await bridge.getTheme();

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugin:get-theme");
    expect(theme).toEqual(payload);
  });

  it("getTheme returns null on cold-boot when host has not broadcast yet", async () => {
    // A null theme must not block entry import.
    const bridge = exposed.get("avePlugin") as { getTheme: () => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true, theme: null });

    const theme = await bridge.getTheme();
    expect(theme).toBeNull();
  });

  it("getTheme throws when main rejects the request", async () => {
    const bridge = exposed.get("avePlugin") as { getTheme: () => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unauthorized-frame" });

    await expect(bridge.getTheme()).rejects.toThrow(/unauthorized-frame/);
  });

  it("getTheme rejects malformed envelopes", async () => {
    const bridge = exposed.get("avePlugin") as { getTheme: () => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: "yes", theme: null });

    await expect(bridge.getTheme()).rejects.toThrow(/plugin-theme-malformed-envelope/);
  });

  it("onEvent registers listener on ave:plugin:event IPC channel and returns unsubscribe", () => {
    const bridge = exposed.get("avePlugin") as {
      onEvent: (type: string, handler: (data: unknown) => void) => () => void;
    };

    const handler = vi.fn();
    const unsubscribe = bridge.onEvent("meeting.started", handler);

    expect(mockOn).toHaveBeenCalledWith("ave:plugin:event", expect.any(Function));
    expect(typeof unsubscribe).toBe("function");

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith("ave:plugin:event", expect.any(Function));
  });

  it("lifecycle APIs absent: getRuntimeCounts, pingMarketplace, onPluginInstallResult not callable", () => {
    const bridge = exposed.get("avePlugin") as Record<string, unknown>;

    expect(bridge).not.toHaveProperty("getRuntimeCounts");
    expect(bridge).not.toHaveProperty("pingMarketplace");
    expect(bridge).not.toHaveProperty("getRuntimeEnv");
    expect(bridge).not.toHaveProperty("onPluginInstallResult");
    expect(bridge).not.toHaveProperty("onPluginUninstallResult");
    expect(bridge).not.toHaveProperty("onPluginInstallProgress");
  });

  it("does not expose the bridge or IPC listener in a child frame", async () => {
    // Reload as a child frame to verify bridge installation fails closed.
    exposed.clear();
    vi.resetModules();
    setMainFrame(false);

    await import("../plugin-preload.js");

    expect(exposed.has("avePlugin")).toBe(false);
    expect(mockOn).not.toHaveBeenCalled();
    setMainFrame(true);
  });
});
