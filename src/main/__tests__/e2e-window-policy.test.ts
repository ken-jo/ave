import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";

const runtime = vi.hoisted(() => ({ isPackaged: false, setActivationPolicy: vi.fn(), on: vi.fn(), exit: vi.fn() }));
vi.mock("electron", () => ({ app: runtime }));
import { configureE2eWindowPolicy } from "../e2e-window-policy.js";
import { showWindowForRuntime } from "../e2e-window-presentation.js";

const originalPlatform = process.platform;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  runtime.isPackaged = false;
  _resetForTest();
  setProcessPlatform(originalPlatform);
});

describe("background test windows", () => {
  it.each([
    [false, "1", "test", false, true],
    [true, "1", "test", false, false],
    [false, "1", "production", false, false],
    [false, "", "test", false, false],
    [false, "1", "test", true, false],
  ])("guards packaged and ordinary launches (%s, %s, %s, %s)", (packaged, flag, env, foreground, enabled) => {
    setProcessPlatform("darwin");
    runtime.isPackaged = packaged;
    setIsPackaged(packaged);
    vi.stubEnv("AVE_E2E", flag);
    vi.stubEnv("NODE_ENV", env);
    vi.stubEnv("AVE_NATIVE_FIXTURE_MODE", foreground ? "foreground" : "cdp");
    configureE2eWindowPolicy();
    expect(runtime.setActivationPolicy.mock.calls).toEqual(enabled ? [["accessory"]] : []);
    const presentation = { show: vi.fn(), showInactive: vi.fn() };
    showWindowForRuntime(presentation as never);
    expect(presentation.showInactive).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(presentation.show).toHaveBeenCalledTimes(enabled ? 0 : 1);
    expect(runtime.on).toHaveBeenCalledTimes(enabled ? 2 : 0);
    if (enabled) {
      const window = Object.assign(new EventEmitter(), { setFocusable: vi.fn() });
      const listener = runtime.on.mock.calls[0]?.[1];
      if (!listener) throw new Error("Window policy listener is missing");
      listener({}, window);
      expect(window.setFocusable).toHaveBeenCalledWith(false);
    }
  });

  it.each(["window", "webview"])("emulates document focus after each %s navigation", async (kind) => {
    setIsPackaged(false);
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    configureE2eWindowPolicy();
    const debuggerApi = { isAttached: vi.fn(() => false), attach: vi.fn(), sendCommand: vi.fn(async () => undefined) };
    const contents = Object.assign(new EventEmitter(), { getType: () => kind, debugger: debuggerApi });
    const listener = runtime.on.mock.calls.find(([event]) => event === "web-contents-created")?.[1];
    if (!listener) throw new Error("Page policy listener is missing");
    listener({}, contents);
    contents.emit("dom-ready");
    await Promise.resolve();
    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", { enabled: true });
  });
});
