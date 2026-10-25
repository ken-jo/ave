/** Config and storage use dedicated channels; dotted tool names have no dispatcher. */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const originalIsMainFrame = Object.getOwnPropertyDescriptor(process, "isMainFrame");

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
  return { contextBridge, ipcRenderer };
});

beforeAll(async () => {
  Object.defineProperty(process, "isMainFrame", { configurable: true, value: true });
  await import("../plugin-preload.js");
});

afterAll(() => {
  if (originalIsMainFrame) {
    Object.defineProperty(process, "isMainFrame", originalIsMainFrame);
  } else {
    Reflect.deleteProperty(process, "isMainFrame");
  }
});

type ConfigBridge = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
};
type StorageBridge = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
};

function getConfig(): ConfigBridge {
  const bridge = exposed.get("avePlugin") as Record<string, unknown>;
  return bridge.config as ConfigBridge;
}
function getStorage(): StorageBridge {
  const bridge = exposed.get("avePlugin") as Record<string, unknown>;
  return bridge.storage as StorageBridge;
}

describe("plugin-preload bridge.config namespace (#B1)", () => {
  it("exposes config.{get,set} as functions", () => {
    const config = getConfig();
    expect(typeof config.get).toBe("function");
    expect(typeof config.set).toBe("function");
  });

  it("config.get invokes ave:plugin:config:get and unwraps `value`", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: "subscribed-team-7" });
    const config = getConfig();

    const value = await config.get<string>("defaultTeam");

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugin:config:get", "defaultTeam");
    expect(value).toBe("subscribed-team-7");
  });

  it("config.get resolves to undefined when host returns `value: undefined`", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: undefined });
    const config = getConfig();

    expect(await config.get("missingKey")).toBeUndefined();
  });

  it("config.set invokes ave:plugin:config:set with key + value", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const config = getConfig();

    await config.set("defaultTeam", "ai-platform");

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:config:set",
      "defaultTeam",
      "ai-platform",
    );
  });

  it("config.get throws Error(error) when host returns ok=false", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "invalid-key" });
    const config = getConfig();

    await expect(config.get("")).rejects.toThrow(/invalid-key/);
  });

  it("config.set throws Error(error) when host returns ok=false", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unauthorized-frame" });
    const config = getConfig();

    await expect(config.set("k", "v")).rejects.toThrow(/unauthorized-frame/);
  });

  it("does NOT route through callTool with dotted name (C2 regression guard)", async () => {
    // Dedicated config channels must not regress to dotted tool calls.
    mockInvoke.mockResolvedValueOnce({ ok: true, value: 1 });
    await getConfig().get("k");
    const channel = mockInvoke.mock.calls.at(-1)?.[0] as string;
    expect(channel).toBe("ave:plugin:config:get");
    expect(channel).not.toMatch(/callTool|hostApi\./);
  });
});

describe("plugin-preload bridge.storage namespace (#B1)", () => {
  it("exposes storage.{get,set} as functions", () => {
    const storage = getStorage();
    expect(typeof storage.get).toBe("function");
    expect(typeof storage.set).toBe("function");
  });

  it("storage.get invokes ave:plugin:storage:get and unwraps `value`", async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      value: { lastViewedTab: "team-board" },
    });
    const storage = getStorage();

    const value = await storage.get<{ lastViewedTab: string }>("uiState");

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugin:storage:get", "uiState");
    expect(value).toEqual({ lastViewedTab: "team-board" });
  });

  it("storage.set invokes ave:plugin:storage:set with key + value", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const storage = getStorage();

    await storage.set("uiState", { lastViewedTab: "my-work" });

    expect(mockInvoke).toHaveBeenCalledWith(
      "ave:plugin:storage:set",
      "uiState",
      { lastViewedTab: "my-work" },
    );
  });

  it("storage.get throws Error(error) when host returns ok=false", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unknown-plugin-id" });
    const storage = getStorage();

    await expect(storage.get("k")).rejects.toThrow(/unknown-plugin-id/);
  });

  it("storage.set throws Error(error) on invalid-key sentinel", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "invalid-key" });
    const storage = getStorage();

    await expect(storage.set("../escape", "x")).rejects.toThrow(/invalid-key/);
  });

  it("does NOT route through callTool with dotted name (C2 regression guard)", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: 1 });
    await getStorage().get("k");
    const channel = mockInvoke.mock.calls.at(-1)?.[0] as string;
    expect(channel).toBe("ave:plugin:storage:get");
    expect(channel).not.toMatch(/callTool|hostApi\./);
  });
});

// getWebContentsId throws before attachment. Inspect event wiring because jsdom cannot reproduce native webview attachment.
describe("plugin UI host — webview registration lifecycle", () => {
  const source = readFileSync(
    new URL("../plugin-ui-host.tsx", import.meta.url),
    "utf8",
  );

  it("never reaches getWebContentsId() from a pre-attach trigger", () => {
    expect(source).not.toMatch(/addEventListener\(\s*"did-start-loading"/);
    expect(source).not.toMatch(/queueMicrotask\(\s*\(\)\s*=>\s*attemptRegisterWebview/);
  });

  it("gates the getWebContentsId() read on observed attachment", () => {
    const call = source.indexOf("node.getWebContentsId()");
    expect(call).toBeGreaterThan(-1);
    const guard = source.indexOf("if (!attachedRef.current) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("still registers on did-attach, and retries only on guest events", () => {
    expect(source).toMatch(/addEventListener\(\s*"did-attach"/);
    // These events fire after attachment and can safely retry a missed attach listener.
    expect(source).toMatch(/addEventListener\(\s*"dom-ready"/);
    expect(source).toMatch(/addEventListener\(\s*"did-finish-load"/);
  });
});
