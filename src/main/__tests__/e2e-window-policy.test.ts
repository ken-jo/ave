import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";

const runtime = vi.hoisted(() => ({ isPackaged: false, setActivationPolicy: vi.fn(), on: vi.fn(), exit: vi.fn() }));
vi.mock("electron", () => ({ app: runtime }));
import { configureE2eWindowPolicy } from "../e2e-window-policy.js";
import { showWindowForRuntime, whenFocusEmulated } from "../e2e-window-presentation.js";

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
    expect(runtime.setActivationPolicy.mock.calls).toEqual(enabled ? [["prohibited"]] : []);
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
    const debuggerApi = Object.assign(new EventEmitter(), { isAttached: vi.fn(() => false), attach: vi.fn(), sendCommand: vi.fn(async () => undefined) });
    const contents = Object.assign(new EventEmitter(), {
      getType: () => kind, debugger: debuggerApi, setBackgroundThrottling: vi.fn(), isDestroyed: () => false,
    });
    const listener = runtime.on.mock.calls.find(([event]) => event === "web-contents-created")?.[1];
    if (!listener) throw new Error("Page policy listener is missing");
    listener({}, contents);
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled();
    let emulated: boolean | undefined;
    void whenFocusEmulated(contents as never).then((value) => { emulated = value; });
    await Promise.resolve();
    expect(emulated).toBeUndefined();
    contents.emit("dom-ready");
    await Promise.resolve();
    await Promise.resolve();
    expect(emulated).toBe(true);
    expect(contents.listenerCount("destroyed")).toBe(1);
    await expect(whenFocusEmulated(contents as never)).resolves.toBe(true);
    expect(contents.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", { enabled: true });
    debuggerApi.isAttached.mockReturnValue(true);
    contents.emit("dom-ready");
    await Promise.resolve();
    expect(contents.setBackgroundThrottling).toHaveBeenCalledTimes(2);
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
  });

  it("reports a page destroyed before focus emulation as unfocused", async () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, debugger: new EventEmitter() });
    const pending = whenFocusEmulated(contents as never);
    contents.emit("destroyed");
    await expect(pending).resolves.toBe(false);
    expect(contents.debugger.listenerCount("detach")).toBe(0);
  });

  it("requires a fresh focus acknowledgement after debugger reconnect", async () => {
    setIsPackaged(false);
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    configureE2eWindowPolicy();
    const commands: Array<ReturnType<typeof deferred<unknown>>> = [];
    const acknowledge = (index: number): void => {
      const command = commands[index];
      if (!command) throw new Error("Focus emulation command is missing");
      command.resolve({});
    };
    const debuggerApi = Object.assign(new EventEmitter(), {
      isAttached: () => false, attach: vi.fn(), sendCommand: vi.fn(() => {
        const command = deferred<unknown>();
        commands.push(command);
        return command.promise;
      }),
    });
    const contents = Object.assign(new EventEmitter(), {
      getType: () => "window", debugger: debuggerApi, setBackgroundThrottling: vi.fn(), isDestroyed: () => false,
    });
    const listener = runtime.on.mock.calls.find(([event]) => event === "web-contents-created")?.[1];
    if (!listener) throw new Error("Page policy listener is missing");
    listener({}, contents);
    contents.emit("dom-ready");
    acknowledge(0);
    await expect(whenFocusEmulated(contents as never)).resolves.toBe(true);
    // An acknowledgement in flight at detach belongs to the old debugger generation.
    contents.emit("dom-ready");
    debuggerApi.emit("detach", {}, "target closed");
    await expect(whenFocusEmulated(contents as never)).resolves.toBe(false);
    contents.emit("dom-ready");
    let focused: boolean | undefined;
    const pending = whenFocusEmulated(contents as never).then((value) => { focused = value; return value; });
    acknowledge(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(focused).toBeUndefined();
    acknowledge(2);
    await expect(pending).resolves.toBe(true);
    Object.defineProperty(contents, "debugger", { get: () => { throw new Error("The page was destroyed"); } });
    expect(() => contents.emit("destroyed")).not.toThrow();
    await expect(whenFocusEmulated(contents as never)).resolves.toBe(false);
    expect(debuggerApi.listenerCount("detach")).toBe(0);
  });

  it("cannot confirm focus after destruction with an acknowledgement still pending", async () => {
    setIsPackaged(false);
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    configureE2eWindowPolicy();
    const command = deferred<unknown>();
    const contents = Object.assign(new EventEmitter(), {
      getType: () => "window", debugger: Object.assign(new EventEmitter(), {
        isAttached: () => false, attach: vi.fn(), sendCommand: () => command.promise,
      }), setBackgroundThrottling: vi.fn(), isDestroyed: () => false,
    });
    const listener = runtime.on.mock.calls.find(([event]) => event === "web-contents-created")?.[1];
    if (!listener) throw new Error("Page policy listener is missing");
    listener({}, contents);
    const pending = whenFocusEmulated(contents as never);
    contents.emit("dom-ready");
    contents.emit("destroyed");
    command.resolve({});
    await expect(pending).resolves.toBe(false);
    await expect(whenFocusEmulated(contents as never)).resolves.toBe(false);
  });
});
