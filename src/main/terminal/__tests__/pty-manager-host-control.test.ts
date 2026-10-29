/** Host terminal control periods at the PTY write chokepoint, with a fake PTY and fake operating-system readings.
 * Asserts the bytes the shell actually received and the output a requesting conversation can actually read. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DataCb = (chunk: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;
class FakePty {
  pid = 4242;
  written: string[] = [];
  respond: ((data: string) => void) | null = null;
  private dataCb: DataCb | null = null;
  private exitCbs = new Set<ExitCb>();
  onData(cb: DataCb) { this.dataCb = cb; return { dispose: () => { this.dataCb = null; } }; }
  onExit(cb: ExitCb) { this.exitCbs.add(cb); return { dispose: () => { this.exitCbs.delete(cb); } }; }
  write(data: string) { this.written.push(data); this.respond?.(data); }
  resize() {}
  kill() { for (const cb of [...this.exitCbs]) cb({ exitCode: 0 }); }
  emitData(chunk: string) { this.dataCb?.(chunk); }
}
let lastPty: FakePty | null = null;
const spawnMock = vi.fn((_cmd: string, _args: string[], _opts: { env: Record<string, string> }) => { lastPty = new FakePty(); return lastPty; });
vi.mock("node-pty", () => ({ spawn: (cmd: string, args: string[], opts: { env: Record<string, string> }) => spawnMock(cmd, args, opts) }));
let foreground: import("../shell-process.js").TerminalForegroundReading = { ok: true, foreground: { pid: 4242, command: "zsh", cwd: "/w" } };
const readForeground = vi.fn(async (_pid: number, _options?: unknown) => foreground);
vi.mock("../shell-process.js", () => ({
  readTerminalForeground: (pid: number, options?: unknown) => readForeground(pid, options),
  readSandboxedShell: vi.fn(),
  forwardResizeToSandboxedPtyRelay: vi.fn(),
}));

import {
  __resetTerminalsForTest, controlTerminal, hostTerminalDisclosure, hostTerminalSession, revokeUnboundHostTerminalLeases, setTerminalEmitter, spawnTerminal,
  typeHostTerminalCommand, writeTerminal, type HostTerminalTypingRequest, type TerminalEmit,
} from "../pty-manager.js";
import { SHELL_INTEGRATION_NONCE_FILE, TERMINAL_EDIT_LINE_QUERY } from "../shell-integration.js";
import type { TerminalSessionInfo } from "../../../shared/terminal-session.js";

const TAB = "terminal:0000c0de-1";
const WINDOW = 5;
const SECRET = "SENTINEL-USER-SECRET-7f3a";
let shellDir: string;
let homeDir: string;
let controlEvents: unknown[];

beforeEach(() => {
  shellDir = mkdtempSync(join(tmpdir(), "ave-host-control-shell-"));
  homeDir = mkdtempSync(join(tmpdir(), "ave-host-control-home-"));
  const zsh = join(shellDir, "zsh");
  writeFileSync(zsh, "#!/bin/sh\n");
  chmodSync(zsh, 0o755);
  vi.stubEnv("SHELL", zsh);
  vi.stubEnv("HOME", homeDir);
  foreground = { ok: true, foreground: { pid: 4242, command: "zsh", cwd: "/w" } };
  controlEvents = [];
  const emit: TerminalEmit = (event, payload) => { if (event === "control") controlEvents.push(payload); };
  __resetTerminalsForTest();
  setTerminalEmitter(emit);
});
afterEach(() => {
  vi.useRealTimers();
  __resetTerminalsForTest();
  vi.unstubAllEnvs();
  rmSync(shellDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const TURN = "turn-1";

/** A user turn the test can end; the real capability comes from `runWithHostTerminalTurn`, this one only lets a test end it mid-command. */
function fakeTurn(turnId = TURN) {
  let current = true;
  const listeners = new Set<() => void>();
  return {
    sessionId: "conversation-a",
    turnId,
    isCurrent: () => current,
    onEnd: (listener: () => void) => { if (!current) { listener(); return () => {}; } listeners.add(listener); return () => { listeners.delete(listener); }; },
    end: () => { current = false; for (const listener of [...listeners]) listener(); listeners.clear(); },
  };
}

function typing(line: string, bound: () => boolean = () => true, extra: Partial<HostTerminalTypingRequest> = {}): HostTerminalTypingRequest {
  return { requestingSessionId: "conversation-a", turn: fakeTurn(), line, expectedCwd: "/w", bound, effectCheck: async () => ({ ok: true }), ...extra };
}

/** A host zsh whose fake line editor answers the typing protocol like the real hooks do. */
async function hostShell(purpose: "workspace" | "side-panel" = "workspace") {
  const spawned = await spawnTerminal({ tabId: TAB, lane: "manual", purpose, ownerWindowId: WINDOW, cwd: tmpdir() });
  if (!spawned.ok) throw new Error(`host spawn failed: ${spawned.message}`);
  const opts = spawnMock.mock.calls.at(-1)![2];
  const nonce = readFileSync(join(opts.env.ZDOTDIR!, SHELL_INTEGRATION_NONCE_FILE), "utf-8");
  const pty = lastPty!;
  const mark = (fields: string): string => `\u001b]133;${fields};${nonce}\u0007`;
  let prompts = 0;
  let token = "";
  const prompt = (): string => {
    token = `${(++prompts).toString(16).padStart(2, "0")}`.repeat(16);
    return `${mark("D;0")}${mark(`P;Cwd=/w;Keys=emacs;Paste=1;NotFound=0;Edit=1;B=${token}`)}${mark("A")}% \u001b]133;B;${token}\u0007`;
  };
  let line = "";
  /** Called with each write; return false to leave it unanswered (a test injects its own event there). */
  const hooks: { onPaste?: (text: string) => boolean; onEnter?: () => void } = {};
  pty.respond = (data) => {
    if (data === "\u0003") { line = ""; queueMicrotask(() => pty.emitData(`\r\n${prompt()}`)); return; }
    const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(data);
    if (paste) {
      if (hooks.onPaste && !hooks.onPaste(paste[1]!)) return;
      line = paste[1]!;
      queueMicrotask(() => pty.emitData(line));
      return;
    }
    if (data === TERMINAL_EDIT_LINE_QUERY) { const reported = line; queueMicrotask(() => pty.emitData(mark(`E;Line=${encodeURIComponent(reported)};B=${token}`))); return; }
    if (data === "\r") hooks.onEnter?.();
  };
  pty.emitData(prompt());
  // The prompt must be quiet before typing (no user input yet in this incarnation).
  const session = hostTerminalSession(TAB, WINDOW) ?? spawned.session;
  return { pty, mark, prompt, hooks, session: session as TerminalSessionInfo, run: (command: string) => mark(`C;cmdline_url=${encodeURIComponent(command)}`) };
}

describe.runIf(process.platform !== "win32")("host terminal control periods", () => {
  it("types one approved command and discloses only its own span to the requesting conversation", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => {
      shell.pty.emitData(`${shell.run("echo approved")}approved output\n`);
      shell.pty.emitData(`${shell.mark("D;0")}${shell.prompt()}`);
    });
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("echo approved", () => true));
    expect(typed).toMatchObject({ ok: true });
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)?.state).toBe("done"));
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)).toMatchObject({ output: "approved output\n", exitCode: 0, command: "echo approved" });
    // Another conversation, even in the same window, reads nothing.
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-b", TURN, typed.firstBlockId)).toBeUndefined();
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } });
    expect(shell.pty.written.filter((data) => data === "\r")).toHaveLength(1);
  });

  it("revokes on the user's keystroke during paste: Enter is never written and the user keeps the line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shell = await hostShell();
    shell.hooks.onPaste = () => {
      // The user presses a key while the paste is in flight: their byte takes control before it reaches the shell.
      writeTerminal(shell.session, "x");
      return true;
    };
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("echo approved", () => true));
    expect(typed.ok).toBe(false);
    expect(shell.pty.written).not.toContain("\r");
    const afterUser = shell.pty.written.slice(shell.pty.written.indexOf("x") + 1);
    expect(afterUser).toEqual([]);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    // A new admission needs a hand-back first, and hand-back needs a fresh empty prompt.
    expect(await typeHostTerminalCommand(shell.session, WINDOW, typing("echo again", () => true))).toMatchObject({ ok: false });
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: false, error: "hand-back-pending-input" });
    shell.pty.emitData(`\r\n${shell.prompt()}`);
    // Still inside the quiet window after the user's last key.
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: false, error: "hand-back-pending-input" });
    vi.setSystemTime(Date.now() + 2_000);
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("keeps user-period output, split sentinels included, out of the disclosed span after Take over", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("tail -f log")}agent line\npartial-before-take`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("tail -f log", () => true));
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)?.output).toContain("agent line"));
    expect(controlTerminal(shell.session, WINDOW, "take-over")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    // The sentinel straddles chunks, and the user types it too.
    shell.pty.emitData(`${SECRET.slice(0, 9)}`);
    writeTerminal(shell.session, `${SECRET}\r`);
    shell.pty.emitData(`${SECRET.slice(9)}\n${SECRET}\n${shell.mark("D;0")}${shell.prompt()}`);
    const disclosed = hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)!;
    expect(disclosed).toMatchObject({ state: "interrupted", interruption: "take-over", exitCode: null });
    expect(disclosed.output).not.toContain(SECRET.slice(0, 9));
    expect(disclosed.output).not.toContain(SECRET);
    expect(JSON.stringify(disclosed)).not.toContain("SENTINEL");
  });

  it("stops only the command it owns, once; a late Stop after Take over writes nothing", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("sleep 30")}`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("sleep 30", () => true));
    expect(typed.ok).toBe(true);
    const before = shell.pty.written.length;
    shell.pty.respond = null;
    expect(controlTerminal(shell.session, WINDOW, "stop")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    expect(shell.pty.written.slice(before)).toEqual(["\u0003"]);
    expect(controlTerminal(shell.session, WINDOW, "stop")).toMatchObject({ ok: true });
    expect(shell.pty.written.slice(before)).toEqual(["\u0003"]);
  });

  it("refuses a side panel terminal, and moving a running tab to the side panel revokes its lease", async () => {
    const side = await hostShell("side-panel");
    expect(hostTerminalSession(TAB, WINDOW)).toBeUndefined();
    expect(await typeHostTerminalCommand(side.session, WINDOW, typing("echo no", () => true))).toMatchObject({ ok: false, reason: "no-terminal" });
    expect(side.pty.written).toEqual([]);
    // The same tab remounted in a workspace pane may take a command; remounting it in the side panel ends the lease.
    expect((await spawnTerminal({ tabId: TAB, lane: "manual", purpose: "workspace", ownerWindowId: WINDOW })).ok).toBe(true);
    side.hooks.onEnter = () => queueMicrotask(() => side.pty.emitData(`${side.run("sleep 30")}agent\n`));
    const typed = await typeHostTerminalCommand(side.session, WINDOW, typing("sleep 30", () => true));
    expect(typed.ok).toBe(true);
    expect((await spawnTerminal({ tabId: TAB, lane: "manual", purpose: "side-panel", ownerWindowId: WINDOW })).ok).toBe(true);
    expect(controlTerminal(side.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    side.pty.emitData(`${SECRET}\n`);
    if (typed.ok) expect(hostTerminalDisclosure(side.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)?.output).not.toContain(SECRET);
  });

  it("refuses a foreground job and a spawn without a declared purpose", async () => {
    expect(await spawnTerminal({ tabId: TAB, lane: "manual", ownerWindowId: WINDOW })).toMatchObject({ ok: false, reason: "bad-request" });
    const shell = await hostShell();
    foreground = { ok: true, foreground: { pid: 5151, command: "vim", cwd: "/w" } };
    expect(await typeHostTerminalCommand(shell.session, WINDOW, typing("echo no", () => true))).toMatchObject({ ok: false, reason: "foreground-not-shell" });
    expect(shell.pty.written).toEqual([]);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("announces each control change for the live incarnation and refuses a retired one", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("echo approved")}ok\n${shell.mark("D;0")}${shell.prompt()}`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("echo approved", () => true));
    expect(typed.ok).toBe(true);
    await vi.waitFor(() => expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } }));
    const modes = controlEvents.map((event) => (event as { control: { mode: string; typed?: boolean } }).control);
    expect(modes.map((control) => control.mode)).toEqual(["agent", "agent", "available"]);
    expect(modes[1]).toMatchObject({ typed: true, command: "echo approved" });
    expect(controlEvents.every((event) => (event as { terminalSessionId: string }).terminalSessionId === shell.session.terminalSessionId)).toBe(true);
    expect(controlTerminal({ ...shell.session, terminalSessionId: "retired" }, WINDOW, "take-over")).toMatchObject({ ok: false, error: "stale-terminal-session" });
    expect(controlTerminal(shell.session, WINDOW + 1, "take-over")).toMatchObject({ ok: false, error: "stale-terminal-session" });
  });

  it("keeps the lease through the emulator's reply to the command's own query, but not through a lookalike nobody asked for", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("tput u7")}\u001b[6n`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("tput u7", () => true));
    expect(typed.ok).toBe(true);
    await vi.waitFor(() => expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "agent", typed: true } }));
    writeTerminal(shell.session, "\u001b[12;40R");
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "agent" } });
    // The same reply again answers nothing: it is the user's input.
    writeTerminal(shell.session, "\u001b[12;40R");
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
  });

  it("stops before Enter without writing Ctrl-C or Enter", async () => {
    const shell = await hostShell();
    let stopped: ReturnType<typeof controlTerminal> | undefined;
    shell.hooks.onPaste = () => { stopped = controlTerminal(shell.session, WINDOW, "stop"); return true; };
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("echo approved", () => true));
    expect(stopped).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    expect(typed).toMatchObject({ ok: false, reason: "aborted" });
    const pasteAt = shell.pty.written.findIndex((data) => data.startsWith("\u001b[200~"));
    expect(shell.pty.written.slice(pasteAt + 1)).toEqual([]);
  });

  it("stops disclosure when the shell reports a different command than the approved one", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("echo other")}${SECRET}\n${shell.mark("D;0")}${shell.prompt()}`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("echo approved", () => true));
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)?.state).toBe("interrupted"));
    const disclosed = hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)!;
    expect(disclosed).toMatchObject({ interruption: "command-mismatch", output: "" });
  });

  it("ends the lease and its disclosure when the pane chat binding goes away mid-command", async () => {
    const shell = await hostShell();
    let bound = true;
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("sleep 30")}agent line\n`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("sleep 30", () => bound));
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)?.output).toContain("agent line"));
    bound = false;
    revokeUnboundHostTerminalLeases(WINDOW, () => (bound ? "conversation-a" : undefined));
    shell.pty.emitData(`${SECRET}\n`);
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)).toMatchObject({ state: "interrupted", interruption: "binding" });
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)!.output).not.toContain(SECRET);
  });

  it("refuses to start for a conversation that is not the tab's pane chat", async () => {
    const shell = await hostShell();
    expect(await typeHostTerminalCommand(shell.session, WINDOW, typing("echo no", () => false))).toMatchObject({ ok: false, reason: "no-terminal" });
    expect(shell.pty.written).toEqual([]);
  });
  it("moves the control generation on a keystroke, a placement move or a binding change with no lease, so a pending approval types nothing", async () => {
    const shell = await hostShell();
    const generation = (): number => { const got = controlTerminal(shell.session, WINDOW, "get"); if (!got.ok) throw new Error("no control"); return got.control.generation; };
    const atApproval = generation();
    writeTerminal(shell.session, "x");
    const afterKey = generation();
    expect(afterKey).toBeGreaterThan(atApproval);
    expect((await spawnTerminal({ tabId: TAB, lane: "manual", purpose: "side-panel", ownerWindowId: WINDOW })).ok).toBe(true);
    expect((await spawnTerminal({ tabId: TAB, lane: "manual", purpose: "workspace", ownerWindowId: WINDOW })).ok).toBe(true);
    const afterMove = generation();
    expect(afterMove).toBeGreaterThan(afterKey);
    // The first binding change seen in the window only records this terminal's binding, and an unrelated one leaves it alone.
    revokeUnboundHostTerminalLeases(WINDOW, () => "conversation-a");
    expect(generation()).toBe(afterMove);
    revokeUnboundHostTerminalLeases(WINDOW, () => "conversation-a");
    expect(generation()).toBe(afterMove);
    revokeUnboundHostTerminalLeases(WINDOW, () => "conversation-b");
    const afterRebind = generation();
    expect(afterRebind).toBeGreaterThan(afterMove);
    revokeUnboundHostTerminalLeases(WINDOW, () => undefined);
    expect(generation()).toBeGreaterThan(afterRebind);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("refuses a turn that has ended, and ends the lease and its disclosure when the turn ends mid-command", async () => {
    const shell = await hostShell();
    const over = fakeTurn();
    over.end();
    expect(await typeHostTerminalCommand(shell.session, WINDOW, typing("echo no", () => true, { turn: over }))).toMatchObject({ ok: false, reason: "aborted" });
    expect(shell.pty.written).toEqual([]);
    const turn = fakeTurn();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("sleep 30")}agent line\n`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("sleep 30", () => true, { turn }));
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)?.output).toContain("agent line"));
    // Another turn of the same conversation reads nothing.
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", "turn-2", typed.firstBlockId)).toBeUndefined();
    turn.end();
    shell.pty.emitData(`${SECRET}\n`);
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)).toMatchObject({ state: "interrupted", interruption: "turn-ended" });
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", TURN, typed.firstBlockId)!.output).not.toContain(SECRET);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("blocks paste and Enter when the sealed directory or route stops matching during preparation", async () => {
    const shell = await hostShell();
    let checks = 0;
    const swapped = typing("echo approved", () => true, { effectCheck: async () => (++checks > 1 ? { ok: false, message: "directory changed" } : { ok: true }) });
    expect(await typeHostTerminalCommand(shell.session, WINDOW, swapped)).toMatchObject({ ok: false, reason: "effect-refused" });
    expect(shell.pty.written.some((data) => data.startsWith("\u001b[200~"))).toBe(false);
    expect(shell.pty.written).not.toContain("\r");
    // Refused after the paste: Enter is never pressed and the pasted line is cleared while the lease holds.
    shell.pty.written.length = 0;
    const late = typing("echo approved", () => true, {
      effectCheck: async () => (shell.pty.written.some((data) => data.startsWith("\u001b[200~")) ? { ok: false, message: "route changed" } : { ok: true }),
    });
    expect(await typeHostTerminalCommand(shell.session, WINDOW, late)).toMatchObject({ ok: false, reason: "effect-refused" });
    const pasteAt = shell.pty.written.findIndex((data) => data.startsWith("\u001b[200~"));
    expect(pasteAt).toBeGreaterThanOrEqual(0);
    expect(shell.pty.written.slice(pasteAt + 1)).toEqual(["\u0003"]);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("clears the pasted line with Ctrl-C when the turn is stopped after the paste but before Enter", async () => {
    const shell = await hostShell();
    const stop = new AbortController();
    shell.hooks.onPaste = () => { queueMicrotask(() => stop.abort()); return true; };
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("echo approved"), stop.signal);
    expect(typed).toMatchObject({ ok: false, reason: "aborted" });
    const pasteAt = shell.pty.written.findIndex((data) => data.startsWith("\u001b[200~"));
    expect(shell.pty.written.slice(pasteAt + 1)).toEqual(["\u0003"]);
    expect(shell.pty.written).not.toContain("\r");
  });

  it("interrupts once when a Stop pressed between Enter and the command's start sees the command start", async () => {
    const shell = await hostShell();
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("sleep 30"));
    expect(typed.ok).toBe(true);
    shell.pty.respond = null;
    const before = shell.pty.written.length;
    expect(controlTerminal(shell.session, WINDOW, "stop")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    expect(shell.pty.written.slice(before)).toEqual([]);
    shell.pty.emitData(shell.run("sleep 30"));
    expect(shell.pty.written.slice(before)).toEqual(["\u0003"]);
    shell.pty.emitData("more output\n");
    expect(shell.pty.written.slice(before)).toEqual(["\u0003"]);
  });

  it("does not interrupt a command that starts after the user acted following a Stop before its start", async () => {
    const shell = await hostShell();
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, typing("sleep 30"));
    expect(typed.ok).toBe(true);
    shell.pty.respond = null;
    expect(controlTerminal(shell.session, WINDOW, "stop")).toMatchObject({ ok: true });
    writeTerminal(shell.session, "q");
    const before = shell.pty.written.length;
    shell.pty.emitData(shell.run("sleep 30"));
    expect(shell.pty.written.slice(before)).toEqual([]);
  });

  it("hands back at an empty prompt whatever its editor settings, and names the state that refuses it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("make")}building\n`));
    expect((await typeHostTerminalCommand(shell.session, WINDOW, typing("make"))).ok).toBe(true);
    await vi.waitFor(() => expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { typed: true } }));
    expect(controlTerminal(shell.session, WINDOW, "take-over")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    // A running command refuses with its own state.
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: false, error: "hand-back-command-running" });
    // vi mode, no bracketed paste and a not-found handler, with a right-hand prompt drawn after the prompt end: the empty prompt is enough.
    const token = "ab".repeat(16);
    shell.pty.emitData(`${shell.mark("D;0")}${shell.mark(`P;Cwd=/w;Keys=vi;Paste=0;NotFound=1;Edit=0;B=${token}`)}${shell.mark("A")}% \u001b]133;B;${token}\u0007\u001b[50C[main]\r\u001b[2C`);
    vi.setSystemTime(Date.now() + 2_000);
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: true, control: { mode: "available" } });
    // A line the user typed at the prompt refuses until they clear or run it.
    shell.pty.emitData(`\r\n${shell.prompt()}`);
    vi.setSystemTime(Date.now() + 2_000);
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("sleep 30")}`));
    expect((await typeHostTerminalCommand(shell.session, WINDOW, typing("sleep 30"))).ok).toBe(true);
    await vi.waitFor(() => expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { typed: true } }));
    // The user's Ctrl-C ends the agent's command (and takes control); at the next prompt they type.
    writeTerminal(shell.session, "\u0003");
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    shell.pty.emitData(`${shell.mark("D;130")}${shell.prompt()}`);
    vi.setSystemTime(Date.now() + 2_000);
    writeTerminal(shell.session, "l");
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: false, error: "hand-back-pending-input" });
  });
});
