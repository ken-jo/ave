import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

const require = createRequire(import.meta.url);
const agentPath = require.resolve("node-pty/lib/windowsPtyAgent.js");

interface PtyAgent {
  kill(): void;
  _getConsoleProcessList(): Promise<number[]>;
}

// Execute installed dependency bytes while keeping native calls and process termination inert.
function loadAgent() {
  const events: string[] = [];
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const fork = vi.fn(() => { events.push("read-list"); return child; });
  const kill = vi.fn((pid: number) => { events.push(`sweep:${pid}`); });
  const nativeKill = vi.fn(() => { events.push("native-kill"); });
  const dispose = vi.fn(() => { events.push("dispose"); });
  const schedule = vi.fn(setTimeout);
  const exports = {} as { WindowsPtyAgent: { prototype: PtyAgent } };
  runInNewContext(readFileSync(agentPath, "utf8"), {
    exports,
    require: (id: string) => id === "child_process" ? { fork } : createRequire(agentPath)(id),
    __dirname: require.resolve("node-pty/package.json").replace(/package\.json$/, "lib"),
    process: { kill },
    setTimeout: schedule,
    clearTimeout,
  }, { filename: agentPath });
  const agent = Object.assign(Object.create(exports.WindowsPtyAgent.prototype) as PtyAgent, {
    _useConpty: true,
    _useConptyDll: false,
    _innerPid: 123,
    _pty: 456,
    _inSocket: { readable: true },
    _outSocket: { readable: true },
    _ptyNative: { kill: nativeKill },
    _conoutSocketWorker: { dispose },
  });
  return { agent, child, fork, kill, nativeKill, dispose, events, schedule };
}

afterEach(() => { vi.useRealTimers(); });

describe("installed PTY console termination", () => {
  it("requests teardown only once while lookup is pending and after completion", async () => {
    vi.useFakeTimers();
    const { agent, child, fork, nativeKill, dispose, kill } = loadAgent();
    agent.kill();
    agent.kill();
    expect(fork).toHaveBeenCalledTimes(1);
    expect(nativeKill).not.toHaveBeenCalled();
    child.emit("message", { consoleProcessList: [321] });
    await Promise.resolve();
    agent.kill();
    await vi.runAllTimersAsync();
    expect(fork).toHaveBeenCalledTimes(1);
    expect(nativeKill).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith(321);
  });

  it("bounds console enumeration below the Windows shutdown wait", async () => {
    vi.useFakeTimers();
    const { agent, schedule } = loadAgent();
    agent.kill();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBeGreaterThan(0);
    expect(schedule.mock.calls[0][1]).toBeLessThan(TOOL_TIMEOUT_POLICY.windowsPtyShutdownMs);
    await vi.runAllTimersAsync();
  });

  it("reads console members before native teardown and sweeps only those members", async () => {
    vi.useFakeTimers();
    const { agent, child, kill, nativeKill, events } = loadAgent();
    agent.kill();
    expect(events).toEqual(["read-list"]);
    child.emit("message", { consoleProcessList: [321, 654] });
    await Promise.resolve();
    expect(events).toEqual(["read-list", "native-kill", "dispose", "sweep:321", "sweep:654"]);
    expect(nativeKill).toHaveBeenCalledExactlyOnceWith(456, false);
    expect(kill).not.toHaveBeenCalledWith(123);
    child.emit("exit", 0);
    await vi.runAllTimersAsync();
    expect(nativeKill).toHaveBeenCalledTimes(1);
  });

  it.each(["exit", "error", "empty", "timeout", "fork-throw"] as const)(
    "tears down without sweeping unobserved PIDs after %s", async failure => {
      vi.useFakeTimers();
      const { agent, child, fork, kill, nativeKill, dispose } = loadAgent();
      if (failure === "fork-throw") fork.mockImplementation(() => { throw new Error("spawn failed"); });
      agent.kill();
      if (failure === "exit") child.emit("exit", 1);
      if (failure === "error") child.emit("error", new Error("spawn failed"));
      if (failure === "empty") child.emit("message", { consoleProcessList: [] });
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      // Exit and error settle now, without waiting for the five-second timeout.
      expect(nativeKill).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
      agent.kill();
      child.emit("message", { consoleProcessList: [123] });
      await vi.runAllTimersAsync();
      expect(fork).toHaveBeenCalledTimes(1);
      expect(nativeKill).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledTimes(failure === "timeout" ? 1 : 0);
    },
  );

  it("continues sweeping when an observed member has already exited", async () => {
    const { agent, child, kill } = loadAgent();
    kill.mockImplementationOnce(() => { throw new Error("ESRCH"); });
    agent.kill();
    child.emit("message", { consoleProcessList: [321, 654] });
    await Promise.resolve();
    expect(kill.mock.calls).toEqual([[321], [654]]);
  });

  it.each([false, true])("the console list child sends a result when attach fails: %s", attachFailed => {
    const getConsoleProcessList = vi.fn(() => {
      if (attachFailed) throw new Error("AttachConsole failed");
      return [321, 654];
    });
    const send = vi.fn();
    const exit = vi.fn();
    const filename = require.resolve("node-pty/lib/conpty_console_list_agent.js");
    runInNewContext(readFileSync(filename, "utf8"), {
      exports: {},
      require: () => ({ loadNativeModule: () => ({ module: { getConsoleProcessList } }) }),
      process: { argv: ["runtime", filename, "123"], send, exit },
    }, { filename });
    expect(getConsoleProcessList).toHaveBeenCalledExactlyOnceWith(123);
    expect(send).toHaveBeenCalledExactlyOnceWith({ consoleProcessList: attachFailed ? [] : [321, 654] });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
