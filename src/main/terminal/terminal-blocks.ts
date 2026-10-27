// Main owns command blocks for both renderer and tools; markerless shells use explicitly labelled Enter-split heuristics.
// Authenticate markers with the terminal nonce, ignore OSC 7, and strip the nonce before renderer delivery or replay.
// See shell-integration.ts for grammar; normalize output to plain text and retain more tail than head because errors usually occur last.
import type {
  TerminalBlock,
  TerminalBlockSource,
  TerminalBlockSummary,
} from "../../shared/terminal-blocks.js";

import { terminalLaneKey, sameTerminalSession, type TerminalRef, type TerminalSessionRef, type TerminalSessionInfo } from "../../shared/terminal-session.js";

// Completed blocks kept per terminal; older ones are dropped first.
const MAX_BLOCKS_PER_TERMINAL = 100;
// Output characters kept from the start of a block.
const HEAD_CHARS = 8 * 1024;
// Output characters kept from the end of a block.
const TAIL_CHARS = 56 * 1024;
// Characters the current (uncommitted) line may hold before its start is committed to the head/tail budget. Keeps a newline-free stream bounded.
const MAX_OPEN_LINE_CHARS = 8 * 1024;
// The OSC limit exceeds a MAX_COMMAND_CHARS command even after percent encoding; discard longer sequences whole.
const MAX_OSC_PAYLOAD_CHARS = 64 * 1024;
// Characters of command text kept per block.
const MAX_COMMAND_CHARS = 4096;

// Plain-text accumulator for one region of terminal output. Applies the CR / LF / backspace rules and keeps a head and a tail when the region grows past its budget.
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
        // Output with no newline (a minified bundle, a binary dumped to the screen) is one endless line. Past the cap its start is committed like any other
        // text, so the head/tail budget bounds it too; only a later CR or backspace can no longer reach the committed part.
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
    // A buffer with no tail budget keeps its head only (`slice(-0)` would keep everything, so the zero case never reaches the trim below).
    if (rest.length === 0 || this.tailChars === 0) return;
    this.tail += rest;
    // Trim in batches so a stream of short lines does not re-slice per line.
    if (this.tail.length > this.tailChars * 2) this.tail = this.tail.slice(-this.tailChars);
  }

  // Whether the last character was a CR that no later character has acted on yet.
  carriageReturnPending(): boolean {
    return this.crPending;
  }

  // The current, uncommitted line (what the cursor row shows).
  currentLine(): string {
    return this.line;
  }

  // The last non-empty line, committed or not.
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
    // A whitespace-only cursor row is padding the shell drew before its next prompt (end-of-line marks, cleared rows), not output.
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

// An OSC / DCS / APC / PM / SOS string in progress.
interface StringEscape {
  state: "string";
  // Only an OSC payload is kept; the others are skipped.
  osc: boolean;
  introducer: string;
  payload: string;
  // Past {@link MAX_OSC_PAYLOAD_CHARS}: discarded at its terminator.
  overflow: boolean;
  // An oversized editor report is never replayed, even before its nonce is known.
  hidden: boolean;
  // The previous character was ESC (a possible ST).
  sawEsc: boolean;
}

type EscapeState =
  | { state: "text" }
  | { state: "esc" }
  | { state: "csi"; params: string }
  | { state: "charset" }
  | StringEscape;

// Decode a percent-encoded string whose literal characters may themselves be non-ASCII. Every `%XX` is a byte; every other character contributes its
// UTF-8 bytes; the result is decoded as UTF-8. A malformed escape stays literal.
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

// Permit automated typing only at an empty authenticated prompt with bracketed paste and supported key bindings.
// Invisible editor prefixes, queued user keys, command-not-found handlers, or missing prompt-end markers require refusal.
export type TerminalPromptState =
  | "ready"
  | "no-shell-integration"
  | "exited"
  | "command-running"
  | "between-prompts"
  | "pending-input"
  | "no-bracketed-paste"
  | "vi-editing-mode"
  | "not-found-handler"
  | "shell-starting"
  | "no-prompt-end-marker";

// How long after the user's last keystroke the prompt is still treated as in use: a key written to the PTY reaches the echo only after the shell reads
// it, so an empty echo just after typing proves nothing.
export const USER_INPUT_QUIET_MS = 1500;

// Bound on the CSI parameter text kept while parsing output, enough for any query this tracker answers for.
const MAX_QUERY_PARAMS_CHARS = 32;
// Bound on unanswered queries of one kind; the oldest is dropped beyond it.
const MAX_OUTSTANDING_QUERIES = 16;

type QueryKind = "da1" | "da2" | "status" | "cursor" | "cursor-private" | `mode:${string}` | `color:${string}`;

// One reply the terminal emulator (xterm.js) sends on its own, as a strict pattern anchored at the start of the remaining input, and the query it answers.
// No pattern admits a control character other than the reply's own introducer and terminator.
const REPLY_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly kind: (match: RegExpExecArray) => QueryKind | "focus" }> = [
  { pattern: /^\u001b\[\?[0-9]{1,5}(?:;[0-9]{1,5}){0,15}c/u, kind: () => "da1" },
  { pattern: /^\u001b\[>[0-9]{1,5}(?:;[0-9]{1,5}){0,15}c/u, kind: () => "da2" },
  { pattern: /^\u001b\[0n/u, kind: () => "status" },
  { pattern: /^\u001b\[[0-9]{1,5};[0-9]{1,5}R/u, kind: () => "cursor" },
  { pattern: /^\u001b\[\?[0-9]{1,5};[0-9]{1,5}R/u, kind: () => "cursor-private" },
  { pattern: /^\u001b\[(\??)([0-9]{1,5});[0-4]\$y/u, kind: (match) => `mode:${match[1]}${match[2]}` },
  { pattern: /^\u001b\]((?:1[0-2])|(?:4;[0-9]{1,3}));rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\u0007|\u001b\\)/iu,
    kind: (match) => `color:${match[1]}` },
  { pattern: /^\u001b\[[IO]/u, kind: () => "focus" },
];

// Which emulator replies the terminal's own programs have asked for. Input counts as the user's unless every byte of it is a reply to such a query: a
// reply shape alone proves nothing, because the user can type or paste it (the line editor still runs any keys inside it).
class EmulatorReplyLedger {
  private readonly outstanding = new Map<QueryKind, number>();
  private focusReports = false;

  // A complete CSI from the program (parameter text, final byte).
  noteQuery(params: string, final: string): void {
    if (final === "c" && (params === "" || params === "0")) this.expect("da1");
    else if (final === "c" && (params === ">" || params === ">0")) this.expect("da2");
    else if (final === "n" && params === "5") this.expect("status");
    else if (final === "n" && params === "6") this.expect("cursor");
    else if (final === "n" && params === "?6") this.expect("cursor-private");
    else if (final === "p" && /^\??[0-9]{1,5}\$$/u.test(params)) this.expect(`mode:${params.slice(0, -1)}`);
    else if ((final === "h" || final === "l") && params.startsWith("?") && params.slice(1).split(";").includes("1004")) this.focusReports = final === "h";
  }

  // A complete OSC body from the program.
  noteOscQuery(body: string): void {
    const query = /^((?:1[0-2])|(?:4;[0-9]{1,3}));\?$/u.exec(body);
    if (query) this.expect(`color:${query[1]}`);
  }

  // Whether `data` is wholly made of replies to outstanding queries (or focus reports while the program asked for them); consumes those queries only then.
  isEmulatorReply(data: string): boolean {
    const consumed = new Map<QueryKind, number>();
    let rest = data;
    while (rest.length > 0) {
      let matched = false;
      for (const { pattern, kind } of REPLY_PATTERNS) {
        const match = pattern.exec(rest);
        if (!match) continue;
        const answered = kind(match);
        if (answered === "focus") {
          if (!this.focusReports) return false;
        } else {
          const used = (consumed.get(answered) ?? 0) + 1;
          if (used > (this.outstanding.get(answered) ?? 0)) return false;
          consumed.set(answered, used);
        }
        rest = rest.slice(match[0].length);
        matched = true;
        break;
      }
      if (!matched) return false;
    }
    for (const [kind, used] of consumed) {
      const left = (this.outstanding.get(kind) ?? 0) - used;
      if (left > 0) this.outstanding.set(kind, left);
      else this.outstanding.delete(kind);
    }
    return true;
  }

  private expect(kind: QueryKind): void {
    if (!this.outstanding.has(kind) && this.outstanding.size >= MAX_OUTSTANDING_QUERIES) {
      const oldest = this.outstanding.keys().next().value;
      if (oldest !== undefined) this.outstanding.delete(oldest);
    }
    this.outstanding.set(kind, Math.min(MAX_OUTSTANDING_QUERIES, (this.outstanding.get(kind) ?? 0) + 1));
  }
}

// Turns one terminal's output (and, for the fallback, its typed input) into blocks. One tracker per PTY session.
export class TerminalBlockTracker {
  // Where the escape-sequence parser stands between chunks.
  private esc: EscapeState = { state: "text" };
  // Queries the terminal's programs sent, which the emulator may answer through the input path.
  private readonly replies = new EmulatorReplyLedger();
  // Display text of the chunk being parsed (see {@link recordOutput}).
  private display = "";
  private phase: Phase = "idle";
  private integrated = false;
  private cwd: string | null = null;
  private nextId = 1;
  private open: OpenBlock | null = null;
  private readonly done: TerminalBlock[] = [];
  // Text outside any block (prompt and typed input in the fallback).
  private idle = new PlainTextBuffer(0, 4096);
  // Echoed input between B and C, used when C carries no command text.
  private echo = new PlainTextBuffer(MAX_COMMAND_CHARS, 0);
  private exited = false;
  // When the user last wrote to this terminal ({@link recordInput}), or null.
  private lastInputAt: number | null = null;
  private userInputs = 0;
  // True once the shell has marked the end of a prompt (B).
  private sawPromptEnd = false;
  // How many prompts the shell has finished drawing (B markers).
  private promptEnds = 0;
  // True once the user pressed a key after the current prompt was drawn.
  private inputSincePromptEnd = false;
  // The line editor's set-up as the shell reported it at its last prompt (`Keys=` and `Paste=` on the P marker), or null when it reported none.
  private editor: { readonly keys: string; readonly bracketedPaste: boolean; readonly notFoundHandler: boolean } | null = null;
  // The token the current prompt's B marker carries, announced in its P marker. B comes from the prompt string, which prompt expansion can print, so it
  // carries this per-prompt token instead of the nonce.
  private promptEndToken: string | null = null;
  // The shell's own pid (`$$`, in its own pid namespace) from its last P marker, or null when it reported none.
  private shellPid: number | null = null;
  private editLineQuerySupported = false;
  private editLinePromptReady = false;
  private editLineReports = 0;
  private currentEditLineReport: { readonly generation: number; readonly line: string } | null = null;
  // Called after authenticated markers, user input, and exit (see {@link subscribe}).
  private readonly listeners = new Set<() => void>();
  private blockOutput: { blockId: number; pending: string; onOutput: (text: string) => void } | undefined;

  private readonly nonce: string;
  private readonly now: () => number;
  // Whether this terminal's shell integration marks the end of its prompt (B): zsh and bash do, fish does not.
  private readonly marksPromptEnd: boolean;

  constructor(options: { nonce: string; marksPromptEnd: boolean; now?: () => number }) {
    // An empty nonce would make every bare marker "authenticated".
    if (!options.nonce) throw new Error("TerminalBlockTracker requires a nonce");
    this.nonce = options.nonce;
    this.marksPromptEnd = options.marksPromptEnd;
    this.now = options.now ?? Date.now;
  }

  // True once the shell has emitted a marker carrying this terminal's nonce.
  isIntegrated(): boolean {
    return this.integrated;
  }

  hasExited(): boolean {
    return this.exited;
  }

  // The shell's state at this moment, from its markers alone ({@link TerminalPromptState}).
  promptState(): TerminalPromptState {
    if (this.exited) return "exited";
    if (!this.integrated) return "no-shell-integration";
    if (this.open) return "command-running";
    // zsh and bash mark the end of the prompt (B): anything echoed after it is the user's own typing. fish marks no B, so its prompt phase is the steady
    // state and typing there cannot be told from the prompt text.
    if (this.phase === "input") {
      // A line editor the shell reported as taking no paste stays that way for the whole prompt, so say so before anything the user may still be doing: zsh
      // reports Paste=0 while a right-hand prompt (RPROMPT) is set, whose text follows B and would otherwise read as typing forever.
      if (this.editor !== null && !this.editor.bracketedPaste) return "no-bracketed-paste";
      if (this.echo.text().trim() !== "" || this.inputSincePromptEnd) return "pending-input";
      if (this.lastInputAt !== null && this.now() - this.lastInputAt < USER_INPUT_QUIET_MS) return "pending-input";
      if (this.editor?.bracketedPaste !== true) return "no-bracketed-paste";
      if (this.editor.keys !== "emacs") return "vi-editing-mode";
      if (this.editor.notFoundHandler) return "not-found-handler";
      return "ready";
    }
    if (this.phase === "prompt") {
      if (!this.marksPromptEnd) return "no-prompt-end-marker";
      return this.sawPromptEnd ? "between-prompts" : "shell-starting";
    }
    return "between-prompts";
  }

  // How many prompts the shell has finished drawing; grows by one with each new prompt.
  promptEndCount(): number {
    return this.promptEnds;
  }

  // Monotonic user-input generation; prompt redraws never reset it.
  userInputGeneration(): number {
    return this.userInputs;
  }

  // Whether the user pressed a key at the current prompt (emulator replies aside).
  typedSincePromptEnd(): boolean {
    return this.inputSincePromptEnd;
  }

  // Remove only the trailing blank-plus-unconsumed-CR wrap placeholder; a later character makes CR an ordinary carriage return.
  editLineText(): string {
    if (this.phase !== "input") return "";
    const text = this.echo.text().replace(/[\r\n]/gu, "");
    return this.echo.carriageReturnPending() && text.endsWith(" ") ? text.slice(0, -1) : text;
  }

  // Whether the current authenticated prompt attested its private editor query binding.
  supportsEditLineQuery(): boolean {
    return this.editLineQuerySupported && this.editLinePromptReady && this.phase === "input" && !this.exited;
  }

  // The latest authenticated buffer report, invalidated by prompt changes or user input.
  editLineReport(): { readonly generation: number; readonly line: string } | null {
    return this.currentEditLineReport === null ? null : { ...this.currentEditLineReport };
  }

  // Accepted report count; invalidation never resets this generation.
  editLineReportGeneration(): number {
    return this.editLineReports;
  }

  // The pid the shell reported for itself (`$$`) at its last prompt, or null.
  reportedShellPid(): number | null {
    return this.shellPid;
  }

  // The working directory the shell last reported, or null before it reported one.
  currentCwd(): string | null {
    return this.cwd;
  }

  // The id the next block will get: every block opened after this call has at least this id.
  nextBlockId(): number {
    return this.nextId;
  }

  // Be told when a block opens or closes or the prompt state changes (after every authenticated marker, user input, and shell exit). Returns the
  // unsubscribe function. A listener runs inside the PTY data or input callback and must only record what it needs.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stream one host-selected future block before scrollback retention can drop its framing. */
  subscribeBlockOutput(blockId: number, onOutput: (text: string) => void): { flush(): void; dispose(): void } {
    if (this.blockOutput || blockId !== this.nextId || this.exited) {
      throw new Error("Terminal output subscription does not name an available next block.");
    }
    const subscription = { blockId, pending: "", onOutput };
    this.blockOutput = subscription;
    return {
      flush: () => {
        if (this.blockOutput === subscription) this.publishBlockOutput("", true);
      },
      dispose: () => {
        subscription.pending = "";
        if (this.blockOutput === subscription) this.blockOutput = undefined;
      },
    };
  }

  private publishBlockOutput(text: string, final = false): void {
    const subscription = this.blockOutput;
    if (!subscription || this.open?.id !== subscription.blockId || this.open.source !== "osc133") return;
    const pending = subscription.pending + text;
    let cut = final ? pending.length : Math.max(pending.lastIndexOf("\n") + 1, pending.length - this.nonce.length + 1, 0);
    // Keep any nonce straddling the delivery cut whole; carry stays below two nonce lengths.
    for (let at = pending.indexOf(this.nonce); at !== -1 && at < cut; at = pending.indexOf(this.nonce, at + this.nonce.length)) {
      if (at + this.nonce.length > cut) { cut = at; break; }
    }
    const delivered = this.redactNonce(pending.slice(0, cut));
    subscription.pending = pending.slice(cut);
    if (delivered) subscription.onOutput(delivered);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // Parse escapes incrementally with bounded OSC storage to avoid quadratic work on split sequences.
  // Hold incomplete markers and strip authenticated nonce fields before renderer output or replay.
  recordOutput(chunk: string): string {
    let text = "";
    const flush = (): void => {
      this.appendText(text);
      text = "";
    };
    // What the terminal view receives: the chunk as it came, except that an OSC is held until it is complete and an authenticated marker is passed on
    // without its fields — so the nonce never leaves the main process.
    this.display = "";
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] ?? "";
      const esc = this.esc;
      // C1 controls and a fresh ESC interrupt other escape sequences, but remain payload inside control strings.
      if (esc.state !== "string") {
        if (ch === "\u001b") {
          if (esc.state === "esc") this.display += "\u001b";
          this.esc = { state: "esc" };
          continue;
        }
        if (ch === "\u009d" || "\u0090\u0098\u009e\u009f".includes(ch)) {
          if (esc.state === "esc") this.display += "\u001b";
          const osc = ch === "\u009d";
          if (!osc) this.display += ch;
          this.esc = { state: "string", osc, introducer: ch, payload: "", overflow: false, hidden: false, sawEsc: false };
          continue;
        }
        if (ch === "\u009b" || ch === "\u009c") {
          if (esc.state === "esc") this.display += "\u001b";
          this.display += ch;
          this.esc = ch === "\u009b" ? { state: "csi", params: "" } : { state: "text" };
          continue;
        }
      }
      switch (esc.state) {
        case "text":
          text += ch;
          this.display += ch;
          break;
        case "esc":
          if (ch === "]") {
            // Held: the display gets it once it is known not to be a marker.
            this.esc = { state: "string", osc: true, introducer: "\u001b]", payload: "", overflow: false, hidden: false, sawEsc: false };
            break;
          }
          this.display += `\u001b${ch}`;
          if (ch === "P" || ch === "_" || ch === "^" || ch === "X") {
            this.esc = { state: "string", osc: false, introducer: `\u001b${ch}`, payload: "", overflow: false, hidden: false, sawEsc: false };
          } else if (ch === "[") {
            this.esc = { state: "csi", params: "" };
          } else if (ch === "(" || ch === ")" || ch === "*" || ch === "+" || ch === "#" || ch === "%") {
            this.esc = { state: "charset" };
          } else {
            this.esc = { state: "text" };
          }
          break;
        case "csi": {
          this.display += ch;
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            this.replies.noteQuery(esc.params, ch);
            this.esc = { state: "text" };
          } else if (esc.params.length < MAX_QUERY_PARAMS_CHARS) {
            esc.params += ch;
          }
          break;
        }
        case "charset":
          this.display += ch;
          this.esc = { state: "text" };
          break;
        case "string": {
          // OSC accepts BEL or ST. DCS/SOS/PM/APC accept only ST; their BEL remains hidden payload.
          if (esc.sawEsc) {
            esc.sawEsc = false;
            if (ch === "\\") {
              this.finishString(esc, "\u001b\\", flush);
              break;
            }
            this.addToString(esc, "\u001b");
          }
          if (ch === "\u009c" || ch === "\u0007" && esc.osc) {
            this.finishString(esc, ch, flush);
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

  // Keep an OSC payload character, or stop keeping once it is over the bound. A string that is not kept streams straight to the display, except an
  // oversized editor report, which must never expose private payloads.
  private addToString(esc: StringEscape, ch: string): void {
    if (!esc.osc || esc.overflow) {
      if (!esc.hidden) this.display += ch;
      return;
    }
    if (esc.payload.length >= MAX_OSC_PAYLOAD_CHARS) {
      // No marker is this long (the scripts bound what they encode), so this is not one: it is discarded whole when its terminator arrives and the text around
      // it is unaffected. Only editor reports stay private: their final nonce cannot be known without retaining the whole payload.
      esc.overflow = true;
      esc.hidden = esc.payload.startsWith("133;E;") || esc.payload === "133;E";
      if (!esc.hidden) this.display += `${esc.introducer}${esc.payload}${ch}`;
      esc.payload = "";
      return;
    }
    esc.payload += ch;
  }

  private finishString(esc: StringEscape, terminator: string, flush: () => void): void {
    this.esc = { state: "text" };
    if (!esc.osc || esc.overflow) {
      if (!esc.hidden) this.display += terminator;
      return;
    }
    const marker = this.handleOsc(esc.payload, flush);
    if (marker === null) {
      this.display += `${esc.introducer}${esc.payload}${terminator}`;
    } else if (marker !== "P" && marker !== "E") {
      // The view only needs the letter (PtyTerminalView re-lists on A/C/D).
      this.display += `\u001b]133;${marker}\u0007`;
    }
  }

  // Every write counts as the user's input unless it is wholly the emulator's reply to queries the terminal's programs sent; markerless Enter input splits
  // heuristic blocks.
  recordInput(data: string): void {
    if (!this.replies.isEmulatorReply(data)) {
      this.currentEditLineReport = null;
      this.userInputs++;
      this.lastInputAt = this.now();
      this.notify();
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

  // The shell exited: close the running block without an exit code.
  recordExit(): void {
    this.currentEditLineReport = null;
    this.editLineQuerySupported = false;
    this.editLinePromptReady = false;
    this.exited = true;
    if (this.open) this.closeOpen(null);
    this.phase = "idle";
    this.notify();
  }

  // Newest first, completed and running.
  list(): TerminalBlockSummary[] {
    const all: TerminalBlockSummary[] = this.done.map(summarize);
    if (this.open) all.push(summarize(this.snapshotOpen(this.open)));
    return all.reverse();
  }

  get(id: number): TerminalBlock | null {
    if (this.open?.id === id) return this.snapshotOpen(this.open);
    return this.done.find((block) => block.id === id) ?? null;
  }

  // The newest `limit` blocks with output, newest first.
  recent(limit: number): TerminalBlock[] {
    const all: TerminalBlock[] = [...this.done];
    if (this.open) all.push(this.snapshotOpen(this.open));
    return all.slice(-Math.max(0, limit)).reverse();
  }

  // Apply one complete OSC. Returns the marker letter when it was an authenticated OSC 133 marker, else null (the sequence is ordinary output).
  private handleOsc(body: string, flush: () => void): string | null {
    this.replies.noteOscQuery(body);
    if (!body.startsWith("133;")) return null;
    const fields = body.slice(4).split(";");
    if (fields[0] === "B") return this.handlePromptEnd(fields, flush);
    // The nonce is the last field. Anything else — no nonce, a wrong one, a marker a program printed — changes nothing, and in particular does not switch the fallback off.
    if (fields.length < 2 || fields[fields.length - 1] !== this.nonce) return null;
    const [marker = "", ...params] = fields.slice(0, -1);
    if (!/^[A-Z]$/u.test(marker)) return null;
    if (marker === "E") {
      this.handleEditLineReport(params, flush);
      // Recognition protects private payloads even when their proof is stale or malformed; only the report handler decides whether to accept it.
      return "E";
    }
    flush();
    if (["P", "A", "C", "D"].includes(marker)) {
      this.currentEditLineReport = null;
      this.editLinePromptReady = false;
    }
    if (!this.integrated) {
      // The first marker ends the fallback for good. A heuristic block that is still running was split on a guess; close it rather than mix sources.
      this.integrated = true;
      if (this.open?.source === "heuristic") this.closeOpen(null);
    }
    switch (marker) {
      case "P": {
        const edit = params.filter((p) => p.startsWith("Edit="));
        this.editLineQuerySupported = edit.length === 1 && edit[0] === "Edit=1";
        const cwd = params.find((p) => p.startsWith("Cwd="));
        if (cwd !== undefined && cwd.length > "Cwd=".length) {
          this.cwd = decodePercentEncoded(cwd.slice("Cwd=".length));
        }
        const keys = params.find((p) => p.startsWith("Keys="))?.slice("Keys=".length);
        const paste = params.find((p) => p.startsWith("Paste="))?.slice("Paste=".length);
        const notFound = params.find((p) => p.startsWith("NotFound="))?.slice("NotFound=".length);
        this.editor = keys === undefined || paste === undefined
          ? null
          // A shell that does not say whether it has a not-found handler is taken to have one.
          : { keys, bracketedPaste: paste === "1", notFoundHandler: notFound !== "0" };
        const token = params.find((p) => p.startsWith("B="))?.slice("B=".length);
        this.promptEndToken = token !== undefined && /^[0-9a-f]{16,}$/u.test(token) ? token : null;
        const pid = params.find((p) => p.startsWith("Pid="))?.slice("Pid=".length);
        this.shellPid = pid !== undefined && /^[1-9][0-9]{0,9}$/u.test(pid) ? Number(pid) : null;
        break;
      }
      case "A":
        // A prompt while a command is still open means its D never came (an interrupted command in some shells): close it without an exit code.
        if (this.open) this.closeOpen(null);
        this.phase = "prompt";
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

  // Accept only a complete, current editor-buffer acknowledgement.
  private handleEditLineReport(params: readonly string[], flush: () => void): string | null {
    if (!this.editLineQuerySupported || !this.editLinePromptReady || this.phase !== "input" || this.exited || this.promptEndToken === null) return null;
    if (params.length !== 2) return null;
    const lines = params.filter((p) => p.startsWith("Line="));
    const tokens = params.filter((p) => p.startsWith("B="));
    if (lines.length !== 1 || tokens.length !== 1 || tokens[0] !== `B=${this.promptEndToken}`) return null;
    const encodedLine = lines[0]!.slice("Line=".length);
    if (/[\u0000-\u001f\u007f]/u.test(encodedLine)) return null;
    let line: string;
    try {
      line = decodeURIComponent(encodedLine);
    } catch {
      return null;
    }
    flush();
    this.currentEditLineReport = { generation: ++this.editLineReports, line };
    this.notify();
    return "E";
  }

  // Accept B only with the current prompt token while that prompt is active; redraw resets echo, while command-time or stale B stays ordinary output.
  private handlePromptEnd(fields: readonly string[], flush: () => void): string | null {
    if (fields.length !== 2 || this.promptEndToken === null || fields[1] !== this.promptEndToken) return null;
    if (this.phase !== "prompt" && this.phase !== "input") return null;
    flush();
    // A same-prompt redisplay leaves the editor buffer unchanged. Query callbacks may force that redisplay after emitting their report.
    if (this.phase !== "input") this.currentEditLineReport = null;
    this.editLinePromptReady = true;
    if (this.phase === "prompt") {
      this.sawPromptEnd = true;
      this.promptEnds++;
      this.inputSincePromptEnd = false;
      this.phase = "input";
    }
    this.echo = new PlainTextBuffer(MAX_COMMAND_CHARS, 0);
    this.notify();
    return "B";
  }

  private appendText(text: string): void {
    if (!text) return;
    switch (this.phase) {
      case "output":
        if (this.open) {
          this.open.output.append(text);
          if (this.blockOutput?.blockId === this.open.id) {
            // The parser already removed escape sequences. Keep only display controls before secret masking.
            const plain = text.replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/gu, "");
            for (let offset = 0; offset < plain.length; offset += MAX_OPEN_LINE_CHARS) {
              this.publishBlockOutput(plain.slice(offset, offset + MAX_OPEN_LINE_CHARS));
            }
          }
        }
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

  // A command can print this terminal's marker nonce (the shell holds it in a variable). Block records go to the agent, and a nonce in the agent's hands
  // would let printed text forge markers, so the records never carry it.
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
    this.publishBlockOutput("", true);
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
    // The fallback names the next block after the line on screen; start that line fresh so the previous block's output does not leak into it.
    this.idle = new PlainTextBuffer(0, 4096);
  }
}

function summarize(block: TerminalBlock): TerminalBlockSummary {
  const { output: _output, ...summary } = block;
  return summary;
}

// Each lane/incarnation owns independent block IDs, state and output.
interface RegisteredTracker {
  tracker: TerminalBlockTracker;
  session: TerminalSessionInfo;
  ownerWindowId: number | null;
}
const trackers = new Map<string, RegisteredTracker>();

export function registerTerminalBlockTracker(session: TerminalSessionInfo, tracker: TerminalBlockTracker, ownerWindowId: number | null): void {
  trackers.set(terminalLaneKey(session), { tracker, session, ownerWindowId });
}
export function unregisterTerminalBlockTracker(ref: TerminalRef): void {
  trackers.delete(terminalLaneKey(ref));
}
export function getTerminalBlockTracker(ref: TerminalSessionRef): TerminalBlockTracker | undefined {
  const entry = trackers.get(terminalLaneKey(ref));
  return entry && sameTerminalSession(entry.session, ref) ? entry.tracker : undefined;
}
export function getWindowTerminalBlockTracker(ref: TerminalSessionRef, windowId: number): TerminalBlockTracker | undefined {
  const entry = trackers.get(terminalLaneKey(ref));
  return entry && entry.ownerWindowId === windowId && sameTerminalSession(entry.session, ref) ? entry.tracker : undefined;
}
function trackerInfo(entry: RegisteredTracker): TerminalSessionInfo {
  const integrated = entry.session.lane === "agent" && entry.tracker.isIntegrated();
  const currentCwd = integrated ? entry.tracker.currentCwd() : null;
  return { ...entry.session, shellIntegration: integrated, currentCwd, cwdSource: currentCwd === null ? "unavailable" : "shell-marker" };
}
export function getWindowTerminalBlockSession(ref: TerminalSessionRef, windowId: number): TerminalSessionInfo | undefined {
  const entry = trackers.get(terminalLaneKey(ref));
  return entry && entry.ownerWindowId === windowId && sameTerminalSession(entry.session, ref) ? trackerInfo(entry) : undefined;
}
export function listTerminalBlockTabs(windowId: number): Array<{ tabId: string; session: TerminalSessionInfo; tracker: TerminalBlockTracker }> {
  return [...trackers.values()].filter((entry) => entry.ownerWindowId === windowId)
    .map((entry) => ({ tabId: entry.session.tabId, session: trackerInfo(entry), tracker: entry.tracker }));
}
export function __resetTerminalBlocksForTest(): void { trackers.clear(); }
