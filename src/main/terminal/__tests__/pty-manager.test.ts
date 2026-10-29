vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { spawnTerminal as spawnLane, writeTerminal as writeLane, ensureConversationTerminal, conversationTerminalRef, releaseConversationTerminals, endConversationTerminalSession, typeAgentTerminalCommand, terminalTabOwnerWindow, terminalOwnedBy as rendererOwnsTerminal } from "../pty-manager.js";
import { spawnTerminal, writeTerminal, resizeTerminal, typeTerminalCommand, verifyTerminalShell, getTerminalBlockTracker, killTerminal, conversationOwnedBy as terminalOwnedBy } from "../../../__tests__/support/terminal-agent-fixture.js";
/** Check terminal confinement wiring with mocked runtime and PTY boundaries, including fail-closed spawn and cleanup.
 * These tests do not exercise native isolation or real PTY allocation. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalTtyHandoff } from "../terminal-tty-handoff.js";
import { terminalSandboxWindowNotice } from "../terminal-sandbox-policy.js";
import { t } from "../../../i18n/index.js";
import type { SandboxCleanupOutcome, SandboxWrapResult } from "../../../permissions/asrt-sandbox.js";
import type { SandboxGitControlSnapshot } from "../../../permissions/sandbox-write-policy.js";
import { egressInvocationAbortSignal, egressInvocationOwner } from "../../../permissions/egress-invocations.js";
import { setAgentTerminalObservationSink, type AgentTerminalObservationInput } from "../../../tools/agent-terminal-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../../tools/agent-observation-context.js";
import { runWithInvocationOrigin } from "../../../plugins/runtime/origin-chain.js";
import { ObservationDaemon } from "../../../observation/daemon.js";
import { ApprovalGate, type ApprovalRequest } from "../../../permissions/approval-gate.js";
import { approvalSurfaceRegistry, updateApprovalSurface } from "../../../permissions/approval-surface-registry.js";
import * as approvalSurfaces from "../../../permissions/approval-surface-registry.js";
import { sentApprovalCards } from "../../../__tests__/test-helpers.js";
import { TerminalObservationAdapter } from "../../../observation/terminal-adapter.js";
import type { TerminalObservedCommand, TerminalObservationEvent } from "../../../shared/agent-observation.js";

let gateActive = true;
const nativePlatform = process.platform;
let additionalProjectDirectories: string[] = [];
let addedGitControlPath: string | undefined;
function emptyGitSnapshot(): SandboxGitControlSnapshot {
  return { roots: new Map(), entries: new Map(), markers: new Map(), stores: new Map(), markerStores: new Map(),
    replacedMarkers: new Set(), directories: new Map(), directoryTargets: new Map(), storeMissingAncestors: new Map(), bareRoots: new Set() };
}
vi.mock("../../../permissions/sandbox-write-policy.js", () => ({
  buildMandatorySandboxWritePolicy: (roots: readonly string[]) => ({
    allowWrite: [...roots],
    denyWrite: addedGitControlPath === undefined ? [] : [addedGitControlPath],
  }),
  snapshotSandboxGitControls: () => ({
    ...emptyGitSnapshot(),
    entries: new Map(addedGitControlPath === undefined ? [] : [[addedGitControlPath,
      { dev: 1, ino: 2, size: 0, mtimeMs: 0, ctimeMs: 0, kind: "file" as const }]]),
  }),
}));
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<SandboxWrapResult>
>(() => Promise.resolve({ argv: ["sandbox-exec", "-p", "prof", "/bin/bash", "-c", "exec /bin/zsh -l -i"], env: {} }));
const wrapTerminalCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<SandboxWrapResult>
>(() => Promise.resolve({ argv: ["/bin/bash", "-c", "sandbox-exec -p prof /bin/zsh -l -i"], env: { HTTP_PROXY: "http://p" } }));
const cleanupMock = vi.fn(() => Promise.resolve());
function withFilesystemPolicy(wrapped: SandboxWrapResult, options: unknown): SandboxWrapResult {
  const filesystem = (options as { filesystem?: { allowWrite: string[] } } | undefined)?.filesystem;
  return { filesystemPolicy: { allowWrite: filesystem?.allowWrite ?? [], denyWrite: [] }, gitControlSnapshot: emptyGitSnapshot(), ...wrapped };
}
vi.mock("../../../permissions/asrt-sandbox.js", async () => ({
  sandboxTempEnvLaunch: (await vi.importActual<typeof import("../../../permissions/asrt-sandbox.js")>(
    "../../../permissions/asrt-sandbox.js",
  )).sandboxTempEnvLaunch,
  isAsrtSandboxActive: () => gateActive,
  isShellSandboxActive: () => gateActive,
  wrapWorkerCommand: async (command: string, options?: unknown) => withFilesystemPolicy(await wrapWorkerCommandMock(command, options), options),
  wrapTerminalCommand: async (command: string, options?: unknown) => withFilesystemPolicy(await wrapTerminalCommandMock(command, options), options),
  cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
  getDefaultSensitiveReadDenyPaths: () => ["/home/u/.ave/secrets", "/home/u/.ssh"],
  getDefaultSensitiveWriteDenyPaths: () => [
    "/home/u/.ave/secrets",
    "/home/u/.ssh",
    "/home/u/.zshrc",
    "/home/u/.config",
    "/home/u/Library/LaunchAgents",
  ],
}));

// The real project resolver consumes this host-owned permission-store fixture.
vi.mock("../../../permissions/permission-settings-store.js", async () => ({
  ...await vi.importActual<typeof import("../../../permissions/permission-settings-store.js")>("../../../permissions/permission-settings-store.js"),
  readPermissionSettings: () => ({ permissions: { additionalDirectories: additionalProjectDirectories } }),
}));
vi.mock("../../../workload/runtime.js", () => ({
  isWorkloadBrokerActive: () => false,
  getActiveWorkloadBrokerProjection: () => undefined,
  isActiveWorkloadBrokerCwd: () => false,
}));

let needsOwnTtyGrant = false;
const deliverMock = vi.fn<(script: string, options?: { signal?: AbortSignal }) => Promise<void>>(() =>
  Promise.resolve(),
);
const handoffDisposeMock = vi.fn();
function terminalHandoff(): TerminalTtyHandoff {
  return {
    trampoline: { file: "/bin/sh", args: ["/handoff/t-1/exec"] },
    deliver: (script, options) => deliverMock(script, options),
    dispose: () => handoffDisposeMock(),
  };
}
const createHandoffMock = vi.fn<() => Promise<TerminalTtyHandoff>>(() => Promise.resolve(terminalHandoff()));
let needsInnerPty = false;
vi.mock("../terminal-tty-platform.js", () => ({
  terminalNeedsOwnTtyGrant: () => needsOwnTtyGrant,
  terminalNeedsInnerPty: () => needsInnerPty,
}));
vi.mock("../terminal-tty-handoff.js", async () => {
  const actual = await vi.importActual<typeof import("../terminal-tty-handoff.js")>("../terminal-tty-handoff.js");
  return {
    ...actual,
    createTerminalTtyHandoff: () => createHandoffMock(),
  };
});

let shellContained = true;
let sandboxGeneration = "0";
vi.mock("../../../permissions/sandbox-capability.js", () => ({
  isActiveSandboxShellContained: () => shellContained,
  getSandboxGeneration: () => sandboxGeneration,
}));

vi.mock("../../../permissions/sandbox-write-jail.js", () => ({
  deriveSandboxWritePaths: (input: { allowedDirectories: readonly string[] }) => [...input.allowedDirectories],
}));

vi.mock("../../../tools/safe-env.js", () => ({
  buildHostShellChildEnv: () => ({ HOME: process.env.HOME ?? "", PATH: "/usr/bin" }),
  buildSandboxedChildEnv: (env: NodeJS.ProcessEnv, extra: Record<string, string> = {}) => ({
    ...env,
    PATH: "/usr/bin",
    ...extra,
  }),
}));

// Real directories, one per terminal, under a parent made per test: the terminal creates its temp directory inside its HOME.
let homeParent = "";
let createdHomes: string[] = [];
const sandboxHomeCleanupMock = vi.fn();
vi.mock("../../../permissions/sandbox-process-home.js", () => ({
  createSandboxProcessHome: () => {
    const path = mkdtempSync(join(homeParent, "home-"));
    createdHomes.push(path);
    return {
      path,
      env: { HOME: path, XDG_CONFIG_HOME: `${path}/config` },
      cleanup: sandboxHomeCleanupMock,
    };
  },
}));

vi.mock("../../../lib/shell-resolver.js", () => ({
  shellQuote: (s: string) => s,
}));

type DataCb = (chunk: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;
class FakePty {
  pid = 9999;
  /** What a test's fake shell does with each write (e.g. redraw its prompt on Ctrl-C). */
  respond: ((data: string) => void) | null = null;
  ptsName: unknown = "/dev/ttys012";
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  killSignals: Array<string | undefined> = [];
  private dataCb: DataCb | null = null;
  private exitCbs = new Set<ExitCb>();
  onData(cb: DataCb) {
    this.dataCb = cb;
    return { dispose: () => { this.dataCb = null; } };
  }
  onExit(cb: ExitCb) {
    this.exitCbs.add(cb);
    return { dispose: () => { this.exitCbs.delete(cb); } };
  }
  write(d: string) {
    this.written.push(d);
    this.respond?.(d);
  }
  resize(c: number, r: number) { this.resized.push([c, r]); }
  kill(signal?: string) {
    this.killed = true;
    this.killSignals.push(signal);
  }
  emitData(chunk: string) { this.dataCb?.(chunk); }
  emitExit(exitCode: number) { for (const cb of [...this.exitCbs]) cb({ exitCode }); }
}
let lastPty: FakePty | null = null;
let spawnedPtys: FakePty[] = [];
const ptySpawnMock = vi.fn<(cmd: string, args: string[], opts: unknown) => FakePty>(() => {
  lastPty = new FakePty();
  spawnedPtys.push(lastPty);
  return lastPty;
});
/** What the operating system reports as the terminal's foreground process. */
let foregroundReading: import("../shell-process.js").TerminalForegroundReading = {
  ok: true,
  foreground: { pid: 9999, command: "zsh", cwd: "/w" },
};
const readForegroundMock = vi.fn(async (_ptyPid: number, _options?: import("../shell-process.js").TerminalForegroundOptions) => foregroundReading);
/** Linux: what the operating system reports about the sandboxed shell. */
let sandboxedShellReading: import("../shell-process.js").SandboxedShellReading = { ok: false, reason: "not set" };
const readSandboxedShellMock = vi.fn(async (_ptyPid: number, _shellName: string, _reportedCwd: string, _options?: import("../shell-process.js").TerminalForegroundOptions) => sandboxedShellReading);
const forwardResizeMock = vi.fn(async (_ptyPid: number, _shellName: string) => true);
vi.mock("../shell-process.js", () => ({
  readTerminalForeground: (ptyPid: number, options?: import("../shell-process.js").TerminalForegroundOptions) => readForegroundMock(ptyPid, options),
  readSandboxedShell: (ptyPid: number, shellName: string, reportedCwd: string, options?: import("../shell-process.js").TerminalForegroundOptions) =>
    readSandboxedShellMock(ptyPid, shellName, reportedCwd, options),
  forwardResizeToSandboxedPtyRelay: (ptyPid: number, shellName: string) => forwardResizeMock(ptyPid, shellName),
}));

const assertRelayMock = vi.fn(() => Promise.resolve());
vi.mock("../terminal-inner-pty.js", async () => {
  const actual = await vi.importActual<typeof import("../terminal-inner-pty.js")>("../terminal-inner-pty.js");
  return { ...actual, assertInnerPtyRelay: () => assertRelayMock() };
});

vi.mock("node-pty", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => ptySpawnMock(cmd, args, opts),
}));

// Module under test; imported AFTER mocks.
import {
  killTerminal as killHostTerminal,
  terminalOwnerWindowId,
  killAllTerminals,
  killTerminalsOwnedBy,
  forceKillAllTerminalsForShutdown,
  setTerminalEmitter,
  _setTerminalInspectionForTest,
  _conversationTerminalOwnerForTest,
  sandboxedShellVerdict,
  __resetTerminalsForTest,
  __terminalSessionCountForTest,
  type TerminalEmit,
} from "../pty-manager.js";
// REAL canonicalizer (NOT mocked); the module resolves the default terminal cwd to
// `canonicalizePathForMatch(process.cwd())` (the workspace-root anchor) and validates a renderer-supplied cwd against it, so the test computes the same.
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";
import { USER_INPUT_QUIET_MS, getWindowTerminalBlockTracker, listTerminalBlockTabs } from "../terminal-blocks.js";
import { SHELL_INTEGRATION_NONCE_FILE, TERMINAL_EDIT_LINE_QUERY } from "../shell-integration.js";

/** The marker nonce a spawned terminal's startup file would read: the file in its sandbox
 * HOME (no shell runs here, so nothing deleted it). It is never in the shell's environment. */
function spawnedNonce(env: Record<string, string>): string {
  expect(Object.keys(env).some((key) => /NONCE/u.test(key))).toBe(false);
  return readFileSync(join(env.ZDOTDIR ?? env.HOME!, SHELL_INTEGRATION_NONCE_FILE), "utf-8");
}

/** The workspace root the module anchors the write-jail to by default, in the canonical form of the
 * platform the cases run as. On a Windows host that is the simulated Linux, which does not fold the drive letter. */
const ROOT = (() => {
  if (nativePlatform !== "win32") return canonicalizePathForMatch(process.cwd());
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return canonicalizePathForMatch(process.cwd());
  } finally {
    Object.defineProperty(process, "platform", { value: nativePlatform, configurable: true });
  }
})();

/** The bits a 0o700 mkdir leaves. Windows keeps no POSIX mode, so Node reports 0o666 for the directory
 * there; the real Windows agent lane refuses before it makes a HOME (see the native Windows case below). */
const OWNER_ONLY_DIR_MODE = nativePlatform === "win32" ? 0o666 : 0o700;

let emitted: Array<{ event: string; payload: unknown }> = [];
/** The window each emitted event was addressed to, index for index with `emitted`. */
let emittedOwners: Array<number | null> = [];
const emit: TerminalEmit = (event, payload, ownerWindowId) => {
  emitted.push({ event, payload });
  emittedOwners.push(ownerWindowId);
};

beforeEach(() => {
  // Fake wrapped PTYs exercise the supported backend on every CI host.
  if (nativePlatform === "win32") Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  gateActive = true;
  additionalProjectDirectories = [];
  addedGitControlPath = undefined;
  shellContained = true;
  sandboxGeneration = "0";
  emitted = [];
  emittedOwners = [];
  lastPty = null;
  spawnedPtys = [];
  wrapWorkerCommandMock.mockClear();
  wrapTerminalCommandMock.mockClear();
  needsOwnTtyGrant = false;
  needsInnerPty = false;
  assertRelayMock.mockReset();
  assertRelayMock.mockImplementation(() => Promise.resolve());
  readSandboxedShellMock.mockClear();
  forwardResizeMock.mockReset();
  forwardResizeMock.mockImplementation(async () => true);
  deliverMock.mockReset();
  deliverMock.mockImplementation(() => Promise.resolve());
  handoffDisposeMock.mockClear();
  createHandoffMock.mockReset();
  createHandoffMock.mockImplementation(() => Promise.resolve(terminalHandoff()));
  cleanupMock.mockClear();
  sandboxHomeCleanupMock.mockClear();
  ptySpawnMock.mockClear();
  homeParent = mkdtempSync(join(tmpdir(), "ave-pty-home-"));
  createdHomes = [];
  __resetTerminalsForTest();
  setTerminalEmitter(emit);
});
afterEach(() => {
  setAgentTerminalObservationSink(undefined);
  __resetTerminalsForTest();
  rmSync(homeParent, { recursive: true, force: true });
  if (nativePlatform === "win32") Object.defineProperty(process, "platform", { value: nativePlatform, configurable: true });
});

describe("pty-manager fail-closed", () => {
  it("refuses to spawn when the gate is inactive", async () => {
    gateActive = false;
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-shell-contained");
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("refuses to spawn when the sandbox is not shell-contained (e.g. Windows fs+network partial)", async () => {
    shellContained = false;
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-shell-contained");
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a terminal tab id, before anything reaches a shell", async () => {
    for (const tabId of ["terminal:1", "browser:0000000a-1", "terminal:0000000a-1; rm -rf /", "terminal:ZZZZZZZZ-1"]) {
      const res = await spawnTerminal({ tabId });
      expect(res).toEqual({ ok: false, reason: "bad-request", message: "tabId is not a terminal tab id" });
    }
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("rejects an empty tabId", async () => {
    const res = await spawnTerminal({ tabId: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-request");
  });
});

describe("pty-manager happy path (fs-contained)", () => {
  it("retains its invocation identity while closing and cancels pending network approval", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    const token = (wrapWorkerCommandMock.mock.calls[0]![1] as { commandId: string }).commandId;
    expect(egressInvocationOwner(token)).toEqual({ kind: "terminal", tabId: "terminal:0000000a-1", sessionId: "terminal:0000000a-1" });
    expect(wrapWorkerCommandMock.mock.calls[0]![1]).toMatchObject({ denyUnixSockets: true });
    const signal = egressInvocationAbortSignal(token);
    expect(signal?.aborted).toBe(false);
    killTerminal("terminal:0000000a-1");
    expect(signal?.aborted).toBe(true);
    expect(egressInvocationOwner(token)).toBeDefined();
    lastPty?.emitExit(0);
    expect(egressInvocationOwner(token)).toBeUndefined();
  });

  it("wraps with the restated read+write sensitive floors + a workspace-anchored cwd jail and spawns the wrapped argv", async () => {
    // No cwd supplied (the production renderer path) → default = workspace root.
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1", cols: 120, rows: 40 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replayed).toBe(false);

    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[]; denyWrite: string[] } },
    ];
    // denyRead floor is RESTATED (per-command denyRead REPLACES the ASRT boot array).
    expect(options.filesystem.denyRead).toContain("/home/u/.ave/secrets");
    expect(options.filesystem.denyRead).toContain("/home/u/.ssh");
    // denyWrite FLOOR is RESTATED (per-command denyWrite REPLACES the boot array); shell-rc / ~/.ssh / ~/.config / LaunchAgents persistence vectors are denied.
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");
    expect(options.filesystem.denyWrite).toContain("/home/u/.ssh");
    expect(options.filesystem.denyWrite).toContain("/home/u/.config");
    expect(options.filesystem.denyWrite).toContain("/home/u/Library/LaunchAgents");
    // write jail anchored on the WORKSPACE ROOT; NOT $HOME (cluster-review MAJOR).
    expect(options.filesystem.allowWrite).toContain(ROOT);
    expect(options.filesystem.allowRead).toContain(ROOT);
    const [sandboxHome] = createdHomes;
    expect(options.filesystem.allowWrite).toContain(sandboxHome);
    expect(options.filesystem.allowRead).toContain(sandboxHome);

    // spawned the WRAPPED argv[0] + argv.slice(1).
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = ptySpawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string>; cols: number; rows: number }];
    expect(cmd).toBe("sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(opts.cwd).toBe(ROOT);
    expect(opts.cols).toBe(120);
    expect(opts.rows).toBe(40);
    expect(opts.env.TERM).toBe("xterm-256color");
    // The stable terminal id reaches the shell, whatever view the tab is shown in.
    expect(opts.env.AVE_TERMINAL_ID).toBe("terminal:0000000a-1");
    expect(opts.env.HOME).toBe(sandboxHome);
  });

  it("sets the shell's temp directory inside the wrap, to one under its own HOME", async () => {
    vi.stubEnv("SHELL", "/bin/sh");
    let res: Awaited<ReturnType<typeof spawnTerminal>>;
    try {
      res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(res.ok).toBe(true);
    const [command, options] = wrapWorkerCommandMock.mock.calls[0] as [string, { filesystem: { allowWrite: string[] } }];
    const [sandboxHome] = createdHomes;
    const temp = join(sandboxHome!, "tmp");
    // ASRT writes its own `TMPDIR=` (the sandbox temp root) ahead of the command, so only an assignment inside the wrap reaches the shell.
    expect(command).toBe(`exec /usr/bin/env TMPDIR=${temp} TMP=${temp} TEMP=${temp} /bin/sh -l -i`);
    expect(statSync(temp).isDirectory()).toBe(true);
    expect(statSync(temp).mode & 0o777).toBe(OWNER_ONLY_DIR_MODE);
    // Written under the HOME the wrap already grants.
    expect(options.filesystem.allowWrite).toContain(sandboxHome);
  });

  it("refuses the spawn and releases the HOME when the temp directory cannot be made", async () => {
    const home = await import("../../../permissions/sandbox-process-home.js");
    const create = vi.spyOn(home, "createSandboxProcessHome");
    create.mockImplementationOnce(() => {
      const path = mkdtempSync(join(homeParent, "home-"));
      writeFileSync(join(path, "tmp"), "");
      return { path, env: { HOME: path }, cleanup: sandboxHomeCleanupMock };
    });
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    create.mockRestore();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("spawn-failed");
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("honors a renderer-supplied cwd that is WITHIN the workspace root", async () => {
    const inside = `${ROOT}/proj`;
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1", cwd: inside });
    expect(res.ok).toBe(true);
    const spawnArgs = ptySpawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnArgs[2].cwd).toBe(inside);
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [string, { filesystem: { allowWrite: string[] } }];
    expect(options.filesystem.allowWrite).toContain(inside);
  });

  it("keeps confined raw output off the renderer emitter", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    lastPty?.emitData("hello");
    expect(emitted).toEqual([]);
  });

  it("forwards input + resize to the pty", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    writeTerminal("terminal:0000000a-1", "ls\n");
    resizeTerminal("terminal:0000000a-1", 100, 30);
    expect(lastPty?.written).toContain("ls\n");
    expect(lastPty?.resized).toContainEqual([100, 30]);
  });

  it("emits exit + decrements ASRT state when the pty exits", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    lastPty?.emitExit(0);
    expect(emitted).toEqual([]);
    expect(cleanupMock).toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).toHaveBeenCalled();
    // session dropped after exit.
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("publishes narrowed writes at startup and final quarantine notices before terminal exit", async () => {
    let complete!: (outcome: SandboxCleanupOutcome) => void;
    const cleanupCompleted = new Promise<SandboxCleanupOutcome>(resolve => { complete = resolve; });
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["wrapped-shell"], env: {}, notices: ["write access narrowed to project"], cleanupCompleted,
    });
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      await spawnTerminal({ tabId: "terminal:0000000a-1" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(emitted).toEqual([]);
    const [, , opts] = ptySpawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    lastPty!.emitData(`\u001b]133;C;cmdline_url=exit;${spawnedNonce(opts.env)}\u0007`);
    lastPty!.emitExit(0);
    expect(cleanupMock).toHaveBeenCalled();
    expect(emitted.some(entry => entry.event === "exit")).toBe(false);
    const notice = "Protected entries moved: source -> quarantine; restore from quarantine";
    complete({ notice });
    await vi.waitFor(() => expect(__terminalSessionCountForTest()).toBe(0));
    expect(emitted).toEqual([]);
    expect(getTerminalBlockTracker("terminal:0000000a-1")!.recent(1)[0]?.output).toContain(notice);
  });

  it("preserves wrapper notices and cleanup outcome when the PTY spawn throws", async () => {
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["wrapped-shell"], env: {}, notices: ["write access narrowed to project"],
      cleanupCompleted: Promise.resolve({ notice: "source moved -> quarantine; restore at quarantine", failure: "another move failed" }),
    });
    ptySpawnMock.mockImplementationOnce(() => { throw new Error("PTY spawn failed"); });
    const result = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(result).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (result.ok) throw new Error("expected failed spawn");
    expect(result.message).toContain("PTY spawn failed");
    expect(result.message).toContain("write access narrowed to project");
    expect(result.message).toContain("source moved -> quarantine; restore at quarantine");
    expect(result.message).toContain("another move failed");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
  });

  it("preserves notices from a wrapper that returns after spawn cancellation", async () => {
    let complete!: (wrapped: SandboxWrapResult) => void;
    wrapWorkerCommandMock.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const starting = spawnTerminal({ tabId: "terminal:0000000a-1" });
    await vi.waitFor(() => expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1));
    killTerminal("terminal:0000000a-1");
    complete({ argv: ["wrapped-shell"], env: {}, notices: ["narrowed after preparation"], cleanupCompleted: Promise.resolve({ notice: "late cleanup quarantine notice" }) });
    const result = await starting;
    expect(result).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (result.ok) throw new Error("expected cancelled spawn");
    expect(result.message).toContain("narrowed after preparation");
    expect(result.message).toContain("late cleanup quarantine notice");
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("does not await unconfirmed cleanup after a handoff may have started the wrapped process", async () => {
    needsOwnTtyGrant = true;
    wrapTerminalCommandMock.mockResolvedValueOnce({
      argv: ["/bin/sh"], env: {}, notices: ["write access narrowed to project"], cleanupCompleted: new Promise(() => {}),
    });
    deliverMock.mockRejectedValueOnce(new Error("handoff failed"));
    const result = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(result).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (result.ok) throw new Error("expected failed handoff");
    expect(result.message).toContain("handoff failed");
    expect(result.message).toContain("write access narrowed to project");
    expect(result.message).toContain(t("sandboxPolicy.cleanupPending"));
    expect(lastPty?.killSignals).toContain("SIGKILL");
  });

  it("wraps the shell under the tab's egress token for the life of the shell", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [string, { commandId: string }];
    // A minted token, not the tab id: the id the proxy sees is unguessable.
    expect(options.commandId).toMatch(/^[0-9a-f]{32}$/);
    expect(egressInvocationOwner(options.commandId)).toEqual({ kind: "terminal", tabId: "terminal:0000000a-1", sessionId: "terminal:0000000a-1" });
    lastPty?.emitExit(0);
    expect(egressInvocationOwner(options.commandId)).toBeUndefined();
  });

  it("ends the tab's pending egress asks when the tab closes, before its shell has exited", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [string, { commandId: string }];
    const signal = egressInvocationAbortSignal(options.commandId);
    expect(signal?.aborted).toBe(false);
    killTerminal("terminal:0000000a-1");
    expect(signal?.aborted).toBe(true);
  });

  it("ends them when the shell exits on its own too", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [string, { commandId: string }];
    const signal = egressInvocationAbortSignal(options.commandId);
    lastPty?.emitExit(0);
    expect(signal?.aborted).toBe(true);
  });

  it("names the window that owns a live tab (where its egress banner is drawn), and none once it is gone", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 7 });
    expect(terminalOwnerWindowId("terminal:0000000a-1")).toBe(7);
    expect(terminalOwnerWindowId("terminal:0000000a-2")).toBeUndefined();
    killTerminal("terminal:0000000a-1");
    expect(terminalOwnerWindowId("terminal:0000000a-1")).toBeUndefined();
  });

  it("is idempotent per tab: a second spawn replays the ring and does not start a second shell", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    lastPty?.emitData("scrollback");
    emitted = [];
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replayed).toBe(true);
    // no second pty spawn.
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    // ring replayed.
    expect(emitted).toEqual([]);
  });

  it("shares an in-flight same-tab spawn instead of creating two PTYs", async () => {
    let releaseWrap: ((value: { argv: string[]; env: NodeJS.ProcessEnv }) => void) | undefined;
    wrapWorkerCommandMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseWrap = resolve;
    }));

    const first = spawnTerminal({ tabId: "terminal:0000000a-1" });
    const overlapping = spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    releaseWrap?.({ argv: ["sandbox-exec", "/bin/bash"], env: {} });

    const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);
    expect(firstResult).toMatchObject({ ok: true, replayed: false });
    expect(overlappingResult).toMatchObject({ ok: true, replayed: true });
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    expect(__terminalSessionCountForTest()).toBe(1);
  });

  it("cancels an in-flight spawn when its tab closes", async () => {
    let releaseWrap: ((value: { argv: string[]; env: NodeJS.ProcessEnv }) => void) | undefined;
    wrapWorkerCommandMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseWrap = resolve;
    }));

    const spawn = spawnTerminal({ tabId: "terminal:0000000a-11" });
    killTerminal("terminal:0000000a-11");
    releaseWrap?.({ argv: ["sandbox-exec", "/bin/bash"], env: {} });

    await expect(spawn).resolves.toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(__terminalSessionCountForTest()).toBe(0);
  });
});

describe("pty-manager lifecycle", () => {
  it("kill tears down the pty + decrements ASRT state", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    killTerminal("terminal:0000000a-1");
    expect(lastPty?.killed).toBe(true);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).not.toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(1);
    writeTerminal("terminal:0000000a-1", "stale input\n");
    resizeTerminal("terminal:0000000a-1", 140, 50);
    expect(lastPty?.written).toEqual([]);
    expect(lastPty?.resized).toEqual([]);
    // A spawn under the closing id does not attach to the dying shell, and no second PTY starts while it is alive: it waits for the exit.
    const closing = lastPty!;
    const next = spawnTerminal({ tabId: "terminal:0000000a-1" });
    await Promise.resolve();
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    closing.emitExit(0);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(await next).toMatchObject({ ok: true, tabId: "terminal:0000000a-1", replayed: false });
    expect(ptySpawnMock).toHaveBeenCalledTimes(2);
    killTerminal("terminal:0000000a-1");
    lastPty?.emitExit(0);
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("retains a closing session and force-kills a PTY that ignores SIGHUP", async () => {
    vi.useFakeTimers();
    try {
      await spawnTerminal({ tabId: "terminal:0000000a-1" });
      const pty = lastPty;
      killTerminal("terminal:0000000a-1");
      expect(pty?.killSignals).toEqual([undefined]);
      expect(__terminalSessionCountForTest()).toBe(1);

      vi.advanceTimersByTime(3_000);
      expect(pty?.killSignals).toEqual([undefined, "SIGKILL"]);
      expect(sandboxHomeCleanupMock).not.toHaveBeenCalled();

      pty?.emitExit(137);
      expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
      expect(__terminalSessionCountForTest()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("killAllTerminals kills every live session", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    await spawnTerminal({ tabId: "terminal:0000000a-2" });
    expect(__terminalSessionCountForTest()).toBe(2);
    const killed = killAllTerminals();
    expect(killed).toBe(2);
    expect(__terminalSessionCountForTest()).toBe(2);
    for (const pty of spawnedPtys) pty.emitExit(0);
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("app shutdown sends SIGKILL immediately and awaits definitive exits", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    const pty = lastPty;
    const shutdown = forceKillAllTerminalsForShutdown();
    expect(pty?.killSignals).toEqual(["SIGKILL"]);
    expect(__terminalSessionCountForTest()).toBe(1);
    pty?.emitExit(137);
    await shutdown;
    expect(__terminalSessionCountForTest()).toBe(0);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("app shutdown cancels and drains an in-flight spawn", async () => {
    let releaseWrap: ((value: { argv: string[]; env: NodeJS.ProcessEnv }) => void) | undefined;
    wrapWorkerCommandMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseWrap = resolve;
    }));

    const spawn = spawnTerminal({ tabId: "terminal:0000000a-14" });
    const shutdown = forceKillAllTerminalsForShutdown();
    releaseWrap?.({ argv: ["sandbox-exec", "/bin/bash"], env: {} });

    await expect(spawn).resolves.toMatchObject({ ok: false, reason: "spawn-failed" });
    await expect(shutdown).resolves.toBe(0);
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(__terminalSessionCountForTest()).toBe(0);
    await expect(spawnTerminal({ tabId: "terminal:0000000a-12" }))
      .resolves.toMatchObject({ ok: false, reason: "spawn-failed" });
  });
});

describe("pty-manager cwd validation (write-jail anchor)", () => {
  it("defaults the cwd to the workspace root when none is supplied (never $HOME)", async () => {
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    expect(res.ok).toBe(true);
    const spawnArgs = ptySpawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnArgs[2].cwd).toBe(ROOT);
  });

  it("rejects a renderer-supplied cwd OUTSIDE the workspace root (no $HOME write-jail)", async () => {
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1", cwd: "/etc" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-request");
    // No PTY spawned for a rejected cwd.
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("admits a user-approved additional project subtree and anchors only that validated cwd", async () => {
    const project = join(homeParent, "approved-project");
    const cwd = join(project, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    additionalProjectDirectories = [project];
    const canonical = canonicalizePathForMatch(cwd);
    const result = await spawnTerminal({ tabId: "terminal:0000000a-1", cwd });
    expect(result).toMatchObject({ ok: true, session: { initialCwd: canonical } });
    expect(ptySpawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: canonical });
    const options = wrapWorkerCommandMock.mock.calls[0]?.[1] as { filesystem: { allowWrite: string[] } };
    expect(options.filesystem.allowWrite).toEqual([canonical, createdHomes[0]]);
    expect(options.filesystem.allowWrite).not.toContain(project);
    expect(options.filesystem.allowWrite).not.toContain(homedir());
  });

  it("rejects an unapproved outside directory and a sibling with the approved root's prefix", async () => {
    const project = join(homeParent, "approved-project");
    const outside = join(homeParent, "outside-project");
    const sibling = project + "-sibling";
    for (const directory of [project, outside, sibling]) mkdirSync(directory);
    additionalProjectDirectories = [project];
    for (const [index, cwd] of [outside, sibling].entries()) {
      expect(await spawnTerminal({ tabId: `terminal:0000000a-${index + 1}`, cwd })).toMatchObject({ ok: false, reason: "bad-request" });
    }
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("rejects a symlink escape from an approved project", async () => {
    const project = join(homeParent, "approved-project");
    const outside = join(homeParent, "outside-project");
    mkdirSync(project);
    mkdirSync(outside);
    const link = join(project, "escape");
    symlinkSync(outside, link, nativePlatform === "win32" ? "junction" : "dir");
    additionalProjectDirectories = [project];
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", cwd: link })).toMatchObject({ ok: false, reason: "bad-request" });
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("canonicalizes a user-approved project alias before matching its real subtree", async () => {
    const project = join(homeParent, "approved-project");
    const cwd = join(project, "app");
    mkdirSync(cwd, { recursive: true });
    const alias = join(homeParent, "project-alias");
    symlinkSync(project, alias, nativePlatform === "win32" ? "junction" : "dir");
    additionalProjectDirectories = [alias];
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", cwd })).toMatchObject({ ok: true, session: { initialCwd: canonicalizePathForMatch(cwd) } });
  });

  it("never anchors an Agent jail at the whole user HOME", async () => {
    additionalProjectDirectories = [homedir()];
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", cwd: homedir() })).toMatchObject({ ok: false, reason: "bad-request" });
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("rejects a relative (non-absolute) cwd", async () => {
    const res = await spawnTerminal({ tabId: "terminal:0000000a-1", cwd: "relative/path" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-request");
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });
});

describe("pty-manager window ownership (two windows)", () => {
  it("keeps a terminal to the window that spawned it: another window cannot attach, type into, or claim it", async () => {
    expect((await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 1 })).ok).toBe(true);
    expect(terminalOwnedBy("terminal:0000000a-1", 1)).toBe(true);
    expect(terminalOwnedBy("terminal:0000000a-1", 2)).toBe(false);
    // The second window's spawn of the same id is refused, and no second shell starts.
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 2 })).toEqual({
      ok: false,
      reason: "bad-request",
      message: "terminal tab belongs to another window",
    });
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    // Its own id in the same window form is its own terminal.
    expect((await spawnTerminal({ tabId: "terminal:0000000b-1", ownerWindowId: 2 })).ok).toBe(true);
    expect(ptySpawnMock).toHaveBeenCalledTimes(2);
  });

  it("addresses every output and exit to the owning window only", async () => {
    const original = await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 1 });
    if (!original.ok) throw new Error("expected terminal");
    const first = lastPty!;
    await spawnTerminal({ tabId: "terminal:0000000b-1", ownerWindowId: 2 });
    const second = lastPty!;
    emitted.length = 0;
    emittedOwners.length = 0;
    first.emitData("from one");
    second.emitData("from two");
    first.emitExit(0);
    expect(emitted).toEqual([]);
    // Logical ownership survives shell exit until the trusted tab closes.
    expect(terminalOwnedBy("terminal:0000000a-1", 2)).toBe(false);
    expect(getWindowTerminalBlockTracker(original.session, 1)?.hasExited()).toBe(true);
    expect(getWindowTerminalBlockTracker(original.session, 2)).toBeUndefined();
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 2 })).toMatchObject({ ok: false, reason: "bad-request" });
    const replacement = await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 1 });
    if (!replacement.ok) throw new Error("expected replacement terminal");
    expect(replacement.session.terminalSessionId).not.toBe(original.session.terminalSessionId);
    expect(getWindowTerminalBlockTracker(original.session, 1)).toBeUndefined();
    expect(getWindowTerminalBlockTracker(replacement.session, 1)).toBeDefined();
    killTerminal("terminal:0000000a-1");
    expect(terminalOwnedBy("terminal:0000000a-1", 2)).toBe(true);
  });
});

describe("pty-manager window close (close, then reopen and restore)", () => {
  it("closes a closed window's shells, and the next window's restore of the same id gets a new shell once the old one exits", async () => {
    expect((await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 1 })).ok).toBe(true);
    const old = lastPty!;
    expect((await spawnTerminal({ tabId: "terminal:0000000b-1", ownerWindowId: 2 })).ok).toBe(true);
    const otherWindow = lastPty!;

    expect(killTerminalsOwnedBy(1)).toBe(1);
    expect(old.killed).toBe(true);
    expect(otherWindow.killed).toBe(false);
    // The closed window no longer owns the id.
    expect(terminalOwnedBy("terminal:0000000a-1", 3)).toBe(true);

    // The reopened window restores the saved layout under the same id.
    let settled = false;
    const restored = spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 3 }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    // Not attached to the dying shell: it waits for it.
    expect(settled).toBe(false);
    old.emitExit(129);
    expect(await restored).toMatchObject({ ok: true, tabId: "terminal:0000000a-1", replayed: false });
    expect(ptySpawnMock).toHaveBeenCalledTimes(3);
    expect(terminalOwnedBy("terminal:0000000a-1", 3)).toBe(true);
    expect(terminalOwnedBy("terminal:0000000a-1", 1)).toBe(false);
  });

  it("cancels a closed window's spawn still starting, and the restore after it starts fresh", async () => {
    const starting = spawnTerminal({ tabId: "terminal:0000000a-2", ownerWindowId: 1 });
    expect(killTerminalsOwnedBy(1)).toBe(1);
    const restored = await spawnTerminal({ tabId: "terminal:0000000a-2", ownerWindowId: 3 });
    expect((await starting).ok).toBe(false);
    expect(restored).toMatchObject({ ok: true, tabId: "terminal:0000000a-2", replayed: false });
    expect(terminalOwnedBy("terminal:0000000a-2", 3)).toBe(true);
  });

  it("drops a waiting restore when its window closes too: no shell starts for a window that is gone", async () => {
    expect((await spawnTerminal({ tabId: "terminal:0000000a-4", ownerWindowId: 1 })).ok).toBe(true);
    const old = lastPty!;
    killTerminalsOwnedBy(1);
    const waiting = spawnTerminal({ tabId: "terminal:0000000a-4", ownerWindowId: 3 });
    // The waiting window holds the id: a third window cannot take it meanwhile.
    expect(terminalOwnedBy("terminal:0000000a-4", 3)).toBe(true);
    expect(terminalOwnedBy("terminal:0000000a-4", 5)).toBe(false);
    expect(killTerminalsOwnedBy(3)).toBe(1);
    expect(await waiting).toEqual({ ok: false, reason: "spawn-failed", message: "terminal spawn cancelled" });
    old.emitExit(129);
    await Promise.resolve();
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    expect(__terminalSessionCountForTest()).toBe(0);
    expect(terminalOwnedBy("terminal:0000000a-4", 5)).toBe(true);
  });

  it("clears the wait's deadline timer when the wait is cancelled", async () => {
    vi.useFakeTimers();
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000a-6", ownerWindowId: 1 })).ok).toBe(true);
      killTerminalsOwnedBy(1);
      // The old shell's SIGKILL escalation timer.
      const before = vi.getTimerCount();
      const waiting = spawnTerminal({ tabId: "terminal:0000000a-6", ownerWindowId: 3 });
      expect(vi.getTimerCount()).toBe(before + 1);
      killTerminalsOwnedBy(3);
      expect(await waiting).toEqual({ ok: false, reason: "spawn-failed", message: "terminal spawn cancelled" });
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the whole wait by one deadline, also behind a cancelled spawn that is slow to settle", async () => {
    vi.useFakeTimers();
    try {
      let releaseWrap!: () => void;
      wrapWorkerCommandMock.mockImplementationOnce(() => new Promise((resolve) => {
        releaseWrap = () => resolve({ argv: ["/bin/zsh"], env: {} });
      }));
      const starting = spawnTerminal({ tabId: "terminal:0000000a-5", ownerWindowId: 1 });
      await vi.advanceTimersByTimeAsync(0);
      killTerminalsOwnedBy(1);
      const restored = spawnTerminal({ tabId: "terminal:0000000a-5", ownerWindowId: 3 });
      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void restored.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await restored).toEqual({
        ok: false,
        reason: "still-closing",
        message: "the previous shell for this tab is still closing",
      });
      releaseWrap();
      expect((await starting).ok).toBe(false);
      expect(ptySpawnMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses clearly, rather than hanging, when the old shell will not exit", async () => {
    vi.useFakeTimers();
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000a-3", ownerWindowId: 1 })).ok).toBe(true);
      killTerminalsOwnedBy(1);
      const restored = spawnTerminal({ tabId: "terminal:0000000a-3", ownerWindowId: 3 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await restored).toEqual({
        ok: false,
        reason: "still-closing",
        message: "the previous shell for this tab is still closing",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pty-manager anti-DoS caps", () => {
  it("refuses to spawn past the concurrent-session cap", async () => {
    const MAX = 16;
    for (let i = 0; i < MAX; i++) {
      const res = await spawnTerminal({ tabId: `terminal:0000000a-${i + 100}` });
      expect(res.ok).toBe(true);
    }
    expect(__terminalSessionCountForTest()).toBe(MAX);
    const over = await spawnTerminal({ tabId: "terminal:0000000a-13" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("too-many-terminals");
    // No extra PTY spawned past the cap.
    expect(ptySpawnMock).toHaveBeenCalledTimes(MAX);
  });

  it("replaying an EXISTING tab at the cap is still allowed (does not count as new)", async () => {
    const MAX = 16;
    for (let i = 0; i < MAX; i++) await spawnTerminal({ tabId: `terminal:0000000a-${i + 100}` });
    // Remount of an existing tab replays; must NOT be rejected by the cap.
    const replay = await spawnTerminal({ tabId: "terminal:0000000a-100" });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
  });

  it("drops an oversized single input write instead of streaming it to the PTY", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    const huge = "x".repeat(1024 * 1024 + 1); // 1 byte over the cap
    writeTerminal("terminal:0000000a-1", huge);
    expect(lastPty?.written).not.toContain(huge);
    expect(lastPty?.written.length ?? 0).toBe(0);
    // A normal write still passes.
    writeTerminal("terminal:0000000a-1", "ls\n");
    expect(lastPty?.written).toContain("ls\n");
  });
});

describe("pty-manager command blocks", () => {
  it("writes the zsh integration into the terminal's own HOME and pins ZDOTDIR there", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000a-1" })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [sandboxHome] = createdHomes;
    expect(readFileSync(join(sandboxHome!, ".zshrc"), "utf-8")).toContain("add-zsh-hook preexec __ave_preexec");
    const [, , opts] = ptySpawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(opts.env.ZDOTDIR).toBe(sandboxHome);
  });

  it("records blocks from PTY output and typed input, keeps them past exit, drops them on tab close", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 3 })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , opts] = ptySpawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    const nonce = spawnedNonce(opts.env);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
    const tracker = getTerminalBlockTracker("terminal:0000000a-1");
    expect(tracker).toBeDefined();
    // Registered under the window that asked for it, and only that window.
    expect(listTerminalBlockTabs(3).map((entry) => entry.tabId)).toEqual(["terminal:0000000a-1"]);
    expect(listTerminalBlockTabs(4)).toEqual([]);

    // A program printing markers without the nonce forges nothing.
    lastPty!.emitData("\u001b]133;C;cmdline_url=rm%20-rf\u0007fake\r\n\u001b]133;D;0\u0007");
    expect(tracker!.list()).toEqual([]);
    expect(tracker!.isIntegrated()).toBe(false);

    lastPty!.emitData(`\u001b]133;C;cmdline_url=make;${nonce}\u0007`);
    lastPty!.emitData(`built\r\n\u001b]133;D;2;${nonce}\u0007`);
    expect(tracker!.recent(1)[0]).toMatchObject({ command: "make", exitCode: 2, output: "built\n" });
    // Confined output and marker fields never reach the renderer bridge.
    const shown = emitted.map((entry) => (entry.payload as { chunk?: string }).chunk ?? "").join("");
    expect(shown).toBe("");
    expect(shown).not.toContain(nonce);
    // A remount also receives no confined scrollback.
    emitted.length = 0;
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 3 })).toMatchObject({ ok: true, replayed: true });
    const replay = emitted.map((entry) => (entry.payload as { chunk?: string }).chunk ?? "").join("");
    expect(replay).toBe("");
    expect(replay).not.toContain(nonce);

    lastPty!.emitExit(0);
    expect(getTerminalBlockTracker("terminal:0000000a-1")).toBe(tracker);
    expect(tracker!.hasExited()).toBe(true);

    killTerminal("terminal:0000000a-1");
    expect(getTerminalBlockTracker("terminal:0000000a-1")).toBeUndefined();
  });

  it("feeds typed input to the fallback splitter", async () => {
    expect((await spawnTerminal({ tabId: "terminal:0000000a-1" })).ok).toBe(true);
    lastPty!.emitData("$ ls");
    writeTerminal("terminal:0000000a-1", "\r");
    expect(lastPty!.written).toEqual(["\r"]);
    expect(getTerminalBlockTracker("terminal:0000000a-1")!.recent(1)[0]).toMatchObject({ command: "$ ls", source: "heuristic" });
  });

  it("refuses the spawn and releases the HOME when the integration cannot be written", async () => {
    const home = await import("../../../permissions/sandbox-process-home.js");
    const create = vi.spyOn(home, "createSandboxProcessHome");
    create.mockImplementationOnce(() => {
      const path = mkdtempSync(join(homeParent, "home-"));
      // A directory where the startup file must go: the write fails.
      mkdirSync(join(path, ".zshrc"));
      return { path, env: { HOME: path }, cleanup: sandboxHomeCleanupMock };
    });
    vi.stubEnv("SHELL", "/bin/zsh");
    let res: Awaited<ReturnType<typeof spawnTerminal>>;
    try {
      res = await spawnTerminal({ tabId: "terminal:0000000a-1" });
    } finally {
      vi.unstubAllEnvs();
      create.mockRestore();
    }
    expect(res).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(getTerminalBlockTracker("terminal:0000000a-1")).toBeUndefined();
  });
});

describe("pty-manager typing an approved agent command", () => {
  const TAB = "terminal:0000000a-1";
  /** The line in bracketed-paste markers; Enter follows separately once it shows. */
  const PASTE = (line: string): string => `\u001b[200~${line}\u001b[201~`;

  beforeEach(() => {
    foregroundReading = { ok: true, foreground: { pid: 9999, command: "zsh", cwd: "/w" } };
    readForegroundMock.mockClear();
  });

  async function zshTerminal(ownerWindowId: number): Promise<{
    pty: FakePty;
    mark: (fields: string) => string;
    prompt: (fields?: string) => string;
    report: (line: string) => void;
    /** How the fake shell shows a pasted line in its edit line. */
    shell: { shows: (line: string) => string; reports: (line: string) => string; acknowledges: (line: string) => boolean };
  }> {
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      expect((await spawnTerminal({ tabId: TAB, ownerWindowId })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , opts] = ptySpawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    const nonce = spawnedNonce(opts.env);
    const mark = (fields: string): string => `\u001b]133;${fields};${nonce}\u0007`;
    // Each prompt announces a fresh B token in P; B carries it, not the nonce.
    let prompts = 0;
    let token = "";
    const prompt = (fields = ";Keys=emacs;Paste=1;NotFound=0"): string => {
      token = `${(++prompts).toString(16).padStart(2, "0")}`.repeat(16);
      return `${mark("D;0")}${mark(`P;Cwd=/w${fields};Edit=1;B=${token}`)}${mark("A")}% \u001b]133;B;${token}\u0007`;
    };
    const pty = lastPty!;
    // The shell: Ctrl-C at its prompt drops the line and draws a fresh prompt; a paste shows in the edit line (as `shows` renders it).
    const shell = { shows: (line: string): string => line, reports: (line: string): string => line, acknowledges: (_line: string): boolean => true };
    let editorLine = "";
    const report = (line: string): void => pty.emitData(mark(`E;Line=${encodeURIComponent(line)};B=${token}`));
    pty.respond = (data) => {
      if (data === "\u0003") {
        editorLine = "";
        queueMicrotask(() => pty.emitData(`\r\n${prompt()}`));
      }
      const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(data);
      if (paste) {
        editorLine = paste[1]!;
        queueMicrotask(() => pty.emitData(shell.shows(paste[1]!)));
      }
      if (data === TERMINAL_EDIT_LINE_QUERY && shell.acknowledges(editorLine)) {
        const line = shell.reports(editorLine);
        queueMicrotask(() => report(line));
      }
    };
    return { pty, mark, prompt, shell, report };
  }

  function observationSink() {
    const controller = new AbortController();
    const lease = { signal: controller.signal, write: vi.fn(), finish: vi.fn(), bindEgress: vi.fn(), releaseHeldOutput: vi.fn(), revoke: vi.fn() };
    const start = vi.fn((_identity: unknown, _input: AgentTerminalObservationInput) => lease);
    setAgentTerminalObservationSink({ start, egress: vi.fn(), releaseSessions: vi.fn() });
    return { start, lease, controller };
  }

  function agentType(line = "echo approved") {
    const identity = { sessionId: "conversation", turnId: "turn", toolUseId: "command" };
    return runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity,
      () => typeTerminalCommand(TAB, 3, line, "/w")));
  }

  it("never observes user commands typed in either terminal lane", async () => {
    const { start } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    writeTerminal(TAB, "echo human\r");
    pty.emitData(`${mark("C;cmdline_url=echo%20human")}private user output\n${mark("D;0")}`);
    const manual = await spawnLane({ tabId: "terminal:0000000b-1", lane: "manual", ownerWindowId: 3 });
    expect(manual.ok).toBe(true);
    if (!manual.ok) throw new Error("Missing manual terminal");
    expect(writeLane(manual.session, "echo manual\r")).toEqual({ ok: true });
    lastPty!.emitData("private manual output\n");
    expect(start).not.toHaveBeenCalled();
  });

  it("does not infer authority from authenticated markers or direct host typing", async () => {
    const { start } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await expect(typeTerminalCommand(TAB, 3, "echo approved", "/w")).resolves.toMatchObject({ ok: true });
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}output\n${mark("D;0")}`);
    expect(start).not.toHaveBeenCalled();
  });

  it("does not observe UI-origin calls nested inside model context", async () => {
    const { start } = observationSink();
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await expect(runWithInvocationOrigin("ui", undefined, () => agentType())).resolves.toMatchObject({ ok: true });
    expect(start).not.toHaveBeenCalled();
  });

  it("binds observation before Enter and continues the exact block after the tool wait ends", async () => {
    const { start, lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    const respond = pty.respond;
    pty.respond = (data) => {
      respond?.(data);
      if (data === "\r") {
        expect(start).toHaveBeenCalledTimes(1);
        pty.emitData(`${mark("C;cmdline_url=echo%20approved")}first\n`);
      }
    };
    await expect(agentType()).resolves.toEqual({ ok: true, firstBlockId: 1 });
    expect(start).toHaveBeenCalledWith({ sessionId: "conversation", turnId: "turn", toolUseId: "command" },
      expect.objectContaining({ kind: "terminal", command: "echo approved", cwd: "/w", tabId: TAB,
        sandbox: { mode: "isolated", detail: "asrt" } }));
    const token = lease.bindEgress.mock.calls[0]![0] as string;
    expect(egressInvocationOwner(token)).toEqual({ kind: "terminal", tabId: TAB, sessionId: TAB });
    expect(lease.bindEgress).toHaveBeenCalledWith(token, "terminal-session");
    expect(lease.write).toHaveBeenCalledWith("first\n");
    expect(lease.finish).not.toHaveBeenCalled();
    pty.emitData("second");
    expect(lease.write).toHaveBeenCalledTimes(1);
    pty.emitData(` line\n${mark("D;2")}unrelated prompt text`);
    expect(lease.write.mock.calls.map(([text]) => text).join("")).toBe("first\nsecond line\n");
    expect(lease.finish).toHaveBeenCalledExactlyOnceWith(2, undefined);
    pty.emitData(`${mark("C;cmdline_url=echo%20human")}human\n${mark("D;0")}`);
    expect(lease.write).toHaveBeenCalledTimes(2);
  });

  it("revokes before accepted human input can echo into the agent block", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}agent output\npartial`);
    pty.respond = () => {
      expect(lease.revoke).toHaveBeenCalledTimes(1);
      pty.emitData("user-private input\n");
    };
    expect(writeTerminal(TAB, "private user value")).toEqual({ ok: true });
    pty.emitData(`${mark("D;0")}`);
    expect(lease.write.mock.calls.map(([text]) => text).join("")).toBe("agent output\n");
    expect(lease.finish).not.toHaveBeenCalled();
  });

  it("keeps the emulator's reply to the agent command's own query outside human-input revocation", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    // The agent's command asks for the device attributes; xterm.js answers through the input path.
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}\u001b[c`);
    expect(writeTerminal(TAB, "\u001b[?1;2c")).toEqual({ ok: true });
    pty.emitData(`continued\n${mark("D;0")}`);
    expect(lease.revoke).not.toHaveBeenCalled();
    expect(lease.write).toHaveBeenCalledWith("continued\n");
    expect(lease.finish).toHaveBeenCalledWith(0, undefined);
  });

  it("fails clearly without recording contents for a mismatched authenticated block", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    expect(() => pty.emitData(`${mark("C;cmdline_url=echo%20different")}private\n`))
      .toThrow("Terminal observation command does not match its admitted block.");
    expect(lease.revoke).toHaveBeenCalledTimes(1);
    expect(lease.write).not.toHaveBeenCalled();
  });

  it("fails clearly when an admitted block changes its reported directory", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    expect(() => pty.emitData(`${mark("P;Cwd=/other")}${mark("C;cmdline_url=echo%20approved")}private\n`))
      .toThrow("Terminal observation command does not match its admitted block.");
    expect(lease.revoke).toHaveBeenCalledTimes(1);
    expect(lease.write).not.toHaveBeenCalled();
  });

  it("preserves ordered command output after terminal scrollback retention truncates", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    pty.emitData(mark("C;cmdline_url=echo%20approved"));
    const first = `${"x".repeat(150_000)}continuing-line`;
    pty.emitData(first);
    pty.emitData(`\nvisible tail\n${mark("D;0")}`);
    const output = lease.write.mock.calls.map(([text]) => text).join("");
    expect(output).toBe(`${first}\nvisible tail\n`);
    expect(getTerminalBlockTracker(TAB)!.get(1)!.truncated).toBe(true);
  });

  it("keeps private-key framing through the actual adapter when one chunk exceeds terminal history", async () => {
    const daemon = new ObservationDaemon();
    const adapter = new TerminalObservationAdapter(daemon);
    const events: TerminalObservationEvent[] = [];
    setAgentTerminalObservationSink({ start: (identity, input) => adapter.start(identity, input),
      egress: (token, decision) => adapter.recordEgress(token, decision), releaseSessions: (ended) => adapter.releaseSessions(ended) });
    try {
      const { pty, mark, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      await agentType();
      const output = `${"x".repeat(9_000)}\n-----BEGIN PRIVATE KEY-----\n${"PRIVATEBODY\n".repeat(20_000)}-----END PRIVATE KEY-----\nvisible tail\n`;
      pty.emitData(`${mark("C;cmdline_url=echo%20approved")}${output}${mark("D;0")}`);
      adapter.registerView("view", "conversation", () => true, (batch) => {
        events.push(...batch);
        adapter.acknowledge("view", batch.at(-1)!.seq);
      });
      let command: TerminalObservedCommand | undefined;
      await vi.waitFor(() => {
        const snapshot = events.findLast((event) => event.kind === "snapshot");
        command = snapshot?.kind === "snapshot" ? snapshot.after.commands[0] : undefined;
        expect(command?.status).toBe("completed");
      });
      expect(command?.outputTail).toContain("visible tail");
      expect(JSON.stringify(events)).not.toContain("PRIVATEBODY");
      expect(command?.outputTail.length).toBeLessThanOrEqual(4_096);
      expect(getTerminalBlockTracker(TAB)!.get(1)!.truncated).toBe(true);
    } finally { daemon.dispose(); }
  });

  it("reuses nonce-redacted snapshots even when a nonce is split across PTY chunks", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    const nonce = mark("A").split(";").at(-1)!.slice(0, -1);
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}${nonce.slice(0, 16)}`);
    expect(lease.write).not.toHaveBeenCalled();
    pty.emitData(`${nonce.slice(16)}\n${mark("D;0")}`);
    const output = lease.write.mock.calls.map(([text]) => text).join("");
    expect(output).toBe("[terminal-nonce]\n");
    expect(output).not.toContain(nonce);
  });

  it("reports unknown command termination on shell exit and stops capture on tab closure", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}last line`);
    pty.emitExit(9);
    expect(lease.write).toHaveBeenCalledWith("last line");
    expect(lease.finish).toHaveBeenCalledExactlyOnceWith(null, "interrupted");
    killTerminal(TAB);
    pty.emitData("late output\n");
    expect(lease.write).toHaveBeenCalledTimes(1);
  });

  it("ends command observation at process exit while sandbox cleanup is still pending", async () => {
    let complete!: (outcome: SandboxCleanupOutcome) => void;
    const cleanupCompleted = new Promise<SandboxCleanupOutcome>((resolve) => { complete = resolve; });
    wrapWorkerCommandMock.mockResolvedValueOnce({ argv: ["wrapped-shell"], env: {}, cleanupCompleted });
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}last partial line`);
    pty.emitExit(3);
    expect(lease.write).toHaveBeenCalledExactlyOnceWith("last partial line");
    expect(lease.finish).toHaveBeenCalledExactlyOnceWith(null, "interrupted");
    complete({ notice: "cleanup finished later" });
    await Promise.resolve();
    expect(lease.write).toHaveBeenCalledTimes(1);
    expect(lease.finish).toHaveBeenCalledTimes(1);
  });

  it("stops an active command observation immediately when its tab closes", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}visible\npending`);
    killTerminal(TAB);
    expect(lease.finish).toHaveBeenCalledExactlyOnceWith(null, "interrupted");
    pty.emitData("late output\n");
    pty.emitExit(0);
    expect(lease.write).toHaveBeenCalledExactlyOnceWith("visible\n");
    expect(lease.finish).toHaveBeenCalledTimes(1);
  });

  it("withholds output and egress once the user has typed in the agent terminal, so an orphaned user job cannot write into the agent's block", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { start, lease } = observationSink();
      const { pty, mark, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      // The user starts a job that outlives its `sh`: it keeps the terminal (and the session's network credentials) and writes later.
      expect(writeTerminal(TAB, "sh -c '(sleep 15; printf \"USER_PRIVATE\\n\") &'\r")).toEqual({ ok: true });
      pty.emitData(`${mark("C;cmdline_url=sh")}${prompt()}`);
      vi.setSystemTime(Date.now() + USER_INPUT_QUIET_MS);
      const respond = pty.respond;
      pty.respond = (data) => {
        respond?.(data);
        if (data === "\r") pty.emitData(`${mark("C;cmdline_url=sleep%2020")}USER_PRIVATE\n`);
      };
      await expect(agentType("sleep 20")).resolves.toMatchObject({ ok: true });
      expect(start).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ command: "sleep 20", outputAvailability: "withheld-user-input" }));
      pty.emitData(`more USER_PRIVATE\n${mark("D;0")}`);
      expect(lease.write).not.toHaveBeenCalled();
      expect(lease.bindEgress).not.toHaveBeenCalled();
      // The agent's command, exit code and duration are still its own.
      expect(lease.finish).toHaveBeenCalledExactlyOnceWith(0, undefined);
    } finally { vi.useRealTimers(); }
  });

  const OSC_WRAPPED_USER_JOB = "\u001b]1;x\rsh -c '(sleep 15; printf \"USER_PRIVATE\\n\") &'\r\u0007";

  it("treats a reply-shaped write that carries keys as user input, so the next agent command is withheld", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { start, lease } = observationSink();
      const { pty, mark, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      // A paste without bracketed paste mode: the line editor runs the command inside the OSC-shaped bytes.
      expect(writeTerminal(TAB, OSC_WRAPPED_USER_JOB)).toEqual({ ok: true });
      expect(getTerminalBlockTracker(TAB)!.userInputGeneration()).toBe(1);
      // Typing refuses while the key is fresh.
      await expect(agentType("sleep 20")).resolves.toMatchObject({ ok: false, reason: "pending-input" });
      expect(start).not.toHaveBeenCalled();
      pty.emitData(`${mark("C;cmdline_url=sh")}${prompt()}`);
      vi.setSystemTime(Date.now() + USER_INPUT_QUIET_MS);
      const respond = pty.respond;
      pty.respond = (data) => {
        respond?.(data);
        if (data === "\r") pty.emitData(`${mark("C;cmdline_url=sleep%2020")}USER_PRIVATE\n`);
      };
      await expect(agentType("sleep 20")).resolves.toMatchObject({ ok: true });
      expect(start).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ command: "sleep 20", outputAvailability: "withheld-user-input" }));
      pty.emitData(`more USER_PRIVATE\n${mark("D;0")}`);
      expect(lease.write).not.toHaveBeenCalled();
      expect(lease.bindEgress).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("revokes a running agent block when a reply-shaped write carries keys", async () => {
    const { lease } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    // The command even asked for an OSC reply: a solicited shape still cannot carry keys.
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}agent output\n\u001b]1;?\u0007`);
    pty.respond = () => {
      expect(lease.revoke).toHaveBeenCalledTimes(1);
      pty.emitData("USER_PRIVATE\n");
    };
    expect(writeTerminal(TAB, OSC_WRAPPED_USER_JOB)).toEqual({ ok: true });
    pty.emitData(`${mark("D;0")}`);
    expect(lease.write.mock.calls.map(([text]) => text).join("")).toBe("agent output\n");
    expect(lease.finish).not.toHaveBeenCalled();
  });

  it("observes a pristine agent terminal with output and session egress", async () => {
    const { start, lease } = observationSink();
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    expect(start.mock.calls[0]![1].outputAvailability).toBeUndefined();
    expect(lease.bindEgress).toHaveBeenCalledWith(expect.any(String), "terminal-session");
  });

  it("refuses Enter, and admits no observation, when another process holds the terminal at the last check", async () => {
    const { start } = observationSink();
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    readForegroundMock.mockImplementation(async (_pid, options) => options?.exclusive
      ? { ok: false, reason: "another process holds the terminal open (pid 4242)", busy: true }
      : foregroundReading);
    try {
      await expect(agentType()).resolves.toMatchObject({ ok: false, reason: "shell-busy", message: expect.stringContaining("pid 4242") });
    } finally { readForegroundMock.mockImplementation(async () => foregroundReading); }
    expect(pty.written).not.toContain("\r");
    expect(start).not.toHaveBeenCalled();
  });

  it("does not admit observation when editor verification refuses the command", async () => {
    const { start } = observationSink();
    const { pty, prompt, shell } = await zshTerminal(3);
    pty.emitData(prompt());
    shell.reports = () => "different text";
    await expect(agentType()).resolves.toMatchObject({ ok: false, reason: "edit-line-mismatch" });
    expect(start).not.toHaveBeenCalled();
  });

  it("drops producer buffers immediately when the observation owner ends its lease", async () => {
    const { lease, controller } = observationSink();
    const { pty, mark, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    await agentType();
    pty.emitData(`${mark("C;cmdline_url=echo%20approved")}pending private output`);
    controller.abort();
    pty.emitData(` should never be sent\n${mark("D;0")}`);
    expect(lease.write).not.toHaveBeenCalled();
    expect(lease.finish).not.toHaveBeenCalled();
    expect(lease.revoke).not.toHaveBeenCalled();
  });

  it("does not submit a matching echo when the editor buffer has lost its first character", async () => {
    const { pty, prompt, shell } = await zshTerminal(3);
    pty.emitData(prompt());
    shell.reports = (line) => line.slice(1);
    await expect(typeTerminalCommand(TAB, 3, "builtin printf approved", "/w")).resolves.toMatchObject({ ok: false, reason: "edit-line-mismatch" });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("builtin printf approved"), TERMINAL_EDIT_LINE_QUERY, "\u0003"]);
    expect(pty.written).not.toContain("\r");
  });

  it("waits for a fresh editor acknowledgement after paste before submitting", async () => {
    const { pty, prompt, shell, report } = await zshTerminal(3);
    pty.emitData(prompt());
    shell.acknowledges = (line) => line === "";
    const typing = typeTerminalCommand(TAB, 3, "echo approved", "/w");
    await expect.poll(() => pty.written.filter((data) => data === TERMINAL_EDIT_LINE_QUERY).length).toBe(2);
    expect(pty.written).not.toContain("\r");
    report("echo approved");
    await expect(typing).resolves.toEqual({ ok: true, firstBlockId: 1 });
    expect(pty.written.filter((data) => data === "\r")).toHaveLength(1);
  });

  it("accepts an unchanged actual buffer when its query widget repaints the display", async () => {
    const { pty, prompt, shell, report } = await zshTerminal(3);
    pty.emitData(prompt());
    shell.acknowledges = (line) => line === "";
    const typing = typeTerminalCommand(TAB, 3, "echo approved", "/w");
    await expect.poll(() => pty.written.filter((data) => data === TERMINAL_EDIT_LINE_QUERY).length).toBe(2);
    expect(pty.written).not.toContain("\r");
    report("echo approved");
    pty.emitData("\r\u001b[2Capproved");
    await expect(typing).resolves.toEqual({ ok: true, firstBlockId: 1 });
    expect(pty.written.filter((data) => data === "\r")).toHaveLength(1);
  });

  it("does not paste into an editor that reports an existing buffer", async () => {
    const { pty, prompt, shell } = await zshTerminal(3);
    pty.emitData(prompt());
    shell.reports = () => "existing text";
    await expect(typeTerminalCommand(TAB, 3, "echo approved", "/w")).resolves.toMatchObject({ ok: false, reason: "edit-line-mismatch" });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, "\u0003"]);
  });

  it("sends no query or command to an editor without the owned query binding", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt().replace(";Edit=1", ";Edit=0"));
    await expect(typeTerminalCommand(TAB, 3, "echo approved", "/w")).resolves.toMatchObject({ ok: false, reason: "edit-line-mismatch" });
    expect(pty.written).toEqual([]);
  });

  it("aborts between paste and Enter without sending cancellation input to another command", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    const abort = new AbortController();
    const respond = pty.respond;
    pty.respond = (data) => {
      respond?.(data);
      if (data.startsWith("\u001b[200~")) abort.abort();
    };
    await expect(typeTerminalCommand(TAB, 3, "echo approved", "/w", abort.signal)).resolves.toMatchObject({ ok: false, reason: "aborted" });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("echo approved")]);
    writeTerminal(TAB, "echo human\r");
    await Promise.resolve();
    expect(pty.written.at(-1)).toBe("echo human\r");
  });

  it("refuses a changed containment generation before any agent byte", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    sandboxGeneration = "1";
    await expect(typeTerminalCommand(TAB, 3, "echo approved", "/w")).resolves.toMatchObject({ ok: false, reason: "no-terminal" });
    expect(pty.written).toEqual([]);
  });

  it("rechecks containment after an awaited OS reading", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    readForegroundMock.mockImplementationOnce(async () => { shellContained = false; return foregroundReading; });
    await expect(typeTerminalCommand(TAB, 3, "echo approved", "/w")).resolves.toMatchObject({ ok: false, reason: "no-terminal" });
    expect(pty.written).toEqual([]);
  });

  it("resets the line editor, checks the shell with the operating system, then pastes the line, and presses Enter once it shows", async () => {
    const { pty, mark, prompt } = await zshTerminal(3);
    // Before the shell's first prompt nothing can be told: refused.
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "no-shell-integration" });
    pty.emitData(prompt());
    // Another window's terminal answers like a missing one.
    await expect(typeTerminalCommand(TAB, 4, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "no-terminal" });
    await expect(typeTerminalCommand(TAB, 3, "ls -la", "/w")).resolves.toEqual({ ok: true, firstBlockId: 1 });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("ls -la"), TERMINAL_EDIT_LINE_QUERY, "\r"]);
    expect(readForegroundMock).toHaveBeenCalledWith(9999, {});
    // Only the last check, right before Enter, also asks that nothing else holds the terminal open.
    expect(readForegroundMock).toHaveBeenLastCalledWith(9999, { exclusive: true });
    expect(readForegroundMock.mock.calls.filter(([, options]) => options?.exclusive)).toHaveLength(1);
    // Until the shell starts it, the pasted line sits at the prompt: a second command is refused.
    await expect(typeTerminalCommand(TAB, 3, "pwd", "/w")).resolves.toMatchObject({ ok: false, reason: "pending-input" });
    pty.emitData(`\r\n${mark("C;cmdline_url=ls%20-la")}total 0\r\n`);
    await expect(typeTerminalCommand(TAB, 3, "pwd", "/w")).resolves.toMatchObject({ ok: false, reason: "command-running" });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("ls -la"), TERMINAL_EDIT_LINE_QUERY, "\r"]);
    pty.emitExit(0);
    await expect(typeTerminalCommand(TAB, 3, "pwd", "/w")).resolves.toMatchObject({ ok: false, reason: "no-terminal" });
  });

  it("presses Enter only when the edit line shows exactly the pasted line, and clears it otherwise", async () => {
    const { pty, prompt, shell } = await zshTerminal(3);
    pty.emitData(prompt());
    // A widget that rewrites pasted text (url-quote-magic quoting a URL).
    shell.shows = (line) => line.replace("?", "\\?");
    await expect(typeTerminalCommand(TAB, 3, "curl https://x/?a", "/w")).resolves.toMatchObject({ ok: false, reason: "edit-line-mismatch" });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("curl https://x/?a"), "\u0003"]);
    // A key the user presses before Enter.
    shell.shows = (line) => line;
    pty.written.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    pty.respond = ((respond) => (data: string) => {
      respond?.(data);
      if (data.startsWith("\u001b[200~")) writeTerminal(TAB, "x");
    })(pty.respond);
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "edit-line-mismatch" });
    expect(pty.written.at(-1)).toBe("x");
    expect(pty.written).not.toContain("\r");
  });

  it("types nothing when the operating system says a program, not the shell, holds the terminal, or another directory", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    foregroundReading = { ok: true, foreground: { pid: 4242, command: "python3", cwd: "/w" } };
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "foreground-not-shell" });
    // A nested zsh the user started holds the terminal: same name, not the terminal's shell.
    foregroundReading = { ok: true, foreground: { pid: 4243, command: "zsh", cwd: "/w" } };
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "foreground-not-shell" });
    foregroundReading = { ok: true, foreground: { pid: 9999, command: "zsh", cwd: "/etc" } };
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "cwd-mismatch" });
    foregroundReading = { ok: false, reason: "the terminal has no foreground process" };
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "cwd-unverified" });
    // The markers alone said the prompt was ready every time: nothing reached it.
    expect(pty.written).toEqual([]);
  });

  it("types nothing when the shell draws no fresh prompt after the reset", async () => {
    vi.useFakeTimers();
    try {
      const { pty, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      pty.respond = null;
      const typing = typeTerminalCommand(TAB, 3, "ls", "/w");
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(typing).resolves.toMatchObject({ ok: false, reason: "no-fresh-prompt" });
      // A Ctrl-C every half second for the three seconds, and nothing else.
      expect(pty.written).toEqual(Array.from({ length: 6 }, () => "\u0003"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops immediately when the user types during a reset, even across prompt redraws", async () => {
    vi.useFakeTimers();
    try {
      const { pty, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      pty.respond = null;
      const typing = typeTerminalCommand(TAB, 3, "ls", "/w");
      await vi.advanceTimersByTimeAsync(100);
      expect(pty.written).toEqual(["\u0003"]);
      writeTerminal(TAB, "x");
      pty.emitData(prompt());
      await expect(typing).resolves.toMatchObject({ ok: false, reason: "pending-input" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(pty.written).toEqual(["\u0003", "x"]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["foreground", "children", "cwd"])("stops resending when the OS reports a change in %s", async (change) => {
    vi.useFakeTimers();
    try {
      const { pty, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      pty.respond = null;
      const typing = typeTerminalCommand(TAB, 3, "ls", "/w");
      await vi.advanceTimersByTimeAsync(100);
      foregroundReading = change === "children"
        ? { ok: false, reason: "the terminal shell has child processes" }
        : { ok: true, foreground: { pid: change === "foreground" ? 4242 : 9999, command: change === "foreground" ? "sleep" : "zsh", cwd: change === "cwd" ? "/etc" : "/w" } };
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(typing).resolves.toMatchObject({ ok: false, reason: change === "children" ? "cwd-unverified" : change === "cwd" ? "cwd-mismatch" : "foreground-not-shell" });
      expect(pty.written).toEqual(["\u0003"]);
    } finally { vi.useRealTimers(); }
  });

  it("rechecks the OS immediately before pasting after a fresh prompt", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    pty.respond = () => {
      foregroundReading = { ok: true, foreground: { pid: 4242, command: "sleep", cwd: "/w" } };
      queueMicrotask(() => pty.emitData(prompt()));
    };
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "foreground-not-shell" });
    expect(pty.written).toEqual(["\u0003"]);
  });

  it.each([2_499, 2_500, 2_501, 2_990])("requires the full quiet window inside the budget after a prompt at %i ms", async (at) => {
    vi.useFakeTimers();
    try {
      const { pty, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      const respond = pty.respond;
      pty.respond = (data) => {
        if (data !== "\u0003") respond?.(data);
      };
      setTimeout(() => pty.emitData(prompt()), at);
      const typing = typeTerminalCommand(TAB, 3, "ls", "/w");
      await vi.advanceTimersByTimeAsync(3_100);
      await expect(typing).resolves.toMatchObject(at <= 2_500 ? { ok: true } : { ok: false, reason: "no-fresh-prompt" });
      expect(pty.written.some((data) => data.startsWith("\u001b[200~"))).toBe(at <= 2_500);
    } finally { vi.useRealTimers(); }
  });

  it("sends Ctrl-C again when bash cleared its line but waits for a key to draw the fresh prompt", async () => {
    vi.useFakeTimers();
    try {
      const { pty, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      // bash 5.2 when the Ctrl-C arrives before readline waits for a key: the line is cleared and `^C` echoed after the prompt, and the fresh prompt comes with the next key.
      const respond = pty.respond;
      let interruptPending = false;
      pty.respond = (data) => {
        if (data === "\u0003" && !interruptPending) {
          interruptPending = true;
          queueMicrotask(() => pty.emitData("^C\u001b[?2004l\r\u001b[?2004h"));
          return;
        }
        respond?.(data);
      };
      const typing = typeTerminalCommand(TAB, 3, "ls", "/w");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(typing).resolves.toEqual({ ok: true, firstBlockId: 1 });
      expect(pty.written).toEqual(["\u0003", "\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("ls"), TERMINAL_EDIT_LINE_QUERY, "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a prompt without bracketed paste, with vi keys, or with a command-not-found handler, before any key is sent", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt(";Keys=emacs;Paste=0"));
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "no-bracketed-paste" });
    pty.emitData(`\r\n${prompt(";Keys=vi;Paste=1")}`);
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "vi-editing-mode" });
    pty.emitData(`\r\n${prompt(";Keys=emacs;Paste=1;NotFound=1")}`);
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "not-found-handler" });
    expect(pty.written).toEqual([]);
  });

  it("refuses a prompt the user pressed any key at, however long ago, and a fresh prompt until keys go quiet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { pty, prompt } = await zshTerminal(3);
      pty.emitData(prompt());
      // ESC: a pending prefix that echoes nothing.
      writeTerminal(TAB, "\u001b");
      vi.setSystemTime(Date.now() + USER_INPUT_QUIET_MS * 10);
      await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "pending-input" });
      // Enter draws a fresh prompt; a key just before it still counts until quiet.
      writeTerminal(TAB, "\r");
      pty.emitData(`\r\n${prompt()}`);
      await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "pending-input" });
      vi.setSystemTime(Date.now() + USER_INPUT_QUIET_MS);
      await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toEqual({ ok: true, firstBlockId: 1 });
      expect(pty.written).toEqual(["\u001b", "\r", "\u0003", TERMINAL_EDIT_LINE_QUERY, PASTE("ls"), TERMINAL_EDIT_LINE_QUERY, "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("knows from the shell it spawned whether a prompt without an end marker is fish or a shell still starting", async () => {
    const { pty, mark } = await zshTerminal(3);
    pty.emitData(`${mark("P;Cwd=/w;Keys=emacs;Paste=1")}${mark("A")}% `);
    await expect(typeTerminalCommand(TAB, 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "shell-starting", message: expect.stringMatching(/retry in a moment/) });
    killTerminal(TAB);
    pty.emitExit(0);
    vi.stubEnv("SHELL", "/usr/bin/fish");
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000b-1", ownerWindowId: 3 })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , opts] = ptySpawnMock.mock.calls.at(-1) as [string, string[], { env: Record<string, string> }];
    const fishMark = (fields: string) => `\u001b]133;${fields};${spawnedNonce(opts.env)}\u0007`;
    lastPty!.emitData(`${fishMark("P;Cwd=/w;Keys=emacs;Paste=1")}${fishMark("A")}/w> `);
    await expect(typeTerminalCommand("terminal:0000000b-1", 3, "ls", "/w")).resolves.toMatchObject({ ok: false, reason: "no-prompt-end-marker" });
    expect(lastPty!.written).toEqual([]);
  });

  it("rejects a line holding characters that would act as keys (a caller bug, never typed)", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    for (const line of ["ls\nrm -rf ~", "ls\t", "echo \u001b[201~", "rm​ -rf x"]) {
      await expect(typeTerminalCommand(TAB, 3, line, "/w")).rejects.toThrow(/cannot be typed as one command/);
    }
    expect(pty.written).toEqual([]);
  });

  it("verifies the reported directory against the shell's real one, through symlinks", async () => {
    const { pty, prompt } = await zshTerminal(3);
    pty.emitData(prompt());
    const real = mkdtempSync(join(tmpdir(), "ave-pty-cwd-"));
    const link = `${real}-link`;
    symlinkSync(real, link, nativePlatform === "win32" ? "junction" : "dir");
    try {
      foregroundReading = { ok: true, foreground: { pid: 9999, command: "zsh", cwd: realpathSync.native(real) } };
      await expect(verifyTerminalShell(TAB, 3, link)).resolves.toEqual({ ok: true, cwd: canonicalizePathForMatch(real) });
      await expect(verifyTerminalShell(TAB, 3, tmpdir())).resolves.toMatchObject({ ok: false, reason: "cwd-mismatch" });
      await expect(verifyTerminalShell(TAB, 4, link)).resolves.toMatchObject({ ok: false, reason: "no-terminal" });
    } finally {
      // A junction is removed as a directory; rmdir does not follow it.
      if (nativePlatform === "win32") rmdirSync(link);
      else rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("pty-manager cancellation during terminal acquisition", () => {
  const TAB_ID = "terminal:0000000d-1";
  const CANCEL_PATHS = ["killTerminal", "window close", "shutdown"] as const;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
  }

  function cancelSpawn(path: typeof CANCEL_PATHS[number]): Promise<unknown> {
    if (path === "killTerminal") killTerminal(TAB_ID);
    else if (path === "window close") killTerminalsOwnedBy(1);
    else return forceKillAllTerminalsForShutdown(0);
    return Promise.resolve();
  }

  function resourceState() {
    return {
      kills: [...(lastPty?.killSignals ?? [])],
      handoffs: handoffDisposeMock.mock.calls.length,
      wraps: cleanupMock.mock.calls.length,
      homes: sandboxHomeCleanupMock.mock.calls.length,
    };
  }

  function expectNoSession() {
    lastPty?.emitExit(137);
    lastPty?.emitData("late output");
    expect(__terminalSessionCountForTest()).toBe(0);
    expect(getTerminalBlockTracker(TAB_ID)).toBeUndefined();
    expect(emitted).toMatchObject([]);
  }

  beforeEach(() => { needsOwnTtyGrant = true; });

  it.each(CANCEL_PATHS)("%s during handoff creation disposes the late FIFO without spawning", async (path) => {
    const entered = deferred<void>();
    const handoff = deferred<TerminalTtyHandoff>();
    createHandoffMock.mockImplementationOnce(() => {
      entered.resolve();
      return handoff.promise;
    });
    const starting = spawnTerminal({ tabId: TAB_ID, ownerWindowId: 1 });
    await entered.promise;
    const cancelled = cancelSpawn(path);
    const immediate = resourceState();
    handoff.resolve(terminalHandoff());
    expect(await starting).toMatchObject({ ok: false, reason: "spawn-failed" });
    await cancelled;
    await cancelSpawn(path);
    expectNoSession();
    expect(immediate).toEqual({ kills: [], handoffs: 0, wraps: 0, homes: 1 });
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(wrapTerminalCommandMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
    expect(resourceState()).toEqual({ kills: [], handoffs: 1, wraps: 0, homes: 1 });
  });

  it.each(CANCEL_PATHS)("%s during wrap immediately kills the trampoline and disposes the FIFO", async (path) => {
    const entered = deferred<void>();
    const wrap = deferred<{ argv: string[]; env: NodeJS.ProcessEnv }>();
    let signal: AbortSignal | undefined;
    wrapTerminalCommandMock.mockImplementationOnce((_command, options) => {
      signal = (options as { abortSignal?: AbortSignal }).abortSignal;
      entered.resolve();
      // Deliberately ignore abort: even a late successful wrap needs cleanup.
      return wrap.promise;
    });
    const starting = spawnTerminal({ tabId: TAB_ID, ownerWindowId: 1 });
    await entered.promise;
    const cancelled = cancelSpawn(path);
    const immediate = resourceState();
    wrap.resolve({ argv: ["/bin/zsh"], env: {} });
    expect(await starting).toMatchObject({ ok: false, reason: "spawn-failed" });
    await cancelled;
    await cancelSpawn(path);
    expectNoSession();
    expect(immediate).toEqual({ kills: ["SIGKILL"], handoffs: 1, wraps: 0, homes: 1 });
    expect(signal?.aborted).toBe(true);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(resourceState()).toEqual({ kills: ["SIGKILL"], handoffs: 1, wraps: 1, homes: 1 });
  });

  it.each(CANCEL_PATHS)("%s during deliver releases everything before the late delivery settles", async (path) => {
    const entered = deferred<void>();
    const delivery = deferred<void>();
    let signal: AbortSignal | undefined;
    deliverMock.mockImplementationOnce((_script, options) => {
      signal = options?.signal;
      entered.resolve();
      return delivery.promise;
    });
    const starting = spawnTerminal({ tabId: TAB_ID, ownerWindowId: 1 });
    await entered.promise;
    const cancelled = cancelSpawn(path);
    const immediate = resourceState();
    delivery.resolve();
    expect(await starting).toMatchObject({ ok: false, reason: "spawn-failed" });
    await cancelled;
    await cancelSpawn(path);
    expectNoSession();
    expect(signal?.aborted).toBe(true);
    expect(immediate).toEqual({ kills: ["SIGKILL"], handoffs: 1, wraps: 1, homes: 1 });
    expect(resourceState()).toEqual(immediate);
  });

  it.each(CANCEL_PATHS)("%s after deliver resolves prevents registration and releases each resource once", async (path) => {
    let cancelled: Promise<unknown> | undefined;
    let immediate: ReturnType<typeof resourceState> | undefined;
    deliverMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolve();
      queueMicrotask(() => {
        cancelled = cancelSpawn(path);
        immediate = resourceState();
      });
    }));
    expect(await spawnTerminal({ tabId: TAB_ID, ownerWindowId: 1 }))
      .toMatchObject({ ok: false, reason: "spawn-failed" });
    await cancelled;
    await cancelSpawn(path);
    expectNoSession();
    expect(immediate).toEqual({ kills: ["SIGKILL"], handoffs: 1, wraps: 1, homes: 1 });
    expect(resourceState()).toEqual(immediate);
  });
});

describe("pty-manager on macOS: the shell gets its own terminal and no other", () => {
  const MAC_TAB = "terminal:0000000c-1";

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    needsOwnTtyGrant = true;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: nativePlatform, configurable: true });
  });

  it("publishes initialization once for an in-flight remount and cancellation closes no tab-owned shell", async () => {
    let entered!: () => void;
    const deliveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let deliver!: () => void;
    deliverMock.mockImplementationOnce(() => {
      lastPty!.emitData("prefix");
      entered();
      return new Promise<void>((resolve) => { deliver = resolve; });
    });
    const starting = spawnTerminal({ tabId: MAC_TAB, ownerWindowId: 1 });
    await deliveryEntered;
    expect(emitted).toEqual([]);
    const remount = spawnTerminal({ tabId: MAC_TAB, ownerWindowId: 1 });
    const abort = new AbortController();
    const cancelledWait = ensureConversationTerminal(MAC_TAB, 1, undefined, abort.signal);
    abort.abort(new Error("cancelled caller"));
    await expect(cancelledWait).rejects.toThrow("cancelled caller");
    expect(lastPty!.killed).toBe(false);
    lastPty!.emitData("suffix");
    expect(emitted).toEqual([]);
    deliver();
    const [first, second] = await Promise.all([starting, remount]);
    if (!first.ok || !second.ok) throw new Error("expected terminal");
    expect(second.session.terminalSessionId).toBe(first.session.terminalSessionId);
    expect(second.replayed).toBe(true);
    expect(emitted).toEqual([]);
    expect(lastPty!.written).toEqual([]);
  });

  it("spawns the trampoline first, wraps with that pty's own slave path, then hands it the wrapped shell", async () => {
    const res = await spawnTerminal({ tabId: MAC_TAB, ownerWindowId: 1 });
    expect(res.ok).toBe(true);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    const [file, args, opts] = ptySpawnMock.mock.calls[0];
    expect(file).toBe("/bin/sh");
    expect(args).toEqual(["/handoff/t-1/exec"]);
    // The trampoline runs nothing but sh: no session env, no secrets.
    expect((opts as { env: Record<string, string> }).env).toEqual({ PATH: "/usr/bin:/bin" });

    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(wrapTerminalCommandMock).toHaveBeenCalledTimes(1);
    const wrapOpts = wrapTerminalCommandMock.mock.calls[0][1] as { ownTty: string; denyUnixSockets: boolean; filesystem: { denyRead: string[] } };
    expect(wrapOpts.ownTty).toBe("/dev/ttys012");
    expect(wrapOpts.denyUnixSockets).toBe(true);
    expect(wrapOpts.filesystem.denyRead).toContain("/home/u/.ssh");

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const script = deliverMock.mock.calls[0][0];
    expect(script.startsWith("exec /usr/bin/env -i ")).toBe(true);
    expect(script).toContain("sandbox-exec -p prof /bin/zsh -l -i");
    expect(script).toContain("TERM=xterm-256color");
    expect(script).toContain("HTTP_PROXY=http://p");
    expect(handoffDisposeMock).toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(1);

    // Output reaches the view through the same session wiring, addressed to the window that spawned it, which alone owns the handed-off shell.
    lastPty!.emitData("hello");
    expect(emitted).toEqual([]);
    expect(emittedOwners).toEqual([]);
    expect(terminalOwnedBy(MAC_TAB, 1)).toBe(true);
    expect(terminalOwnedBy(MAC_TAB, 2)).toBe(false);
  });

  it("ends a stalled handoff when its window closes, so the restore of that id starts a new shell", async () => {
    // The trampoline never takes its command: only an abort ends the wait (the real deliver would otherwise hold it for 10 s, past a restore's 5 s).
    let signalSeen: AbortSignal | undefined;
    deliverMock.mockImplementationOnce((_script, options) => {
      signalSeen = options?.signal;
      return new Promise<void>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("handoff aborted")), { once: true });
      });
    });
    const starting = spawnTerminal({ tabId: MAC_TAB, ownerWindowId: 1 });
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    const trampoline = lastPty!;

    expect(killTerminalsOwnedBy(1)).toBe(1);
    const restored = spawnTerminal({ tabId: MAC_TAB, ownerWindowId: 3 });
    const first = await Promise.race([
      starting,
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 200)),
    ]);
    expect(first).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(signalSeen?.aborted).toBe(true);
    expect(trampoline.killSignals).toEqual(["SIGKILL"]);
    trampoline.emitExit(137);
    // The cancelled spawn released its wrap and HOME once; its trampoline's exit reported nothing to any window.
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === "exit")).toBe(false);

    // Not "still-closing": the restore got a fresh shell for its own window.
    expect(await restored).toMatchObject({ ok: true, tabId: MAC_TAB, replayed: false });
    expect(ptySpawnMock).toHaveBeenCalledTimes(2);
    expect(__terminalSessionCountForTest()).toBe(1);
    expect(terminalOwnedBy(MAC_TAB, 3)).toBe(true);
    expect(terminalOwnedBy(MAC_TAB, 1)).toBe(false);
  });

  it("ends a stalled handoff at shutdown, inside the shutdown deadline", async () => {
    deliverMock.mockImplementationOnce((_script, options) =>
      new Promise<void>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("handoff aborted")), { once: true });
      }),
    );
    const starting = spawnTerminal({ tabId: MAC_TAB, ownerWindowId: 1 });
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    const trampoline = lastPty!;
    await forceKillAllTerminalsForShutdown(200);
    // Settled by the time shutdown returns, not left behind it.
    const settled = await Promise.race([starting, Promise.resolve("stalled" as const)]);
    expect(settled).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(trampoline.killSignals).toEqual(["SIGKILL"]);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("fails the spawn without wrapping when node-pty reports no slave path", async () => {
    ptySpawnMock.mockImplementationOnce(() => {
      lastPty = new FakePty();
      lastPty.ptsName = undefined;
      spawnedPtys.push(lastPty);
      return lastPty;
    });
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/no pty slave device/);
    expect(wrapTerminalCommandMock).not.toHaveBeenCalled();
    expect(lastPty!.killSignals).toEqual(["SIGKILL"]);
    expect(handoffDisposeMock).toHaveBeenCalled();
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("refuses a malformed slave path the wrap rejects, and kills the trampoline", async () => {
    wrapTerminalCommandMock.mockImplementationOnce(() => Promise.reject(new Error("ttys: \"/dev/ttys*\" is not a pty slave device")));
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(false);
    expect(lastPty!.killSignals).toEqual(["SIGKILL"]);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("kills the trampoline and releases the wrap ONCE when the handoff fails", async () => {
    deliverMock.mockImplementationOnce(() => Promise.reject(new Error("trampoline did not take its command")));
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(false);
    const pty = lastPty!;
    expect(pty.killSignals).toEqual(["SIGKILL"]);
    // Its exit after the kill must not run the session cleanup again.
    pty.emitExit(137);
    await Promise.resolve();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === "exit")).toBe(false);
    expect(handoffDisposeMock).toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("kills the shell instead of registering it when the tab closes during the handoff", async () => {
    deliverMock.mockImplementationOnce(() => {
      killTerminal(MAC_TAB);
      return Promise.resolve();
    });
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(false);
    const pty = lastPty!;
    expect(pty.killSignals).toContain("SIGKILL");
    pty.emitExit(137);
    await Promise.resolve();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalled();
    expect(emitted.some((e) => e.event === "exit")).toBe(false);
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("kills the shell instead of registering it when shutdown starts during the handoff", async () => {
    let shutdown: Promise<number> | undefined;
    deliverMock.mockImplementationOnce(() => {
      shutdown = forceKillAllTerminalsForShutdown(50);
      return Promise.resolve();
    });
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(false);
    expect(lastPty!.killSignals).toContain("SIGKILL");
    await shutdown;
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("stops waiting when the trampoline exits before reading the fifo, and cleans up once", async () => {
    let signalSeen: AbortSignal | undefined;
    deliverMock.mockImplementationOnce((_script, options) => {
      signalSeen = options?.signal;
      return new Promise<void>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("trampoline exited")), { once: true });
        lastPty!.emitExit(127);
      });
    });
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(false);
    expect(signalSeen?.aborted).toBe(true);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === "exit")).toBe(false);
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("never passes a tty off macOS", async () => {
    needsOwnTtyGrant = false;
    const res = await spawnTerminal({ tabId: MAC_TAB });
    expect(res.ok).toBe(true);
    expect(wrapTerminalCommandMock).not.toHaveBeenCalled();
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).not.toHaveBeenCalled();
  });
});

describe("pty-manager on Linux: the shell gets a pty of its own inside the sandbox", () => {
  const LINUX_TAB = "terminal:0000000f-1";
  const SHELL_PID = 4321;
  type SandboxedShellReading = import("../shell-process.js").SandboxedShellReading;
  const shellReading = (overrides: Partial<Extract<SandboxedShellReading, { ok: true }>["shell"]> = {}): SandboxedShellReading => ({
    ok: true,
    shell: {
      pid: SHELL_PID,
      nsPid: 3,
      command: "zsh",
      foreground: { pgid: SHELL_PID, command: "zsh" },
      children: [],
      cwd: "/w",
      cwdIsReported: true,
      holders: [],
      holdersUnreadable: null,
      ...overrides,
    },
  });

  beforeEach(() => {
    needsInnerPty = true;
    sandboxedShellReading = shellReading();
    readForegroundMock.mockClear();
  });

  it("keeps host policy notices on replay after raw input, forged markers and scrollback eviction", async () => {
    let inspected = "";
    _setTerminalInspectionForTest((event, payload) => { if (event === "data") inspected += (payload as { chunk: string }).chunk; });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      wrapWorkerCommandMock.mockResolvedValueOnce({ argv: ["wrapped-shell"], env: {}, notices: ["write access narrowed to project"] });
      const { pty } = await linuxZsh();
      const notice = terminalSandboxWindowNotice()!;
      expect(inspected).toContain(notice);
      writeTerminal(LINUX_TAB, "sleep 100 &\r");
      pty.emitData("\u001b]133;D;0;forged\u0007");
      pty.emitData("older-output".repeat(20_000));
      pty.emitData("newer-output".repeat(20_000));
      inspected = "";
      expect(await spawnTerminal({ tabId: LINUX_TAB, ownerWindowId: 3 })).toMatchObject({ ok: true, replayed: true });
      expect(inspected).toContain(notice);
      expect(inspected).toContain("write access narrowed to project");
      expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
      expect(emitted).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("refuses agent typing after new Git controls appear without advancing the original snapshot", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const { pty } = await linuxZsh();
      addedGitControlPath = "/w/later/.git/config";
      await expect(typeTerminalCommand(LINUX_TAB, 3, "git status", "/w")).resolves.toMatchObject({
        ok: false, reason: "cwd-unverified", message: t("sandboxPolicy.terminalChanged"),
      });
      await expect(typeTerminalCommand(LINUX_TAB, 3, "git status", "/w")).resolves.toMatchObject({ ok: false });
      expect(pty.written).toEqual([]);
      writeTerminal(LINUX_TAB, "echo manual-input\r");
      expect(pty.written).toEqual(["echo manual-input\r"]);
      expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  async function linuxZsh(): Promise<{ pty: FakePty; prompt: (pid?: string) => string; report: (line: string) => void }> {
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      expect((await spawnTerminal({ tabId: LINUX_TAB, ownerWindowId: 3 })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , opts] = ptySpawnMock.mock.calls.at(-1) as [string, string[], { env: Record<string, string> }];
    const nonce = spawnedNonce(opts.env);
    const mark = (fields: string): string => `\u001b]133;${fields};${nonce}\u0007`;
    const pty = lastPty!;
    return {
      pty,
      prompt: (pid = "3") => `${mark("D;0")}${mark(`P;Cwd=/w;Keys=emacs;Paste=1;NotFound=0;Edit=1;B=${"ab".repeat(16)};Pid=${pid}`)}${mark("A")}% \u001b]133;B;${"ab".repeat(16)}\u0007`,
      report: (line) => pty.emitData(mark(`E;Line=${encodeURIComponent(line)};B=${"ab".repeat(16)}`)),
    };
  }

  it("runs the login shell under util-linux script, inside the same worker wrap", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      expect((await spawnTerminal({ tabId: LINUX_TAB })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(assertRelayMock).toHaveBeenCalledTimes(1);
    expect(wrapTerminalCommandMock).not.toHaveBeenCalled();
    const [cmdline] = wrapWorkerCommandMock.mock.calls[0] as [string, unknown];
    // shellQuote is the identity in this file, so the words read as they are.
    expect(cmdline).toMatch(/^exec \/usr\/bin\/env SHELL=\/bin\/sh \/usr\/bin\/script -q -e -c exec \/usr\/bin\/env SHELL=\/bin\/zsh TMPDIR=\S+ TMP=\S+ TEMP=\S+ \/bin\/zsh -l -i \/dev\/null$/u);
  });

  it("refuses to start a terminal when the pty relay is missing, before anything is wrapped or spawned", async () => {
    assertRelayMock.mockImplementation(() => Promise.reject(new Error("The terminal needs util-linux script(1) at /usr/bin/script")));
    const res = await spawnTerminal({ tabId: LINUX_TAB });
    expect(res).toMatchObject({ ok: false, reason: "spawn-failed", message: expect.stringMatching(/util-linux script/) });
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("forwards a resize to the relay, one forward at a time, the last size included", async () => {
    const { pty } = await linuxZsh();
    let release!: () => void;
    forwardResizeMock.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(true); }));
    resizeTerminal(LINUX_TAB, 100, 30);
    resizeTerminal(LINUX_TAB, 110, 31);
    resizeTerminal(LINUX_TAB, 120, 32);
    expect(pty.resized).toEqual([[100, 30], [110, 31], [120, 32]]);
    expect(forwardResizeMock).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(forwardResizeMock).toHaveBeenCalledTimes(2));
    expect(forwardResizeMock).toHaveBeenLastCalledWith(9999, "zsh");
  });

  it("does not forward a resize off Linux", async () => {
    needsInnerPty = false;
    expect((await spawnTerminal({ tabId: LINUX_TAB })).ok).toBe(true);
    resizeTerminal(LINUX_TAB, 100, 30);
    expect(forwardResizeMock).not.toHaveBeenCalled();
  });

  it("checks the shell through the sandbox's process tree, with the pid the shell reported", async () => {
    const { pty, prompt } = await linuxZsh();
    pty.emitData(prompt());
    await expect(verifyTerminalShell(LINUX_TAB, 3, "/w")).resolves.toEqual({ ok: true, cwd: canonicalizePathForMatch("/w") });
    expect(readSandboxedShellMock).toHaveBeenCalledWith(9999, "zsh", "/w", {});
    expect(readForegroundMock).not.toHaveBeenCalled();
    // A prompt that reported another pid is not this shell's.
    pty.emitData(`\r\n${prompt("7")}`);
    await expect(verifyTerminalShell(LINUX_TAB, 3, "/w")).resolves.toMatchObject({ ok: false, reason: "foreground-not-shell" });
  });

  it("types an approved command after Ctrl-C reaches the shell through its own pty", async () => {
    const { pty, prompt, report } = await linuxZsh();
    let editorLine = "";
    pty.respond = (data) => {
      if (data === "\u0003") {
        editorLine = "";
        queueMicrotask(() => pty.emitData(`\r\n${prompt()}`));
      }
      const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(data);
      if (paste) {
        editorLine = paste[1]!;
        queueMicrotask(() => pty.emitData(editorLine));
      }
      if (data === TERMINAL_EDIT_LINE_QUERY) queueMicrotask(() => report(editorLine));
    };
    pty.emitData(prompt());
    await expect(typeTerminalCommand(LINUX_TAB, 3, "ls -la", "/w")).resolves.toEqual({ ok: true, firstBlockId: 1 });
    expect(pty.written).toEqual(["\u0003", TERMINAL_EDIT_LINE_QUERY, "\u001b[200~ls -la\u001b[201~", TERMINAL_EDIT_LINE_QUERY, "\r"]);
    // The last check before Enter also asks that nothing else in the sandbox holds the terminal open.
    expect(readSandboxedShellMock).toHaveBeenLastCalledWith(9999, "zsh", "/w", { exclusive: true });
    expect(readSandboxedShellMock.mock.calls.filter(([, , , options]) => options?.exclusive)).toHaveLength(1);
  });

  it("judges a reading: the reporting shell, in the foreground, idle, in the very directory", () => {
    expect(sandboxedShellVerdict(shellReading(), "/w", 3)).toEqual({ ok: true, cwd: canonicalizePathForMatch("/w") });
    // The pid the prompt reported is not the shell found in the process tree, or none was reported.
    expect(sandboxedShellVerdict(shellReading(), "/w", 2)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
    expect(sandboxedShellVerdict(shellReading(), "/w", null)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
    // A program (or a nested shell) holds the shell's terminal.
    expect(sandboxedShellVerdict(shellReading({ foreground: { pgid: 5000, command: "zsh" } }), "/w", 3)).toMatchObject({
      ok: false,
      reason: "foreground-not-shell",
    });
    // A background job, or a command still finishing.
    expect(sandboxedShellVerdict(shellReading({ children: [{ pid: 5001, command: "sleep" }] }), "/w", 3)).toMatchObject({
      ok: false,
      reason: "shell-busy",
      message: expect.stringContaining('"sleep"'),
    });
    // A process in the sandbox that left the shell's session but still holds its terminal open, or one whose open files cannot be read.
    expect(sandboxedShellVerdict(shellReading({ holders: [{ pid: 5002, command: "python3" }] }), "/w", 3)).toMatchObject({
      ok: false, reason: "shell-busy", message: expect.stringContaining('"python3" pid 5002'),
    });
    expect(sandboxedShellVerdict(shellReading({ holdersUnreadable: "the open files of \"x\" (pid 5003) could not be read" }), "/w", 3)).toMatchObject({
      ok: false, reason: "shell-busy", message: expect.stringContaining("pid 5003"),
    });
    // A directory only the sandbox has, at a path the host also has.
    expect(sandboxedShellVerdict(shellReading({ cwdIsReported: false }), "/w", 3)).toMatchObject({ ok: false, reason: "cwd-mismatch" });
    expect(sandboxedShellVerdict({ ok: false, reason: "the terminal's sandbox is not running" }, "/w", 3)).toMatchObject({
      ok: false,
      reason: "cwd-unverified",
    });
  });
});


describe("host tabs and conversation-owned isolation", () => {
  it("releases failed terminal delivery aliases while retaining its conversation's own approval surface", async () => {
    const sessionId = "conversation-failed-egress-owner";
    const surface = { send: vi.fn(), isDestroyed: () => false };
    updateApprovalSurface({ kind: "attach", sessionId, surface: surface as never });
    const updates = vi.spyOn(approvalSurfaces, "updateApprovalSurface");
    const failure = new Error("controlled launch refusal");
    wrapWorkerCommandMock.mockRejectedValueOnce(failure);
    try {
      await expect(ensureConversationTerminal(sessionId, 8)).rejects.toThrow("controlled launch refusal");
      const binding = updates.mock.calls.map(([update]) => update).find((update) => update.kind === "bind-terminal-session");
      expect(binding?.kind).toBe("bind-terminal-session");
      if (!binding || binding.kind !== "bind-terminal-session") throw new Error("Missing conversation terminal binding");
      expect(approvalSurfaceRegistry.resolve(undefined, binding.tabId)).toBeNull();
      expect(approvalSurfaceRegistry.resolve(sessionId)).toBe(surface);
    } finally {
      updates.mockRestore();
      updateApprovalSurface({ kind: "release", sessionId });
    }
  });
  const tabId = "terminal:abcdabcd-1";
  it("preserves the configured host interpreter without confined backend availability", async () => {
    gateActive = false;
    vi.stubEnv("SHELL", process.execPath);
    try {
      const result = await spawnLane({ tabId, lane: "manual", ownerWindowId: 8, cwd: tmpdir() });
      expect(result).toMatchObject({ ok: true, session: { lane: "manual", substrate: "host", shellIntegration: false, integrationUnavailableReason: expect.any(String) } });
      expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
      expect(ptySpawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(ptySpawnMock.mock.calls[0]?.[2]).toMatchObject({ env: { HOME: process.env.HOME ?? "" } });
      expect(await spawnLane({ tabId, lane: "agent", ownerWindowId: 8 })).toMatchObject({ ok: false, reason: "no-terminal" });
      if (!result.ok) throw new Error("expected host terminal");
      expect(await typeAgentTerminalCommand(result.session, 8, "echo no", "/workspace")).toMatchObject({ ok: false, reason: "no-terminal" });
      expect(writeLane(result.session, "echo user\r")).toEqual({ ok: true });
    } finally { vi.unstubAllEnvs(); }
  });

  it("reserves host ownership after interpreter failure without granting an isolated companion", async () => {
    vi.stubEnv("SHELL", "/missing/interactive-shell");
    try {
      expect((await spawnLane({ tabId, lane: "manual", ownerWindowId: 8 })).ok).toBe(false);
      expect(terminalTabOwnerWindow(tabId)).toBe(8);
      expect(await spawnLane({ tabId, lane: "manual", ownerWindowId: 9 })).toMatchObject({ ok: false, reason: "bad-request" });
      expect(await spawnLane({ tabId, lane: "agent", ownerWindowId: 8 })).toMatchObject({ ok: false, reason: "no-terminal" });
      const abort = new AbortController(); abort.abort();
      await expect(ensureConversationTerminal("conversation-cancelled", 8, undefined, abort.signal)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  async function initializedConversation(id: string) {
    const originalShell = process.env.SHELL;
    vi.stubEnv("SHELL", "/bin/zsh");
    const started = ensureConversationTerminal(id, 8);
    vi.stubEnv("SHELL", originalShell);
    await vi.waitFor(() => expect(conversationTerminalRef(id, 8)).toBeDefined());
    const nonce = spawnedNonce((ptySpawnMock.mock.calls.at(-1)![2] as { env: Record<string, string> }).env);
    lastPty!.emitData(`\u001b]133;D;0;${nonce}\u0007\u001b]133;P;Cwd=/w;Keys=emacs;Paste=1;NotFound=0;Edit=1;B=${"ab".repeat(16)};${nonce}\u0007\u001b]133;A;${nonce}\u0007% \u001b]133;B;${"ab".repeat(16)}\u0007`);
    return started;
  }

  it("deduplicates one conversation's spawn and keeps different conversations isolated", async () => {
    const first = initializedConversation("conversation-one");
    const overlapping = ensureConversationTerminal("conversation-one", 8);
    const [one, same] = await Promise.all([first, overlapping]);
    const two = await initializedConversation("conversation-two");
    expect(same.terminalSessionId).toBe(one.terminalSessionId);
    expect(two.tabId).not.toBe(one.tabId);
    expect(ptySpawnMock).toHaveBeenCalledTimes(2);
    expect(conversationTerminalRef("conversation-one", 9)).toBeUndefined();
    await expect(ensureConversationTerminal("conversation-one", 9)).rejects.toThrow("another window");
    expect(emitted).toEqual([]);
  });

  it("delivers a conversation terminal's egress card to its live session owner and revokes delivery on teardown", async () => {
    const sessionId = "conversation-egress-owner";
    const surface = { send: vi.fn(), isDestroyed: () => false };
    updateApprovalSurface({ kind: "attach", sessionId, surface: surface as never });
    const terminal = await initializedConversation(sessionId);
    const gate = new ApprovalGate((requestingSessionId, terminalTabId) => approvalSurfaceRegistry.resolve(requestingSessionId, terminalTabId),
      undefined, undefined, { log: vi.fn() } as never);
    try {
      expect(approvalSurfaceRegistry.resolve(undefined, terminal.tabId)).toBe(surface);
      const pending = gate.requestAndWait({
        id: "conversation-egress-request", category: "tool", kind: "egress-host", toolName: "terminal", toolCategory: "network",
        args: { host: "destination.example", port: 443, tabId: terminal.tabId }, reason: "Destination approval", createdAt: Date.now(),
        allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false, forceExplicit: true, isReadOnly: false,
        egressHost: { host: "destination.example", port: 443, scopes: ["once"], network: "public", rule: null, terminalTabId: terminal.tabId },
      });
      await vi.waitFor(() => expect(sentApprovalCards<ApprovalRequest>(surface)).toHaveLength(1));
      const card = sentApprovalCards<ApprovalRequest>(surface)[0]!;
      gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, nonce: card.nonce, hmac: card.hmac,
        choice: "allow-once", egressScope: "once" }, surface as never);
      await expect(pending).resolves.toMatchObject({ choice: "allow-once", egressScope: "once" });
      releaseConversationTerminals((id) => id === sessionId);
      expect(approvalSurfaceRegistry.resolve(undefined, terminal.tabId)).toBeNull();
    } finally {
      gate.disposeAll();
      updateApprovalSurface({ kind: "release", sessionId });
      releaseConversationTerminals((id) => id === sessionId);
    }
  });

  it("closes only the host PTY on host-tab close and releases isolated state on conversation end", async () => {
    vi.stubEnv("SHELL", process.execPath);
    try {
      const host = await spawnLane({ tabId, lane: "manual", ownerWindowId: 8 });
      if (!host.ok) throw new Error("expected host terminal");
      const isolated = await initializedConversation("conversation-one");
      killHostTerminal(tabId);
      expect(spawnedPtys[0]!.killed).toBe(true);
      expect(spawnedPtys[1]!.killed).toBe(false);
      expect(conversationTerminalRef("conversation-one", 8)).toEqual({ tabId: isolated.tabId, lane: "agent", terminalSessionId: isolated.terminalSessionId });
      expect(rendererOwnsTerminal(isolated.tabId, 8)).toBe(false);
      killHostTerminal(isolated.tabId);
      expect(spawnedPtys[1]!.killed).toBe(false);
      releaseConversationTerminals(id => id === "conversation-one");
      expect(spawnedPtys[1]!.killed).toBe(true);
      expect(conversationTerminalRef("conversation-one", 8)).toBeUndefined();
      expect(getWindowTerminalBlockTracker(isolated, 8)).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it("waits for exit even when permission revocation released ownership before shell teardown", async () => {
    await initializedConversation("conversation-ending");
    const pty = lastPty!;
    releaseConversationTerminals((id) => id === "conversation-ending");
    let settled = false;
    const ending = endConversationTerminalSession("conversation-ending").then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pty.killed).toBe(true);
    pty.emitExit(0);
    await ending;
    expect(settled).toBe(true);
    expect(__terminalSessionCountForTest()).toBe(0);
  });
  it("releases failed conversation reservations before they can exhaust host terminal capacity", async () => {
    gateActive = false;
    for (let index = 0; index < 20; index++) {
      await expect(ensureConversationTerminal(`conversation-failed-${index}`, 8)).rejects.toThrow("Terminal requires the OS tool sandbox");
    }
    expect(__terminalSessionCountForTest()).toBe(0);
    vi.stubEnv("SHELL", process.execPath);
    try {
      expect(await spawnLane({ tabId, lane: "manual", ownerWindowId: 8 })).toMatchObject({ ok: true });
      expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("releases a failed shared spawn even after its only waiter aborts", async () => {
    let finish!: (result: SandboxWrapResult) => void;
    wrapWorkerCommandMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const abort = new AbortController();
    const starting = ensureConversationTerminal("conversation-aborted-setup", 8, undefined, abort.signal);
    const failure = expect(starting).rejects.toThrow("caller stopped waiting");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    abort.abort(new Error("caller stopped waiting"));
    await failure;
    finish({ argv: [], env: {} });
    await vi.waitFor(() => expect(_conversationTerminalOwnerForTest("conversation-aborted-setup")).toBeUndefined());
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("cancels an in-flight conversation spawn without orphaning its tracker", async () => {
    let finish!: (result: SandboxWrapResult) => void;
    wrapWorkerCommandMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const starting = ensureConversationTerminal("conversation-ending", 8);
    const failure = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    releaseConversationTerminals(id => id === "conversation-ending");
    finish({ argv: ["wrapped-shell"], env: {} });
    await failure;
    expect(conversationTerminalRef("conversation-ending", 8)).toBeUndefined();
    expect(listTerminalBlockTabs(8)).toEqual([]);
    expect(__terminalSessionCountForTest()).toBe(0);
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

});
