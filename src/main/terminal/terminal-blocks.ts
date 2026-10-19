/**
 * terminal-blocks.ts — command blocks for the interactive PTY terminal.
 *
 * A block is one command plus its output, its exit code, the directory it ran
 * in and how long it took. The PTY output stream is the only input: the shell
 * integration written into each terminal's sandbox HOME (shell-integration.ts)
 * brackets every command with OSC 133 markers, and this module turns that
 * marked stream into block records. A shell that emits no markers gets a
 * coarser split at each Enter the user types, labelled `heuristic` so no
 * reader mistakes it for a measured boundary.
 *
 * The main process is the single source of truth for blocks. The renderer
 * lists and attaches them over IPC and the agent's `terminal_read` tool reads
 * them here, so both see the same record. This module is pure: no electron,
 * no node-pty — pty-manager feeds it.
 *
 * Marker grammar (OSC 133, terminated by BEL or ST; `<n>` is the nonce):
 *   A;<n>  prompt start      B;<n>  command input start
 *   C[;cmdline_url=…];<n>    command output start (command text percent-encoded)
 *   D[;<exit>];<n>           command finished
 *   P;Cwd=<encoded path>;<n> the working directory
 *
 * A marker counts only when its last field is this terminal's nonce (see
 * shell-integration.ts): anything a command prints reaches the same stream,
 * and an unauthenticated marker is output like any other escape sequence. It
 * changes no block and does not end the fallback. OSC 7 carries no nonce, so
 * it is never read. The nonce is removed from the stream the renderer and the
 * scrollback replay receive ({@link TerminalBlockTracker.recordOutput}).
 *
 * Output is stored as plain text: escape sequences are dropped, CRLF becomes
 * LF, a bare CR rewinds the line (so progress bars keep their final state) and
 * backspace erases one character. Each block keeps its first
 * {@link HEAD_CHARS} and last {@link TAIL_CHARS} characters; errors usually
 * sit at the end, so the tail gets most of the budget.
 */
import type {
  TerminalBlock,
  TerminalBlockSource,
  TerminalBlockSummary,
} from "../../shared/terminal-blocks.js";

/** Completed blocks kept per terminal; older ones are dropped first. */
const MAX_BLOCKS_PER_TERMINAL = 100;
/** Output characters kept from the start of a block. */
const HEAD_CHARS = 8 * 1024;
/** Output characters kept from the end of a block. */
const TAIL_CHARS = 56 * 1024;
/**
 * Characters the current (uncommitted) line may hold before its start is
 * committed to the head/tail budget. Keeps a newline-free stream bounded.
 */
const MAX_OPEN_LINE_CHARS = 8 * 1024;
/**
 * OSC payload characters kept while a sequence is incomplete. The longest
 * marker the shell integration emits is a C carrying a command of at most
 * {@link MAX_COMMAND_CHARS} characters, percent-encoded (a Korean syllable is
 * nine characters encoded): well under this. A longer OSC is discarded whole.
 */
const MAX_OSC_PAYLOAD_CHARS = 64 * 1024;
/** Characters of command text kept per block. */
const MAX_COMMAND_CHARS = 4096;

/**
 * Plain-text accumulator for one region of terminal output. Applies the
 * CR / LF / backspace rules and keeps a head and a tail when the region grows
 * past its budget.
 */
class PlainTextBuffer {
  private head = "";
  private tail = "";
  private line = "";
  private crPending = false;
  private total = 0;

  constructor(
    private readonly headChars: number,
    private readonly tailChars: number,
  ) {}

  append(text: string): void {
    for (const ch of text) {
      if (ch === "\n") {
        this.crPending = false;
        this.commit(`${this.line}\n`);
        this.line = "";
      } else if (ch === "\r") {
        this.crPending = true;
      } else if (ch === "\b") {
        this.line = this.line.slice(0, -1);
      } else if (ch === "\t" || ch >= " ") {
        if (ch === "\u007f") continue;
        if (this.crPending) {
          this.crPending = false;
          this.line = "";
        }
        this.line += ch;
        // Output with no newline (a minified bundle, a binary dumped to the
        // screen) is one endless line. Past the cap its start is committed
        // like any other text, so the head/tail budget bounds it too; only a
        // later CR or backspace can no longer reach the committed part.
        if (this.line.length > MAX_OPEN_LINE_CHARS) {
          const keep = MAX_OPEN_LINE_CHARS / 2;
          this.commit(this.line.slice(0, this.line.length - keep));
          this.line = this.line.slice(-keep);
        }
      }
    }
  }

  private commit(segment: string): void {
    this.total += segment.length;
    let rest = segment;
    if (this.head.length < this.headChars && this.tail.length === 0) {
      const room = this.headChars - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    // A buffer with no tail budget keeps its head only (`slice(-0)` would
    // keep everything, so the zero case never reaches the trim below).
    if (rest.length === 0 || this.tailChars === 0) return;
    this.tail += rest;
    // Trim in batches so a stream of short lines does not re-slice per line.
    if (this.tail.length > this.tailChars * 2) this.tail = this.tail.slice(-this.tailChars);
  }

  /** The current, uncommitted line (what the cursor row shows). */
  currentLine(): string {
    return this.line;
  }

  /** The last non-empty line, committed or not. */
  lastNonEmptyLine(): string {
    if (this.line.trim()) return this.line;
    const committed = `${this.head}${this.tail}`.split("\n");
    for (let i = committed.length - 1; i >= 0; i--) {
      const candidate = committed[i] ?? "";
      if (candidate.trim()) return candidate;
    }
    return "";
  }

  chars(): number {
    return this.total + this.line.length;
  }

  truncated(): boolean {
    return this.total > this.head.length + Math.min(this.tail.length, this.tailChars);
  }

  text(): string {
    const tail = this.tailChars === 0
      ? ""
      : this.tail.length > this.tailChars ? this.tail.slice(-this.tailChars) : this.tail;
    const kept = this.head.length + tail.length;
    const omitted = this.total - kept;
    const gap = omitted > 0 ? `\n[… ${omitted} characters omitted …]\n` : "";
    // A whitespace-only cursor row is padding the shell drew before its next
    // prompt (end-of-line marks, cleared rows), not output.
    const line = this.line.trim() ? this.line : "";
    return `${this.head}${gap}${tail}${line}`;
  }
}

interface OpenBlock {
  id: number;
  command: string;
  cwd: string | null;
  startedAt: number;
  source: TerminalBlockSource;
  output: PlainTextBuffer;
}

type Phase = "idle" | "prompt" | "input" | "output";

/** An OSC / DCS / APC / PM / SOS string in progress. */
interface StringEscape {
  state: "string";
  /** Only an OSC payload is kept; the others are skipped. */
  osc: boolean;
  payload: string;
  /** Past {@link MAX_OSC_PAYLOAD_CHARS}: discarded at its terminator. */
  overflow: boolean;
  /** The previous character was ESC (a possible ST). */
  sawEsc: boolean;
}

type EscapeState =
  | { state: "text" }
  | { state: "esc" }
  | { state: "csi" }
  | { state: "charset" }
  | StringEscape;

/**
 * Decode a percent-encoded string whose literal characters may themselves be
 * non-ASCII. Every `%XX` is a byte; every other character contributes its UTF-8
 * bytes; the result is decoded as UTF-8. A malformed escape stays literal.
 */
export function decodePercentEncoded(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] ?? "";
    if (ch === "%" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = value.codePointAt(i) ?? 0;
    const encoded = Buffer.from(String.fromCodePoint(code), "utf-8");
    for (const byte of encoded) bytes.push(byte);
    if (code > 0xffff) i += 1;
  }
  return Buffer.from(bytes).toString("utf-8");
}

function cleanCommand(raw: string): string {
  const oneLine = raw.replace(/\s+$/u, "").replace(/^\s+/u, "");
  return oneLine.length > MAX_COMMAND_CHARS ? oneLine.slice(0, MAX_COMMAND_CHARS) : oneLine;
}

/**
 * Whether the shell is waiting at its prompt for a new command, and if not,
 * why not. Read before `terminal_run` types a command into a terminal.
 *  - `ready`: an empty prompt — the last command finished and nothing has
 *    been typed at the new prompt;
 *  - `no-shell-integration`: the shell emits no markers, so its state cannot
 *    be known;
 *  - `exited`: the shell is gone;
 *  - `command-running`: a command (or a full-screen program) is in the
 *    foreground, so typed text would go to it rather than to the shell;
 *  - `between-prompts`: a command finished and the next prompt has not
 *    started;
 *  - `pending-input`: the user has typed at the prompt and not submitted it,
 *    pressed any key since the prompt was drawn (an ESC or Ctrl-X prefix or
 *    a switch to vi command mode leaves no echo, yet changes what typed text
 *    does), or typed anything within the last {@link USER_INPUT_QUIET_MS}
 *    (keys still on their way through the shell have not been echoed yet);
 *  - `no-bracketed-paste`: the shell did not report bracketed paste on, so
 *    text written to it would be read as keys rather than inserted;
 *  - `vi-editing-mode`: the shell's line editor uses vi key bindings, where
 *    typed text can be read as editing commands;
 *  - `shell-starting`: a shell that marks the end of its prompt (zsh, bash)
 *    has begun its first prompt but not finished it yet;
 *  - `no-prompt-end-marker`: the shell marks no end of prompt (fish), so
 *    typing at its prompt cannot be told from the prompt itself.
 */
export type TerminalPromptState =
  | "ready"
  | "no-shell-integration"
  | "exited"
  | "command-running"
  | "between-prompts"
  | "pending-input"
  | "no-bracketed-paste"
  | "vi-editing-mode"
  | "shell-starting"
  | "no-prompt-end-marker";

/**
 * How long after the user's last keystroke the prompt is still treated as in
 * use: a key written to the PTY reaches the echo only after the shell reads
 * it, so an empty echo just after typing proves nothing.
 */
export const USER_INPUT_QUIET_MS = 1500;

/**
 * A write made only of replies the terminal emulator sends by itself through
 * the same input channel as keystrokes: focus in/out (`CSI I`, `CSI O`),
 * device-attribute, status and cursor-position reports (`CSI ? … c`,
 * `CSI … n`, `CSI … R`), and OSC/DCS answers to a program's queries. None of
 * them edits the prompt line. A key — an arrow, a letter, a paste — never
 * has this shape.
 */
const TERMINAL_REPLY =
  /^(?:\u001b\[[IO]|\u001b\[[?>=]?[0-9;]*[cnR]|\u001b\][0-9]+;[^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001bP[^\u001b]*\u001b\\)+$/u;

/**
 * Turns one terminal's output (and, for the fallback, its typed input) into
 * blocks. One tracker per PTY session.
 */
export class TerminalBlockTracker {
  /** Where the escape-sequence parser stands between chunks. */
  private esc: EscapeState = { state: "text" };
  /** Display text of the chunk being parsed (see {@link recordOutput}). */
  private display = "";
  private phase: Phase = "idle";
  private integrated = false;
  private cwd: string | null = null;
  private nextId = 1;
  private open: OpenBlock | null = null;
  private readonly done: TerminalBlock[] = [];
  /** Text outside any block (prompt and typed input in the fallback). */
  private idle = new PlainTextBuffer(0, 4096);
  /** Echoed input between B and C, used when C carries no command text. */
  private echo = new PlainTextBuffer(MAX_COMMAND_CHARS, 0);
  private exited = false;
  /** When the user last wrote to this terminal ({@link recordInput}), or null. */
  private lastInputAt: number | null = null;
  /** True once the shell has marked the end of a prompt (B). */
  private sawPromptEnd = false;
  /** How many prompts the shell has finished drawing (B markers). */
  private promptEnds = 0;
  /** True once the user pressed a key after the current prompt was drawn. */
  private inputSincePromptEnd = false;
  /**
   * The line editor's set-up as the shell reported it at its last prompt
   * (`Keys=` and `Paste=` on the P marker), or null when it reported none.
   */
  private editor: { readonly keys: string; readonly bracketedPaste: boolean } | null = null;
  /** Called after every authenticated marker and on exit (see {@link subscribe}). */
  private readonly listeners = new Set<() => void>();

  private readonly nonce: string;
  private readonly now: () => number;
  /** Whether this terminal's shell integration marks the end of its prompt (B): zsh and bash do, fish does not. */
  private readonly marksPromptEnd: boolean;

  constructor(options: { nonce: string; marksPromptEnd: boolean; now?: () => number }) {
    // An empty nonce would make every bare marker "authenticated".
    if (!options.nonce) throw new Error("TerminalBlockTracker requires a nonce");
    this.nonce = options.nonce;
    this.marksPromptEnd = options.marksPromptEnd;
    this.now = options.now ?? Date.now;
  }

  /** True once the shell has emitted a marker carrying this terminal's nonce. */
  isIntegrated(): boolean {
    return this.integrated;
  }

  hasExited(): boolean {
    return this.exited;
  }

  /** The shell's state at this moment, from its markers alone ({@link TerminalPromptState}). */
  promptState(): TerminalPromptState {
    if (this.exited) return "exited";
    if (!this.integrated) return "no-shell-integration";
    if (this.open) return "command-running";
    // zsh and bash mark the end of the prompt (B): anything echoed after it is
    // the user's own typing. fish marks no B, so its prompt phase is the
    // steady state and typing there cannot be told from the prompt text.
    if (this.phase === "input") {
      if (this.echo.text().trim() !== "" || this.inputSincePromptEnd) return "pending-input";
      if (this.lastInputAt !== null && this.now() - this.lastInputAt < USER_INPUT_QUIET_MS) return "pending-input";
      if (this.editor?.bracketedPaste !== true) return "no-bracketed-paste";
      if (this.editor.keys !== "emacs") return "vi-editing-mode";
      return "ready";
    }
    if (this.phase === "prompt") {
      if (!this.marksPromptEnd) return "no-prompt-end-marker";
      return this.sawPromptEnd ? "between-prompts" : "shell-starting";
    }
    return "between-prompts";
  }

  /** How many prompts the shell has finished drawing; grows by one with each new prompt. */
  promptEndCount(): number {
    return this.promptEnds;
  }

  /** The working directory the shell last reported, or null before it reported one. */
  currentCwd(): string | null {
    return this.cwd;
  }

  /** The id the next block will get: every block opened after this call has at least this id. */
  nextBlockId(): number {
    return this.nextId;
  }

  /**
   * Be told when a block opens or closes or the prompt state changes (after
   * every authenticated marker, and when the shell exits). Returns the
   * unsubscribe function. A listener runs inside the PTY data callback and
   * must only record what it needs.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Feed one PTY output chunk.
   *
   * A small state machine, so an escape sequence split across chunks resumes
   * where it stopped instead of being re-scanned from its start (a long OSC
   * arriving a byte at a time would otherwise cost quadratic time). Only OSC
   * payloads are kept, up to {@link MAX_OSC_PAYLOAD_CHARS}; every other
   * sequence is skipped as it streams past.
   *
   * Returns the text to show and replay for this chunk: the chunk itself,
   * with an incomplete OSC held back until it completes and each
   * authenticated marker reduced to `OSC 133;<letter>` (`P` dropped), so the
   * nonce never reaches the renderer or the scrollback ring.
   */
  recordOutput(chunk: string): string {
    let text = "";
    const flush = (): void => {
      this.appendText(text);
      text = "";
    };
    // What the terminal view receives: the chunk as it came, except that an
    // OSC is held until it is complete and an authenticated marker is passed
    // on without its fields — so the nonce never leaves the main process.
    this.display = "";
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] ?? "";
      const esc = this.esc;
      switch (esc.state) {
        case "text":
          if (ch === "\u001b") {
            this.esc = { state: "esc" };
          } else {
            text += ch;
            this.display += ch;
          }
          break;
        case "esc":
          if (ch === "]") {
            // Held: the display gets it once it is known not to be a marker.
            this.esc = { state: "string", osc: true, payload: "", overflow: false, sawEsc: false };
            break;
          }
          this.display += `\u001b${ch}`;
          if (ch === "P" || ch === "_" || ch === "^" || ch === "X") {
            this.esc = { state: "string", osc: false, payload: "", overflow: false, sawEsc: false };
          } else if (ch === "[") {
            this.esc = { state: "csi" };
          } else if (ch === "(" || ch === ")" || ch === "*" || ch === "+" || ch === "#" || ch === "%") {
            this.esc = { state: "charset" };
          } else {
            this.esc = { state: "text" };
          }
          break;
        case "csi": {
          this.display += ch;
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) this.esc = { state: "text" };
          break;
        }
        case "charset":
          this.display += ch;
          this.esc = { state: "text" };
          break;
        case "string": {
          // Terminated by BEL or ST (ESC \). An ESC not followed by `\` is
          // payload, as before.
          if (esc.sawEsc) {
            esc.sawEsc = false;
            if (ch === "\\") {
              this.finishString(esc, "\u001b\\", flush);
              break;
            }
            this.addToString(esc, "\u001b");
          }
          if (ch === "\u0007") {
            this.finishString(esc, "\u0007", flush);
          } else if (ch === "\u001b") {
            esc.sawEsc = true;
          } else {
            this.addToString(esc, ch);
          }
          break;
        }
      }
    }
    flush();
    return this.display;
  }

  /**
   * Keep an OSC payload character, or stop keeping once it is over the bound.
   * A string that is not kept streams straight to the display.
   */
  private addToString(esc: StringEscape, ch: string): void {
    if (!esc.osc || esc.overflow) {
      this.display += ch;
      return;
    }
    if (esc.payload.length >= MAX_OSC_PAYLOAD_CHARS) {
      // No marker is this long (the scripts bound what they encode), so this
      // is not one: it is discarded whole when its terminator arrives and the
      // text around it is unaffected. The view gets it as it was.
      esc.overflow = true;
      this.display += `\u001b]${esc.payload}${ch}`;
      esc.payload = "";
      return;
    }
    esc.payload += ch;
  }

  private finishString(esc: StringEscape, terminator: string, flush: () => void): void {
    this.esc = { state: "text" };
    if (!esc.osc || esc.overflow) {
      this.display += terminator;
      return;
    }
    const marker = this.handleOsc(esc.payload, flush);
    if (marker === null) {
      this.display += `\u001b]${esc.payload}${terminator}`;
    } else if (marker !== "P") {
      // The view only needs the letter (PtyTerminalView re-lists on A/C/D).
      this.display += `\u001b]133;${marker}\u0007`;
    }
  }

  /**
   * Feed one user input write. Its time is kept for {@link promptState},
   * unless the write is only replies the terminal emulator sent on its own
   * ({@link TERMINAL_REPLY}), which are not the user typing. The
   * fallback also uses it: before the shell has shown any marker, an Enter
   * closes the running heuristic block and opens a new one named after the
   * line on screen.
   */
  recordInput(data: string): void {
    if (!TERMINAL_REPLY.test(data)) {
      this.lastInputAt = this.now();
      if (this.phase === "input") this.inputSincePromptEnd = true;
    }
    if (this.integrated || !data.includes("\r")) return;
    const line = this.open ? this.open.output.currentLine() : this.idle.currentLine();
    const command = cleanCommand(line || (this.open ? this.open.output.lastNonEmptyLine() : this.idle.lastNonEmptyLine()));
    if (this.open) this.closeOpen(null);
    this.open = {
      id: this.nextId++,
      command,
      cwd: this.cwd,
      startedAt: this.now(),
      source: "heuristic",
      output: new PlainTextBuffer(HEAD_CHARS, TAIL_CHARS),
    };
    this.phase = "output";
  }

  /** The shell exited: close the running block without an exit code. */
  recordExit(): void {
    this.exited = true;
    if (this.open) this.closeOpen(null);
    this.phase = "idle";
    this.notify();
  }

  /** Newest first, completed and running. */
  list(): TerminalBlockSummary[] {
    const all: TerminalBlockSummary[] = this.done.map(summarize);
    if (this.open) all.push(summarize(this.snapshotOpen(this.open)));
    return all.reverse();
  }

  get(id: number): TerminalBlock | null {
    if (this.open?.id === id) return this.snapshotOpen(this.open);
    return this.done.find((block) => block.id === id) ?? null;
  }

  /** The newest `limit` blocks with output, newest first. */
  recent(limit: number): TerminalBlock[] {
    const all: TerminalBlock[] = [...this.done];
    if (this.open) all.push(this.snapshotOpen(this.open));
    return all.slice(-Math.max(0, limit)).reverse();
  }

  /**
   * Apply one complete OSC. Returns the marker letter when it was an
   * authenticated OSC 133 marker, else null (the sequence is ordinary output).
   */
  private handleOsc(body: string, flush: () => void): string | null {
    if (!body.startsWith("133;")) return null;
    const fields = body.slice(4).split(";");
    // The nonce is the last field. Anything else — no nonce, a wrong one, a
    // marker a program printed — changes nothing, and in particular does not
    // switch the fallback off.
    if (fields.length < 2 || fields[fields.length - 1] !== this.nonce) return null;
    const [marker = "", ...params] = fields.slice(0, -1);
    if (!/^[A-Z]$/u.test(marker)) return null;
    flush();
    if (!this.integrated) {
      // The first marker ends the fallback for good. A heuristic block that is
      // still running was split on a guess; close it rather than mix sources.
      this.integrated = true;
      if (this.open?.source === "heuristic") this.closeOpen(null);
    }
    switch (marker) {
      case "P": {
        const cwd = params.find((p) => p.startsWith("Cwd="));
        if (cwd !== undefined && cwd.length > "Cwd=".length) {
          this.cwd = decodePercentEncoded(cwd.slice("Cwd=".length));
        }
        const keys = params.find((p) => p.startsWith("Keys="))?.slice("Keys=".length);
        const paste = params.find((p) => p.startsWith("Paste="))?.slice("Paste=".length);
        this.editor = keys === undefined || paste === undefined ? null : { keys, bracketedPaste: paste === "1" };
        break;
      }
      case "A":
        // A prompt while a command is still open means its D never came (an
        // interrupted command in some shells): close it without an exit code.
        if (this.open) this.closeOpen(null);
        this.phase = "prompt";
        break;
      case "B":
        this.sawPromptEnd = true;
        this.promptEnds++;
        this.inputSincePromptEnd = false;
        this.echo = new PlainTextBuffer(MAX_COMMAND_CHARS, 0);
        this.phase = "input";
        break;
      case "C": {
        if (this.open) this.closeOpen(null);
        const cmdParam = params.find((p) => p.startsWith("cmdline_url="));
        const command = cmdParam !== undefined
          ? decodePercentEncoded(cmdParam.slice("cmdline_url=".length))
          : this.echo.text();
        this.open = {
          id: this.nextId++,
          command: cleanCommand(command),
          cwd: this.cwd,
          startedAt: this.now(),
          source: "osc133",
          output: new PlainTextBuffer(HEAD_CHARS, TAIL_CHARS),
        };
        this.phase = "output";
        break;
      }
      case "D": {
        const raw = params[0];
        const exit = raw !== undefined && /^-?\d+$/u.test(raw) ? Number.parseInt(raw, 10) : null;
        if (this.open) this.closeOpen(exit);
        this.phase = "idle";
        break;
      }
      default:
        break;
    }
    this.notify();
    return marker;
  }

  private appendText(text: string): void {
    if (!text) return;
    switch (this.phase) {
      case "output":
        if (this.open) this.open.output.append(text);
        else this.idle.append(text);
        break;
      case "input":
        this.echo.append(text);
        break;
      default:
        this.idle.append(text);
        break;
    }
  }

  /**
   * A command can print this terminal's marker nonce (the shell holds it in a
   * variable). Block records go to the agent, and a nonce in the agent's hands
   * would let printed text forge markers, so the records never carry it.
   */
  private redactNonce(text: string): string {
    return text.includes(this.nonce) ? text.split(this.nonce).join("[terminal-nonce]") : text;
  }

  private snapshotOpen(open: OpenBlock): TerminalBlock {
    return {
      id: open.id,
      command: this.redactNonce(open.command),
      cwd: open.cwd,
      exitCode: null,
      startedAt: open.startedAt,
      endedAt: null,
      status: "running",
      source: open.source,
      outputChars: open.output.chars(),
      truncated: open.output.truncated(),
      output: this.redactNonce(open.output.text()),
    };
  }

  private closeOpen(exitCode: number | null): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    this.done.push({
      ...this.snapshotOpen(open),
      exitCode,
      endedAt: this.now(),
      status: "done",
    });
    if (this.done.length > MAX_BLOCKS_PER_TERMINAL) {
      this.done.splice(0, this.done.length - MAX_BLOCKS_PER_TERMINAL);
    }
    // The fallback names the next block after the line on screen; start that
    // line fresh so the previous block's output does not leak into it.
    this.idle = new PlainTextBuffer(0, 4096);
  }
}

function summarize(block: TerminalBlock): TerminalBlockSummary {
  const { output: _output, ...summary } = block;
  return summary;
}

// ─── Registry: one tracker per terminal tab ─────────────────────────────────

interface RegisteredTracker {
  tracker: TerminalBlockTracker;
  /**
   * The app window whose renderer spawned the terminal (Electron
   * BrowserWindow id), or null when it could not be told. terminal_read
   * shows a session only the terminals of the window that hosts it.
   */
  ownerWindowId: number | null;
}

const trackers = new Map<string, RegisteredTracker>();

/** Install the tracker for a newly spawned PTY, replacing any previous one. */
export function registerTerminalBlockTracker(
  tabId: string,
  tracker: TerminalBlockTracker,
  ownerWindowId: number | null,
): void {
  trackers.set(tabId, { tracker, ownerWindowId });
}

/** Drop a tab's blocks (tab closed). */
export function unregisterTerminalBlockTracker(tabId: string): void {
  trackers.delete(tabId);
}

export function getTerminalBlockTracker(tabId: string): TerminalBlockTracker | undefined {
  return trackers.get(tabId)?.tracker;
}

/** One window's tracker for `tabId`, or undefined when the tab is another window's. */
export function getWindowTerminalBlockTracker(tabId: string, windowId: number): TerminalBlockTracker | undefined {
  const entry = trackers.get(tabId);
  return entry && entry.ownerWindowId === windowId ? entry.tracker : undefined;
}

/**
 * The window a terminal tab belongs to: its id, null when the terminal was
 * spawned without one, undefined when no terminal has that tab id.
 */
export function terminalTabOwnerWindow(tabId: string): number | null | undefined {
  return trackers.get(tabId)?.ownerWindowId;
}

/** The terminal tabs of one window that have a tracker, in creation order. */
export function listTerminalBlockTabs(windowId: number): Array<{ tabId: string; tracker: TerminalBlockTracker }> {
  return [...trackers.entries()]
    .filter(([, entry]) => entry.ownerWindowId === windowId)
    .map(([tabId, entry]) => ({ tabId, tracker: entry.tracker }));
}

/** Test-only: clear the registry. */
export function __resetTerminalBlocksForTest(): void {
  trackers.clear();
}
