/**
 * pty-manager.ts — interactive PTY terminal sessions for the workspace rail
 * (#1444). One long-lived pseudo-terminal per workspace tab, spawned INSIDE the
 * ASRT OS sandbox (architecture §6.3.9) so an arbitrary interactive shell
 * inherits the SAME deny-by-default egress floor + filesystem confinement as a
 * bash tool / MCP worker.
 *
 * SECURITY MODEL (why this is worker-wrap, not tool-wrap):
 *   A terminal is a LONG-LIVED process that runs a SEQUENCE of arbitrary
 *   user-typed commands with NO per-command AST validation and NO reviewer gate
 *   (that is the nature of an interactive shell). The ONLY load-bearing control
 *   is therefore the OS sandbox confinement. So this module FAILS CLOSED: it
 *   refuses to spawn unless the active sandbox contains shell effects
 *   (`isActiveSandboxShellContained()` — filesystem + process confinement). On
 *   a degraded / gate-off / Windows fs+network partial host, subprocess/process
 *   residuals remain uncontained, which is strictly worse than a one-shot bash
 *   tool, so we do NOT plain-spawn (No-Fallback rule). See PR body §security.
 *
 * The wrap contract mirrors {@link ../../permissions/worker-spawn.ts} exactly:
 *   `wrapWorkerCommand(cmdline, { filesystem })` returns `{ argv, env }`; the
 *   host spawns `argv[0]` with `argv.slice(1)` — here through `pty.spawn` so the
 *   inner shell gets a real controlling TTY. Per-command `denyRead`/`denyWrite`
 *   REPLACE the shared boot arrays in ASRT, so we RESTATE
 *   `getDefaultSensitiveReadDenyPaths()` (else the shell regains read of
 *   `~/.ssh` / `~/.ave/secrets` / …) AND `getDefaultSensitiveWriteDenyPaths()`
 *   (else the shell could WRITE `~/.zshrc` / `~/.ssh` / `~/.config` /
 *   `~/Library/LaunchAgents` / cron — persistence/re-exec that later runs
 *   OUTSIDE the sandbox).
 *
 * WRITE-JAIL ANCHOR: the cwd anchors the write-jail, so it DEFAULTS to the
 * workspace root (process.cwd(), anchored to `~/.ave/workspace` at boot), NEVER
 * `$HOME` — a `$HOME`-anchored jail would let the shell write those persistence
 * files even before the `denyWrite` floor. A renderer-supplied cwd is validated
 * (absolute + within the workspace root) before it anchors the jail.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { IPty } from "node-pty";
import { createLogger } from "../../lib/logger.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { buildSandboxedChildEnv } from "../../tools/safe-env.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  isAsrtSandboxActive,
  sandboxTempEnvLaunch,
} from "../../permissions/asrt-sandbox.js";
import { isActiveSandboxShellContained } from "../../permissions/sandbox-capability.js";
import { deriveSandboxWritePaths } from "../../permissions/sandbox-write-jail.js";
import { canonicalizePathForMatch } from "../../permissions/sensitive-paths.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import { errorMessage } from "../../shared/error-message.js";
import { installShellIntegration } from "./shell-integration.js";
import {
  TerminalBlockTracker,
  registerTerminalBlockTracker,
  unregisterTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "./terminal-blocks.js";
import { isTerminalTabId } from "../../shared/tab-id.js";

const log = createLogger("ave");

/** Scrollback ring cap per session (bytes). Bounds main-process memory + the
 * replay payload sent to a remounting renderer. */
const RING_MAX_BYTES = 256 * 1024;
/** Hard bounds on the PTY geometry a renderer may request (anti-DoS). */
const MIN_DIM = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 1000;
/** Anti-DoS: max concurrent PTY sessions across all tabs. A new spawn past this
 * is refused so an arbitrary/looping tabId can never spawn unbounded PTYs. */
const MAX_TERMINALS = 16;
/** Anti-DoS: max bytes accepted for a single {@link writeTerminal} (keystroke /
 * paste) forward. An oversized write is dropped rather than streamed to the PTY. */
const MAX_INPUT_BYTES = 1024 * 1024;

export interface SpawnTerminalOptions {
  readonly tabId: string;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  /**
   * The app window whose renderer asked for the terminal. Its blocks are
   * visible to terminal_read only from sessions that window hosts.
   */
  readonly ownerWindowId?: number | null;
}

export type SpawnTerminalResult =
  | { ok: true; tabId: string; replayed: boolean }
  | {
      ok: false;
      reason: "not-shell-contained" | "bad-request" | "spawn-failed" | "too-many-terminals";
      message: string;
    };

/** main→renderer emitter. Registered ONCE by the terminal IPC domain, which
 * fans out to the app window(s) via safe-send. Kept as an injected sink so this
 * module stays free of `electron` imports (unit-testable in node). */
export type TerminalEmit = (
  event: "data" | "exit",
  payload:
    | { tabId: string; chunk: string }
    | { tabId: string; exitCode: number; signal?: number },
  /** The window that owns the terminal — the only one its output goes to (null: no window). */
  ownerWindowId: number | null,
) => void;

let _emit: TerminalEmit = () => {};

/** Register the main→renderer output sink (called once at IPC registration). */
export function setTerminalEmitter(fn: TerminalEmit): void {
  _emit = fn;
}

interface TerminalSession {
  pty: IPty;
  /** The window that spawned it. Only that window may attach, type, resize or close it. */
  ownerWindowId: number | null;
  /** Command blocks parsed from this PTY's output (terminal-blocks.ts). */
  blocks: TerminalBlockTracker;
  /** FIFO scrollback chunks, capped to {@link RING_MAX_BYTES}. */
  ring: string[];
  ringBytes: number;
  disposeData: () => void;
  disposeExit: () => void;
  cleanupSandboxHome: () => void;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  exited: boolean;
}

interface TerminalSpawnInFlight {
  promise: Promise<SpawnTerminalResult>;
  ownerWindowId: number | null;
  cancelled: boolean;
  cleanupSandboxHome?: () => void;
}

const sessions = new Map<string, TerminalSession>();
const terminalSpawnsInFlight = new Map<string, TerminalSpawnInFlight>();
let terminalShutdownStarted = false;

/** Lazy, cached ESM import of the native (external, asarUnpack'd) node-pty. Kept
 * dynamic like ASRT's loadSandboxManager so merely importing this module pulls
 * no native addon into non-terminal contexts. */
let _ptyModule: typeof import("node-pty") | null = null;
async function loadPty(): Promise<typeof import("node-pty")> {
  if (_ptyModule) return _ptyModule;
  _ptyModule = await import("node-pty");
  return _ptyModule;
}

function clampDim(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < MIN_DIM) return MIN_DIM;
  if (n > max) return max;
  return n;
}

/** Resolve the interactive login shell. Never derived from workspace content —
 * only `$SHELL` (validated absolute) or a per-platform default. */
function resolveLoginShell(): string {
  const envShell = process.env.SHELL;
  if (typeof envShell === "string" && isAbsolute(envShell)) return envShell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Resolve + VALIDATE the working directory that ANCHORS the write-jail.
 *
 * Default (no request): the workspace root — `process.cwd()`, anchored to
 * `~/.ave/workspace` at boot (ensureWorkspaceCwd) — NEVER `$HOME`, whose jail
 * would let the shell write shell-rc / login-agent persistence files. A
 * renderer-supplied cwd is a trust-sensitive input (it widens the write-jail),
 * so it is honored ONLY when it is absolute, canonicalizes cleanly, and stays
 * WITHIN the workspace root; anything else is REJECTED (No-Fallback: never
 * silently substitute an out-of-root cwd). Canonicalization uses the SAME helper
 * as {@link deriveSandboxWritePaths} so the validated path and the derived jail
 * see bit-identical strings.
 */
function resolveTerminalCwd(
  requested: string | undefined,
): { ok: true; cwd: string } | { ok: false; message: string } {
  const root = canonicalizePathForMatch(process.cwd());
  if (requested === undefined) return { ok: true, cwd: root };
  if (typeof requested !== "string" || !isAbsolute(requested)) {
    return { ok: false, message: "terminal cwd must be an absolute path" };
  }
  const canonical = canonicalizePathForMatch(requested);
  if (canonical !== root && !canonical.startsWith(`${root}/`)) {
    return { ok: false, message: "terminal cwd must be within the workspace root" };
  }
  return { ok: true, cwd: canonical };
}

/** The command string ASRT runs under its `-c` wrapper: exec the interactive
 * login shell so it takes over the PTY node-pty allocated for the sandbox
 * wrapper process (fd 0/1/2 inherit down sandbox-exec/bwrap → shell). */
function buildShellCommand(shell: string, tempDir: string): string {
  // `exec` replaces the wrapper's `/bin/bash -c` shell so there is no extra
  // process layer; `-l -i` = login + interactive (prompt, job control, rc).
  // The temp directory is set inside the wrap, because ASRT writes its own
  // `TMPDIR=` there that no spawn env outranks: the sandbox temp root, which
  // this terminal is neither granted nor allowed to read. Its own, under its
  // HOME, is both — as the shell tool's bootstrap does.
  const launch = sandboxTempEnvLaunch(tempDir, shell, ["-l", "-i"]);
  return `exec ${[launch.command, ...launch.args].map(shellQuote).join(" ")}`;
}

function pushRing(session: TerminalSession, chunk: string): void {
  session.ring.push(chunk);
  session.ringBytes += Buffer.byteLength(chunk, "utf-8");
  while (session.ringBytes > RING_MAX_BYTES && session.ring.length > 1) {
    const dropped = session.ring.shift();
    if (dropped !== undefined) session.ringBytes -= Buffer.byteLength(dropped, "utf-8");
  }
}

/**
 * Spawn (or, if a session already exists for `tabId`, REPLAY) an interactive
 * terminal. Idempotent per tab: a renderer remount re-invokes spawn with the
 * same `tabId` and receives the buffered scrollback rather than a fresh shell —
 * the PTY survives ChatSidePanel unmount (redesign "state survives" goal).
 */
export function spawnTerminal(options: SpawnTerminalOptions): Promise<SpawnTerminalResult> {
  const tabId = typeof options.tabId === "string" ? options.tabId : "";
  if (!tabId) {
    return Promise.resolve({ ok: false, reason: "bad-request", message: "missing tabId" });
  }
  // The id reaches the shell as AVE_TERMINAL_ID and keys the PTY across every
  // window, so only a well-formed terminal tab id is accepted.
  if (!isTerminalTabId(tabId)) {
    return Promise.resolve({ ok: false, reason: "bad-request", message: "tabId is not a terminal tab id" });
  }
  // A tab another window owns is not this window's to attach to: tab ids are
  // unique per window by construction, so a clash is a contract violation.
  const ownerWindowId = options.ownerWindowId ?? null;
  if (!terminalOwnedBy(tabId, ownerWindowId)) {
    log.warn({ tabId }, "terminal: refused a spawn for a tab another window owns");
    return Promise.resolve({ ok: false, reason: "bad-request", message: "terminal tab belongs to another window" });
  }
  if (terminalShutdownStarted) {
    return Promise.resolve({
      ok: false,
      reason: "spawn-failed",
      message: "Terminal shutdown is already in progress",
    });
  }

  // Idempotent replay for a remounting renderer.
  const existing = sessions.get(tabId);
  if (existing && !existing.exited) {
    if (existing.ring.length > 0) {
      _emit("data", { tabId, chunk: existing.ring.join("") }, existing.ownerWindowId);
    }
    return Promise.resolve({ ok: true, tabId, replayed: true });
  }

  // Reserve the tab before the first async boundary. Concurrent renderer IPC
  // calls for one tab must share the in-flight spawn; otherwise both can create
  // a PTY and the later sessions.set() strands the first process and its HOME.
  const inFlight = terminalSpawnsInFlight.get(tabId);
  if (inFlight) {
    return inFlight.promise.then((result) =>
      result.ok ? { ok: true, tabId, replayed: true } : result,
    );
  }

  let resolveTracked!: (result: SpawnTerminalResult) => void;
  let rejectTracked!: (reason?: unknown) => void;
  const tracked = new Promise<SpawnTerminalResult>((resolve, reject) => {
    resolveTracked = resolve;
    rejectTracked = reject;
  });
  const owner: TerminalSpawnInFlight = { promise: tracked, cancelled: false, ownerWindowId };
  terminalSpawnsInFlight.set(tabId, owner);
  void spawnNewTerminal(options, tabId, owner).then(
    (result) => {
      if (terminalSpawnsInFlight.get(tabId) === owner) terminalSpawnsInFlight.delete(tabId);
      resolveTracked(result);
    },
    (err) => {
      if (terminalSpawnsInFlight.get(tabId) === owner) terminalSpawnsInFlight.delete(tabId);
      rejectTracked(err);
    },
  );
  return tracked;
}

async function spawnNewTerminal(
  options: SpawnTerminalOptions,
  tabId: string,
  owner: TerminalSpawnInFlight,
): Promise<SpawnTerminalResult> {
  if (owner.cancelled) {
    return { ok: false, reason: "spawn-failed", message: "terminal spawn cancelled" };
  }

  // ── FAIL CLOSED: an interactive arbitrary-command shell may spawn ONLY when
  // the active OS sandbox contains shell effects (filesystem + process). No
  // plain-spawn fallback (No-Fallback rule) — a terminal outside shell
  // confinement is strictly more dangerous than a one-shot bash tool. ──
  if (!isAsrtSandboxActive() || !isActiveSandboxShellContained()) {
    return {
      ok: false,
      reason: "not-shell-contained",
      message:
        "Terminal requires the OS tool sandbox with filesystem and process isolation active " +
        "(Settings → Permissions). Unavailable on a degraded / disabled / " +
        "partial sandbox host.",
    };
  }

  // Anti-DoS: bound concurrent PTYs. A remount of an EXISTING tab was replayed
  // above and does not reach here; only a genuinely NEW session counts.
  if (sessions.size + terminalSpawnsInFlight.size > MAX_TERMINALS) {
    return {
      ok: false,
      reason: "too-many-terminals",
      message: `Too many terminal sessions open (max ${MAX_TERMINALS}). Close one and retry.`,
    };
  }

  // cwd ANCHORS the write-jail: default = workspace root, never $HOME; a
  // renderer-supplied cwd is validated absolute + within the workspace root.
  const resolvedCwd = resolveTerminalCwd(options.cwd);
  if (!resolvedCwd.ok) {
    return { ok: false, reason: "bad-request", message: resolvedCwd.message };
  }
  const cwd = resolvedCwd.cwd;

  const cols = clampDim(options.cols, 80, MAX_COLS);
  const rows = clampDim(options.rows, 24, MAX_ROWS);

  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  // No initializer, matching `sandboxHome` above: the catch below returns, so
  // reaching past the try means both were assigned. A no-op placeholder would
  // be dead — never observable — and would read as if a missing cleanup were a
  // supported state (CodeQL: useless assignment to local variable).
  let cleanupSandboxHome: () => void;
  try {
    sandboxHome = createSandboxProcessHome();
    let homeCleanupRequested = false;
    cleanupSandboxHome = () => {
      if (homeCleanupRequested) return;
      homeCleanupRequested = true;
      sandboxHome.cleanup();
    };
    owner.cleanupSandboxHome = cleanupSandboxHome;
  } catch (err) {
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Could not create isolated terminal HOME: ${errorMessage(err)}`,
    };
  }
  const tempDir = join(sandboxHome.path, "tmp");
  try {
    mkdirSync(tempDir, { mode: 0o700 });
  } catch (err) {
    cleanupSandboxHome();
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Could not create isolated terminal temp directory: ${errorMessage(err)}`,
    };
  }

  // Command-block markers: the integration file goes into this terminal's own
  // sandbox HOME, never the user's. A HOME that cannot take one small file is
  // not a HOME the shell can use either, so a write failure fails the spawn.
  // The nonce authenticates this terminal's markers (shell-integration.ts):
  // only the startup file and the tracker know it, and it is never logged.
  const shell = resolveLoginShell();
  const markerNonce = randomBytes(16).toString("hex");
  let integrationEnv: Record<string, string>;
  try {
    integrationEnv = installShellIntegration(sandboxHome.path, shell, {
      nonce: markerNonce,
      sandboxEnv: sandboxHome.env,
    }).env;
  } catch (err) {
    cleanupSandboxHome();
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Could not write terminal shell integration: ${errorMessage(err)}`,
    };
  }

  // Filesystem jail (mirrors worker-spawn): write = cwd ∪ authorized dirs;
  // read = jail ∪ cwd; denyRead = the RESTATED shared sensitive read floor (a
  // per-command denyRead REPLACES ASRT's boot array, so omit-it-and-leak).
  // denyWrite = the RESTATED sensitive WRITE floor (shell-rc / ~/.ssh / ~/.config
  // / LaunchAgents / cron persistence + the read floor): ASRT applies it as
  // denyWithinAllow with PRECEDENCE over allowWrite, so even if the write-jail
  // ever covers $HOME the shell can never write these re-exec vectors.
  const allowWrite = [
    ...deriveSandboxWritePaths({ allowedDirectories: [cwd] }),
    sandboxHome.path,
  ];
  const allowRead = [cwd, ...allowWrite];
  const denyRead = getDefaultSensitiveReadDenyPaths();
  const denyWrite = getDefaultSensitiveWriteDenyPaths();

  let wrapped = false;
  try {
    const cmdline = buildShellCommand(shell, tempDir);
    const { argv, env } = await wrapWorkerCommand(cmdline, {
      filesystem: { allowWrite, allowRead, denyRead, denyWrite },
    });
    wrapped = true;
    if (owner.cancelled) throw new Error("terminal spawn cancelled");

    const [cmd, ...wrappedArgs] = argv;
    if (cmd === undefined) {
      throw new Error("ASRT returned an empty argv for the terminal wrap");
    }

    // Secret-stripped env + only the ASRT proxy/CA keys ASRT actually changed,
    // plus the TTY hints the shell/xterm expect. buildSandboxedChildEnv already
    // strips AVE_*/*_API_KEY/GITHUB_TOKEN/AWS_* and overlays the proxy.
    const childEnv: Record<string, string> = {
      ...buildSandboxedChildEnv(env, { ...sandboxHome.env, ...integrationEnv }),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      // The terminal's stable id, wherever its view is mounted (side panel or
      // a main pane): what a script or an agent in the shell names it by.
      // Added after the strip above, which removes inherited AVE_* keys.
      AVE_TERMINAL_ID: tabId,
    };

    const { spawn: ptySpawn } = await loadPty();
    if (owner.cancelled) throw new Error("terminal spawn cancelled");
    const pty = ptySpawn(cmd, wrappedArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: childEnv,
    });

    const session: TerminalSession = {
      pty,
      ownerWindowId: options.ownerWindowId ?? null,
      blocks: new TerminalBlockTracker({ nonce: markerNonce }),
      ring: [],
      ringBytes: 0,
      disposeData: () => {},
      disposeExit: () => {},
      cleanupSandboxHome,
      forceKillTimer: null,
      closing: false,
      exited: false,
    };

    const dataSub = pty.onData((chunk) => {
      // The view and the replay ring get the tracker's display text: the
      // same bytes with the marker nonce removed (and an incomplete OSC held
      // until it completes).
      const display = session.blocks.recordOutput(chunk);
      if (!display) return;
      pushRing(session, display);
      _emit("data", { tabId, chunk: display }, session.ownerWindowId);
    });
    session.disposeData = () => dataSub.dispose();

    const exitSub = pty.onExit(({ exitCode, signal }) => {
      session.exited = true;
      // The blocks outlive the shell (the tab still shows its output) until
      // the tab closes or a new shell replaces them.
      session.blocks.recordExit();
      if (session.forceKillTimer !== null) clearTimeout(session.forceKillTimer);
      _emit("exit", { tabId, exitCode, signal }, session.ownerWindowId);
      // Per-command ASRT state decrement (mirrors worker-spawn cleanupOnce) +
      // drop the session so a later spawn for the same tab starts fresh.
      void cleanupAsrtSandboxAfterCommand();
      session.cleanupSandboxHome();
      session.disposeData();
      session.disposeExit();
      if (sessions.get(tabId) === session) sessions.delete(tabId);
    });
    session.disposeExit = () => exitSub.dispose();

    sessions.set(tabId, session);
    registerTerminalBlockTracker(tabId, session.blocks, options.ownerWindowId ?? null);
    log.info({ tabId, cwd, cols, rows, pid: pty.pid }, "terminal: spawned sandboxed PTY");
    return { ok: true, tabId, replayed: false };
  } catch (err) {
    // FAIL CLOSED: the wrap succeeded but pty.spawn threw → decrement the ASRT
    // per-command state so a failed spawn leaves no lingering ref (mirrors
    // worker-spawn's catch).
    if (wrapped) void cleanupAsrtSandboxAfterCommand();
    cleanupSandboxHome();
    const message = errorMessage(err);
    if (owner.cancelled) {
      log.info({ tabId }, "terminal: cancelled in-flight spawn");
    } else {
      log.error({ tabId, err: message }, "terminal: spawn failed");
    }
    return { ok: false, reason: "spawn-failed", message };
  }
}

/**
 * Whether `ownerWindowId` may act on `tabId`: no live or starting terminal has
 * that id, or the one that has it is this window's.
 */
export function terminalOwnedBy(tabId: string, ownerWindowId: number | null): boolean {
  const session = sessions.get(tabId);
  if (session && !session.exited) return session.ownerWindowId === ownerWindowId;
  const inFlight = terminalSpawnsInFlight.get(tabId);
  if (inFlight && !inFlight.cancelled) return inFlight.ownerWindowId === ownerWindowId;
  return true;
}

/** Forward user keystrokes to the PTY. No-op for an unknown/exited tab. An
 * oversized single write (> {@link MAX_INPUT_BYTES}) is DROPPED — a hostile or
 * buggy renderer must not flood an unbounded buffer into the shell (anti-DoS). */
export function writeTerminal(tabId: string, data: string): void {
  const session = sessions.get(tabId);
  if (!session || session.exited || session.closing) return;
  if (typeof data !== "string") return;
  const bytes = Buffer.byteLength(data, "utf-8");
  if (bytes > MAX_INPUT_BYTES) {
    log.warn({ tabId, bytes, max: MAX_INPUT_BYTES }, "terminal: dropped oversized input write");
    return;
  }
  session.blocks.recordInput(data);
  session.pty.write(data);
}

/** Resize the PTY (FitAddon / ResizeObserver). Clamped, no-op for unknown tab. */
export function resizeTerminal(tabId: string, cols: number, rows: number): void {
  const session = sessions.get(tabId);
  if (!session || session.exited || session.closing) return;
  session.pty.resize(clampDim(cols, 80, MAX_COLS), clampDim(rows, 24, MAX_ROWS));
}

/** Kill + tear down one terminal (tab close / teardown). Idempotent. */
export function killTerminal(tabId: string): void {
  unregisterTerminalBlockTracker(tabId);
  const inFlight = terminalSpawnsInFlight.get(tabId);
  if (inFlight) {
    inFlight.cancelled = true;
    inFlight.cleanupSandboxHome?.();
  }
  const session = sessions.get(tabId);
  if (!session || session.closing) return;
  session.closing = true;
  session.disposeData();
  try {
    if (!session.exited) session.pty.kill();
  } catch (err) {
    log.warn({ tabId, err: errorMessage(err) }, "terminal: kill failed");
  }
  if (session.exited) return;
  session.forceKillTimer = setTimeout(() => {
    if (session.exited) return;
    try {
      // node-pty defaults to SIGHUP. A shell may trap/ignore it, so retain
      // ownership until this definitive escalation or the exit callback.
      session.pty.kill("SIGKILL");
    } catch (err) {
      // Keep the session registered even when signal delivery fails. Losing
      // the only owner here would allow a replacement PTY while this one may
      // still be alive and would strand its ASRT/HOME finalizers.
      log.warn(
        { tabId, err: errorMessage(err) },
        "terminal: force kill failed",
      );
    }
  }, 3_000);
}

/** Force-kill every live terminal (app shutdown). Returns the count killed. */
export function killAllTerminals(): number {
  const ids = [...sessions.entries()]
    .filter(([, session]) => !session.closing)
    .map(([id]) => id);
  for (const id of ids) killTerminal(id);
  return ids.length;
}

/**
 * App-shutdown path: signal every PTY immediately and wait only until all exit
 * callbacks run or the bounded deadline expires. Unlike a tab close, shutdown
 * cannot rely on a later timer after Electron has already quit.
 */
export async function forceKillAllTerminalsForShutdown(timeoutMs = 1_000): Promise<number> {
  terminalShutdownStarted = true;
  const startedAt = Date.now();
  const inFlight = [...terminalSpawnsInFlight.values()];
  for (const owner of inFlight) {
    owner.cancelled = true;
    owner.cleanupSandboxHome?.();
  }

  // Snapshot and signal live PTYs synchronously before yielding to any pending
  // setup promise. Shutdown must not give an existing shell extra runtime just
  // because another tab is still resolving its wrapper/native module.
  const sessionsToKill = [...sessions.entries()].filter(([, session]) => !session.exited);
  for (const [tabId, session] of sessionsToKill) {
    session.closing = true;
    session.disposeData();
    if (session.forceKillTimer !== null) {
      clearTimeout(session.forceKillTimer);
      session.forceKillTimer = null;
    }
    try {
      session.pty.kill("SIGKILL");
    } catch (err) {
      // Keep ownership until a late exit callback; the bounded wait below
      // prevents a broken native PTY from hanging application shutdown.
      log.warn(
        { tabId, err: errorMessage(err) },
        "terminal: shutdown SIGKILL failed",
      );
    }
  }
  if (sessionsToKill.length === 0 && inFlight.length === 0) return 0;

  let inFlightSettled = inFlight.length === 0;
  if (!inFlightSettled) {
    void Promise.allSettled(inFlight.map((owner) => owner.promise)).then(() => {
      inFlightSettled = true;
    });
  }

  await new Promise<void>((resolve) => {
    const poll = (): void => {
      const liveSessionsExited = sessionsToKill.every(([, session]) => session.exited);
      if (inFlightSettled && liveSessionsExited) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        if (!inFlightSettled) {
          log.warn(
            { unresolved: terminalSpawnsInFlight.size, timeoutMs },
            "terminal: shutdown deadline expired with in-flight spawns",
          );
        }
        const unresolvedSessions = sessionsToKill.filter(([, session]) => !session.exited).length;
        if (unresolvedSessions > 0) {
          log.warn(
            { unresolved: unresolvedSessions, timeoutMs },
            "terminal: shutdown deadline expired with live PTYs",
          );
        }
        resolve();
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  return sessionsToKill.length;
}

/** Test-only: number of live sessions. */
export function __terminalSessionCountForTest(): number {
  return sessions.size;
}

/** Test-only: reset module state between tests. */
export function __resetTerminalsForTest(): void {
  for (const session of sessions.values()) {
    if (session.forceKillTimer !== null) clearTimeout(session.forceKillTimer);
    session.disposeData();
    session.disposeExit();
  }
  sessions.clear();
  for (const owner of terminalSpawnsInFlight.values()) owner.cancelled = true;
  terminalSpawnsInFlight.clear();
  terminalShutdownStarted = false;
  __resetTerminalBlocksForTest();
  _emit = () => {};
}
