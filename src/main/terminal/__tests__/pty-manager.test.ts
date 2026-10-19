/**
 * pty-manager unit tests (#1444). Stub ASRT (gate + wrap + cleanup) + the
 * sandbox-capability shell-containment gate + node-pty, and assert the
 * WIRING — they do NOT exercise the real Seatbelt/bwrap PTY allocation (that is
 * the macOS/Linux runtime QA, which the design flags as the primary unknown).
 *
 * Covered:
 *   - FAIL CLOSED: gate off / not-shell-contained → spawn refused, node-pty never
 *     loaded, ASRT never wrapped.
 *   - bad-request: empty tabId.
 *   - happy path (shell-contained): wrapWorkerCommand receives the RESTATED
 *     sensitive denyRead floor + a cwd-derived write jail; pty spawned with the
 *     wrapped argv; onData → ring + emit; input/resize forwarded; onExit emits +
 *     cleans up ASRT state.
 *   - idempotent replay: a second spawn for the same tab replays the ring, does
 *     NOT spawn a second shell.
 *   - kill / killAll tear down + decrement ASRT state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalTtyHandoff } from "../terminal-tty-handoff.js";

// ─── ASRT mock — gate + wrap controllable per test ──────────
let gateActive = true;
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>(() => Promise.resolve({ argv: ["sandbox-exec", "-p", "prof", "/bin/bash", "-c", "exec /bin/zsh -l -i"], env: {} }));
const wrapTerminalCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>(() => Promise.resolve({ argv: ["/bin/bash", "-c", "sandbox-exec -p prof /bin/zsh -l -i"], env: { HTTP_PROXY: "http://p" } }));
const cleanupMock = vi.fn(() => Promise.resolve());
vi.mock("../../../permissions/asrt-sandbox.js", async () => ({
  sandboxTempEnvLaunch: (await vi.importActual<typeof import("../../../permissions/asrt-sandbox.js")>(
    "../../../permissions/asrt-sandbox.js",
  )).sandboxTempEnvLaunch,
  isAsrtSandboxActive: () => gateActive,
  wrapWorkerCommand: (command: string, options?: unknown) => wrapWorkerCommandMock(command, options),
  wrapTerminalCommand: (command: string, options?: unknown) => wrapTerminalCommandMock(command, options),
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

// ─── macOS own-tty handoff — platform + fifo controllable per test ──
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
vi.mock("../terminal-tty-platform.js", () => ({
  terminalNeedsOwnTtyGrant: () => needsOwnTtyGrant,
}));
vi.mock("../terminal-tty-handoff.js", async () => {
  const actual = await vi.importActual<typeof import("../terminal-tty-handoff.js")>("../terminal-tty-handoff.js");
  return {
    ...actual,
    createTerminalTtyHandoff: () => createHandoffMock(),
  };
});

// ─── shell-containment gate ─────────────────────────────────
let shellContained = true;
vi.mock("../../../permissions/sandbox-capability.js", () => ({
  isActiveSandboxShellContained: () => shellContained,
}));

// ─── write-jail derivation (deterministic) ──────────────────
vi.mock("../../../permissions/sandbox-write-jail.js", () => ({
  deriveSandboxWritePaths: (input: { allowedDirectories: readonly string[] }) => [...input.allowedDirectories],
}));

// ─── env sanitizer (identity-ish) ───────────────────────────
vi.mock("../../../tools/safe-env.js", () => ({
  buildSandboxedChildEnv: (env: NodeJS.ProcessEnv, extra: Record<string, string> = {}) => ({
    ...env,
    PATH: "/usr/bin",
    ...extra,
  }),
}));

// Real directories, one per terminal, under a parent made per test: the
// terminal creates its temp directory inside its HOME.
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

// ─── node-pty mock ──────────────────────────────────────────
type DataCb = (chunk: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;
class FakePty {
  pid = 9999;
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
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.resized.push([c, r]); }
  kill(signal?: string) {
    this.killed = true;
    this.killSignals.push(signal);
  }
  // test helpers
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
vi.mock("node-pty", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => ptySpawnMock(cmd, args, opts),
}));

// Module under test — imported AFTER mocks.
import {
  spawnTerminal,
  terminalOwnedBy,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  killTerminalsOwnedBy,
  forceKillAllTerminalsForShutdown,
  setTerminalEmitter,
  typeTerminalCommand,
  __resetTerminalsForTest,
  __terminalSessionCountForTest,
  type TerminalEmit,
} from "../pty-manager.js";
// REAL canonicalizer (NOT mocked) — the module resolves the default terminal cwd
// to `canonicalizePathForMatch(process.cwd())` (the workspace-root anchor) and
// validates a renderer-supplied cwd against it, so the test computes the same.
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";
import { USER_INPUT_QUIET_MS, getTerminalBlockTracker, listTerminalBlockTabs } from "../terminal-blocks.js";
import { SHELL_INTEGRATION_NONCE_FILE } from "../shell-integration.js";

/**
 * The marker nonce a spawned terminal's startup file would read: the file in
 * its sandbox HOME (no shell runs here, so nothing deleted it). It is never
 * in the shell's environment.
 */
function spawnedNonce(env: Record<string, string>): string {
  expect(Object.keys(env).some((key) => /NONCE/u.test(key))).toBe(false);
  return readFileSync(join(env.ZDOTDIR ?? env.HOME!, SHELL_INTEGRATION_NONCE_FILE), "utf-8");
}

/** The workspace root the module anchors the write-jail to by default. */
const ROOT = canonicalizePathForMatch(process.cwd());

let emitted: Array<{ event: string; payload: unknown }> = [];
/** The window each emitted event was addressed to, index for index with `emitted`. */
let emittedOwners: Array<number | null> = [];
const emit: TerminalEmit = (event, payload, ownerWindowId) => {
  emitted.push({ event, payload });
  emittedOwners.push(ownerWindowId);
};

beforeEach(() => {
  gateActive = true;
  shellContained = true;
  emitted = [];
  emittedOwners = [];
  lastPty = null;
  spawnedPtys = [];
  wrapWorkerCommandMock.mockClear();
  wrapTerminalCommandMock.mockClear();
  needsOwnTtyGrant = false;
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
  __resetTerminalsForTest();
  rmSync(homeParent, { recursive: true, force: true });
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
    // denyWrite FLOOR is RESTATED (per-command denyWrite REPLACES the boot array) —
    // shell-rc / ~/.ssh / ~/.config / LaunchAgents persistence vectors are denied.
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");
    expect(options.filesystem.denyWrite).toContain("/home/u/.ssh");
    expect(options.filesystem.denyWrite).toContain("/home/u/.config");
    expect(options.filesystem.denyWrite).toContain("/home/u/Library/LaunchAgents");
    // write jail anchored on the WORKSPACE ROOT — NOT $HOME (cluster-review MAJOR).
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
    // ASRT writes its own `TMPDIR=` (the sandbox temp root) ahead of the
    // command, so only an assignment inside the wrap reaches the shell.
    expect(command).toBe(`exec /usr/bin/env TMPDIR=${temp} TMP=${temp} TEMP=${temp} /bin/sh -l -i`);
    expect(statSync(temp).isDirectory()).toBe(true);
    expect(statSync(temp).mode & 0o777).toBe(0o700);
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

  it("streams pty output to the emitter and buffers it for replay", async () => {
    await spawnTerminal({ tabId: "terminal:0000000a-1" });
    lastPty?.emitData("hello");
    expect(emitted).toContainEqual({ event: "data", payload: { tabId: "terminal:0000000a-1", chunk: "hello" } });
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
    expect(emitted.some((e) => e.event === "exit")).toBe(true);
    expect(cleanupMock).toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).toHaveBeenCalled();
    // session dropped after exit.
    expect(__terminalSessionCountForTest()).toBe(0);
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
    expect(emitted).toContainEqual({ event: "data", payload: { tabId: "terminal:0000000a-1", chunk: "scrollback" } });
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
    // A spawn under the closing id does not attach to the dying shell, and no
    // second PTY starts while it is alive: it waits for the exit.
    const closing = lastPty!;
    const next = spawnTerminal({ tabId: "terminal:0000000a-1" });
    await Promise.resolve();
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    closing.emitExit(0);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(await next).toEqual({ ok: true, tabId: "terminal:0000000a-1", replayed: false });
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
    await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 1 });
    const first = lastPty!;
    await spawnTerminal({ tabId: "terminal:0000000b-1", ownerWindowId: 2 });
    const second = lastPty!;
    emitted.length = 0;
    emittedOwners.length = 0;
    first.emitData("from one");
    second.emitData("from two");
    first.emitExit(0);
    expect(emitted.map((entry, index) => [entry.event, (entry.payload as { tabId: string }).tabId, emittedOwners[index]])).toEqual([
      ["data", "terminal:0000000a-1", 1],
      ["data", "terminal:0000000b-1", 2],
      ["exit", "terminal:0000000a-1", 1],
    ]);
    // An exited shell no longer holds its id.
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
    expect(await restored).toEqual({ ok: true, tabId: "terminal:0000000a-1", replayed: false });
    expect(ptySpawnMock).toHaveBeenCalledTimes(3);
    expect(terminalOwnedBy("terminal:0000000a-1", 3)).toBe(true);
    expect(terminalOwnedBy("terminal:0000000a-1", 1)).toBe(false);
  });

  it("cancels a closed window's spawn still starting, and the restore after it starts fresh", async () => {
    const starting = spawnTerminal({ tabId: "terminal:0000000a-2", ownerWindowId: 1 });
    expect(killTerminalsOwnedBy(1)).toBe(1);
    const restored = await spawnTerminal({ tabId: "terminal:0000000a-2", ownerWindowId: 3 });
    expect((await starting).ok).toBe(false);
    expect(restored).toEqual({ ok: true, tabId: "terminal:0000000a-2", replayed: false });
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
    // Remount of an existing tab replays — must NOT be rejected by the cap.
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
    // The view gets the markers without their fields, so the nonce stays here.
    const shown = emitted.map((entry) => (entry.payload as { chunk?: string }).chunk ?? "").join("");
    expect(shown).toContain("built\r\n\u001b]133;D\u0007");
    expect(shown).not.toContain(nonce);
    // ...and so does the scrollback a remounting view replays.
    emitted.length = 0;
    expect(await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId: 3 })).toMatchObject({ ok: true, replayed: true });
    const replay = emitted.map((entry) => (entry.payload as { chunk?: string }).chunk ?? "").join("");
    expect(replay).toContain("built");
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
  async function zshTerminal(ownerWindowId: number): Promise<{ pty: FakePty; mark: (fields: string) => string }> {
    vi.stubEnv("SHELL", "/bin/zsh");
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000a-1", ownerWindowId })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , opts] = ptySpawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    const nonce = spawnedNonce(opts.env);
    return { pty: lastPty!, mark: (fields) => `\u001b]133;${fields};${nonce}\u0007` };
  }

  it("types the line and Enter only at an empty prompt of the owning window's live terminal", async () => {
    const { pty, mark } = await zshTerminal(3);
    // Before the shell's first prompt nothing can be told: refused.
    expect(typeTerminalCommand("terminal:0000000a-1", 3, "ls")).toMatchObject({ ok: false, reason: "no-shell-integration" });
    pty.emitData(`${mark("D;0")}${mark("P;Cwd=/w")}${mark("A")}% ${mark("B")}`);
    // Another window's terminal answers like a missing one.
    expect(typeTerminalCommand("terminal:0000000a-1", 4, "ls")).toMatchObject({ ok: false, reason: "no-terminal" });
    expect(typeTerminalCommand("terminal:0000000a-1", 3, "ls -la")).toEqual({ ok: true, firstBlockId: 1 });
    expect(pty.written).toEqual(["ls -la\r"]);
    // Until the shell starts it, the typed line sits at the prompt: a second command is refused.
    pty.emitData("ls -la");
    expect(typeTerminalCommand("terminal:0000000a-1", 3, "pwd")).toMatchObject({ ok: false, reason: "pending-input" });
    pty.emitData(`\r\n${mark("C;cmdline_url=ls%20-la")}total 0\r\n`);
    expect(typeTerminalCommand("terminal:0000000a-1", 3, "pwd")).toMatchObject({ ok: false, reason: "command-running" });
    expect(pty.written).toEqual(["ls -la\r"]);
    pty.emitExit(0);
    expect(typeTerminalCommand("terminal:0000000a-1", 3, "pwd")).toMatchObject({ ok: false, reason: "no-terminal" });
  });

  it("knows from the shell it spawned whether a prompt without an end marker is fish or a shell still starting", async () => {
    const { pty, mark } = await zshTerminal(3);
    pty.emitData(`${mark("P;Cwd=/w")}${mark("A")}% `);
    expect(typeTerminalCommand("terminal:0000000a-1", 3, "ls")).toMatchObject({ ok: false, reason: "shell-starting", message: expect.stringMatching(/retry in a moment/) });
    killTerminal("terminal:0000000a-1");
    pty.emitExit(0);
    vi.stubEnv("SHELL", "/usr/bin/fish");
    try {
      expect((await spawnTerminal({ tabId: "terminal:0000000b-1", ownerWindowId: 3 })).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , opts] = ptySpawnMock.mock.calls.at(-1) as [string, string[], { env: Record<string, string> }];
    const fishMark = (fields: string) => `\u001b]133;${fields};${spawnedNonce(opts.env)}\u0007`;
    lastPty!.emitData(`${fishMark("P;Cwd=/w")}${fishMark("A")}/w> `);
    expect(typeTerminalCommand("terminal:0000000b-1", 3, "ls")).toMatchObject({ ok: false, reason: "no-prompt-end-marker" });
    expect(lastPty!.written).toEqual([]);
  });

  it("refuses while the user's keystrokes may still be on their way to the echo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { pty, mark } = await zshTerminal(3);
      pty.emitData(`${mark("D;0")}${mark("P;Cwd=/w")}${mark("A")}% ${mark("B")}`);
      // Written to the PTY, not echoed back yet: the prompt still looks empty.
      writeTerminal("terminal:0000000a-1", "r");
      expect(typeTerminalCommand("terminal:0000000a-1", 3, "ls")).toMatchObject({ ok: false, reason: "pending-input" });
      expect(pty.written).toEqual(["r"]);
      vi.setSystemTime(Date.now() + USER_INPUT_QUIET_MS);
      expect(typeTerminalCommand("terminal:0000000a-1", 3, "ls")).toEqual({ ok: true, firstBlockId: 1 });
      expect(pty.written).toEqual(["r", "ls\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on a line holding characters that would act as keys (a caller bug, never typed)", async () => {
    const { pty, mark } = await zshTerminal(3);
    pty.emitData(`${mark("D;0")}${mark("P;Cwd=/w")}${mark("A")}% ${mark("B")}`);
    for (const line of ["ls\nrm -rf ~", "ls\t", "echo \u001b[201~", "rm\u200b -rf x"]) {
      expect(() => typeTerminalCommand("terminal:0000000a-1", 3, line)).toThrow(/cannot be typed as one command/);
    }
    expect(pty.written).toEqual([]);
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
    expect(emitted).toEqual([]);
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
    needsOwnTtyGrant = true;
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
    const wrapOpts = wrapTerminalCommandMock.mock.calls[0][1] as { ownTty: string; filesystem: { denyRead: string[] } };
    expect(wrapOpts.ownTty).toBe("/dev/ttys012");
    expect(wrapOpts.filesystem.denyRead).toContain("/home/u/.ssh");

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const script = deliverMock.mock.calls[0][0];
    expect(script.startsWith("exec /usr/bin/env -i ")).toBe(true);
    expect(script).toContain("sandbox-exec -p prof /bin/zsh -l -i");
    expect(script).toContain("TERM=xterm-256color");
    expect(script).toContain("HTTP_PROXY=http://p");
    expect(handoffDisposeMock).toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(1);

    // Output reaches the view through the same session wiring, addressed to
    // the window that spawned it, which alone owns the handed-off shell.
    lastPty!.emitData("hello");
    expect(emitted.some((e) => e.event === "data")).toBe(true);
    expect(emittedOwners).toEqual([1]);
    expect(terminalOwnedBy(MAC_TAB, 1)).toBe(true);
    expect(terminalOwnedBy(MAC_TAB, 2)).toBe(false);
  });

  it("ends a stalled handoff when its window closes, so the restore of that id starts a new shell", async () => {
    // The trampoline never takes its command: only an abort ends the wait
    // (the real deliver would otherwise hold it for 10 s, past a restore's 5 s).
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
    // The cancelled spawn released its wrap and HOME once; its trampoline's
    // exit reported nothing to any window.
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === "exit")).toBe(false);

    // Not "still-closing": the restore got a fresh shell for its own window.
    expect(await restored).toEqual({ ok: true, tabId: MAC_TAB, replayed: false });
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
