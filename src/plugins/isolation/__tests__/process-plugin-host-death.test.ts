// windows-permission
import childProcess, { type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { posixProcessExists, spawnSacrificialHost, stopFixtureProcesses, stopSacrificialHost, waitForFixture, withFixtureCleanup } from "../../../__tests__/support/sacrificial-host.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../../lib/shell-resolver.js";
import { ProcessEntryUnconfinedError } from "../../process-entry.js";
import { spawnConfinedPluginChild } from "../out-of-process-plugin.js";

const HOST = `
  const [pluginModule, sandboxModule, capabilityModule, homeModule, storageModule, pluginId, pluginRoot, pluginDataDir, launcher] = process.argv.slice(1);
  const { spawnConfinedPluginChild, derivePluginChildEnvelope } = await import(pluginModule);
  const { initializeAsrtSandbox } = await import(sandboxModule);
  const { setPluginWorkerConfinementRequestedAtBoot } = await import(capabilityModule);
  const { aveHome, ensureAveHomePrivate } = await import(homeModule);
  const { resolvePluginSocketDir } = await import(storageModule);
  if (ensureAveHomePrivate(aveHome()).enforcement === "none") throw new Error("Fixture home is not private");
  setPluginWorkerConfinementRequestedAtBoot(true);
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  const child = await spawnConfinedPluginChild({
    pluginId,
    socketDir: resolvePluginSocketDir(pluginDataDir),
    envelope: derivePluginChildEnvelope({ pluginId, pluginRoot, pluginDataDir, configValue: () => undefined }),
    launch: { kind: "process", command: launcher, args: [], env: { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: pluginDataDir } },
  });
  process.send({ pgid: child.pid, confinement: child.confinement });
  process.on("message", (message) => {
    if (message === "close-plugin-input") child.link.output.end();
  });
`;

const HEARTBEAT = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [role, outsidePath] = process.argv.slice(2);
const path = (name) => join(process.env.PLUGIN_DATA, name);
function report(name, data) {
  writeFileSync(path(name + ".pending"), JSON.stringify(data));
  renameSync(path(name + ".pending"), path(name));
}
function child(nextRole, detached) {
  const spawned = spawn(process.execPath, [fileURLToPath(import.meta.url), nextRole, outsidePath], { detached, stdio: "ignore" });
  spawned.on("error", (error) => report("spawn-error", error.message));
}

function requestThroughProxy() {
  const proxy = new URL(process.env.HTTP_PROXY);
  return new Promise((resolve) => {
    const req = request({
      hostname: proxy.hostname, port: proxy.port, path: "http://example.invalid/",
      headers: { Host: "example.invalid", "Proxy-Authorization": "Basic " + Buffer.from(
        decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password),
      ).toString("base64") },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", (error) => resolve(error.code));
    req.end();
  });
}

let proxy;
if (role === "leader") {
  process.stdin.on("end", () => report("stdin-eof", process.pid));
  process.stdin.resume();
  child("same-group", false);
} else if (role === "same-group") {
  child("new-session", true);
} else if (process.platform === "darwin") {
  proxy = await requestThroughProxy();
  const probe = setInterval(async () => {
    if (!existsSync(path("probe-after"))) return;
    clearInterval(probe);
    let write = "succeeded";
    try { writeFileSync(outsidePath, "changed"); } catch (error) { write = error.code; }
    report("probe-result", { write, proxy: await requestThroughProxy() });
  }, 50);
}

appendFileSync(path(role), ".");
report("ready-" + role, { pid: process.pid, proxy });
setInterval(() => appendFileSync(path(role), "."), 50);
`;

const ROLES = ["leader", "same-group", "new-session"] as const;
type Role = (typeof ROLES)[number];
const PLUGIN_ID = "heartbeat";

async function heartbeatProcesses(script: string, outsidePath: string, deadline: number): Promise<Map<Role, number>> {
  // The Linux sandbox's process IDs are local to its PID namespace. Match the host's IDs to this fixture's exact argv.
  const processes = new Map<Role, number>();
  const timeout = Math.ceil(deadline - performance.now());
  const timeoutMessage = "Fixture watchdog expired during heartbeat process inventory";
  if (timeout <= 0) throw new Error(timeoutMessage);
  const listing = await new Promise<string>((resolve, reject) => {
    childProcess.execFile("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error?.killed && error.signal === "SIGKILL" && error.code == null) {
        reject(new Error(timeoutMessage, { cause: error }));
      } else if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
  if (performance.now() >= deadline) throw new Error(timeoutMessage);
  for (const line of listing.split("\n")) {
    const match = /^\s*([1-9]\d*)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const [, pid, command] = match;
    for (const role of ROLES) {
      if (command?.endsWith(` ${script} ${role} ${outsidePath}`) && Number(pid) > 1) processes.set(role, Number(pid));
    }
  }
  return processes;
}

async function reapHeartbeatProcesses(script: string, outsidePath: string, deadline: number): Promise<void> {
  const processes = await heartbeatProcesses(script, outsidePath, deadline);
  if (performance.now() >= deadline) throw new Error("Fixture watchdog expired during heartbeat process inventory");
  await stopFixtureProcesses([...processes.values()], deadline);
}

it("reports stalled heartbeat process reaping and attempts fixture directory removal", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inventory = vi.spyOn(childProcess, "execFile").mockReturnValue(new childProcess.ChildProcess());
  try {
    const failure = new Error("Fixture assertion failed");
    const reportFailure = vi.fn();
    const removeDirectory = vi.fn();
    void withFixtureCleanup(async () => { throw failure; }, [
      { phase: "heartbeat process reaping", run: (deadline) => reapHeartbeatProcesses("/fixture/heartbeat.mjs", "/fixture/host-owned", deadline) },
      { phase: "fixture directory removal", run: removeDirectory },
    ]).catch(reportFailure);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(removeDirectory).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      errors: [failure, expect.objectContaining({ message: "Fixture cleanup timed out during heartbeat process reaping" })],
    }));
    expect(inventory).toHaveBeenCalledExactlyOnceWith(
      "/bin/ps", ["-axww", "-o", "pid=,command="],
      { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" }, expect.any(Function),
    );
  } finally {
    inventory.mockRestore();
    vi.useRealTimers();
  }
});

it("reports the stalled phase at the shared fixture deadline and runs teardown", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const cleanup = vi.fn();
  const probe = vi.fn<() => true | undefined>()
    .mockImplementationOnce(() => {
      clock.mockReturnValue(100);
      return undefined;
    })
    .mockReturnValue(true);

  try {
    await expect(withFixtureCleanup(async (deadline) => {
      await waitForFixture("confined host launch", () => {
        clock.mockReturnValue(75);
        return true;
      }, deadline);
      await waitForFixture("plugin stdin EOF acknowledgment", probe, deadline);
    }, [{ phase: "fixture cleanup", run: cleanup }], 100)).rejects.toThrow("Fixture watchdog expired during plugin stdin EOF acknowledgment");
    expect(probe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
});

describe.runIf(process.platform === "win32")("direct process plugin admission", () => {
  it("refuses a Windows process launch before validating its command or roots", async () => {
    const root = join(tmpdir(), "missing-process-plugin");
    await expect(spawnConfinedPluginChild({
      pluginId: PLUGIN_ID,
      socketDir: join(root, "sockets"),
      envelope: { read: [root], write: [root] },
      launch: { kind: "process", command: join(root, "plugin.exe"), args: [], env: {} },
    })).rejects.toBeInstanceOf(ProcessEntryUnconfinedError);
  });
});

describe.runIf(process.platform === "linux" || process.platform === "darwin")("process plugin host death", () => {
  it("reaps the confined group on host SIGKILL and measures the new session", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ave-plugin-heartbeat-")));
    const home = join(root, "home");
    const pluginRoot = join(home, "plugins", PLUGIN_ID);
    const pluginDataDir = join(pluginRoot, "data");
    const path = (name: string): string => join(pluginDataDir, name);
    const script = join(pluginRoot, "heartbeat.mjs");
    const launcher = join(pluginRoot, "launch");
    const outsidePath = join(root, "host-owned");
    const mac = process.platform === "darwin";
    const heartbeat = async (role: Role): Promise<number> => {
      try {
        return (await stat(path(role))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    };
    const readResult = async <T>(name: string): Promise<T | undefined> => {
      try {
        return JSON.parse(await readFile(path(name), "utf8")) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    };
    let activeHost: ChildProcess | undefined;
    let pgid: number | undefined;
    await withFixtureCleanup(async (deadline) => {
      await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
      await writeFile(outsidePath, "original");
      await writeFile(script, HEARTBEAT);
      const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
      await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(script)} leader ${shellQuote(outsidePath)}\n`);
      await chmod(launcher, 0o700);

      const host = spawnSacrificialHost(HOST, [
        new URL("../out-of-process-plugin.ts", import.meta.url).href,
        new URL("../../../permissions/asrt-sandbox.ts", import.meta.url).href,
        new URL("../../../permissions/sandbox-capability.ts", import.meta.url).href,
        new URL("../../../shared/ave-home.ts", import.meta.url).href,
        new URL("../../plugin-storage-layout.ts", import.meta.url).href,
        PLUGIN_ID, pluginRoot, pluginDataDir, launcher,
      ], { AVE_HOME: home });
      activeHost = host;
      let started: { pgid: number; confinement: string } | undefined;
      let hostError: Error | undefined;
      host.on("message", (message: { pgid: number; confinement: string }) => { started = message; pgid = message.pgid; });
      host.on("error", (error) => { hostError = error; });
      const assertHostRunning = (): void => {
        if (hostError) throw hostError;
        if (host.exitCode !== null || host.signalCode !== null) throw new Error("Sacrificial host exited before SIGKILL");
      };
      const launch = await waitForFixture("confined host launch", () => {
        assertHostRunning();
        return started;
      }, deadline);
      expect(launch.confinement).toBe(mac ? "macos-sandbox" : "linux-bubblewrap");
      expect(launch.pgid).toBeGreaterThan(1);
      const ready = await waitForFixture("plugin readiness", async () => {
        assertHostRunning();
        const spawnError = await readResult<string>("spawn-error");
        if (spawnError !== undefined) throw new Error(spawnError);
        const markers = await Promise.all(ROLES.map((role) => access(path(`ready-${role}`)).then(() => true, () => false)));
        return markers.every(Boolean) ? true : undefined;
      }, deadline);
      expect(ready).toBe(true);
      for (const role of ROLES) expect(await heartbeat(role), role).toBeGreaterThan(0);
      const visible = await heartbeatProcesses(script, outsidePath, deadline);
      expect(visible.size).toBe(ROLES.length);
      const newSession = visible.get("new-session");
      if (newSession === undefined) throw new Error("Missing host-visible new-session PID");
      if (mac) {
        expect(await readResult("ready-new-session")).toEqual({ pid: newSession, proxy: 403 });
        expect(posixProcessExists(-newSession)).toBe(true);
      }
      expect(posixProcessExists(-launch.pgid)).toBe(true);

      host.send("close-plugin-input");
      await waitForFixture("plugin stdin EOF acknowledgment", () => {
        assertHostRunning();
        return readResult<number>("stdin-eof");
      }, deadline);
      for (const pid of visible.values()) expect(posixProcessExists(pid)).toBe(true);
      host.kill("SIGKILL");
      await waitForFixture("host SIGKILL", () => host.signalCode ?? undefined, deadline);
      expect(host.signalCode).toBe("SIGKILL");

      const reaped = mac ? ROLES.slice(0, 2) : ROLES;
      await waitForFixture("plugin processes reaped", () => {
        if (posixProcessExists(-launch.pgid)) return undefined;
        for (const role of reaped) {
          const pid = visible.get(role);
          if (pid === undefined) throw new Error(`Missing PID for ${role}`);
          if (posixProcessExists(pid)) return undefined;
        }
        return true;
      }, deadline);
      pgid = undefined;
      const stopped = await Promise.all(reaped.map(heartbeat));
      if (mac) {
        expect(posixProcessExists(newSession)).toBe(true);
        const surviving = await heartbeat("new-session");
        await writeFile(path("probe-after"), "");
        const result = await waitForFixture("surviving session probe", () => {
          if (!posixProcessExists(newSession)) throw new Error("New session exited before its probe");
          return readResult<{ write: string; proxy: string }>("probe-result");
        }, deadline);
        expect(result.write).toMatch(/^(EPERM|EACCES)$/);
        expect(result.proxy).toBe("ECONNREFUSED");
        expect(await readFile(outsidePath, "utf8")).toBe("original");
        await waitForFixture("surviving heartbeat", async () => await heartbeat("new-session") > surviving ? true : undefined, deadline);
      }
      expect(await Promise.all(reaped.map(heartbeat))).toEqual(stopped);
    }, [
      { phase: "sacrificial host shutdown", run: async (deadline) => { if (activeHost) await stopSacrificialHost(activeHost, deadline); } },
      { phase: "plugin group reaping", run: (deadline) => stopFixtureProcesses(pgid !== undefined && pgid > 1 ? [-pgid] : [], deadline) },
      { phase: "heartbeat process reaping", run: (deadline) => reapHeartbeatProcesses(script, outsidePath, deadline) },
      { phase: "fixture directory removal", run: () => cleanupTmpDir(root) },
    ]);
  });
});
