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
  typeHostTerminalCommand, writeTerminal, type TerminalEmit,
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

describe("host terminal control periods", () => {
  it("types one approved command and discloses only its own span to the requesting conversation", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => {
      shell.pty.emitData(`${shell.run("echo approved")}approved output\n`);
      shell.pty.emitData(`${shell.mark("D;0")}${shell.prompt()}`);
    });
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo approved", "/w", () => true);
    expect(typed).toMatchObject({ ok: true });
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)?.state).toBe("done"));
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)).toMatchObject({ output: "approved output\n", exitCode: 0, command: "echo approved" });
    // Another conversation, even in the same window, reads nothing.
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-b", typed.firstBlockId)).toBeUndefined();
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
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo approved", "/w", () => true);
    expect(typed.ok).toBe(false);
    expect(shell.pty.written).not.toContain("\r");
    const afterUser = shell.pty.written.slice(shell.pty.written.indexOf("x") + 1);
    expect(afterUser).toEqual([]);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    // A new admission needs a hand-back first, and hand-back needs a fresh empty prompt.
    expect(await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo again", "/w", () => true)).toMatchObject({ ok: false });
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: false, error: "prompt-not-ready" });
    shell.pty.emitData(`\r\n${shell.prompt()}`);
    // Still inside the quiet window after the user's last key.
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: false, error: "prompt-not-ready" });
    vi.setSystemTime(Date.now() + 2_000);
    expect(controlTerminal(shell.session, WINDOW, "hand-back")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("keeps user-period output, split sentinels included, out of the disclosed span after Take over", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("tail -f log")}agent line\npartial-before-take`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "tail -f log", "/w", () => true);
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)?.output).toContain("agent line"));
    expect(controlTerminal(shell.session, WINDOW, "take-over")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    // The sentinel straddles chunks, and the user types it too.
    shell.pty.emitData(`${SECRET.slice(0, 9)}`);
    writeTerminal(shell.session, `${SECRET}\r`);
    shell.pty.emitData(`${SECRET.slice(9)}\n${SECRET}\n${shell.mark("D;0")}${shell.prompt()}`);
    const disclosed = hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)!;
    expect(disclosed).toMatchObject({ state: "interrupted", interruption: "take-over", exitCode: null });
    expect(disclosed.output).not.toContain(SECRET.slice(0, 9));
    expect(disclosed.output).not.toContain(SECRET);
    expect(JSON.stringify(disclosed)).not.toContain("SENTINEL");
  });

  it("stops only the command it owns, once; a late Stop after Take over writes nothing", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("sleep 30")}`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "sleep 30", "/w", () => true);
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
    expect(await typeHostTerminalCommand(side.session, WINDOW, "conversation-a", "echo no", "/w", () => true)).toMatchObject({ ok: false, reason: "no-terminal" });
    expect(side.pty.written).toEqual([]);
    // The same tab remounted in a workspace pane may take a command; remounting it in the side panel ends the lease.
    expect((await spawnTerminal({ tabId: TAB, lane: "manual", purpose: "workspace", ownerWindowId: WINDOW })).ok).toBe(true);
    side.hooks.onEnter = () => queueMicrotask(() => side.pty.emitData(`${side.run("sleep 30")}agent\n`));
    const typed = await typeHostTerminalCommand(side.session, WINDOW, "conversation-a", "sleep 30", "/w", () => true);
    expect(typed.ok).toBe(true);
    expect((await spawnTerminal({ tabId: TAB, lane: "manual", purpose: "side-panel", ownerWindowId: WINDOW })).ok).toBe(true);
    expect(controlTerminal(side.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    side.pty.emitData(`${SECRET}\n`);
    if (typed.ok) expect(hostTerminalDisclosure(side.session, WINDOW, "conversation-a", typed.firstBlockId)?.output).not.toContain(SECRET);
  });

  it("refuses a foreground job and a spawn without a declared purpose", async () => {
    expect(await spawnTerminal({ tabId: TAB, lane: "manual", ownerWindowId: WINDOW })).toMatchObject({ ok: false, reason: "bad-request" });
    const shell = await hostShell();
    foreground = { ok: true, foreground: { pid: 5151, command: "vim", cwd: "/w" } };
    expect(await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo no", "/w", () => true)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
    expect(shell.pty.written).toEqual([]);
    expect(controlTerminal(shell.session, WINDOW, "get")).toMatchObject({ ok: true, control: { mode: "available" } });
  });

  it("announces each control change for the live incarnation and refuses a retired one", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("echo approved")}ok\n${shell.mark("D;0")}${shell.prompt()}`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo approved", "/w", () => true);
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
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "tput u7", "/w", () => true);
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
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo approved", "/w", () => true);
    expect(stopped).toMatchObject({ ok: true, control: { mode: "taken-over" } });
    expect(typed).toMatchObject({ ok: false, reason: "aborted" });
    const pasteAt = shell.pty.written.findIndex((data) => data.startsWith("\u001b[200~"));
    expect(shell.pty.written.slice(pasteAt + 1)).toEqual([]);
  });

  it("stops disclosure when the shell reports a different command than the approved one", async () => {
    const shell = await hostShell();
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("echo other")}${SECRET}\n${shell.mark("D;0")}${shell.prompt()}`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo approved", "/w", () => true);
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)?.state).toBe("interrupted"));
    const disclosed = hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)!;
    expect(disclosed).toMatchObject({ interruption: "command-mismatch", output: "" });
  });

  it("ends the lease and its disclosure when the pane chat binding goes away mid-command", async () => {
    const shell = await hostShell();
    let bound = true;
    shell.hooks.onEnter = () => queueMicrotask(() => shell.pty.emitData(`${shell.run("sleep 30")}agent line\n`));
    const typed = await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "sleep 30", "/w", () => bound);
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    await vi.waitFor(() => expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)?.output).toContain("agent line"));
    bound = false;
    revokeUnboundHostTerminalLeases(WINDOW, () => bound);
    shell.pty.emitData(`${SECRET}\n`);
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)).toMatchObject({ state: "interrupted", interruption: "binding" });
    expect(hostTerminalDisclosure(shell.session, WINDOW, "conversation-a", typed.firstBlockId)!.output).not.toContain(SECRET);
  });

  it("refuses to start for a conversation that is not the tab's pane chat", async () => {
    const shell = await hostShell();
    expect(await typeHostTerminalCommand(shell.session, WINDOW, "conversation-a", "echo no", "/w", () => false)).toMatchObject({ ok: false, reason: "no-terminal" });
    expect(shell.pty.written).toEqual([]);
  });
});
