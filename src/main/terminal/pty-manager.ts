/** Host terminals belong to visible tabs; confined terminals belong to conversations. */
import { randomBytes } from "node:crypto";
import { beginAgentTerminalObservation, type AgentTerminalObservationLease } from "../../tools/agent-terminal-observation.js";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { IPty } from "node-pty";
import { createLogger } from "../../lib/logger.js";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { assertSrtWinSpawnIntegrity } from "../../permissions/srt-win-integrity.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { buildHostShellChildEnv, buildSandboxedChildEnv } from "../../tools/safe-env.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  wrapTerminalCommand,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  isShellSandboxActive,
  sandboxTempEnvLaunch,
  type SandboxWrapResult,
} from "../../permissions/asrt-sandbox.js";
import { openEgressInvocation } from "../../permissions/egress-invocations.js";
import { getSandboxGeneration, isActiveSandboxShellContained } from "../../permissions/sandbox-capability.js";
import { deriveSandboxWritePaths } from "../../permissions/sandbox-write-jail.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../../permissions/sensitive-paths.js";
import { isPathAllowed } from "../../permissions/allowed-directories.js";
import { listAuthorizedWorkspaceProjects } from "../project-root-authorization.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import { errorMessage } from "../../shared/error-message.js";
import { installShellIntegration, TERMINAL_EDIT_LINE_QUERY } from "./shell-integration.js";
import {
  forwardResizeToSandboxedPtyRelay,
  readSandboxedShell,
  readTerminalForeground,
  type SandboxedShellReading,
  type TerminalForegroundOptions,
  type TerminalForegroundReading,
} from "./shell-process.js";
import type { TerminalTtyHandoff } from "./terminal-tty-handoff.js";
import { terminalNeedsInnerPty, terminalNeedsOwnTtyGrant } from "./terminal-tty-platform.js";
import {
  TerminalBlockTracker,
  registerTerminalBlockTracker,
  unregisterTerminalBlockTracker,
  __resetTerminalBlocksForTest,
  type TerminalPromptState,
} from "./terminal-blocks.js";
import { isTerminalTabId } from "../../shared/tab-id.js";
import { hasOnlyTypeableCharacters, MAX_TERMINAL_COMMAND_CHARS } from "../../shared/terminal-command-text.js";

import { prepareHostShellIntegration } from "./host-shell-integration.js";
import { resolveManualShell } from "./manual-shell.js";
import { prepareTerminalGitPolicyCheck, terminalSandboxWindowNotice } from "./terminal-sandbox-policy.js";
import { t } from "../../i18n/index.js";
import { isTerminalLane, sameTerminalSession, terminalLaneKey, type TerminalSessionRef, type TerminalSessionInfo, type TerminalSpawnRequest, type TerminalSpawnResult, type TerminalMutationResult, type TerminalDataEvent, type TerminalExitEvent } from "../../shared/terminal-session.js";

const log = createLogger("ave");

/** Scrollback ring cap per session (bytes). Bounds main-process memory + the replay payload sent to a remounting renderer. */
const RING_MAX_BYTES = 256 * 1024;
/** Hard bounds on the PTY geometry a renderer may request (anti-DoS). */
const MIN_DIM = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 1000;
/** Anti-DoS: max visible host terminal tabs. A new tab past this is refused so an arbitrary/looping tabId can never spawn unbounded PTYs. */
const MAX_HOST_TERMINALS = 16;
/** Anti-DoS: max conversation-owned isolated PTYs. A separate budget, so hidden conversations never block the user's own terminal tabs. */
const MAX_CONVERSATION_TERMINALS = 16;

/** Live sessions plus spawns in flight of one lane, each against its own budget. */
function laneAtCapacity(lane: SpawnTerminalOptions["lane"]): boolean {
  const suffix = `/${lane}`;
  let count = 0;
  for (const key of sessions.keys()) if (key.endsWith(suffix)) count++;
  for (const key of terminalSpawnsInFlight.keys()) if (key.endsWith(suffix)) count++;
  return count > (lane === "manual" ? MAX_HOST_TERMINALS : MAX_CONVERSATION_TERMINALS);
}
/** Anti-DoS: max bytes accepted for a single {@link writeTerminal} (keystroke / paste) forward. An oversized write is dropped rather than streamed to the PTY. */
const MAX_INPUT_BYTES = 1024 * 1024;

export interface SpawnTerminalOptions extends TerminalSpawnRequest {
  /** Derived from the authenticated host renderer, never renderer payloads. */
  readonly ownerWindowId?: number | null;
}
export type SpawnTerminalResult = TerminalSpawnResult;

/** main→renderer emitter. Registered ONCE by the terminal IPC domain, which fans out to the app window(s) via
 * safe-send. Kept as an injected sink so this module stays free of `electron` imports (unit-testable in node). */
export type TerminalEmit = (
  event: "data" | "exit",
  payload: TerminalDataEvent | TerminalExitEvent,
  /** The window that owns the terminal; the only one its output goes to (null: no window). */
  ownerWindowId: number | null,
) => void;

let _emit: TerminalEmit = () => {};
let terminalInspectionForTest: TerminalEmit | undefined;
/** Test-only main-process inspection for native confinement acceptance fixtures. */
export function _setTerminalInspectionForTest(inspect: TerminalEmit): void {
  terminalInspectionForTest = inspect;
}

/** Register the main→renderer output sink (called once at IPC registration). */
export function setTerminalEmitter(fn: TerminalEmit): void {
  _emit = fn;
}

interface TerminalSession {
  info: TerminalSessionInfo;
  pty: IPty;
  /** The window that spawned it. Only that window may attach, type, resize or close it. */
  ownerWindowId: number | null;
  /** Command blocks parsed from this PTY's output (terminal-blocks.ts). */
  blocks: TerminalBlockTracker;
  /** Program name of the login shell this terminal runs (`zsh`, `bash`, …). */
  shellName: string;
  /** Linux: the shell runs on a pty of its own inside the sandbox (terminal-inner-pty.ts), so it
   * is checked through the sandbox's process tree and a resize is forwarded to its pty relay. */
  innerPty: boolean;
  /** Linux refuses agent typing when new Git controls need fresh deny mounts. */
  gitPolicyChanged?: () => boolean;
  /** A resize forward to the inner pty's relay is running, and whether another resize came in meanwhile. */
  resizeForward: { running: boolean; again: boolean };
  /** FIFO scrollback chunks, capped to {@link RING_MAX_BYTES}. */
  ring: string[];
  ringBytes: number;
  /** Host policy notices survive bounded terminal scrollback eviction. */
  hostNotices: readonly string[];
  disposeData: () => void;
  disposeExit: () => void;
  /** Aborted when the tab closes or its shell ends: denies the tab's pending egress asks at once instead of leaving their banners to time out. */
  egressAbort?: AbortController;
  /** Private lifetime token: observations disclose decisions, never proxy authority. */
  egressToken?: string;
  observation?: TerminalCommandObservation;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  cleanupIntegration?: () => void;
  closing: boolean;
  exited: boolean;
  /** Settles when the shell has exited and the session is dropped. */
  gone: Promise<void>;
  markGone: () => void;
}

interface TerminalCommandObservation {
  readonly lease: AgentTerminalObservationLease;
  readonly blockId: number;
  readonly command: string;
  readonly cwd: string;
  readonly inputGeneration: number;
  subscription?: { flush(): void; dispose(): void };
  stop(): void;
}

function revokeTerminalObservation(session: TerminalSession): void {
  const observation = session.observation;
  observation?.stop();
  observation?.lease.revoke();
}

function stopTerminalObservation(session: TerminalSession, options?: { flushPending: boolean }): void {
  const observation = session.observation;
  if (options?.flushPending) observation?.subscription?.flush();
  observation?.stop();
  observation?.lease.finish(null, "interrupted");
}

/** Read only the host-bound authenticated block; neither lane nor timing attributes output. */
function terminalObservationBlock(session: TerminalSession) {
  const observation = session.observation;
  if (!observation) return null;
  if (session.blocks.userInputGeneration() !== observation.inputGeneration) {
    revokeTerminalObservation(session);
    return null;
  }
  const block = session.blocks.get(observation.blockId);
  if (!block) return null;
  if (block.source !== "osc133" || block.command !== observation.command
    || block.cwd === null || canonicalizePathForMatch(block.cwd) !== observation.cwd) {
    revokeTerminalObservation(session);
    throw new Error("Terminal observation command does not match its admitted block.");
  }
  return block;
}

function refreshTerminalObservation(session: TerminalSession): void {
  const observation = session.observation;
  const block = terminalObservationBlock(session);
  if (observation && block?.status === "done") {
    observation.stop();
    observation.lease.finish(block.exitCode, block.exitCode === null ? "interrupted" : undefined);
  }
}

interface TerminalSpawnInFlight {
  promise: Promise<SpawnTerminalResult>;
  ownerWindowId: number | null;
  cancelled: boolean;
  /** Aborted with the spawn: ends a wait that would otherwise outlive the cancel (the macOS tty handoff
   * waits up to its own timeout for the trampoline, longer than a restore waits for the cancelled spawn). */
  abort: AbortController;
  cleanupResources?: () => void;
}

/** Cancel an in-flight spawn and release everything it has acquired so far. */
function cancelInFlightSpawn(owner: TerminalSpawnInFlight): void {
  owner.cancelled = true;
  owner.abort.abort(new Error("terminal spawn cancelled"));
  owner.cleanupResources?.();
}

interface LogicalTerminalTab { ownerWindowId: number | null; initialCwd?: string }
const logicalTabs = new Map<string, LogicalTerminalTab>();
interface ConversationTerminal { readonly tabId: string; readonly ownerWindowId: number | null; readonly initialCwd?: string }
/** Main-only ownership. Internal terminal ids never identify workspace tabs. */
const conversationTerminals = new Map<string, ConversationTerminal>();
const retiringConversationTerminals = new Map<string, Set<Promise<unknown>>>();
function conversationForTerminal(tabId: string): ConversationTerminal | undefined {
  return [...conversationTerminals.values()].find((owner) => owner.tabId === tabId);
}
function isConversationTerminalId(tabId: string): boolean {
  const key = terminalLaneKey({ tabId, lane: "agent" });
  return conversationForTerminal(tabId) !== undefined || sessions.has(key) || terminalSpawnsInFlight.has(key);
}
function allocateConversationTerminalId(): string {
  let tabId: string;
  do { tabId = `terminal:${randomBytes(4).toString("hex")}-1`; }
  while (logicalTabs.has(tabId) || isConversationTerminalId(tabId));
  return tabId;
}

/** Only host output is delivered over the terminal renderer bridge. */
function emitTerminal(event: "data" | "exit", payload: TerminalDataEvent | TerminalExitEvent, ownerWindowId: number | null): void {
  terminalInspectionForTest?.(event, payload, ownerWindowId);
  if (payload.lane === "manual") _emit(event, payload, ownerWindowId);
}
const sessions = new Map<string, TerminalSession>();
function sessionInfo(session: TerminalSession): TerminalSessionInfo {
  const integrated = session.blocks.isIntegrated();
  const cwd = integrated ? session.blocks.currentCwd() : null;
  return { ...session.info, currentCwd: cwd, cwdSource: cwd === null ? "unavailable" : "shell-marker", shellIntegration: integrated };
}

function agentSession(ref: TerminalSessionRef, ownerWindowId: number): TerminalSession | undefined {
  if (ref.lane !== "agent" || process.platform === "win32" || !isShellSandboxActive() || !isActiveSandboxShellContained()) return undefined;
  const session = sessions.get(terminalLaneKey(ref));
  return session && !session.exited && !session.closing && session.ownerWindowId === ownerWindowId
    && sameTerminalSession(session.info, ref) && session.info.lane === "agent"
    && session.info.sandboxGeneration === getSandboxGeneration() ? session : undefined;
}
const terminalSpawnsInFlight = new Map<string, TerminalSpawnInFlight>();
let terminalShutdownStarted = false;

/** Lazy, cached ESM import of the native (external, asarUnpack'd) node-pty. Kept dynamic like ASRT's
 * loadSandboxManager so merely importing this module pulls no native addon into non-terminal contexts. */
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

/** Resolve the interactive login shell. Never derived from workspace content; only `$SHELL` (validated absolute) or a per-platform default. */
function resolveLoginShell(): string {
  const envShell = process.env.SHELL;
  if (typeof envShell === "string" && isAbsolute(envShell)) return envShell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/** Resolve + VALIDATE the working directory that ANCHORS the write-jail. Default (no request): the workspace root; `process.cwd()`, anchored to `~/.ave/workspace` at boot (ensureWorkspaceCwd); NEVER `$HOME`, whose jail would let the shell write shell-rc / login-agent persistence files. A renderer-supplied cwd is admitted only beneath an authorized workspace project:
 * the default workspace or a user-approved additional project root. The host's project resolver owns that set; renderer paths never add a grant. Canonicalization resolves symlink escapes before the segment-aligned check, using the same canonical form as the resulting sandbox write-jail. HOME itself remains an invalid jail anchor even if it is an authorized project. */
function resolveTerminalCwd(
  requested: string | undefined,
): { ok: true; cwd: string } | { ok: false; message: string } {
  const candidate = requested ?? process.cwd();
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    return { ok: false, message: "terminal cwd must be an absolute path" };
  }
  const canonical = canonicalizePathForMatch(candidate);
  const forMatch = caseFoldForMatch(canonical);
  if (forMatch === caseFoldForMatch(canonicalizePathForMatch(homedir()))) {
    return { ok: false, message: "terminal cwd must not be the user home directory" };
  }
  const directories = listAuthorizedWorkspaceProjects().map((project) =>
    caseFoldForMatch(canonicalizePathForMatch(project.projectRoot)),
  );
  if (!isPathAllowed(forMatch, { directories })) {
    return { ok: false, message: "terminal cwd must be within an authorized workspace project" };
  }
  return { ok: true, cwd: canonical };
}

/** The command string ASRT runs under its `-c` wrapper: exec the interactive login shell so it takes over the PTY node-pty allocated for the sandbox
 * wrapper process (fd 0/1/2 inherit down sandbox-exec/bwrap → shell), or, on Linux, `innerPtyCommand` runs it on a pty of its own inside the sandbox. */
function buildShellCommand(
  shell: string,
  tempDir: string,
  innerPtyCommand?: (shell: string, launch: { command: string; args: string[] }) => string,
): string {
  // `exec` replaces the wrapper's `/bin/bash -c` shell so there is no extra process layer; `-l -i` = login + interactive (prompt, job control, rc). The temp directory is set inside the wrap, because ASRT writes
  // its own `TMPDIR=` there that no spawn env outranks: the sandbox temp root, which this terminal is neither granted nor allowed to read. Its own, under its HOME, is both; as the shell tool's bootstrap does.
  const launch = sandboxTempEnvLaunch(tempDir, shell, ["-l", "-i"]);
  if (innerPtyCommand !== undefined) return innerPtyCommand(shell, launch);
  return `exec ${[launch.command, ...launch.args].map(shellQuote).join(" ")}`;
}

function pushRing(session: TerminalSession, chunk: string): void {
  if (Buffer.byteLength(chunk, "utf-8") > RING_MAX_BYTES) {
    chunk = Buffer.from(chunk, "utf-8").subarray(-(RING_MAX_BYTES - 3)).toString("utf-8");
  }
  session.ring.push(chunk);
  session.ringBytes += Buffer.byteLength(chunk, "utf-8");
  while (session.ringBytes > RING_MAX_BYTES && session.ring.length > 1) {
    const dropped = session.ring.shift();
    if (dropped !== undefined) session.ringBytes -= Buffer.byteLength(dropped, "utf-8");
  }
}

/** Spawn or replay one interactive terminal lane. A renderer remount with the same tab and
 * lane receives buffered scrollback rather than a fresh shell; the PTY survives view unmount. */
export function spawnTerminal(options: SpawnTerminalOptions): Promise<SpawnTerminalResult> {
  return spawnTerminalBefore(options, Date.now() + RETIRING_WAIT_MS);
}

/**
 * {@link spawnTerminal} with one deadline for every wait on a closing shell
 * under this id. A cancelled in-flight spawn registers no session (it
 * re-checks cancellation after every await, and nothing between the last
 * check and registering the session is async), so the wait after it finds
 * nothing closing today; the shared deadline keeps the whole spawn inside
 * one bound should that ever change.
 */
function spawnTerminalBefore(options: SpawnTerminalOptions, deadline: number): Promise<SpawnTerminalResult> {
  const tabId = typeof options.tabId === "string" ? options.tabId : "";
  if (!tabId) {
    return Promise.resolve({ ok: false, reason: "bad-request", message: "missing tabId" });
  }
  // The id reaches the shell as AVE_TERMINAL_ID and keys the PTY across every window, so only a well-formed terminal tab id is accepted.
  if (!isTerminalTabId(tabId)) {
    return Promise.resolve({ ok: false, reason: "bad-request", message: "tabId is not a terminal tab id" });
  }
  if (!isTerminalLane(options.lane)) return Promise.resolve({ ok: false, reason: "bad-request", message: "invalid terminal lane" });
  const key = terminalLaneKey(options);
  const record = options.lane === "agent" ? conversationForTerminal(tabId) : logicalTabs.get(tabId);
  if (options.lane === "agent" && !record) return Promise.resolve({ ok: false, reason: "no-terminal", message: "terminal has no owning conversation" });
  if (options.lane === "manual" && isConversationTerminalId(tabId)) return Promise.resolve({ ok: false, reason: "bad-request", message: "terminal identity is reserved for a conversation" });
  // A tab another window owns is not this window's to attach to: tab ids are unique per window by construction, so a clash is a contract violation.
  const ownerWindowId = options.ownerWindowId ?? null;
  if (record && record.ownerWindowId !== ownerWindowId) {
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

  // Only an authenticated manual spawn can reserve a logical tab, before any await.
  if (!record) {
    if (logicalTabs.size >= MAX_HOST_TERMINALS) return Promise.resolve({ ok: false, reason: "too-many-terminals", message: "too many terminal tabs" });
    logicalTabs.set(tabId, { ownerWindowId, ...(options.cwd !== undefined ? { initialCwd: options.cwd } : {}) });
  }

  // A shell still closing under this id (its window closed, and that window's saved layout is now being restored) is waited out, then a new one starts: replaying the dying one would
  // attach the tab to a shell about to exit. The wait is held under its window, so the window closing (or the tab closing) during it cancels it rather than starting a shell for no one.
  const closing = closingUnder(key);
  if (closing) {
    const waiter = addSpawnWaiter(key, ownerWindowId);
    return waitOutClosing(closing, deadline, waiter.cancelledSignal).then((outcome) => {
      removeSpawnWaiter(key, waiter);
      if (outcome === "cancelled" || waiter.cancelled) {
        return { ok: false, reason: "spawn-failed", message: "terminal spawn cancelled" } as const;
      }
      // Its own reason, not a cwd refusal: the renderer must not answer it by starting somewhere else.
      return outcome === "gone"
        ? spawnTerminalBefore(options, deadline)
        : { ok: false, reason: "still-closing", message: "the previous shell for this tab is still closing" } as const;
    });
  }

  // Idempotent replay for a remounting renderer.
  const existing = sessions.get(key);
  if (existing && !existing.exited) {
    if (existing.info.lane === "agent" && (process.platform === "win32" || !isShellSandboxActive()
      || !isActiveSandboxShellContained() || existing.info.sandboxGeneration !== getSandboxGeneration())) {
      return Promise.resolve({ ok: false, reason: "not-shell-contained", message: "agent terminal containment changed; close and reopen the tab" });
    }
    if (existing.ring.length > 0 || existing.hostNotices.length > 0) {
      emitTerminal("data", { ...existing.info, chunk: `${existing.hostNotices.map(notice => `\r\n${notice}\r\n`).join("")}${existing.ring.join("")}` }, existing.ownerWindowId);
    }
    return Promise.resolve({ ok: true, tabId, replayed: true, session: sessionInfo(existing), blockMarkerToken: existing.blocks.viewToken });
  }

  // Reserve the tab before the first async boundary. Concurrent renderer IPC calls for one tab must share the
  // in-flight spawn; otherwise both can create a PTY and the later sessions.set() strands the first process and its HOME.
  const inFlight = terminalSpawnsInFlight.get(key);
  if (inFlight) {
    return inFlight.promise.then((result) =>
      result.ok ? { ...result, replayed: true } : result,
    );
  }

  let resolveTracked!: (result: SpawnTerminalResult) => void;
  let rejectTracked!: (reason?: unknown) => void;
  const tracked = new Promise<SpawnTerminalResult>((resolve, reject) => {
    resolveTracked = resolve;
    rejectTracked = reject;
  });
  const owner: TerminalSpawnInFlight = {
    promise: tracked,
    cancelled: false,
    abort: new AbortController(),
    ownerWindowId,
  };
  terminalSpawnsInFlight.set(key, owner);
  void spawnNewTerminal(options, tabId, owner).then(
    (result) => {
      if (terminalSpawnsInFlight.get(key) === owner) terminalSpawnsInFlight.delete(key);
      resolveTracked(result);
    },
    (err) => {
      if (terminalSpawnsInFlight.get(key) === owner) terminalSpawnsInFlight.delete(key);
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

  if (laneAtCapacity(options.lane)) {
    return { ok: false, reason: "too-many-terminals", message: "too many terminal sessions" };
  }
  if (options.lane === "manual") return spawnManualTerminal(options, owner);
  const key = terminalLaneKey(options);
  const sandboxGeneration = getSandboxGeneration();

  // FAIL CLOSED: an interactive arbitrary-command shell may spawn ONLY when the active OS sandbox contains shell effects (filesystem +
  // process). No plain-spawn fallback (No-Fallback rule) — a terminal outside shell confinement is strictly more dangerous than a one-shot bash tool.
  if (process.platform === "win32" || !isShellSandboxActive() || !isActiveSandboxShellContained()) {
    return {
      ok: false,
      reason: "not-shell-contained",
      message:
        "Terminal requires the OS tool sandbox with filesystem and process isolation active " +
        "(Settings → Permissions). Unavailable on a degraded / disabled / " +
        "partial sandbox host.",
    };
  }

  // Anti-DoS: bound concurrent PTYs. A remount of an EXISTING tab was replayed above and does not reach here; only a genuinely NEW session counts.
  if (laneAtCapacity("agent")) {
    return {
      ok: false,
      reason: "too-many-terminals",
      message: `Too many isolated terminal sessions open (max ${MAX_CONVERSATION_TERMINALS}). End a conversation's shell and retry.`,
    };
  }

  // cwd ANCHORS the write-jail: default = workspace root, never $HOME; a renderer-supplied cwd is validated absolute + within the workspace root.
  const resolvedCwd = resolveTerminalCwd(options.cwd);
  if (!resolvedCwd.ok) {
    return { ok: false, reason: "bad-request", message: resolvedCwd.message };
  }
  const cwd = resolvedCwd.cwd;

  const cols = clampDim(options.cols, 80, MAX_COLS);
  const rows = clampDim(options.rows, 24, MAX_ROWS);

  // Until registration, cancellation owns every acquired resource. A result arriving after disposal is released on arrival, before another effect.
  const cleanups: Array<() => void> = [];
  let disposed = false;
  const addCleanup = (cleanup: () => void): (() => void) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      cleanup();
    };
    if (disposed) release();
    else cleanups.push(release);
    return release;
  };
  const disposeResources = (): void => {
    if (disposed) return;
    disposed = true;
    for (const release of cleanups.reverse()) {
      try {
        release();
      } catch (err) {
        log.warn({ tabId, err: errorMessage(err) }, "terminal: spawn cleanup failed");
      }
    }
    cleanups.length = 0;
  };
  owner.cleanupResources = disposeResources;

  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  // No initializer, matching `sandboxHome` above: the catch below returns, so reaching past the try means both were assigned. A no-op placeholder
  // would be dead; never observable; and would read as if a missing cleanup were a supported state (CodeQL: useless assignment to local variable).
  let cleanupSandboxHome: () => void;
  try {
    sandboxHome = createSandboxProcessHome();
    cleanupSandboxHome = addCleanup(() => sandboxHome.cleanup());
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
    disposeResources();
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Could not create isolated terminal temp directory: ${errorMessage(err)}`,
    };
  }

  // Command-block markers: the integration file goes into this terminal's own sandbox HOME, never the user's. A HOME that cannot take one small file is not a HOME the shell can use
  // either, so a write failure fails the spawn. The nonce authenticates this terminal's markers (shell-integration.ts): only the startup file and the tracker know it, and it is never logged.
  const shell = resolveLoginShell();
  const markerNonce = randomBytes(16).toString("hex");
  let integrationEnv: Record<string, string>;
  let marksPromptEnd: boolean;
  try {
    const integration = installShellIntegration(sandboxHome.path, shell, {
      nonce: markerNonce,
      sandboxEnv: sandboxHome.env,
    });
    integrationEnv = integration.env;
    // fish's integration marks no end of prompt (shell-integration.ts).
    marksPromptEnd = integration.shell !== "fish";
  } catch (err) {
    disposeResources();
    return {
      ok: false,
      reason: "spawn-failed",
      message: `Could not write terminal shell integration: ${errorMessage(err)}`,
    };
  }

  // Filesystem jail (mirrors worker-spawn): write = cwd ∪ authorized dirs; read = jail ∪ cwd; denyRead = the RESTATED shared sensitive read floor (a per-command denyRead REPLACES ASRT's boot array, so omit-it-and-leak). denyWrite = the RESTATED sensitive
  // WRITE floor (shell-rc / ~/.ssh / ~/.config / LaunchAgents / cron persistence + the read floor): ASRT applies it as denyWithinAllow with PRECEDENCE over allowWrite, so even if the write-jail ever covers $HOME the shell can never write these re-exec vectors.
  const allowWrite = [
    ...deriveSandboxWritePaths({ allowedDirectories: [cwd] }),
    sandboxHome.path,
  ];
  const allowRead = [cwd, ...allowWrite];
  const denyRead = getDefaultSensitiveReadDenyPaths();
  const denyWrite = getDefaultSensitiveWriteDenyPaths();

  // macOS only (terminal-tty-handoff.ts): the pty is spawned first, on a trampoline, so the wrap can grant the shell its own terminal by path.
  let handoff: TerminalTtyHandoff | undefined;
  let disposeHandoff: (() => void) | undefined;
  let trampolinePty: IPty | undefined;
  let pendingSession: TerminalSession | undefined;
  let wrapped: SandboxWrapResult | undefined;
  let wrappedProcessStarted = false;
  let wrappedProcessExited = false;
  try {
    let innerPtyCommand: Parameters<typeof buildShellCommand>[2];
    if (terminalNeedsInnerPty()) {
      // Loaded on spawn, like the macOS handoff below.
      const innerPty = await import("./terminal-inner-pty.js");
      owner.abort.signal.throwIfAborted();
      await innerPty.assertInnerPtyRelay();
      owner.abort.signal.throwIfAborted();
      innerPtyCommand = innerPty.innerPtyShellCommand;
    }
    const cmdline = buildShellCommand(shell, tempDir, innerPtyCommand);
    const filesystem = { allowWrite, allowRead, denyRead, denyWrite };
    const ptyOptions = { name: "xterm-256color", cols, rows, cwd };

    let ownTty: string | undefined;
    let renderHandoffScript: ((argv: readonly string[], env: Readonly<Record<string, string>>) => string) | undefined;
    if (terminalNeedsOwnTtyGrant()) {
      // Loaded on spawn, like node-pty: terminal-only code, and the main bundle's initial size has a budget.
      const ttyHandoff = await import("./terminal-tty-handoff.js");
      owner.abort.signal.throwIfAborted();
      renderHandoffScript = ttyHandoff.renderHandoffScript;
      const { spawn: ptySpawn } = await loadPty();
      owner.abort.signal.throwIfAborted();
      const acquiredHandoff = await ttyHandoff.createTerminalTtyHandoff();
      handoff = acquiredHandoff;
      disposeHandoff = addCleanup(() => acquiredHandoff.dispose());
      owner.abort.signal.throwIfAborted();
      const trampoline = ptySpawn(handoff.trampoline.file, [...handoff.trampoline.args], {
        ...ptyOptions,
        env: { ...ttyHandoff.TRAMPOLINE_ENV },
      });
      trampolinePty = trampoline;
      addCleanup(() => trampoline.kill("SIGKILL"));
      ownTty = ttyHandoff.ownPtySlavePath(trampolinePty);
    }

    // Keep egress identity and grant lifetime on this confined shell; approval delivery follows its conversation.
    const egressAbort = new AbortController();
    const conversationSessionId = [...conversationTerminals.entries()].find(([, terminal]) => terminal.tabId === tabId)?.[0];
    if (conversationSessionId === undefined) throw new Error("Confined terminal has no owning conversation");
    const egress = openEgressInvocation({ kind: "terminal", tabId, sessionId: conversationSessionId }, {
      abortSignal: AbortSignal.any([owner.abort.signal, egressAbort.signal]),
    });
    const releaseEgress = addCleanup(() => {
      egressAbort.abort(new Error("terminal shell ended"));
      egress.release();
    });
    wrapped =
      ownTty === undefined
        ? await wrapWorkerCommand(cmdline, { filesystem, commandId: egress.token, denyUnixSockets: true, abortSignal: owner.abort.signal })
        : await wrapTerminalCommand(cmdline, { filesystem, ownTty, commandId: egress.token, denyUnixSockets: true, abortSignal: owner.abort.signal });
    const { argv, env } = wrapped;
    const cleanupWrap = addCleanup(() => { void cleanupAsrtSandboxAfterCommand(); releaseEgress(); });
    const gitPolicyChanged = prepareTerminalGitPolicyCheck(wrapped.filesystemPolicy, wrapped.gitControlSnapshot);
    owner.abort.signal.throwIfAborted();

    const [cmd, ...wrappedArgs] = argv;
    if (cmd === undefined) {
      throw new Error("ASRT returned an empty argv for the terminal wrap");
    }

    // Secret-stripped env + only the ASRT proxy/CA keys ASRT actually changed, plus the TTY hints the
    // shell/xterm expect. buildSandboxedChildEnv already strips AVE_*/*_API_KEY/GITHUB_TOKEN/AWS_* and overlays the proxy.
    const childEnv: Record<string, string> = {
      ...buildSandboxedChildEnv(env, { ...sandboxHome.env, ...integrationEnv }),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      // The terminal's stable id, wherever its view is mounted (side panel or a main pane): what a script or
      // an agent in the shell names it by. Added after the strip above, which removes inherited AVE_* keys.
      AVE_TERMINAL_ID: tabId,
    };

    let pty: IPty;
    if (trampolinePty !== undefined) {
      pty = trampolinePty;
    } else {
      const { spawn: ptySpawn } = await loadPty();
      owner.abort.signal.throwIfAborted();
      assertSrtWinSpawnIntegrity(cmd);
      pty = ptySpawn(cmd, wrappedArgs, { ...ptyOptions, env: childEnv });
      wrappedProcessStarted = true;
      addCleanup(() => pty.kill("SIGKILL"));
    }
    // node-pty starts the shell in its own session, so its pid is the process group the sandbox keeps the ended tab's listener port for.
    if (pty.pid > 1) egress.noteProcessGroup(pty.pid);

    egress.noteProcessGroup(pty.pid);
    let markGone!: () => void;
    const gone = new Promise<void>((resolve) => { markGone = resolve; });
    const sandboxWindowNotice = terminalSandboxWindowNotice();
    const session: TerminalSession = {
      info: { tabId, lane: "agent", terminalSessionId: randomBytes(16).toString("hex"), substrate: "asrt", sandboxGeneration, initialCwd: cwd, currentCwd: null, cwdSource: "unavailable", shellIntegration: false },
      pty,
      ownerWindowId: options.ownerWindowId ?? null,
      blocks: new TerminalBlockTracker({ nonce: markerNonce, marksPromptEnd }),
      shellName: basename(shell).replace(/^-/u, ""),
      innerPty: innerPtyCommand !== undefined,
      ...(gitPolicyChanged === undefined ? {} : { gitPolicyChanged }),
      resizeForward: { running: false, again: false },
      ring: [],
      ringBytes: 0,
      hostNotices: [...(wrapped.notices ?? []), ...(sandboxWindowNotice === undefined ? [] : [sandboxWindowNotice])],
      disposeData: () => {},
      disposeExit: () => {},
      egressAbort,
      egressToken: egress.token,
      forceKillTimer: null,
      closing: false,
      exited: false,
      gone,
      markGone,
    };
    pendingSession = session;

    const dataSub = pty.onData((chunk) => {
      // The view and the replay ring get the tracker's display text: the same bytes with the marker nonce removed (and an incomplete OSC held until it completes).
      const display = session.blocks.recordOutput(chunk);
      refreshTerminalObservation(session);
      if (!display) return;
      pushRing(session, display);
      // Initialization can outlive a renderer mount. Publish its accumulated output only at registration, so
      // an in-flight join misses no prefix and receives no duplicate replay of data already delivered to it.
      if (sessions.get(key) === session) emitTerminal("data", { ...session.info, chunk: display }, session.ownerWindowId);
    });
    session.disposeData = addCleanup(() => dataSub.dispose());

    const exitSub = pty.onExit(({ exitCode, signal }) => {
      wrappedProcessExited = true;
      // A trampoline that exits before it runs the shell fails the spawn: the spawn's own catch cleans up, once, so this handler must not.
      if (pendingSession === session) return;
      session.exited = true;
      stopTerminalObservation(session, { flushPending: true });
      if (session.forceKillTimer !== null) clearTimeout(session.forceKillTimer);
      // Per-command ASRT state decrement (mirrors worker-spawn cleanupOnce) + drop the session so a later spawn for the same tab starts fresh.
      cleanupWrap();
      const finish = (notice?: string): void => {
        if (notice !== undefined) {
          session.hostNotices = [...session.hostNotices, notice];
          const display = session.blocks.recordOutput(`\r\n${notice}\r\n`);
          pushRing(session, display);
          emitTerminal("data", { ...session.info, chunk: display }, session.ownerWindowId);
        }
        // Keep a final cleanup notice in the open block before readers see exit.
        session.blocks.recordExit();
        refreshTerminalObservation(session);
        stopTerminalObservation(session);
        emitTerminal("exit", { ...session.info, exitCode, signal }, session.ownerWindowId);
        cleanupSandboxHome();
        session.disposeData();
        session.disposeExit();
        if (sessions.get(key) === session) sessions.delete(key);
        session.markGone();
      };
      if (wrapped?.cleanupCompleted !== undefined) {
        void wrapped.cleanupCompleted.then(outcome => finish([outcome.notice, outcome.failure].filter(Boolean).join("\n") || undefined), error => {
          log.warn({ tabId, err: errorMessage(error) }, "terminal: sandbox cleanup failed");
          finish(errorMessage(error));
        });
      } else finish();
    });
    session.disposeExit = addCleanup(() => exitSub.dispose());

    if (handoff !== undefined && renderHandoffScript !== undefined) {
      // Subscribed first: the shell starts writing as soon as it is exec'd. A trampoline that dies before reading the fifo ends the wait now, not
      // at the timeout; so does the spawn's cancel (its tab or window closed, or shutdown began), which a restore of the same id is waiting out.
      const trampolineExited = new AbortController();
      const trampolineExitSub = pty.onExit(() => trampolineExited.abort());
      const disposeTrampolineExit = addCleanup(() => trampolineExitSub.dispose());
      try {
        wrappedProcessStarted = true;
        await handoff.deliver(renderHandoffScript(argv, childEnv), {
          signal: AbortSignal.any([trampolineExited.signal, owner.abort.signal]),
        });
        owner.abort.signal.throwIfAborted();
      } finally {
        disposeTrampolineExit();
      }
      disposeHandoff?.();
    }

    owner.abort.signal.throwIfAborted();
    pendingSession = undefined;
    if (sandboxGeneration !== getSandboxGeneration() || !isShellSandboxActive() || !isActiveSandboxShellContained()) throw new Error("terminal sandbox changed during launch");
    sessions.set(key, session);
    registerTerminalBlockTracker(session.info, session.blocks, options.ownerWindowId ?? null);
    if (session.ring.length > 0 || session.hostNotices.length > 0) emitTerminal("data", { ...session.info, chunk: `${session.hostNotices.map(notice => `\r\n${notice}\r\n`).join("")}${session.ring.join("")}` }, session.ownerWindowId);
    // The session now owns its wrap, HOME and subscriptions until exit.
    owner.cleanupResources = undefined;
    cleanups.length = 0;
    log.info({ tabId, cwd, cols, rows, pid: pty.pid }, "terminal: spawned sandboxed PTY");
    return { ok: true, tabId, replayed: false, session: sessionInfo(session), blockMarkerToken: session.blocks.viewToken };
  } catch (err) {
    // Reverse acquisition order detaches listeners before killing the PTY; each release is shared with cancellation and any late setup result.
    disposeResources();
    const notices = [...(wrapped?.notices ?? [])];
    if (wrapped?.cleanupCompleted !== undefined) {
      if (wrappedProcessStarted && !wrappedProcessExited) notices.push(t("sandboxPolicy.cleanupPending"));
      else {
        try {
          const outcome = await wrapped.cleanupCompleted;
          if (outcome.notice !== undefined) notices.push(outcome.notice);
          if (outcome.failure !== undefined) notices.push(outcome.failure);
        } catch (error) {
          notices.push(errorMessage(error));
          log.warn({ tabId, err: errorMessage(error) }, "terminal: spawn cleanup failed");
        }
      }
    }
    const message = [errorMessage(err), ...notices].join("\n");
    if (owner.cancelled) {
      log.info({ tabId }, "terminal: cancelled in-flight spawn");
    } else {
      log.error({ tabId, err: message }, "terminal: spawn failed");
    }
    return { ok: false, reason: "spawn-failed", message };
  }
}

/** A host shell preserves the real profile and owns its temporary integration files. */
async function spawnManualTerminal(options: SpawnTerminalOptions, owner: TerminalSpawnInFlight): Promise<SpawnTerminalResult> {
  const { tabId } = options;
  const key = terminalLaneKey(options);
  let pty: IPty | undefined;
  let disposeData: (() => void) | undefined;
  let disposeExit: (() => void) | undefined;
  let registered = false;
  let integration: ReturnType<typeof prepareHostShellIntegration> | undefined;
  const cleanup = (): void => {
    if (registered) return;
    disposeData?.();
    disposeExit?.();
    try { pty?.kill("SIGKILL"); } finally { integration?.cleanup(); }
  };
  owner.cleanupResources = cleanup;
  try {
    const requestedCwd = options.cwd ?? process.cwd();
    if (!isAbsolute(requestedCwd) || !statSync(requestedCwd).isDirectory()) throw new Error("terminal cwd must be an existing absolute directory");
    const cwd = realpathSync(requestedCwd);
    const launch = resolveManualShell();
    if (!statSync(launch.command).isFile()) throw new Error("terminal interpreter is not a file");
    accessSync(launch.command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    integration = prepareHostShellIntegration(launch, buildHostShellChildEnv({
      TERM: "xterm-256color", COLORTERM: "truecolor",
      ...(process.env.ZDOTDIR === undefined ? {} : { ZDOTDIR: process.env.ZDOTDIR }),
    }));
    const native = await loadPty();
    owner.abort.signal.throwIfAborted();
    pty = native.spawn(integration.command, integration.args, {
      name: "xterm-256color", cwd,
      cols: clampDim(options.cols, 80, MAX_COLS), rows: clampDim(options.rows, 24, MAX_ROWS),
      env: integration.env,
    });
    let markGone!: () => void;
    const gone = new Promise<void>((resolve) => { markGone = resolve; });
    const session: TerminalSession = {
      info: { tabId, lane: "manual", terminalSessionId: randomBytes(16).toString("hex"), substrate: "host", initialCwd: cwd, currentCwd: null, cwdSource: "unavailable", shellIntegration: false, ...(integration.integrationUnavailableReason === undefined ? {} : { integrationUnavailableReason: integration.integrationUnavailableReason }) },
      pty, ownerWindowId: options.ownerWindowId ?? null,
      blocks: new TerminalBlockTracker({ nonce: integration.nonce, marksPromptEnd: integration.marksPromptEnd }),
      shellName: basename(launch.command), innerPty: false,
      resizeForward: { running: false, again: false }, ring: [], ringBytes: 0, hostNotices: [],
      disposeData: () => {}, disposeExit: () => {},
      cleanupIntegration: integration.cleanup,
      forceKillTimer: null, closing: false, exited: false, gone, markGone,
    };
    const dataSub = pty.onData((chunk) => {
      const display = session.blocks.recordOutput(chunk);
      if (!display) return;
      pushRing(session, display);
      if (sessions.get(key) === session) emitTerminal("data", { ...session.info, chunk: display }, session.ownerWindowId);
    });
    disposeData = session.disposeData = () => dataSub.dispose();
    const exitSub = pty.onExit(({ exitCode, signal }) => {
      session.exited = true;
      session.blocks.recordExit();
      integration?.cleanup();
      if (session.forceKillTimer !== null) clearTimeout(session.forceKillTimer);
      emitTerminal("exit", { ...session.info, exitCode, signal }, session.ownerWindowId);
      session.disposeData();
      session.disposeExit();
      if (sessions.get(key) === session) sessions.delete(key);
      session.markGone();
    });
    disposeExit = session.disposeExit = () => exitSub.dispose();
    owner.abort.signal.throwIfAborted();
    sessions.set(key, session);
    registerTerminalBlockTracker(session.info, session.blocks, session.ownerWindowId);
    if (session.ring.length > 0) emitTerminal("data", { ...session.info, chunk: session.ring.join("") }, session.ownerWindowId);
    const logical = logicalTabs.get(tabId);
    if (logical && logical.ownerWindowId === session.ownerWindowId) logical.initialCwd = cwd;
    registered = true;
    owner.cleanupResources = undefined;
    return { ok: true, tabId, replayed: false, session: sessionInfo(session), blockMarkerToken: session.blocks.viewToken };
  } catch (error) {
    cleanup();
    return { ok: false, reason: "spawn-failed", message: errorMessage(error) };
  }
}

/** Resolve only the invoking conversation's own confined terminal. Main supplies its directory. */
export async function ensureConversationTerminal(sessionId: string, ownerWindowId: number, cwd?: string, signal?: AbortSignal): Promise<TerminalSessionInfo> {
  signal?.throwIfAborted();
  if (!sessionId) throw new Error("conversation session id is required");
  let ownership = conversationTerminals.get(sessionId);
  if (ownership && ownership.ownerWindowId !== ownerWindowId) throw new Error("conversation terminal belongs to another window");
  if (!ownership) {
    if (conversationTerminals.size >= MAX_CONVERSATION_TERMINALS) throw new Error("too many conversation terminals");
    ownership = { tabId: allocateConversationTerminalId(), ownerWindowId, ...(cwd === undefined ? {} : { initialCwd: cwd }) };
    conversationTerminals.set(sessionId, ownership);
    updateApprovalSurface({ kind: "bind-terminal-session", tabId: ownership.tabId, sessionId });
  }
  const owner = ownership;
  const key = terminalLaneKey({ tabId: owner.tabId, lane: "agent" });
  const existing = sessions.get(key);
  let info: TerminalSessionInfo;
  if (existing && !existing.closing && !existing.exited) {
    if (!agentSession(existing.info, ownerWindowId)) throw new Error("conversation terminal confinement changed");
    info = sessionInfo(existing);
  } else {
    const spawning = spawnTerminal({ tabId: owner.tabId, lane: "agent", ownerWindowId, ...(owner.initialCwd === undefined ? {} : { cwd: owner.initialCwd }) });
    // A caller abort ends only its wait. Release failed setup at the shared spawn's
    // completion, so an aborted waiter cannot strand a reservation or close a live shell.
    const releaseFailedReservation = (): void => {
      if (conversationTerminals.get(sessionId) === owner && !sessions.has(key) && !terminalSpawnsInFlight.has(key)) {
        conversationTerminals.delete(sessionId);
        updateApprovalSurface({ kind: "release-terminal", tabId: owner.tabId });
      }
    };
    void spawning.then(result => { if (!result.ok) releaseFailedReservation(); }, releaseFailedReservation);
    const result = await waitForTerminalSpawn(spawning, signal);
    signal?.throwIfAborted();
    if (!result.ok) throw new Error(result.message);
    if (conversationTerminals.get(sessionId) !== owner) throw new Error("conversation terminal was released during initialization");
    info = result.session;
  }
  const session = agentSession(info, ownerWindowId);
  if (!session) throw new Error("agent terminal is no longer contained");
  const starting = (): boolean => ["shell-starting", "no-shell-integration", "between-prompts"].includes(session.blocks.promptState());
  if (starting()) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, FRESH_PROMPT_TIMEOUT_MS);
      const unsubscribe = session.blocks.subscribe(() => { if (!starting() || session.exited) finish(); });
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
  signal?.throwIfAborted();
  if (conversationTerminals.get(sessionId) !== owner || agentSession(info, ownerWindowId) !== session) throw new Error("conversation terminal changed during initialization");
  return sessionInfo(session);
}

/** Main-only reference lookup; renderer terminal ids confer no conversation authority. */
export function conversationTerminalRef(sessionId: string, ownerWindowId: number): TerminalSessionRef | undefined {
  const owner = conversationTerminals.get(sessionId);
  if (!owner || owner.ownerWindowId !== ownerWindowId) return undefined;
  const session = sessions.get(terminalLaneKey({ tabId: owner.tabId, lane: "agent" }));
  return session && agentSession(session.info, ownerWindowId) ? { tabId: session.info.tabId, lane: "agent", terminalSessionId: session.info.terminalSessionId } : undefined;
}

/** Main conversation teardown also cancels reservations that have not completed spawning. */
export function releaseConversationTerminals(ended: (sessionId: string) => boolean): void {
  for (const [sessionId, owner] of conversationTerminals) {
    if (!ended(sessionId)) continue;
    const key = terminalLaneKey({ tabId: owner.tabId, lane: "agent" });
    const pending = retiringConversationTerminals.get(sessionId) ?? new Set<Promise<unknown>>();
    for (const completion of [sessions.get(key)?.gone, terminalSpawnsInFlight.get(key)?.promise]) {
      if (!completion) continue;
      pending.add(completion);
      const finished = (): void => {
        pending.delete(completion);
        if (pending.size === 0 && retiringConversationTerminals.get(sessionId) === pending) retiringConversationTerminals.delete(sessionId);
      };
      void completion.then(finished, finished);
    }
    if (pending.size > 0) retiringConversationTerminals.set(sessionId, pending);
    conversationTerminals.delete(sessionId);
    unregisterTerminalBlockTracker({ tabId: owner.tabId, lane: "agent" });
    updateApprovalSurface({ kind: "release-terminal", tabId: owner.tabId });
    killTerminalLane(terminalLaneKey({ tabId: owner.tabId, lane: "agent" }));
  }
}

/** Actual conversation teardown waits for the confined shell's existing exit/cleanup boundary. */
export async function endConversationTerminalSession(sessionId: string): Promise<void> {
  releaseConversationTerminals((held) => held === sessionId);
  await Promise.all(retiringConversationTerminals.get(sessionId) ?? []);
}

function waitForTerminalSpawn(promise: Promise<SpawnTerminalResult>, signal?: AbortSignal): Promise<SpawnTerminalResult> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason ?? new Error("terminal initialization cancelled")); };
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

/** The authenticated window that reserved this logical tab, or undefined when no tab is reserved. A null owner represents a host-owned tab. */
export function terminalTabOwnerWindow(tabId: string): number | null | undefined {
  return logicalTabs.get(tabId)?.ownerWindowId;
}

/** The window that owns a live (or starting) terminal tab: where that tab's egress asks are drawn.
 * Undefined when no shell runs or starts under the id; null when the shell belongs to no window. */
export function terminalOwnerWindowId(tabId: string): number | null | undefined {
  const session = sessions.get(terminalLaneKey({ tabId, lane: "agent" }));
  if (session && !session.exited && !session.closing) return session.ownerWindowId;
  const inFlight = terminalSpawnsInFlight.get(terminalLaneKey({ tabId, lane: "agent" }));
  if (inFlight && !inFlight.cancelled) return inFlight.ownerWindowId;
  return undefined;
}

export function terminalOwnedBy(tabId: string, ownerWindowId: number | null): boolean {
  if (isConversationTerminalId(tabId)) return false;
  const tab = logicalTabs.get(tabId);
  return tab === undefined || tab.ownerWindowId === ownerWindowId;
}

/** Forward trusted user input only to the selected live incarnation. */
export function writeTerminal(ref: TerminalSessionRef, data: string): TerminalMutationResult {
  const session = sessions.get(terminalLaneKey(ref));
  if (!session || session.exited || session.closing || !sameTerminalSession(session.info, ref)) return { ok: false, error: "stale-terminal-session" };
  if (typeof data !== "string" || Buffer.byteLength(data, "utf-8") > MAX_INPUT_BYTES) return { ok: false, error: "invalid-params" };
  const generation = session.blocks.userInputGeneration();
  session.blocks.recordInput(data);
  if (session.blocks.userInputGeneration() !== generation) revokeTerminalObservation(session);
  session.pty.write(data);
  return { ok: true };
}

type TerminalNotTypedReason =
  | "edit-line-mismatch"
  | "no-terminal"
  | Exclude<TerminalPromptState, "ready">
  | "no-fresh-prompt"
  | "foreground-not-shell"
  | "shell-busy"
  | "cwd-unverified"
  | "cwd-mismatch"
  | "aborted";

export type TypeTerminalCommandResult =
  | { ok: true; firstBlockId: number }
  | { ok: false; reason: TerminalNotTypedReason; message: string };

export type VerifyTerminalShellResult =
  | { ok: true; cwd: string }
  | { ok: false; reason: "no-terminal" | "foreground-not-shell" | "shell-busy" | "cwd-unverified" | "cwd-mismatch"; message: string };

/** How long typing waits for the shell to draw a fresh prompt after the line-editor reset (Ctrl-C at an idle prompt). */
const FRESH_PROMPT_TIMEOUT_MS = 3_000;

/** Check what the shell's markers say against the operating system: the terminal's foreground process must be its own shell (not a program that printed a prompt), and that shell's
 * real working directory must be the one the markers reported. Markers are output text; the process table is not. Returns the shell's directory as the operating system resolves it. */
export async function verifyAgentTerminalShell(ref: TerminalSessionRef, ownerWindowId: number, reportedCwd: string, options: TerminalForegroundOptions = {}): Promise<VerifyTerminalShellResult> {
  const tabId = ref.tabId;
  const session = agentSession(ref, ownerWindowId);
  if (!session) {
    return { ok: false, reason: "no-terminal", message: `no running terminal with tabId ${JSON.stringify(tabId)} in this window` };
  }
  if (session.innerPty) {
    return sandboxedShellVerdict(
      await readSandboxedShell(session.pty.pid, session.shellName, reportedCwd, options),
      reportedCwd,
      session.blocks.reportedShellPid(),
    );
  }
  return foregroundVerdict(await readTerminalForeground(session.pty.pid, options), session.pty.pid, session.shellName, reportedCwd);
}

/** Judge the reading of a sandboxed Linux terminal's shell ({@link readSandboxedShell}) for {@link verifyAgentTerminalShell}. The shell was found by its place in the sandbox's process tree and its name; it must also be the shell that reported the prompt (`reportedPid`, `$$` from the P marker, is its pid in its own namespace), hold its
 * own terminal's foreground, have no child or other process sharing its terminal session or foreground group (a command still finishing, or a background job that could write to the terminal or, through TIOCSTI on that terminal, type into the line), and be in the very directory `reportedCwd` names on the host (same device and inode). */
export function sandboxedShellVerdict(
  reading: SandboxedShellReading,
  reportedCwd: string,
  reportedPid: number | null,
): VerifyTerminalShellResult {
  if (!reading.ok) {
    return { ok: false, reason: "cwd-unverified", message: `the terminal's shell could not be checked: ${reading.reason}` };
  }
  const { shell } = reading;
  if (reportedPid !== shell.nsPid) {
    return {
      ok: false,
      reason: "foreground-not-shell",
      message: `the shell that reported the prompt (pid ${reportedPid ?? "unknown"}) is not the terminal's ${shell.command} shell (pid ${shell.nsPid} in its sandbox)`,
    };
  }
  if (shell.foreground.pgid !== shell.pid) {
    return {
      ok: false,
      reason: "foreground-not-shell",
      message: `the terminal's foreground process is ${JSON.stringify(shell.foreground.command ?? "unknown")}, not its ${shell.command} shell`,
    };
  }
  if (shell.children.length > 0) {
    const named = shell.children.map((child) => JSON.stringify(child.command)).join(", ");
    return {
      ok: false,
      reason: "shell-busy",
      message: `the terminal's shell has processes sharing its input (${named}): a command still finishing or a background job`,
    };
  }
  if (shell.holdersUnreadable !== null) {
    return { ok: false, reason: "shell-busy", message: `the terminal's shell is not proven alone on its terminal: ${shell.holdersUnreadable}` };
  }
  if (shell.holders.length > 0) {
    const named = shell.holders.map((holder) => `${JSON.stringify(holder.command)} pid ${holder.pid}`).join(", ");
    return { ok: false, reason: "shell-busy", message: `the terminal's shell is not alone on its terminal: another process holds it open (${named})` };
  }
  if (!shell.cwdIsReported) {
    return {
      ok: false,
      reason: "cwd-mismatch",
      message: `the terminal reported ${JSON.stringify(reportedCwd)} as its directory, but its shell is in another directory (${JSON.stringify(shell.cwd)}), or one only its sandbox has`,
    };
  }
  return { ok: true, cwd: canonicalizePathForMatch(reportedCwd) };
}

/**
 * Judge an operating-system reading of a terminal's foreground process for
 * {@link verifyAgentTerminalShell}: it must be `shellName`, in `reportedCwd`
 * (compared after resolving symlinks).
 */
export function foregroundVerdict(
  reading: TerminalForegroundReading,
  shellPid: number,
  shellName: string,
  reportedCwd: string,
): VerifyTerminalShellResult {
  if (!reading.ok) {
    return reading.busy
      ? { ok: false, reason: "shell-busy", message: `the terminal's shell is not alone on its terminal: ${reading.reason}` }
      : { ok: false, reason: "cwd-unverified", message: `the terminal's shell could not be checked: ${reading.reason}` };
  }
  const { foreground } = reading;
  // The shell is the process spawned on the pty (its session leader; every wrapper before it execs
  // in place). A nested shell or any other process holding the terminal is not it, whatever its name.
  if (foreground.pid !== shellPid || foreground.command !== shellName) {
    return {
      ok: false,
      reason: "foreground-not-shell",
      message: `the terminal's foreground process is ${JSON.stringify(foreground.command)}, not its ${shellName} shell`,
    };
  }
  const actual = canonicalizePathForMatch(foreground.cwd);
  if (canonicalizePathForMatch(reportedCwd) !== actual) {
    return {
      ok: false,
      reason: "cwd-mismatch",
      message: `the terminal reported ${JSON.stringify(reportedCwd)} as its directory, but its shell is in ${JSON.stringify(foreground.cwd)}`,
    };
  }
  return { ok: true, cwd: actual };
}

/** Resolves true once the shell finishes drawing a prompt after `since`, false at the timeout or exit. */
function waitForFreshPrompt(blocks: TerminalBlockTracker, since: number, timeoutMs: number, cancelled: () => boolean = () => false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = blocks.subscribe(() => {
      if (blocks.hasExited() || cancelled()) finish(false);
      else if (blocks.promptEndCount() > since) finish(true);
    });
  });
}

/** Only authorized terminal_run may type into its owning window's live, empty shell prompt; refuse control or invisible characters.
 * Verify OS process and cwd, reset editor state with Ctrl-C, then require a fresh untouched prompt and empty buffer.
 * Paste as bracketed text; press Enter only after echo and private buffer acknowledgements match the approved line without user input.
 * On mismatch, clear only while the untouched shell is safe; return the block floor so execution can be compared with approval. */
export async function typeAgentTerminalCommand(
  ref: TerminalSessionRef,
  ownerWindowId: number,
  line: string,
  expectedCwd: string,
  signal?: AbortSignal,
): Promise<TypeTerminalCommandResult> {
  const tabId = ref.tabId;
  const live = (): TerminalSession | undefined => agentSession(ref, ownerWindowId);
  const session = live();
  if (session?.gitPolicyChanged !== undefined) {
    try {
      if (session.gitPolicyChanged()) return { ok: false, reason: "cwd-unverified", message: t("sandboxPolicy.terminalChanged") };
    } catch (error) {
      log.warn({ tabId, err: errorMessage(error) }, "terminal: Git protection refresh failed");
      return { ok: false, reason: "cwd-unverified", message: t("sandboxPolicy.terminalChanged") };
    }
  }
  return typeLineAtPrompt(
    {
      blocks: session?.blocks,
      isLive: () => live() === session && session !== undefined,
      write: (data) => { if (!signal?.aborted && live() === session) session?.pty.write(data); },
      verify: (options) => verifyAgentTerminalShell(ref, ownerWindowId, expectedCwd, options),
      onBeforeEnter: (blockId) => {
        if (!session || live() !== session || signal?.aborted) throw new Error("Terminal observation session is unavailable.");
        if (session.observation) throw new Error("Terminal observation command is still active.");
        // Once the user has typed into this terminal, a process they started may have left it (setsid, closed descriptors) while keeping the session's
        // egress credentials, or may reopen the terminal by path later; no process-table reading rules that out. Such a terminal still shows the agent's
        // command, directory, exit code and duration, but neither its output nor its network decisions.
        const withheld = session.blocks.userInputGeneration() !== 0;
        const lease = beginAgentTerminalObservation({ kind: "terminal", command: line, cwd: expectedCwd,
          tabId: ref.tabId, terminalSessionId: ref.terminalSessionId,
          sandbox: { mode: "isolated", detail: session.info.substrate },
          ...(withheld ? { outputAvailability: "withheld-user-input" as const } : {}) });
        if (!lease) return;
        const stop = (): void => {
          if (session.observation === observation) session.observation = undefined;
          observation.subscription?.dispose();
          lease.signal.removeEventListener("abort", stop);
        };
        const observation: TerminalCommandObservation = { lease, blockId, command: line.trim(), cwd: canonicalizePathForMatch(expectedCwd),
          inputGeneration: session.blocks.userInputGeneration(), stop };
        session.observation = observation;
        lease.signal.addEventListener("abort", stop, { once: true });
        if (lease.signal.aborted) { stop(); return; }
        if (withheld) return;
        observation.subscription = session.blocks.subscribeBlockOutput(blockId, (text) => {
          if (session.observation === observation && terminalObservationBlock(session)) lease.write(text);
        });
        if (session.egressToken) lease.bindEgress(session.egressToken, "terminal-session");
      },
      missing: `no contained agent terminal with tabId ${JSON.stringify(tabId)} in this window`,
      ...(signal ? { signal } : {}),
    },
    line,
    () => log.info({ tabId, terminalSessionId: ref.terminalSessionId, chars: line.length }, "terminal: typed an approved agent command"),
  );
}

/** The terminal {@link typeLineAtPrompt} types into. */
export interface PromptTypingTarget {
  readonly signal?: AbortSignal;
  /** Its block tracker, or undefined when there is no such terminal. */
  readonly blocks: TerminalBlockTracker | undefined;
  /** Whether it is still open (and still the caller's). */
  isLive(): boolean;
  write(data: string): void;
  /** Runs after the final editor proof, before Enter can synchronously produce output. */
  onBeforeEnter?(firstBlockId: number): void;
  /** The operating-system check of its shell ({@link verifyAgentTerminalShell}); `exclusive` is asked only for the last check before Enter. */
  verify(options?: TerminalForegroundOptions): Promise<VerifyTerminalShellResult>;
  /** The message when there is no such terminal. */
  readonly missing: string;
}

/** The typing protocol of {@link typeAgentTerminalCommand}, over any terminal: check, reset (Ctrl-C), wait for the fresh prompt, paste, confirm the edit line, Enter. */
export async function typeLineAtPrompt(
  target: PromptTypingTarget,
  line: string,
  onTyped: () => void = () => {},
): Promise<TypeTerminalCommandResult> {
  if (!hasOnlyTypeableCharacters(line) || line.length > MAX_TERMINAL_COMMAND_CHARS) {
    throw new Error("typeAgentTerminalCommand: the line holds characters that cannot be typed as one command");
  }
  const notTyped = (reason: TerminalNotTypedReason, message: string): TypeTerminalCommandResult => ({ ok: false, reason, message });
  const blocks = target.blocks;
  const check = (): TypeTerminalCommandResult | null => {
    if (target.signal?.aborted) return notTyped("aborted", "terminal command preparation was cancelled; no further input was sent");
    if (!blocks || !target.isLive()) return notTyped("no-terminal", target.missing);
    const state = blocks.promptState();
    return state === "ready" ? null : notTyped(state, TERMINAL_NOT_READY_MESSAGES[state]);
  };

  const generation = blocks?.userInputGeneration();
  const interrupted = (): TypeTerminalCommandResult | null =>
    target.signal?.aborted ? notTyped("aborted", "terminal command preparation was cancelled; no further input was sent") : blocks?.userInputGeneration() !== generation ? notTyped("pending-input", "the user typed while the command was being prepared; no further input was sent") : null;
  const safeToWrite = async (options?: TerminalForegroundOptions): Promise<TypeTerminalCommandResult | null> => {
    const before = interrupted();
    if (before) return before;
    const verified = await target.verify(options);
    if (!verified.ok) return notTyped(verified.reason, verified.message);
    return interrupted() ?? (!target.isLive() ? notTyped("no-terminal", target.missing) : null);
  };
  const before = check();
  if (before || !blocks) return before ?? notTyped("no-terminal", target.missing);
  if (!blocks.supportsEditLineQuery()) {
    return notTyped("edit-line-mismatch", "the terminal cannot confirm its editable command buffer");
  }

  // 1. The operating system agrees: the shell holds the terminal, in the approved directory.
  const verified = await target.verify();
  if (!verified.ok) return notTyped(verified.reason, verified.message);
  const afterCheck = interrupted() ?? check();
  if (afterCheck) return afterCheck;

  // 2–3. Reset the line editor and wait for the fresh prompt.
  const resetFailure = await resetToFreshPrompt(blocks, target, safeToWrite, interrupted);
  if (resetFailure) return resetFailure;
  const reported = blocks.currentCwd();
  if (reported === null || canonicalizePathForMatch(reported) !== verified.cwd) {
    return notTyped("cwd-mismatch", "the terminal's shell changed directory while the command was being prepared");
  }

  // 4. Recheck the OS and confirm the editor is empty before pasting.
  const beforeWrite = await safeToWrite() ?? check();
  if (beforeWrite) return beforeWrite;
  const prompt = blocks.promptEndCount();
  const empty = await requestEditLine(blocks, target, prompt, interrupted);
  if (target.signal?.aborted) return notTyped("aborted", "terminal command preparation was cancelled; no further input was sent");
  if (!empty || empty.line !== "" || interrupted()) {
    if (target.isLive() && !await safeToWrite()) target.write("\u0003");
    return notTyped("edit-line-mismatch", "the terminal did not confirm an empty editable command buffer; no command was pasted");
  }
  const beforePaste = await safeToWrite() ?? check();
  if (beforePaste) return beforePaste;
  if (blocks.promptEndCount() !== prompt || blocks.editLineReport()?.generation !== empty.generation) {
    return notTyped("edit-line-mismatch", "the terminal prompt or editable buffer changed before pasting");
  }
  target.write(`\u001b[200~${line}\u001b[201~`);
  // 5. Confirm both the display and the editor's actual buffer before Enter.
  const shown = await waitForEditLine(blocks, prompt, line, EDIT_LINE_TIMEOUT_MS, target.signal);
  if (target.signal?.aborted) return notTyped("aborted", "terminal command preparation was cancelled; Enter was not pressed");
  if (!shown || !target.isLive() || interrupted()) {
    if (target.isLive() && !await safeToWrite()) target.write("\u0003");
    return notTyped("edit-line-mismatch", "the terminal's line editor did not show exactly the approved line after it was pasted, so Enter was not pressed");
  }
  const beforeQuery = await safeToWrite();
  if (beforeQuery) return beforeQuery;
  const confirmed = await requestEditLine(blocks, target, prompt, interrupted);
  if (target.signal?.aborted) return notTyped("aborted", "terminal command preparation was cancelled; Enter was not pressed");
  if (!confirmed || confirmed.line !== line || interrupted()) {
    if (target.isLive() && !await safeToWrite()) target.write("\u0003");
    return notTyped("edit-line-mismatch", "the terminal's editable command buffer did not match the approved line; Enter was not pressed");
  }
  // No other process may share the terminal when Enter is pressed: whatever it writes would land in the agent's command output.
  const beforeEnter = await safeToWrite({ exclusive: true });
  if (beforeEnter) return beforeEnter;
  // The query widget can repaint the display without changing its buffer. Echo was checked before the query; the fresh report is the buffer proof.
  if (blocks.promptEndCount() !== prompt || blocks.typedSincePromptEnd()
    || blocks.editLineReport()?.generation !== confirmed.generation || blocks.editLineReport()?.line !== line) {
    return notTyped("edit-line-mismatch", "the terminal prompt or editor acknowledgement changed before Enter; no further input was sent");
  }
  const firstBlockId = blocks.nextBlockId();
  target.onBeforeEnter?.(firstBlockId);
  target.write("\r");
  onTyped();
  return { ok: true, firstBlockId };
}

/** How long typing waits for a fresh prompt after one Ctrl-C before it sends another, and how long the prompts must then stay still. */
const RESET_REPEAT_MS = 500;

/** Repeat Ctrl-C until a fresh prompt appears; each resend requires unchanged user input and a new OS check.
 * Some shells defer prompt drawing until another key, so multiple resets must settle before pasting. */
async function resetToFreshPrompt(
  blocks: TerminalBlockTracker,
  target: PromptTypingTarget,
  safeToWrite: () => Promise<TypeTerminalCommandResult | null>,
  interrupted: () => TypeTerminalCommandResult | null,
): Promise<TypeTerminalCommandResult | null> {
  const deadline = Date.now() + FRESH_PROMPT_TIMEOUT_MS;
  const expired = (): TypeTerminalCommandResult => ({ ok: false, reason: "no-fresh-prompt", message: "the terminal's shell did not draw a fresh prompt with a full quiet window within three seconds" });
  let drawn = false;
  let sent = 0;
  while (!drawn) {
    const unsafe = await safeToWrite();
    if (unsafe) return unsafe;
    const left = deadline - Date.now();
    if (left <= 0) return expired();
    const fresh = waitForFreshPrompt(blocks, blocks.promptEndCount(), Math.min(RESET_REPEAT_MS, left), () => interrupted() !== null);
    target.write("\u0003");
    sent++;
    drawn = await fresh;
    const changed = interrupted();
    if (changed) return changed;
    if (!target.isLive()) return { ok: false, reason: "no-terminal", message: target.missing };
  }
  if (sent > 1) {
    for (;;) {
      // A truncated wait is not evidence of quiescence.
      if (deadline - Date.now() < RESET_REPEAT_MS) return expired();
      const redrawn = await waitForFreshPrompt(blocks, blocks.promptEndCount(), RESET_REPEAT_MS, () => interrupted() !== null);
      const changed = interrupted();
      if (changed) return changed;
      if (!target.isLive()) return { ok: false, reason: "no-terminal", message: target.missing };
      if (!redrawn) break;
    }
  }
  return null;
}

/** How long typing waits for the pasted line to show in the line editor. */
const EDIT_LINE_TIMEOUT_MS = 2_000;

/** Ask the owned shell editor for its buffer, rather than infer it from display echo. */
async function requestEditLine(
  blocks: TerminalBlockTracker,
  target: PromptTypingTarget,
  prompt: number,
  interrupted: () => TypeTerminalCommandResult | null,
): Promise<{ readonly generation: number; readonly line: string } | null> {
  const state = blocks.promptState();
  if (!blocks.supportsEditLineQuery() || !target.isLive() || interrupted()
    || blocks.promptEndCount() !== prompt || blocks.typedSincePromptEnd()
    || (state !== "ready" && state !== "pending-input")) return null;
  const generation = blocks.editLineReportGeneration();
  target.write(TERMINAL_EDIT_LINE_QUERY);
  const deadline = Date.now() + EDIT_LINE_TIMEOUT_MS;
  for (;;) {
    if (!target.isLive() || interrupted() || blocks.promptEndCount() !== prompt
      || !blocks.supportsEditLineQuery() || blocks.typedSincePromptEnd()) return null;
    const report = blocks.editLineReport();
    if (report && report.generation > generation) return report;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wait until the prompt typed at (`prompt`, its end count) shows exactly `line` in its edit line,
 * with no key from the user since it was drawn. False on timeout, or when that prompt goes away. */
async function waitForEditLine(blocks: TerminalBlockTracker, prompt: number, line: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  // Echoed text does not notify subscribers (only markers do), so poll.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted || blocks.promptEndCount() !== prompt || blocks.hasExited() || blocks.typedSincePromptEnd()) return false;
    if (blocks.editLineText() === line) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TERMINAL_NOT_READY_MESSAGES: Record<Exclude<TerminalPromptState, "ready">, string> = {
  "no-shell-integration": "the terminal's shell reports no command markers, so whether it is waiting at its prompt cannot be told",
  exited: "the terminal's shell has exited",
  "command-running": "a command is running in the foreground of the terminal; typed text would go to it",
  "between-prompts": "the terminal's shell is between commands and has not shown its prompt yet",
  "pending-input": "the user is typing at the prompt, pressed a key since it was drawn, or it holds text they typed and have not run",
  "no-bracketed-paste": "the terminal's shell does not take bracketed paste (zsh 5.1 or bash 4.4 and later do), so typed text could be read as keys; zsh also reports none while a right-hand prompt (RPROMPT) is set",
  "vi-editing-mode": "the terminal's shell uses vi key bindings, where typed text can be read as editing commands",
  "not-found-handler": "the terminal's shell defines a command-not-found handler; ask the user to run unset -f command_not_found_handle (bash) or unfunction command_not_found_handler (zsh) in this terminal, then retry",
  "shell-starting": "the terminal's shell is still starting and has not finished its first prompt; retry in a moment",
  "no-prompt-end-marker": "the terminal's shell does not mark the end of its prompt, so typing there cannot be told",
};

/** Resize the PTY (FitAddon / ResizeObserver). Clamped, no-op for unknown tab. */
export function resizeTerminal(ref: TerminalSessionRef, cols: number, rows: number): TerminalMutationResult {
  const tabId = ref.tabId;
  const session = sessions.get(terminalLaneKey(ref));
  if (!session || session.exited || session.closing || !sameTerminalSession(session.info, ref)) return { ok: false, error: "stale-terminal-session" };
  session.pty.resize(clampDim(cols, 80, MAX_COLS), clampDim(rows, 24, MAX_ROWS));
  if (session.innerPty) forwardResizeToInnerPty(tabId, session);
  return { ok: true };
}

/** Tell the inner pty's relay about a resize (terminal-inner-pty.ts). One forward at a time per terminal: a resize during
 * one (a window being dragged) is folded into one more forward after it, which reads the size the outer pty has by then. */
function forwardResizeToInnerPty(tabId: string, session: TerminalSession): void {
  const state = session.resizeForward;
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  state.again = false;
  void forwardResizeToSandboxedPtyRelay(session.pty.pid, session.shellName)
    .catch((err: unknown) => {
      log.warn({ tabId, err: errorMessage(err) }, "terminal: could not forward a resize to the shell's pty");
    })
    .finally(() => {
      state.running = false;
      if (state.again && !session.exited && !session.closing) forwardResizeToInnerPty(tabId, session);
    });
}

/** How long a spawn may wait, in all, for closing shells under the same id; past the SIGKILL escalation. */
const RETIRING_WAIT_MS = 5_000;

interface TerminalSpawnWaiter {
  ownerWindowId: number | null;
  cancelled: boolean;
  cancel: () => void;
  cancelledSignal: Promise<"cancelled">;
}

/** Spawns waiting for a closing shell under their id, by tab id. */
const terminalSpawnWaiters = new Map<string, Set<TerminalSpawnWaiter>>();

function addSpawnWaiter(tabId: string, ownerWindowId: number | null): TerminalSpawnWaiter {
  let resolveCancelled!: (value: "cancelled") => void;
  const waiter: TerminalSpawnWaiter = {
    ownerWindowId,
    cancelled: false,
    cancelledSignal: new Promise<"cancelled">((resolve) => { resolveCancelled = resolve; }),
    cancel: () => {
      waiter.cancelled = true;
      resolveCancelled("cancelled");
    },
  };
  const waiters = terminalSpawnWaiters.get(tabId) ?? new Set<TerminalSpawnWaiter>();
  waiters.add(waiter);
  terminalSpawnWaiters.set(tabId, waiters);
  return waiter;
}

function removeSpawnWaiter(tabId: string, waiter: TerminalSpawnWaiter): void {
  const waiters = terminalSpawnWaiters.get(tabId);
  if (!waiters) return;
  waiters.delete(waiter);
  if (waiters.size === 0) terminalSpawnWaiters.delete(tabId);
}

/** Settles once the closing shell or cancelled spawn under `tabId` is gone; `null` when nothing under that id is closing. */
function closingUnder(tabId: string): Promise<unknown> | null {
  const session = sessions.get(tabId);
  if (session && session.closing && !session.exited) return session.gone;
  const inFlight = terminalSpawnsInFlight.get(tabId);
  if (inFlight && inFlight.cancelled) return inFlight.promise.catch(() => undefined);
  return null;
}

/** Wait for `closing` until `deadline`, or until the waiter is cancelled; the deadline timer is cleared however the wait ends. */
function waitOutClosing(
  closing: Promise<unknown>,
  deadline: number,
  cancelled: Promise<"cancelled">,
): Promise<"gone" | "timeout" | "cancelled"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve("timeout");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); });
  return Promise.race([closing.then(() => "gone" as const), timeout, cancelled]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** Close every terminal a window owns; the window is gone (macOS keeps the app running when its last window closes, so nothing else would). Returns how many were closed. */
export function killTerminalsOwnedBy(ownerWindowId: number): number {
  const ids = [...logicalTabs.entries()].filter(([, tab]) => tab.ownerWindowId === ownerWindowId).map(([id]) => id);
  for (const id of ids) killTerminal(id);
  const conversations = [...conversationTerminals.entries()].filter(([, owner]) => owner.ownerWindowId === ownerWindowId).map(([id]) => id);
  releaseConversationTerminals((id) => conversations.includes(id));
  return ids.length + conversations.length;
}

/** Closing a visible host tab cannot close a conversation terminal. */
export function killTerminal(tabId: string): void {
  if (!logicalTabs.has(tabId)) return;
  updateApprovalSurface({ kind: "release-terminal", tabId });
  logicalTabs.delete(tabId);
  unregisterTerminalBlockTracker({ tabId, lane: "manual" });
  killTerminalLane(terminalLaneKey({ tabId, lane: "manual" }));
}

/** Kill + tear down one terminal (tab close / teardown). Idempotent. */
function killTerminalLane(key: string): void {
  const tabId = key.slice(0, key.lastIndexOf("/"));
  for (const waiter of terminalSpawnWaiters.get(key) ?? []) waiter.cancel();
  const inFlight = terminalSpawnsInFlight.get(key);
  if (inFlight) cancelInFlightSpawn(inFlight);
  const session = sessions.get(key);
  if (!session || session.closing) return;
  session.closing = true;
  stopTerminalObservation(session);
  // The tab is closing: its banners go now, not when the shell has exited.
  session.egressAbort?.abort(new Error("terminal tab closed"));
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
      // node-pty defaults to SIGHUP. A shell may trap/ignore it, so retain ownership until this definitive escalation or the exit callback.
      session.pty.kill("SIGKILL");
    } catch (err) {
      // Keep the session registered even when signal delivery fails. Losing the only owner here would
      // allow a replacement PTY while this one may still be alive and would strand its ASRT/HOME finalizers.
      log.warn(
        { tabId, err: errorMessage(err) },
        "terminal: force kill failed",
      );
    }
  }, 3_000);
}

/** Close every logical tab through ordinary escalation; return live lanes closed. */
export function killAllTerminals(): number {
  const count = [...sessions.values()].filter((session) => !session.closing).length;
  for (const id of [...logicalTabs.keys()]) killTerminal(id);
  releaseConversationTerminals(() => true);
  return count;
}

/** App-shutdown path: signal every PTY immediately and wait only until all exit callbacks run or the bounded
 * deadline expires. Unlike a tab close, shutdown cannot rely on a later timer after Electron has already quit. */
export async function forceKillAllTerminalsForShutdown(timeoutMs = 1_000): Promise<number> {
  terminalShutdownStarted = true;
  logicalTabs.clear();
  conversationTerminals.clear();
  retiringConversationTerminals.clear();
  for (const waiters of terminalSpawnWaiters.values()) for (const waiter of waiters) waiter.cancel();
  const startedAt = Date.now();
  const inFlight = [...terminalSpawnsInFlight.values()];
  for (const owner of inFlight) cancelInFlightSpawn(owner);

  // Snapshot and signal live PTYs synchronously before yielding to any pending setup promise. Shutdown must not
  // give an existing shell extra runtime just because another tab is still resolving its wrapper/native module.
  const sessionsToKill = [...sessions.entries()].filter(([, session]) => !session.exited);
  for (const [tabId, session] of sessionsToKill) {
    session.closing = true;
    unregisterTerminalBlockTracker(session.info);
    stopTerminalObservation(session);
    session.egressAbort?.abort();
    session.disposeData();
    if (session.forceKillTimer !== null) {
      clearTimeout(session.forceKillTimer);
      session.forceKillTimer = null;
    }
    try {
      session.pty.kill("SIGKILL");
    } catch (err) {
      // Keep ownership until a late exit callback; the bounded wait below prevents a broken native PTY from hanging application shutdown.
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

/** Test-only: inspect ownership without granting renderer access. */
export function _conversationTerminalOwnerForTest(sessionId: string): number | null | undefined {
  return conversationTerminals.get(sessionId)?.ownerWindowId;
}

/** Test-only: deterministic conversation identity for low-level confinement tests. */
export function _reserveConversationTerminalForTest(sessionId: string, tabId: string, ownerWindowId: number | null, initialCwd?: string): void {
  if (!conversationTerminals.has(sessionId)) {
    conversationTerminals.set(sessionId, { tabId, ownerWindowId, ...(initialCwd !== undefined ? { initialCwd } : {}) });
    updateApprovalSurface({ kind: "bind-terminal-session", tabId, sessionId });
  }
}

/** Test-only: reset module state between tests. */
export function __resetTerminalsForTest(): void {
  for (const session of sessions.values()) {
    session.cleanupIntegration?.();
    stopTerminalObservation(session);
    if (session.forceKillTimer !== null) clearTimeout(session.forceKillTimer);
    session.disposeData();
    session.disposeExit();
  }
  sessions.clear();
  logicalTabs.clear();
  for (const owner of conversationTerminals.values()) updateApprovalSurface({ kind: "release-terminal", tabId: owner.tabId });
  conversationTerminals.clear();
  retiringConversationTerminals.clear();
  for (const owner of terminalSpawnsInFlight.values()) {
    owner.cancelled = true;
    owner.abort.abort();
  }
  terminalSpawnsInFlight.clear();
  for (const waiters of terminalSpawnWaiters.values()) for (const waiter of waiters) waiter.cancel();
  terminalSpawnWaiters.clear();
  terminalShutdownStarted = false;
  __resetTerminalBlocksForTest();
  _emit = () => {};
  terminalInspectionForTest = undefined;
}
