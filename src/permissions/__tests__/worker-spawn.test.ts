vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));

// Stubbed wiring verifies wrap-before-spawn, shared socket registration, exact worker grants, live wrap markers and idempotent cleanup; native enforcement is covered in worker-spawn-uds.smoke.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { egressInvocationOwner } from "../egress-invocations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";

// Lifecycle fixtures intercept the launch; real image verification has native tests.
vi.mock("../srt-win-integrity.js", async (original) => ({
  ...await original<typeof import("../srt-win-integrity.js")>(),
  assertSrtWinSpawnIntegrity: vi.fn(),
}));

// node:fs / node:fs/promises mocks (no real disk touch)
const mkdirMock = vi.fn<(path: unknown, opts?: unknown) => Promise<undefined>>(() =>
  Promise.resolve(undefined),
);
const unlinkSyncMock = vi.fn<(path: unknown) => void>(() => undefined);
const rmdirSyncMock = vi.fn<(path: unknown) => void>(() => undefined);
const chmodSyncMock = vi.fn<(path: unknown, mode: unknown) => void>(() => undefined);
// Default: the control dir is a real dir, NOT a symlink (the security check).
const lstatSyncMock = vi.fn<(path: unknown) => { isSymbolicLink: () => boolean }>(() => ({
  isSymbolicLink: () => false,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: (path: unknown, opts?: unknown) => mkdirMock(path, opts),
}));
vi.mock("node:fs", async (importOriginal) => ({
  // The real module underneath: the sandbox module's logger reaches for more of it than the cases below steer.
  ...(await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await importOriginal<typeof import("node:fs")>()),
  unlinkSync: (path: unknown) => unlinkSyncMock(path),
  rmdirSync: (path: unknown) => rmdirSyncMock(path),
  chmodSync: (path: unknown, mode: unknown) => chmodSyncMock(path, mode),
  lstatSync: (path: unknown) => lstatSyncMock(path),
}));

const SANDBOX_HOME = "/tmp/ave-sandbox-home-test";
const sandboxHomeCleanupMock = vi.fn();
vi.mock("../sandbox-process-home.js", () => ({
  createSandboxProcessHome: () => ({
    path: SANDBOX_HOME,
    env: {
      HOME: SANDBOX_HOME,
      USERPROFILE: SANDBOX_HOME,
      APPDATA: `${SANDBOX_HOME}/AppData/Roaming`,
      LOCALAPPDATA: `${SANDBOX_HOME}/AppData/Local`,
      XDG_CONFIG_HOME: `${SANDBOX_HOME}/config`,
    },
    cleanup: sandboxHomeCleanupMock,
  }),
}));

// child_process mock
const spawnMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => unknown
>();
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: (cmd: string, args?: readonly string[], opts?: unknown) =>
    spawnMock(cmd, args, opts),
}));

// managed-child tracker is a no-op stub here
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: () => {},
  trackManagedChildProcess: () => () => {},
}));

// ASRT mock — gate + wrap controllable per test
let gateActive = false;
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const cleanupMock = vi.fn(() => Promise.resolve());
const registerUdsMock = vi.fn<(dir: string) => Promise<void>>(() => Promise.resolve());
const unregisterUdsMock = vi.fn<(dir: string) => Promise<void>>(() => Promise.resolve());
const grantReleaseMock = vi.fn<() => void>();
const grantWindowsWorkerFilesystemAccessMock = vi.fn<
  (opts: unknown) => Promise<{ allowRead: readonly string[]; allowWrite: readonly string[]; release: () => void }>
>(() =>
  Promise.resolve({
    allowRead: [],
    allowWrite: [],
    release: grantReleaseMock,
  }),
);
vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  assertExtensionStartAllowed: (await importOriginal<typeof import("../asrt-sandbox.js")>()).assertExtensionStartAllowed,
  // The real launcher and naming; the directory itself is not created.
  sandboxTempEnvLaunch: (await importOriginal<typeof import("../asrt-sandbox.js")>()).sandboxTempEnvLaunch,
  ensureSandboxTempPrincipalDir: (principal: { kind: string; id: string }) => ({
    dir: `/tmp/ave-test-sandbox-tmp/${principal.kind}-${Buffer.from(principal.id).toString("hex")}`,
    root: "/tmp/ave-test-sandbox-tmp",
  }),
  isAsrtSandboxActive: () => gateActive,
  isPluginWorkerConfinementActive: () => gateActive,
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
  registerWorkerUnixSocketDir: (dir: string) => registerUdsMock(dir),
  unregisterWorkerUnixSocketDir: (dir: string) => unregisterUdsMock(dir),
  grantWindowsWorkerFilesystemAccess: (opts: unknown) =>
    grantWindowsWorkerFilesystemAccessMock(opts),
  // The host-secret read floor restated on the worker wrap SOT). With the sandbox private roots, as the real floor carries them on POSIX.
  getDefaultSensitiveReadDenyPaths: () => [
    "/home/u/.ave/secrets",
    "/home/u/.ssh",
    "/tmp/ave-test-sandbox-tmp",
    "/home/u/.ave/sandbox/home",
  ],
  // The persistence-vector write floor restated on the worker wrap SOT).
  getDefaultSensitiveWriteDenyPaths: () => [
    "/home/u/.ave/secrets",
    "/home/u/.ssh",
    "/home/u/.zshrc",
    "/home/u/.config",
    "/home/u/Library/LaunchAgents",
  ],
}));

// Module imports AFTER the mocks.
import { __resetActiveWrappedWorkersForTest, spawnWorker, type SpawnWorkerSpec, waitForPluginWorkersStopped } from "../worker-spawn.js";
import { aveHome } from "../../shared/ave-home.js";
import {
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  isPluginWorkerWrapped,
} from "../sandbox-capability.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { startFakeRelayPeer } from "../../__tests__/support/fake-relay-peer.js";
import { resolvePluginChildEntryPath } from "../confined-child.js";

// A minimal child-process double (NOT a shared helper — local to this file).
class StubWorkerChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  killed = false;
  killCalls: Array<string | undefined> = [];
  kill(signal?: string): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

function setEnvForTest(values: Record<string, string | undefined>): () => void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const REAL_PLATFORM = process.platform;

function workerOptions(overrides: Partial<SpawnWorkerSpec> = {}): SpawnWorkerSpec {
  return { pluginId: "local-indexer", workerId: "embed", command: "/opt/worker", ...overrides };
}

// The control socket lives under the Ave home, and a Unix socket path is limited to 103 bytes on macOS. The per-file test home sits under `$HOME/.ave/test-tmp/<run>/<file>`, so with a HOME of a little over 20 bytes the longest plugin/worker pair here passes the limit and every gate-ON case fails with the length error instead of testing what it names. These cases run in a short Ave home of their own; `/tmp` rather than `os.tmpdir`, which on macOS is itself about 50 bytes. The guard allows it: it is outside the account's `~/.ave`.
const REAL_AVE_HOME = process.env.AVE_HOME;
let shortAveHome: string;
beforeAll(() => {
  shortAveHome = mkdtempSync(join(REAL_PLATFORM === "win32" ? tmpdir() : "/tmp", "ave-ws-"));
  process.env.AVE_HOME = shortAveHome;
});
afterAll(() => {
  if (REAL_AVE_HOME === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = REAL_AVE_HOME;
  rmSync(shortAveHome, { recursive: true, force: true });
});
const REAL_SYSTEM_ROOT = process.env.SystemRoot;
const REAL_WINDIR = process.env.WINDIR;

beforeEach(() => {
  __resetActiveWrappedWorkersForTest();
  process.env.SystemRoot = "C:\\Windows";
  process.env.WINDIR = "C:\\Windows";
  spawnMock.mockReset();
  wrapWorkerCommandMock.mockReset();
  cleanupMock.mockClear();
  sandboxHomeCleanupMock.mockClear();
  registerUdsMock.mockClear();
  unregisterUdsMock.mockClear();
  grantReleaseMock.mockClear();
  grantWindowsWorkerFilesystemAccessMock.mockClear();
  mkdirMock.mockClear();
  unlinkSyncMock.mockClear();
  rmdirSyncMock.mockClear();
  gateActive = false;
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

afterEach(() => {
  __resetActiveWrappedWorkersForTest();
  vi.useRealTimers();
  if (REAL_SYSTEM_ROOT === undefined) {
    delete process.env.SystemRoot;
  } else {
    process.env.SystemRoot = REAL_SYSTEM_ROOT;
  }
  if (REAL_WINDIR === undefined) {
    delete process.env.WINDIR;
  } else {
    process.env.WINDIR = REAL_WINDIR;
  }
  setProcessPlatform(REAL_PLATFORM);
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

// Gate OFF — plain unwrapped spawn

describe("spawnWorker — gate OFF (default)", () => {
  it("waits for relayed stdout after process exit before publishing completion", async () => {
    setProcessPlatform("win32");
    gateActive = true;
    setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: "win32", reason: "Filesystem confinement", confines: { filesystem: true, process: false, network: true } });
    wrapWorkerCommandMock.mockResolvedValueOnce({ argv: ["srt-win.exe", "exec", "--", "cmd.exe"], env: { ...process.env } });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);
    const worker = await spawnWorker({ pluginId: "local-indexer", workerId: "relay-drain", command: "C:/runtime/worker.exe" });
    const peer = await startFakeRelayPeer(child.stdout);
    try {
      await peer.request;
      const events: unknown[] = [];
      worker.onStdout((chunk) => events.push(["stdout", chunk]));
      const completion = new Promise<void>((resolve) => worker.onExit((info) => { events.push(["exit", info]); resolve(); }));
      child.emit("exit", 4, null);
      child.stderr.end();
      expect(events).toEqual([]);
      child.stdout.end("trailing relay output");
      await completion;
      expect(events).toEqual([["stdout", "trailing relay output"], ["exit", { code: 4, signal: null }]]);
      worker.stop();
      expect(child.killCalls).toEqual([]);
    } finally {
      peer.close();
    }
  });

  it("rejects ambiguous path aliases instead of silently normalizing them", async () => {
    await expect(spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed:primary",
      command: "/opt/worker",
    })).rejects.toThrow(/invalid workerId/);
    await expect(spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed?primary",
      command: "/opt/worker",
    })).rejects.toThrow(/invalid workerId/);
    await expect(spawnWorker({
      pluginId: "local-indexer",
      workerId: "Embed",
      command: "/opt/worker",
    })).rejects.toThrow(/invalid workerId/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("plain-spawns the worker UNCHANGED, no wrap, no UDS, socketPath null, reviewer none", async () => {
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions({
      args: ["--serve"],
    }));

    // No wrap, no UDS dir creation.
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    // Plain spawn with the EXACT command + args, shell:false. stdin is piped: it is the host's liveness pipe, the one EOF a worker of a crashed or killed host ever gets.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { shell: boolean; stdio: unknown[] }];
    expect(cmd).toBe("/opt/worker");
    expect(args).toEqual(["--serve"]);
    expect(opts.shell).toBe(false);
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    // Legacy path signal: socketPath null.
    expect(worker.socketPath).toBeNull();
    expect(worker.pid).toBe(4242);
    // Worker NOT marked wrapped → reviewer stays none.
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer");
    expect(cap.kind).toBe("none");
  });

  it("absorbs an 'error' on the worker's stdin so a worker that exits first cannot crash the host", async () => {
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    await spawnWorker(workerOptions());

    // An 'error' with no listener throws out of the emitter — on a real child that is the unhandled event a late EPIPE on the liveness pipe would raise.
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  });
});

// Gate ON (macOS) — wrapped spawn + UDS + reviewer

describe("spawnWorker — control socket path length", () => {
  it("refuses a socket path past the platform limit before creating, registering or spawning anything", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    // A deep account home: the production layout under it cannot hold the socket.
    process.env.AVE_HOME = join(shortAveHome, "a-very-long-account-home-directory-name", ".ave");
    try {
      await expect(spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "/opt/worker",
        args: ["--serve"],
        allowReadPaths: ["/opt/worker"],
        allowWritePaths: ["/data/index"],
        udsArgName: "--uds",
      })).rejects.toThrow(/worker control socket for local-indexer\/embed: socket path is \d+ bytes, over this platform's \d+-byte limit/);
    } finally {
      process.env.AVE_HOME = shortAveHome;
    }
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(registerUdsMock).not.toHaveBeenCalled();
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("spawnWorker — gate ON (macOS)", () => {
  it("registers the socketDir on the shared config, wraps with allowWrite=[socketDir,…] (FS jail only), marks wrapped, socketPath non-null", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec … /opt/worker --serve --uds /sock"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions({
      args: ["--serve"],
      allowReadPaths: ["/opt/worker", "/opt/scripts/embed.py"],
      allowWritePaths: ["/data/index"],
      udsArgName: "--uds",
    }));

    const commandId = (wrapWorkerCommandMock.mock.calls[0]![1] as { commandId: string }).commandId;
    expect(egressInvocationOwner(commandId)).toEqual({ kind: "worker", role: "worker", pluginId: "local-indexer", instanceId: "embed" });
    const socketDir = join(aveHome(), "plugins", "local-indexer", "run", "embed");
    const socketPath = join(socketDir, "control.sock");
    // socketDir created 0o700; stale socket unlinked before mkdir.
    expect(mkdirMock).toHaveBeenCalledWith(socketDir, { recursive: true, mode: 0o700 });
    expect(unlinkSyncMock).toHaveBeenCalledWith(socketPath);

    // The UDS allow is registered on the SHARED config (NOT per-command — that channel is inert in current ASRT).
    expect(registerUdsMock).toHaveBeenCalledWith(socketDir);

    // The per-command wrap carries ONLY the FS jail (socketDir first); there is NO per-command UDS option (allowUnixSocketPath / allowAllUnixSockets).
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead?: string[]; denyWrite?: string[] }; allowUnixSocketPath?: string; allowAllUnixSockets?: boolean },
    ];
    // The confinement primitive prepends the temp directory of the worker's PLUGIN — the one its child and hooks get too — so the socket dir is the first path the CALLER contributed rather than the first in the list.
    const pluginTempDir = `/tmp/ave-test-sandbox-tmp/plugin-${Buffer.from("local-indexer").toString("hex")}`;
    expect(options.filesystem.allowWrite).toContain(socketDir);
    expect(options.filesystem.allowWrite[0]).toBe(pluginTempDir);
    expect(options.filesystem.allowWrite).not.toContain("/tmp/ave-test-sandbox-tmp");
    expect(options.filesystem.denyRead).toContain("/tmp/ave-test-sandbox-tmp");
    expect(cmdline.startsWith(`'/usr/bin/env' 'TMPDIR=${pluginTempDir}' `)).toBe(true);
    expect(options.filesystem.allowWrite).toContain(SANDBOX_HOME);
    expect(options.filesystem.allowRead).toContain(SANDBOX_HOME);
    expect(options.filesystem.allowWrite).toContain("/data/index");
    // A plugin worker is plugin-owned code: its write roots are pinned.
    expect((options.filesystem as { pinWriteRoots?: boolean }).pinWriteRoots).toBe(true);
    // And it reads no plugin's directory but the grants it was given: the plugins root is refused, those grants re-allowed inside it.
    expect((options.filesystem as { denyPluginsRoot?: boolean }).denyPluginsRoot).toBe(true);
    expect(options.filesystem.allowRead).toContain("/opt/worker");
    expect(options.filesystem.allowRead).toContain("/opt/scripts/embed.py");
    expect(options.allowUnixSocketPath).toBeUndefined();
    expect(options.allowAllUnixSockets).toBeUndefined();
    // The host-secret read floor MUST be restated on the worker wrap — a per-command denyRead REPLACES (not unions) the shared boot array in ASRT, so an absent/empty denyRead re-exposes ~/.ave/secrets, ~/.ssh, … to the worker. Non-empty array here proves the floor is carried.
    expect(Array.isArray(options.filesystem.denyRead)).toBe(true);
    expect(options.filesystem.denyRead?.length ?? 0).toBeGreaterThan(0);
    // The sensitive write floor is also restated — a per-command denyWrite REPLACES the shared boot array, so worker/MCP wraps must carry it just as the terminal does.
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");
    expect(options.filesystem.denyWrite).toContain("/home/u/.ssh");
    expect(options.filesystem.denyWrite).toContain("/home/u/.config");
    expect(options.filesystem.denyWrite).toContain("/home/u/Library/LaunchAgents");
    // The udsArgName was injected EXACTLY once (a duplicated injection would feed the worker `--uds <path> --uds <path>` and break its arg contract).
    expect(cmdline).toContain("--uds");
    expect(cmdline).toContain(socketPath);
    expect((cmdline.match(/--uds/g) ?? []).length).toBe(1);

    // Spawn ran the WRAPPED argv, shell:false, stdin piped (the liveness pipe reaches the worker through the wrapper on this path too).
    const [scmd, sargs, sopts] = spawnMock.mock.calls[0] as [string, string[], { shell: boolean; stdio: unknown[] }];
    expect(scmd).toBe("/bin/bash");
    expect(sargs[0]).toBe("-c");
    expect(sopts.shell).toBe(false);
    expect(sopts.stdio).toEqual(["pipe", "pipe", "pipe"]);

    // Non-null socketPath + reviewer reports genuine asrt for the plugin tool.
    expect(worker.socketPath).toBe(socketPath);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer");
    expect(cap.kind).toBe("asrt");
    expect(cap.reason).toContain("plugin worker 'local-indexer/embed' ASRT-wrapped");
    worker.stop();
    expect(egressInvocationOwner(commandId)).toBeDefined();
    child.emit("exit", 0, null);
    expect(egressInvocationOwner(commandId)).toBeUndefined();
  });

  it("injects the UDS path via env when udsArgName is the env form", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    let capturedEnv: NodeJS.ProcessEnv = {};
    spawnMock.mockImplementationOnce((_c, _a, opts) => {
      capturedEnv = (opts as { env: NodeJS.ProcessEnv }).env;
      return new StubWorkerChild();
    });

    await spawnWorker(workerOptions({
      udsArgName: { env: "AVE_CONTROL_SOCKET" },
    }));

    const socketPath = join(aveHome(), "plugins", "local-indexer", "run", "embed", "control.sock");
    expect(capturedEnv.AVE_CONTROL_SOCKET).toBe(socketPath);
    expect(capturedEnv.HOME).toBe(SANDBOX_HOME);
  });
});

// Gate ON (linux) — registers the socketDir; FS-jail-only wrap

describe("spawnWorker — a symlinked control dir", () => {
  // `chmod` follows a link, so the refusal must come before the mode is forced: the other order would change the mode of whatever the link points at.
  it("refuses it before forcing any mode, so the host never chmods a link target", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    chmodSyncMock.mockClear();
    lstatSyncMock.mockImplementationOnce(() => ({ isSymbolicLink: () => true }));
    await expect(spawnWorker(workerOptions()))
      .rejects.toThrow(/refusing symlinked control dir/);
    expect(chmodSyncMock).not.toHaveBeenCalled();
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });
});

describe("spawnWorker — gate ON (linux)", () => {
  it("does not report plugin workers stopped until their process exits", async () => {
    setProcessPlatform("linux");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({ argv: ["/bin/bash", "-c", "wrapped"], env: { ...process.env } });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);
    const worker = await spawnWorker({ pluginId: "sandbox-candidate", workerId: "index", command: "/opt/worker" });
    let completed = false;
    const waiting = waitForPluginWorkersStopped("sandbox-candidate").then(() => { completed = true; });
    worker.stop();
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit("exit", 0, null);
    await waiting;
    expect(completed).toBe(true);
  });

  it("registers the socketDir on the shared config and wraps with the FS jail only (no per-command UDS option)", async () => {
    setProcessPlatform("linux");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(new StubWorkerChild());

    await spawnWorker(workerOptions());

    const socketDir = join(aveHome(), "plugins", "local-indexer", "run", "embed");
    // Platform-uniform: the socketDir is registered on the shared config (the linux allowAllUnixSockets weakening is applied inside asrt-sandbox's withWorkerUnixSockets, asserted in the asrt-sandbox unit tests).
    expect(registerUdsMock).toHaveBeenCalledWith(socketDir);
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { allowUnixSocketPath?: string; allowAllUnixSockets?: boolean },
    ];
    expect(options.allowUnixSocketPath).toBeUndefined();
    expect(options.allowAllUnixSockets).toBeUndefined();
  });
});

// Idempotent any-exit cleanup

describe("spawnWorker — idempotent any-exit cleanup", () => {
  it("unmarks the worker + cleans up ONCE on child exit, then reviewer is none", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions());
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);

    const socketDir = join(aveHome(), "plugins", "local-indexer", "run", "embed");
    // Child dies unexpectedly → exit fires cleanup.
    child.emit("exit", 1, null);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    // The shared-config UDS allow is released exactly once.
    expect(unregisterUdsMock).toHaveBeenCalledTimes(1);
    expect(unregisterUdsMock).toHaveBeenCalledWith(socketDir);
    // Reviewer falls back to none (no stale asrt) after the worker is gone.
    expect(resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer").kind).toBe("none");

    // stop after exit must NOT double-run cleanup.
    worker.stop();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(unregisterUdsMock).toHaveBeenCalledTimes(1);
  });

  it("stop() retains confinement and HOME ownership until exit", async () => {
    setProcessPlatform("linux");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions());

    worker.stop();
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    expect(sandboxHomeCleanupMock).not.toHaveBeenCalled();

    child.emit("exit", 0, "SIGTERM");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("onExit forwards the child's exit (code + signal) to the consumer", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions());

    // The consumer owns lifecycle via the handle — onExit is how it learns the worker died (a crash with no onExit would leave the consumer's state stuck).
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    worker.onExit((info) => exits.push(info));
    child.emit("exit", 3, null);
    child.stdout.emit("end");
    child.stderr.emit("end");
    expect(exits).toEqual([{ code: 3, signal: null }]);
  });

  it("replays output and exit that happened before the consumer subscribed", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions());
    child.stdout.write("already written");
    child.stderr.write("already warned");
    child.emit("exit", 7, null);
    child.emit("exit", 8, null);
    child.stdout.emit("end");
    child.stderr.emit("end");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    worker.onStdout((chunk) => stdout.push(chunk));
    worker.onStderr((chunk) => stderr.push(chunk));
    worker.onExit((info) => exits.push(info));
    expect(stdout).toEqual(["already written"]);
    expect(stderr).toEqual(["already warned"]);
    expect(exits).toEqual([{ code: 7, signal: null }]);
  });

  it("drains trailing output after process exit before publishing completion", async () => {
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);
    const worker = await spawnWorker({ pluginId: "local-indexer", workerId: "drain", command: "/opt/worker" });
    const events: unknown[] = [];
    worker.onStdout((chunk) => events.push(["stdout", chunk]));
    worker.onStderr((chunk) => events.push(["stderr", chunk]));
    worker.onExit((info) => events.push(["exit", info]));
    child.emit("exit", 7, null);
    worker.stop();
    expect(child.killCalls).toEqual([]);
    expect(events).toEqual([]);
    child.stdout.write("trailing output");
    child.stderr.write("trailing warning");
    child.stdout.end();
    await new Promise<void>((resolve) => child.stdout.once("end", resolve));
    expect(events).toEqual([["stdout", "trailing output"], ["stderr", "trailing warning"]]);
    const stderrEnded = new Promise<void>((resolve) => child.stderr.once("end", resolve));
    child.stderr.end();
    await stderrEnded;
    expect(events).toEqual([["stdout", "trailing output"], ["stderr", "trailing warning"], ["exit", { code: 7, signal: null }]]);
    const late = vi.fn();
    worker.onExit(late);
    expect(late).toHaveBeenCalledExactlyOnceWith({ code: 7, signal: null });
  });

  it("stops and clears both output queues when a replay listener throws", async () => {
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);
    const worker = await spawnWorker({ pluginId: "local-indexer", workerId: "replay", command: "/opt/worker" });
    child.stdout.write("first");
    child.stdout.write("second");
    child.stderr.write("warning");
    const failure = new Error("listener failed");
    const listener = vi.fn(() => { throw failure; });
    expect(() => worker.onStdout(listener)).toThrow(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(child.killCalls).toHaveLength(1);
    expect(() => worker.onStderr(() => {})).toThrow(failure);
    child.stdout.write("late");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, 0, ""])("retains a falsy replay failure (%s)", async (failure) => {
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);
    const worker = await spawnWorker({ pluginId: "local-indexer", workerId: "falsy-replay", command: "/opt/worker" });
    child.stdout.write("captured");
    const caught = (run: () => void) => {
      try {
        run();
        return { thrown: false };
      } catch (error) {
        return { thrown: true, error };
      }
    };
    expect(caught(() => worker.onStdout(() => { throw failure; }))).toEqual({ thrown: true, error: failure });
    child.stderr.write("late");
    expect(caught(() => worker.onStderr(() => {}))).toEqual({ thrown: true, error: failure });
    expect(child.killCalls).toHaveLength(1);
  });

  it.each([
    ["bytes", () => [Buffer.alloc(1024 * 1024 + 1, 0x61)]],
    ["events", () => Array.from({ length: 257 }, () => Buffer.from("x"))],
  ])("refuses a pre-listener stdout backlog past the %s bound", async (_name, chunks) => {
    setProcessPlatform("darwin");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    const worker = await spawnWorker(workerOptions());
    for (const chunk of chunks()) child.stdout.write(chunk);

    expect(() => worker.onStdout(() => {})).toThrow(/pre-listener buffer/);
    expect(child.killCalls).toHaveLength(1);
  });

  it("keeps a live worker confined when a process operation emits error", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    const child = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(child);

    await spawnWorker(workerOptions());

    child.emit("error", new Error("kill failed"));
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).not.toHaveBeenCalled();

    child.emit("close", null, null);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a same-key replacement until the old wrapped worker exits", async () => {
    setProcessPlatform("darwin");
    gateActive = true;
    wrapWorkerCommandMock
      .mockResolvedValueOnce({ argv: ["/bin/bash", "-c", "old"], env: { ...process.env } })
      .mockResolvedValueOnce({ argv: ["/bin/bash", "-c", "replacement"], env: { ...process.env } });
    const oldChild = new StubWorkerChild();
    const replacementChild = new StubWorkerChild();
    spawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(replacementChild);
    const spec = workerOptions();

    const oldWorker = await spawnWorker(spec);
    oldWorker.stop();
    await expect(spawnWorker(spec)).rejects.toThrow(/already running or stopping/);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    oldChild.emit("exit", 0, "SIGTERM");
    const replacement = await spawnWorker(spec);
    expect(replacement.pid).toBe(replacementChild.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    replacementChild.emit("exit", 0, null);
  });
});

// Windows + gate ON → holder ACL grant + srt-win wrapped TCP ─

describe("spawnWorker — Windows with gate ON", () => {
  it("wraps the worker with a dedicated holder PID ACL grant and keeps TCP control", async () => {
    setProcessPlatform("win32");
    gateActive = true;
    const restoreEnv = setEnvForTest({
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      TEMP: "C:\\Users\\test\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\test\\AppData\\Local\\Temp",
      ANTHROPIC_API_KEY: "sk-should-not-reach-worker",
      AVE_INTERNAL_SECRET: "ave-should-not-reach-worker",
    });
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-Command", "wrapped"],
      env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:60080" },
    });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);

    const pluginDataDir = join(aveHome(), "plugins", "local-indexer", "data");
    const indexDir = join(pluginDataDir, "index");
    const workerScript = "C:/ave/local-indexer/dist/worker/local_indexer_worker.py";
    const pythonExecutable = "C:/Python/python.exe";
    const worker = await (async () => {
      try {
        return await spawnWorker({
          pluginId: "local-indexer",
          workerId: "embed",
          command: pythonExecutable,
          args: [workerScript, "--host", "127.0.0.1", "--port", "17037"],
          allowReadPaths: [pythonExecutable, workerScript],
          allowWritePaths: [indexDir],
          udsArgName: "--uds",
        });
      } finally {
        restoreEnv();
      }
    })();

    expect(mkdirMock).not.toHaveBeenCalled();
    expect(registerUdsMock).not.toHaveBeenCalled();
    expect(unregisterUdsMock).not.toHaveBeenCalled();
    expect(grantWindowsWorkerFilesystemAccessMock).toHaveBeenCalledWith({
      holderPid: 5101,
      allowRead: [SANDBOX_HOME, pythonExecutable, workerScript],
      allowWrite: [SANDBOX_HOME, indexDir],
    });

    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowRead?: string[]; allowWrite?: string[]; denyRead?: string[]; denyWrite?: string[] }; binShell?: string },
    ];
    // The worker runs through the stdio relay: the line srt-win runs is the host's own runtime in relay mode, and nothing of the worker's is on it.
    expect(cmdline).toBe(
      `set "ELECTRON_RUN_AS_NODE=1"&& "${process.execPath}" "--preserve-symlinks" "--preserve-symlinks-main" `
        + `"${resolvePluginChildEntryPath()}" "--ave-child-transport=relay"`,
    );
    expect(cmdline).not.toContain("python");
    expect(options.binShell).toEqual({ exe: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/v:off", "/s", "/c"] });
    expect(options.filesystem.allowRead).toBeUndefined();
    expect(options.filesystem.allowWrite).toBeUndefined();
    // No plugins-root deny on Windows: there it would be an ACE for the one account every confined process runs as.
    expect((options.filesystem as { denyPluginsRoot?: boolean }).denyPluginsRoot).toBeUndefined();
    expect(options.filesystem.denyRead).toContain("/home/u/.ave/secrets");
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [holderCmd, holderArgs, holderOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv; shell: boolean; stdio: unknown[] },
    ];
    expect(holderCmd).toBe("C:\\Windows\\System32\\more.com");
    expect(holderArgs).toEqual([]);
    expect(holderOpts.cwd).toBe("C:\\Windows\\System32");
    expect(holderOpts.env?.PATH).toBeUndefined();
    expect(holderOpts.shell).toBe(false);
    expect(holderOpts.stdio).toEqual(["pipe", "ignore", "ignore"]);
    const [workerCmd, workerArgs, workerOpts] = spawnMock.mock.calls[1] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv; shell: boolean; stdio: unknown[] },
    ];
    expect(workerCmd).toBe("srt-win.exe");
    expect(workerArgs[0]).toBe("exec");
    expect(workerOpts.env?.SystemRoot).toBe("C:\\Windows");
    expect(workerOpts.env?.WINDIR).toBe("C:\\Windows");
    expect(workerOpts.env?.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(workerOpts.env?.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(workerOpts.env?.HOME).toBe(SANDBOX_HOME);
    expect(workerOpts.env?.USERPROFILE).toBe(SANDBOX_HOME);
    expect(workerOpts.env?.LOCALAPPDATA).toBe(`${SANDBOX_HOME}/AppData/Local`);
    expect(workerOpts.env?.TEMP).toBe("C:\\Users\\test\\AppData\\Local\\Temp");
    expect(workerOpts.env?.TMP).toBe("C:\\Users\\test\\AppData\\Local\\Temp");
    expect(workerOpts.env?.HTTPS_PROXY).toBe("http://127.0.0.1:60080");
    expect(workerOpts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(workerOpts.env?.AVE_INTERNAL_SECRET).toBeUndefined();
    expect(workerOpts.shell).toBe(false);
    expect(workerOpts.stdio).toEqual(["pipe", "pipe", "pipe"]);

    // The worker's program, arguments and environment travel in the relay request; its stdout comes back through the relay; its stdin — the liveness pipe — is held open and never ended by the host.
    const peer = await startFakeRelayPeer(child.stdout);
    const request = await peer.request;
    expect(request.command).toBe(pythonExecutable);
    expect(request.args).toEqual([workerScript, "--host", "127.0.0.1", "--port", "17037"]);
    const relayedEnv = request.env as Record<string, string>;
    expect(relayedEnv.HOME).toBe(SANDBOX_HOME);
    expect(relayedEnv.USERPROFILE).toBe(SANDBOX_HOME);
    expect(relayedEnv.NODE_OPTIONS).toBe("--preserve-symlinks --preserve-symlinks-main");
    expect(relayedEnv.PATH).toBeUndefined();
    expect(relayedEnv.PATHEXT).toBeUndefined();
    expect(relayedEnv.HTTPS_PROXY).toBeUndefined();
    expect(relayedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(relayedEnv.AVE_INTERNAL_SECRET).toBeUndefined();
    const out: string[] = [];
    worker.onStdout((text) => out.push(text));
    child.stdout.write("worker says hi\n");
    await vi.waitFor(() => expect(out.join("")).toBe("worker says hi\n"));
    let inputEnded = false;
    void peer.inputEnded.then(() => {
      inputEnded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputEnded).toBe(false);
    peer.close();

    expect(worker.socketPath).toBeNull();
    expect(worker.pid).toBe(5102);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed", "local-indexer");
    expect(cap.kind).toBe("asrt");

    worker.stop();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(grantReleaseMock).not.toHaveBeenCalled();
    expect(holder.killed).toBe(false);
    expect(child.killCalls).toEqual(["SIGTERM"]);

    child.emit("exit", 0, "SIGTERM");
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(holder.killed).toBe(true);
    const workerKillCalls = child.killCalls.length;
    holder.emit("exit", 0, "SIGTERM");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(child.killCalls).toHaveLength(workerKillCalls);
  });

  it("terminates the Windows worker and releases grants when the holder exits first", async () => {
    vi.useFakeTimers();
    setProcessPlatform("win32");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-Command", "wrapped"],
      env: { ...process.env },
    });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);

    await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "C:/Python/python.exe",
      args: ["C:/worker.py"],
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index"],
    });

    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    holder.emit("exit", 1, null);

    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(grantReleaseMock).not.toHaveBeenCalled();
    expect(child.killed).toBe(true);
    expect(child.killCalls).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(3_000);
    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);

    child.emit("exit", 0, null);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("aborts Windows worker spawn if the holder exits during grant setup", async () => {
    setProcessPlatform("win32");
    gateActive = true;
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    spawnMock.mockReturnValueOnce(holder);
    grantWindowsWorkerFilesystemAccessMock.mockImplementationOnce(async () => {
      holder.emit("exit", 1, null);
      return {
        allowRead: [],
        allowWrite: [],
        release: grantReleaseMock,
      };
    });

    await expect(
      spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "C:/Python/python.exe",
        args: ["C:/worker.py"],
        allowReadPaths: ["C:/worker.py"],
        allowWritePaths: ["C:/index"],
      }),
    ).rejects.toThrow(/Windows ACL grant holder exited/);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
  });

  it("consumes the Windows holder spawn error when no holder pid is published", async () => {
    setProcessPlatform("win32");
    gateActive = true;
    const holder = new StubWorkerChild();
    (holder as unknown as { pid?: number }).pid = undefined;
    spawnMock.mockReturnValueOnce(holder);

    await expect(
      spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "C:/Python/python.exe",
        args: ["C:/worker.py"],
      }),
    ).rejects.toThrow(/Windows ACL grant holder started without a pid/);

    expect(holder.listenerCount("error")).toBeGreaterThan(0);
    expect(() => holder.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    expect(grantWindowsWorkerFilesystemAccessMock).not.toHaveBeenCalled();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
  });

  it("continues Windows cleanup when grant release throws", async () => {
    setProcessPlatform("win32");
    gateActive = true;
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    grantReleaseMock.mockImplementationOnce(() => {
      throw new Error("already revoked");
    });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-Command", "wrapped"],
      env: { ...process.env },
    });
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    const child = new StubWorkerChild();
    child.pid = 5102;
    spawnMock.mockReturnValueOnce(holder).mockReturnValueOnce(child);

    const worker = await spawnWorker({
      pluginId: "local-indexer",
      workerId: "embed",
      command: "C:/Python/python.exe",
      args: ["C:/worker.py"],
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index"],
    });

    expect(() => worker.stop()).not.toThrow();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(true);
    expect(holder.killed).toBe(false);
    child.emit("exit", 0, "SIGTERM");
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
    expect(holder.killed).toBe(true);
  });

  it("rolls back the holder grant when the Windows wrap fails", async () => {
    setProcessPlatform("win32");
    gateActive = true;
    const holder = new StubWorkerChild();
    holder.pid = 5101;
    spawnMock.mockReturnValueOnce(holder);
    wrapWorkerCommandMock.mockRejectedValueOnce(new Error("wrap failed"));

    await expect(
      spawnWorker({
        pluginId: "local-indexer",
        workerId: "embed",
        command: "C:/Python/python.exe",
        args: ["C:/worker.py"],
        allowReadPaths: ["C:/worker.py"],
        allowWritePaths: ["C:/index"],
      }),
    ).rejects.toThrow(/wrap failed/);

    expect(grantReleaseMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(registerUdsMock).not.toHaveBeenCalled();
    expect(isPluginWorkerWrapped("local-indexer", "embed")).toBe(false);
  });
});
