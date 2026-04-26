/**
 * #237 Option B — Plugin Preload Bridge Security Tests
 *
 * Verifies that the plugin webview preload (plugin-preload.ts) exposes ONLY
 * the narrow `window.avePlugin` bridge and does NOT leak any host-level APIs
 * (`window.aveApi`, `window.aveHost`, `window.ave`).
 *
 * We load the preload once and capture its contextBridge registrations.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";

// ─── Capture contextBridge registrations ─────────────────────────────────────

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock("electron", () => ({
  default: {
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        exposed.set(key, value);
      },
    },
    ipcRenderer: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
      on: (...args: unknown[]) => mockOn(...args),
      removeListener: (...args: unknown[]) => mockRemoveListener(...args),
    },
  },
}));

// Load the preload module once — top-level code executes once per module instance.
beforeAll(async () => {
  await import("../plugin-preload.js");
});

// ─── Positive / negative contract tests ───────────────────────────────────────

describe("plugin-preload bridge", () => {
  it("exposes window.avePlugin with callTool, emitEvent, onEvent", () => {
    expect(exposed.has("avePlugin")).toBe(true);
    const bridge = exposed.get("avePlugin") as Record<string, unknown>;
    expect(typeof bridge.callTool).toBe("function");
    expect(typeof bridge.emitEvent).toBe("function");
    expect(typeof bridge.onEvent).toBe("function");
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

  it("callTool invokes ave:plugin:call-tool IPC channel", async () => {
    const bridge = exposed.get("avePlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true, result: "pong" });

    await bridge.callTool("agent_hub_status", { verbose: true });

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:call-tool",
      expect.any(String), // pluginId from query string (empty string in test env)
      "agent_hub_status",
      { verbose: true },
    );
  });

  it("emitEvent invokes ave:plugin:emit-event IPC channel", async () => {
    const bridge = exposed.get("avePlugin") as { emitEvent: (type: string, data?: unknown) => Promise<void> };
    mockInvoke.mockResolvedValueOnce({ ok: true });

    await bridge.emitEvent("my.custom.event", { foo: "bar" });

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:emit-event",
      expect.any(String), // pluginId
      "my.custom.event",
      { foo: "bar" },
    );
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
});
