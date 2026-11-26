import childProcess from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { runOneHookScript, type RunnableHook } from "../script-hook-runner.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import type { ScriptHookStdin } from "../script-hook-types.js";

const resources = new PermissionTestResources();
afterEach(() => resources.cleanup());

const payload: ScriptHookStdin = {
  hookType: "pre", toolName: "write_file", source: "builtin", category: "write",
  input: {}, sessionId: "cancel-hook-session", trustOrigin: "user-keyboard",
};

function waitingHook(pidPath: string): RunnableHook {
  return {
    id: "waiting-command", hookType: "pre", source: "config", hookPath: "node",
    configDir: dirname(pidPath),
    command: ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", pidPath],
  };
}

describe("script hook caller cancellation", () => {
  it("kills only the owned hook child and leaves another hook running", async () => {
    const root = resources.makeTmpDir("ave-hook-cancel-");
    const firstPath = join(root, "first.pid");
    const secondPath = join(root, "second.pid");
    const first = new AbortController();
    const second = new AbortController();
    const spawn = childProcess.spawn;
    let firstArmedAtSpawn = false;
    const observed = vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
      if (Array.isArray(args) && args.includes(firstPath)) {
        firstArmedAtSpawn = getEventListeners(first.signal, "abort").length > 0;
      }
      return spawn(command, args, options);
    });
    syncBuiltinESMExports();
    const firstRun = runOneHookScript(waitingHook(firstPath), payload, { cwd: root, abortSignal: first.signal });
    const secondRun = runOneHookScript(waitingHook(secondPath), payload, { cwd: root, abortSignal: second.signal });
    try {
      let firstPid = 0;
      let secondPid = 0;
      await vi.waitFor(() => {
        firstPid = Number(readFileSync(firstPath, "utf8"));
        secondPid = Number(readFileSync(secondPath, "utf8"));
        expect(firstPid).toBeGreaterThan(0);
        expect(secondPid).toBeGreaterThan(0);
      });
      expect(firstArmedAtSpawn).toBe(true);
      first.abort(new Error("owner stopped first hook"));
      expect(await firstRun).toMatchObject({ decision: "deny", reason: "Hook execution cancelled", timedOut: false });
      expect(() => process.kill(firstPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(() => process.kill(secondPid, 0)).not.toThrow();
    } finally {
      first.abort();
      second.abort();
      try { await Promise.all([firstRun, secondRun]); }
      finally { observed.mockRestore(); syncBuiltinESMExports(); }
    }
  });

  it.each(["delayed group kill", "leader close", "missing close"] as const)("waits for the managed POSIX verdict after %s", async scenario => {
    const platform = process.platform;
    const root = resources.makeTmpDir("ave-hook-group-");
    const caller = new AbortController();
    const acquired = deferred<void>();
    const child = Object.assign(new EventEmitter(), { pid: 14003, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let groupAlive = true;
    const nativeKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -child.pid) return nativeKill(pid, signal);
      if (groupAlive) return true;
      throw Object.assign(new Error("Group exited"), { code: "ESRCH" });
    });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      acquired.resolve();
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });
    syncBuiltinESMExports();
    setProcessPlatform("linux");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let result: Awaited<ReturnType<typeof runOneHookScript>> | undefined;
    const pending = runOneHookScript({ ...waitingHook(join(root, "unused.pid")), command: [process.execPath] }, payload,
      { cwd: root, abortSignal: caller.signal }).then(value => { result = value; });
    const close = (): void => { child.emit("close", null, "SIGKILL"); };
    try {
      await acquired.promise;
      caller.abort(new Error("Stop the process group"));
      if (scenario === "leader close") close();
      await vi.advanceTimersByTimeAsync(0);
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(result).toBeUndefined();
      if (scenario !== "missing close") {
        groupAlive = false;
        if (scenario === "delayed group kill") close();
      }
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs);
      expect(result).toMatchObject({ decision: "deny", reason: scenario === "missing close"
        ? expect.stringContaining("hook-termination-unverified") : "Hook execution cancelled" });
    } finally {
      groupAlive = false;
      close();
      await pending;
      vi.useRealTimers();
      setProcessPlatform(platform);
      kill.mockRestore();
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("inherits cancellation through the current turn and never spawns after held admission resolves", async () => {
    const root = resources.makeTmpDir("ave-hook-admission-cancel-");
    const pidPath = join(root, "not-started.pid");
    const caller = new AbortController();
    const held = deferred<{ decision: "allow"; reason: string }>();
    const entered = deferred<void>();
    const running = turnExtensionPolicyContext.run({ allowExternalHooks: true, abortSignal: caller.signal }, () =>
      runOneHookScript(waitingHook(pidPath), payload, {
        cwd: root,
        authorizeCommand: async () => { entered.resolve(); return held.promise; },
      }));
    await entered.promise;
    caller.abort(new Error("owner stopped before admission"));
    expect(await running).toMatchObject({ decision: "deny", reason: "Hook execution cancelled", timedOut: false });
    held.resolve({ decision: "allow", reason: "Late approval" });
    await Promise.resolve();
    expect(() => readFileSync(pidPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});
