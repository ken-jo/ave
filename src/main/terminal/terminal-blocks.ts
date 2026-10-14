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
 * Marker grammar (OSC 133, terminated by BEL or ST):
 *   A  prompt start      B  command input start
 *   C[;cmdline_url=…]    command output start (command text percent-encoded)
 *   D[;<exit>]           command finished
 * plus OSC 7 `file://host/path` for the working directory.
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
/** An escape sequence longer than this is never completed; it is discarded. */
const MAX_PENDING_ESCAPE = 4096;
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
    if (rest.length === 0) return;
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
    const tail = this.tail.length > this.tailChars ? this.tail.slice(-this.tailChars) : this.tail;
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

/** Parse an OSC 7 payload (`file://host/path`) into a path, or null. */
function parseOsc7(payload: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/u.exec(payload);
  if (!match?.[1]) return null;
  return decodePercentEncoded(match[1]);
}

/**
 * Turns one terminal's output (and, for the fallback, its typed input) into
 * blocks. One tracker per PTY session.
 */
export class TerminalBlockTracker {
  private pending = "";
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

  constructor(private readonly now: () => number = Date.now) {}

  /** True once the shell has emitted any OSC 133 marker. */
  isIntegrated(): boolean {
    return this.integrated;
  }

  hasExited(): boolean {
    return this.exited;
  }

  /** Feed one PTY output chunk. */
  recordOutput(chunk: string): void {
    const data = this.pending + chunk;
    this.pending = "";
    let text = "";
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch !== "\u001b") {
        text += ch;
        i += 1;
        continue;
      }
      const consumed = this.consumeEscape(data, i, () => {
        this.appendText(text);
        text = "";
      });
      if (consumed === 0) {
        // Incomplete escape at the end of the chunk: hold it for the next one,
        // unless it has already grown past any plausible sequence.
        const rest = data.slice(i);
        if (rest.length <= MAX_PENDING_ESCAPE) this.pending = rest;
        break;
      }
      i += consumed;
    }
    this.appendText(text);
  }

  /**
   * Feed one user input write. Used only by the fallback: before the shell has
   * shown any marker, an Enter closes the running heuristic block and opens a
   * new one named after the line on screen.
   */
  recordInput(data: string): void {
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
   * Consume the escape sequence starting at `data[start]`. Returns the number
   * of characters consumed, or 0 when the sequence is not complete yet.
   * `flush` is called before a marker takes effect so text preceding the
   * marker lands in the phase it was printed in.
   */
  private consumeEscape(data: string, start: number, flush: () => void): number {
    const kind = data[start + 1];
    if (kind === undefined) return 0;
    if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
      // String sequence: OSC / DCS / APC / PM / SOS, ended by BEL or ST.
      for (let j = start + 2; j < data.length; j++) {
        const c = data[j];
        if (c === "\u0007") {
          if (kind === "]") this.handleOsc(data.slice(start + 2, j), flush);
          return j + 1 - start;
        }
        if (c === "\u001b") {
          if (j + 1 >= data.length) return 0;
          if (data[j + 1] === "\\") {
            if (kind === "]") this.handleOsc(data.slice(start + 2, j), flush);
            return j + 2 - start;
          }
        }
      }
      return 0;
    }
    if (kind === "[") {
      for (let j = start + 2; j < data.length; j++) {
        const code = data.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) return j + 1 - start;
      }
      return 0;
    }
    if (kind === "(" || kind === ")" || kind === "*" || kind === "+" || kind === "#" || kind === "%") {
      return start + 2 < data.length ? 3 : 0;
    }
    return 2;
  }

  private handleOsc(body: string, flush: () => void): void {
    if (body.startsWith("7;")) {
      const path = parseOsc7(body.slice(2));
      if (path) this.cwd = path;
      return;
    }
    if (!body.startsWith("133;")) return;
    flush();
    const [marker = "", ...params] = body.slice(4).split(";");
    if (!this.integrated) {
      // The first marker ends the fallback for good. A heuristic block that is
      // still running was split on a guess; close it rather than mix sources.
      this.integrated = true;
      if (this.open?.source === "heuristic") this.closeOpen(null);
    }
    switch (marker) {
      case "A":
        // A prompt while a command is still open means its D never came (an
        // interrupted command in some shells): close it without an exit code.
        if (this.open) this.closeOpen(null);
        this.phase = "prompt";
        break;
      case "B":
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

  private snapshotOpen(open: OpenBlock): TerminalBlock {
    return {
      id: open.id,
      command: open.command,
      cwd: open.cwd,
      exitCode: null,
      startedAt: open.startedAt,
      endedAt: null,
      status: "running",
      source: open.source,
      outputChars: open.output.chars(),
      truncated: open.output.truncated(),
      output: open.output.text(),
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

const trackers = new Map<string, TerminalBlockTracker>();

/** Install the tracker for a newly spawned PTY, replacing any previous one. */
export function registerTerminalBlockTracker(tabId: string, tracker: TerminalBlockTracker): void {
  trackers.set(tabId, tracker);
}

/** Drop a tab's blocks (tab closed). */
export function unregisterTerminalBlockTracker(tabId: string): void {
  trackers.delete(tabId);
}

export function getTerminalBlockTracker(tabId: string): TerminalBlockTracker | undefined {
  return trackers.get(tabId);
}

/** Every terminal tab that has a tracker, in creation order. */
export function listTerminalBlockTabs(): Array<{ tabId: string; tracker: TerminalBlockTracker }> {
  return [...trackers.entries()].map(([tabId, tracker]) => ({ tabId, tracker }));
}

/** Test-only: clear the registry. */
export function __resetTerminalBlocksForTest(): void {
  trackers.clear();
}
