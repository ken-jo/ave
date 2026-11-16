/**
 * One xterm per terminal tab, alive from the tab's first view until the tab closes. A view attaches it to its host
 * element and detaches it on unmount; the screen, scrollback, markers and decorations stay in the instance, so switching
 * tabs or moving a tab between the side panel and a pane shows exactly what was there. Output that arrives while no
 * view is mounted is still written. Only a window that has no instance for the tab (a reload) gets main's bounded replay.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { validateExternalUrl } from "../../../shared/external-url.js";
import { isDarwin } from "../api-client.js";
import { matchesShortcut } from "../hooks/use-shortcuts.js";
import type { TerminalBehaviorSettings } from "../../../shared/appearance-settings.js";
import { terminalClipboardAction, terminalCommandJump, terminalPlatform } from "./terminal-keys.js";
import { terminalColumnsFor } from "./terminal-fit.js";
import { onTerminalUserInput } from "./terminal-user-input.js";
import { TerminalResizeDebouncer } from "./terminal-resize-debouncer.js";
import { XtermBlockAnchors, viewBlockId } from "./terminal-block-anchors.js";
import { setTerminalAttended, setTerminalExited, setTerminalReplaying } from "../preview/terminal-attention.js";
import { takeRestoredTerminal } from "../preview/main-layout-restore.js";
import {
  TERMINAL_INPUT_MAX_BYTES,
  sameTerminalSession, TERMINAL_REPLAY_MAX_BYTES, type HostTerminalControlState, type TerminalApi, type TerminalDataEvent, type TerminalExitEvent,
  type TerminalPurpose, type TerminalSessionInfo, type TerminalSessionRef, type TerminalSpawnResult,
} from "../../../shared/terminal-session.js";

/** Delay before re-listing blocks after an Enter, so the shell has echoed. */
const ENTER_RELIST_DELAY_MS = 150;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface LiveTerminalStyle {
  readonly terminalPalette: ITheme;
  readonly terminalFont: { readonly family: string; readonly size: number; readonly lineHeight: number };
  readonly behavior: Omit<TerminalBehaviorSettings, "shell">;
}

/** What a mounted view shows of its terminal. A new object on every change. */
export interface LiveTerminalState {
  readonly session: TerminalSessionInfo | null;
  readonly control: HostTerminalControlState | null;
  readonly blockRevision: number;
  /** Why no shell is running in this tab: its process exited, or it could not be started. Null while one runs or is starting. */
  readonly ended: { readonly kind: "exited"; readonly code: number } | { readonly kind: "not-started" } | null;
  /** The last input the shell did not receive, until input next arrives or the shell changes: more than the terminal accepts at once, or refused
   * for a shell that is no longer this tab's. Typed or pasted text is never dropped without saying so. */
  readonly inputNotice: "too-large" | "not-delivered" | null;
  /** The command whose output fills the top of the view while its own row has scrolled out above it; null at a command's start or before the first. */
  readonly sticky: { readonly blockId: number; readonly text: string } | null;
}

/** The view a terminal is attached to. */
export interface LiveTerminalView {
  readonly purpose: TerminalPurpose;
  /** Where a NEW shell starts; read by the tab's first spawn only. */
  readonly initialCwd: string | null;
  readonly t: Translate;
  /** Whether the user is looking at this view when it has a box. */
  readonly attended: () => boolean;
  /** Open a web link from the terminal in an Ave browser tab. Absent where the view has no place to open one. */
  readonly openLink?: (url: string) => void;
  /** The user pressed the search key in the terminal: show this view's find bar. */
  readonly openFind?: () => void;
}

/** Where the find bar's query stands in the buffer: the selected match (1-based, 0 when none is selected) of how many. */
export interface TerminalFindResult {
  readonly index: number;
  readonly count: number;
}

/** Dim-yellow ANSI wrapper for host-emitted diagnostic lines in the buffer. */
function diagnostic(text: string): string {
  return `\r\n\x1b[33m${text}\x1b[0m\r\n`;
}

const TYPE_AHEAD_ENCODER = new TextEncoder();
export class LiveTerminal {
  readonly term: Terminal;
  readonly anchors: XtermBlockAnchors;
  private readonly fitAddon = new FitAddon();
  private readonly searchAddon = new SearchAddon();
  /** The last size sent to a shell, and which one. */
  private told: { session: string; cols: number; rows: number } | null = null;
  private readonly resizer = new TerminalResizeDebouncer(
    () => this.term.buffer.normal.length,
    (cols, rows) => this.applySize(cols, rows),
    (cols) => this.applySize(cols, this.term.rows),
    (rows) => this.applySize(this.term.cols, rows),
  );
  private paintedFit: ReturnType<typeof setTimeout> | null = null;
  private copyOnSelect = false;
  private state: LiveTerminalState = { session: null, control: null, blockRevision: 0, ended: null, inputNotice: null, sticky: null };
  /** Where a restarted shell starts: the directory the ended one last reported. */
  private restartCwd: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private liveRef: TerminalSessionRef | null = null;
  private blockMarkerToken: string | null = null;
  /** The purpose main last accepted for the running shell. */
  private purpose: TerminalPurpose | null = null;
  // Replay precedes spawn's reply. Buffer by incarnation until the host confirms it.
  private pending: Array<TerminalDataEvent | TerminalExitEvent> = [];
  private pendingBytes = 0;
  private spawning = false;
  private exited = false;
  /** Set just before a data event the user caused (see onTerminalUserInput), and taken by that event. */
  private userInput = false;
  /** What the user typed before the shell was there to take it. */
  private typedAhead = "";
  private typedAheadBytes = 0;
  /** Typed-ahead input outgrew what is kept; said until the user's next input is delivered. */
  private heldTooMuch = false;
  private enterTimer: ReturnType<typeof setTimeout> | null = null;
  private host: HTMLElement | null = null;
  private view: LiveTerminalView | null = null;
  private observer: ResizeObserver | null = null;
  private opened = false;
  private disposed = false;
  private box = false;
  private t: Translate;
  private linkTip: HTMLElement | null = null;
  /** Spawn and re-attach requests run one at a time, each against the view mounted when it runs. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly api: TerminalApi, readonly tabId: string, style: LiveTerminalStyle, t: Translate) {
    this.t = t;
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: style.terminalFont.size,
      fontFamily: style.terminalFont.family,
      lineHeight: style.terminalFont.lineHeight,
      theme: style.terminalPalette,
      scrollback: style.behavior.scrollback,
      cursorStyle: style.behavior.cursorStyle,
      macOptionIsMeta: style.behavior.optionAsMeta,
      allowProposedApi: true,
      // OSC 8 hyperlinks take the same path as detected URLs; without this xterm asks through a native confirm() and opens the system browser.
      linkHandler: {
        activate: (event, target) => this.activateLink(event, target),
        hover: (event, target) => this.showLinkTip(event, target),
        leave: () => this.hideLinkTip(),
        allowNonHttpProtocols: false,
      },
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon((event, target) => this.activateLink(event, target), {
      hover: (event, target) => this.showLinkTip(event, target),
      leave: () => this.hideLinkTip(),
    }));
    // Character widths from Unicode 11, which shells and full-screen programs assume: with the built-in Unicode 6 tables an emoji is one cell here and
    // two cells to the program that printed it, and every column after it is off by one.
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.anchors = new XtermBlockAnchors(this.term);
    // OSC 133 A (prompt) and D (command finished) end a block; C starts one. Returning false leaves the sequence to xterm's
    // default handling.
    const markerSub = this.term.parser.registerOscHandler(133, (data) => {
      const marker = data.charAt(0);
      if (marker === "C") {
        const blockId = viewBlockId(data, this.blockMarkerToken);
        if (blockId !== null) this.anchors.noteCommandStart(blockId);
      }
      if (marker === "A" || marker === "C" || marker === "D") this.bumpBlocks();
      return false;
    });
    // Copy and paste keys where the platform has no menu key for them. Returning false keeps the key from xterm, and the
    // default is prevented so the browser does not paste a second time.
    this.term.attachCustomKeyEventHandler((event) => {
      // The app's search key, pressed in a terminal, searches that terminal: the key is taken here so the window's own search does not also open.
      if (event.type === "keydown" && this.view?.openFind && matchesShortcut("app.search", event)) {
        event.preventDefault();
        event.stopPropagation();
        this.view.openFind();
        return false;
      }
      const jump = terminalCommandJump(event, terminalPlatform());
      if (jump !== null) {
        event.preventDefault();
        this.jumpToCommand(jump);
        return false;
      }
      const action = terminalClipboardAction(event, terminalPlatform(), this.term.hasSelection());
      if (action === null) return true;
      event.preventDefault();
      if (action === "copy") this.copySelection(true);
      else this.pasteClipboard();
      return false;
    });
    // Forward keystrokes → PTY stdin.
    const userInputSub = onTerminalUserInput(this.term, () => { this.userInput = true; });
    const inputSub = this.term.onData((data) => {
      const fromUser = this.userInput;
      this.userInput = false;
      if (!fromUser) {
        // The terminal answering a program's question: owed to the running shell and to nothing else.
        if (this.liveRef && this.state.ended === null) this.send(this.liveRef, data);
        return;
      }
      // No shell is running: nothing takes the keys, and Enter starts a new one.
      if (this.state.ended !== null) {
        if (data === "\r") this.restart();
        return;
      }
      // The shell is still starting (or restarting): what the user types is kept for it, as a terminal keeps type-ahead.
      if (!this.liveRef) {
        this.holdInput(data);
        return;
      }
      this.send(this.liveRef, data);
      if (data.includes("\r")) {
        if (this.enterTimer !== null) clearTimeout(this.enterTimer);
        this.enterTimer = setTimeout(() => {
          this.enterTimer = null;
          this.bumpBlocks();
        }, ENTER_RELIST_DELAY_MS);
      }
    });
    // The sticky command follows the view: a scroll (the user's or new output's) and a command starting or leaving the scrollback.
    const scrollSub = this.term.onScroll(() => this.syncSticky());
    this.copyOnSelect = style.behavior.copyOnSelect;
    // Copy on select: a finished selection is on the clipboard without a key. An emptied selection copies nothing.
    const selectionSub = this.term.onSelectionChange(() => {
      if (this.copyOnSelect) this.copySelection();
    });
    this.disposers.push(
      () => scrollSub.dispose(),
      () => selectionSub.dispose(),
      this.anchors.subscribe(() => this.syncSticky()),
      () => markerSub.dispose(),
      () => inputSub.dispose(),
      () => userInputSub.dispose(),
      api.onData((event) => this.acceptEvent(event)),
      api.onExit((event) => this.acceptEvent(event)),
      // Main owns control; the strip only shows the latest state for this incarnation.
      api.onControl((event) => {
        if (!this.disposed && this.liveRef && sameTerminalSession(this.liveRef, event)) this.setState({ control: event.control });
      }),
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getState = (): LiveTerminalState => this.state;

  /** The block bar's fresher copy of the session (the directory the shell last reported). */
  readonly setSession = (session: TerminalSessionInfo): void => {
    if (!this.disposed && this.liveRef && sameTerminalSession(this.liveRef, session)) this.setState({ session });
  };

  /** Main's answer to this view's own control request, for the incarnation it was asked of. */
  acceptControl(session: TerminalSessionRef, control: HostTerminalControlState): void {
    if (!this.disposed && this.liveRef && sameTerminalSession(this.liveRef, session)) this.setState({ control });
  }

  /** Whether the attached host is laid out with a size. */
  get hasBox(): boolean {
    return this.box;
  }

  /** Show this terminal in `host`. The first attach opens xterm there; a later one moves the same element. */
  attach(host: HTMLElement, view: LiveTerminalView): void {
    if (this.disposed) throw new Error("live terminal attached after its tab closed");
    this.observer?.disconnect();
    this.host = host;
    this.view = view;
    this.t = view.t;
    if (!this.opened) {
      this.term.open(host);
      this.opened = true;
    } else if (this.term.element && this.term.element.parentElement !== host) {
      host.appendChild(this.term.element);
    }
    this.reportAttended();
    // A terminal with no shell yet takes the host's size now, for the shell to start at, whatever its buffer holds. One whose shell is running
    // is sized as any later change is.
    this.fitToHost(this.liveRef === null);
    // Resize the PTY when the pane changes size.
    this.observer = new ResizeObserver(() => {
      this.reportAttended();
      this.fitOncePainted();
    });
    this.observer.observe(host);
    this.chain = this.chain.then(() => this.sync());
  }

  /** Stop showing this terminal in `host`. The instance and its shell stay; the tab's close disposes them. */
  detach(host: HTMLElement): void {
    if (this.host !== host) return;
    // A width still waiting was measured in a host this view is leaving. The terminal keeps the size it has, and is measured against
    // whichever host shows it next.
    this.resizer.cancel();
    this.cancelPaintedFit();
    this.observer?.disconnect();
    this.observer = null;
    this.host = null;
    this.view = null;
    this.box = false;
    this.hideLinkTip();
    if (!this.disposed) {
      this.term.element?.remove();
      setTerminalAttended(this.tabId, false);
    }
  }

  /** The attended flag of the mounted view changed, or its host was laid out. */
  reportAttended(): void {
    const host = this.host;
    // The user is looking at this terminal while its host has a box: a hidden pane or a side panel set aside lays it out at
    // zero size.
    this.box = host !== null && host.offsetWidth > 0 && host.offsetHeight > 0;
    setTerminalAttended(this.tabId, this.view?.attended() === true && this.box);
  }

  /** Re-tint in place: the options take a new theme and font, so the shell, scrollback and cursor are kept. */
  applyStyle(style: LiveTerminalStyle): void {
    const { fontFamily, fontSize, lineHeight, scrollback } = this.term.options;
    this.term.options.theme = style.terminalPalette;
    this.term.options.fontFamily = style.terminalFont.family;
    this.term.options.fontSize = style.terminalFont.size;
    this.term.options.lineHeight = style.terminalFont.lineHeight;
    this.term.options.scrollback = style.behavior.scrollback;
    this.term.options.cursorStyle = style.behavior.cursorStyle;
    this.term.options.macOptionIsMeta = style.behavior.optionAsMeta;
    this.copyOnSelect = style.behavior.copyOnSelect;
    // Only a change of the cell's size, or of the scrollbar's presence, changes how many cells the host holds. A view that mounts again with the
    // same style has nothing to refit, and must not take whatever width its host has that instant.
    const options = this.term.options;
    const cellsChanged = options.fontFamily !== fontFamily || options.fontSize !== fontSize || options.lineHeight !== lineHeight
      || (options.scrollback === 0) !== (scrollback === 0);
    if (this.host && cellsChanged) this.fitToHost(true);
  }

  /** Select the next or previous match of `query` in the screen and scrollback and mark the others; false when there is none. A typed query
   * (`incremental`) keeps the current match while it still matches instead of jumping to the following one. */
  find(query: string, direction: "next" | "previous", options: { caseSensitive: boolean; incremental?: boolean }): boolean {
    const theme = this.term.options.theme ?? {};
    // Other matches are outlined and the selected one is the selection itself, so output colours stay readable under both.
    const mark = theme.yellow;
    const active = theme.foreground;
    if (mark === undefined || active === undefined) throw new Error("The terminal palette has no colours to mark search matches with.");
    const searchOptions = {
      caseSensitive: options.caseSensitive,
      incremental: options.incremental === true,
      decorations: { matchBorder: mark, matchOverviewRuler: mark, activeMatchBorder: active, activeMatchColorOverviewRuler: active },
    };
    return direction === "next" ? this.searchAddon.findNext(query, searchOptions) : this.searchAddon.findPrevious(query, searchOptions);
  }

  /** Remove the find marks and the selected match. */
  clearFind(): void {
    this.searchAddon.clearDecorations();
    this.term.clearSelection();
  }

  onFindResult(listener: (result: TerminalFindResult) => void): () => void {
    const subscription = this.searchAddon.onDidChangeResults((event) => listener({ index: event.resultIndex + 1, count: event.resultCount }));
    return () => subscription.dispose();
  }

  focus(): void {
    this.term.focus();
  }

  /** Scroll so the previous or next command's row is the first row of the view; past the last command, to the bottom. */
  jumpToCommand(direction: "previous" | "next"): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const target = this.anchors.commandNear(buffer.viewportY, direction === "previous" ? "before" : "after");
    if (target) this.term.scrollToLine(target.line);
    else if (direction === "next") this.term.scrollToBottom();
  }

  /** Scroll the sticky command's own row back into view. */
  revealStickyCommand(): void {
    if (this.state.sticky) this.jumpToCommand("previous");
  }

  private syncSticky(): void {
    const buffer = this.term.buffer.active;
    // A full-screen program draws on the alternate buffer, which has no commands.
    // The command the first row belongs to; while that row is the command's own, nothing has scrolled out.
    const owner = buffer.type === "normal" ? this.anchors.commandNear(buffer.viewportY + 1, "before") : null;
    const above = owner !== null && owner.line < buffer.viewportY ? owner : null;
    const sticky = above === null || above.text.trim() === "" ? null : { blockId: above.blockId, text: above.text };
    const current = this.state.sticky;
    if (current?.blockId === sticky?.blockId && current?.text === sticky?.text) return;
    this.setState({ sticky });
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  selectAll(): void {
    this.term.selectAll();
  }

  /** Drop the scrollback and everything above the cursor's line. The shell is not told: its prompt line stays. */
  clear(): void {
    this.term.clear();
  }

  /** The command block drawn at viewport height `clientY`, for a menu opened on that row. */
  blockAt(clientY: number): number | null {
    const screen = this.term.element?.querySelector(".xterm-screen");
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.height <= 0 || clientY < rect.top || clientY >= rect.bottom) return null;
    const row = Math.floor((clientY - rect.top) / (rect.height / this.term.rows));
    return this.anchors.blockAtLine(this.term.buffer.active.viewportY + row);
  }

  /** Copy the selected text. `clear` drops the selection afterwards, the convention where Ctrl+C both copies and interrupts, so the next Ctrl+C reaches the shell. */
  copySelection(clear = false): void {
    const text = this.term.getSelection();
    if (text.length === 0) return;
    void navigator.clipboard.writeText(text);
    if (clear) this.term.clearSelection();
  }

  /** Paste the clipboard's text through xterm, which brackets it when the shell asked for bracketed paste. */
  /** Send input to the shell and say so when it did not arrive. A refusal for a shell that has since ended is the exit's to report, not this. */
  private send(ref: TerminalSessionRef, data: string): void {
    const settle = (notice: LiveTerminalState["inputNotice"]): void => {
      if (this.disposed || this.liveRef !== ref || this.state.ended !== null) return;
      if (this.state.inputNotice !== notice) this.setState({ inputNotice: notice });
    };
    void this.api.input(ref, data).then(
      (result) => settle(result.ok ? null : result.error === "invalid-params" ? "too-large" : "not-delivered"),
      () => settle("not-delivered"),
    );
  }

  pasteClipboard(): void {
    void navigator.clipboard.readText().then((text) => {
      if (!this.disposed && text.length > 0) this.term.paste(text);
    });
  }

  /** Start a new shell in this tab after its shell ended or failed to start. The screen and scrollback stay. */
  restart(): void {
    if (this.disposed || this.state.ended === null) return;
    this.restartCwd = this.state.session?.currentCwd ?? this.state.session?.initialCwd ?? null;
    this.exited = false;
    this.liveRef = null;
    this.purpose = null;
    // A new start begins with nothing held: input typed for an earlier shell is never the new one's.
    this.typedAhead = "";
    this.typedAheadBytes = 0;
    this.heldTooMuch = false;
    this.setState({ session: null, control: null, ended: null, inputNotice: null });
    // Show the cursor the exit hid.
    this.term.write("\x1b[?25h");
    this.chain = this.chain.then(() => this.sync());
  }

  /** The tab closed: release the xterm. Main ends the shell. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPaintedFit();
    this.observer?.disconnect();
    this.observer = null;
    if (this.enterTimer !== null) clearTimeout(this.enterTimer);
    this.hideLinkTip();
    for (const dispose of this.disposers) dispose();
    setTerminalAttended(this.tabId, false);
    setTerminalReplaying(this.tabId, false);
    this.resizer.dispose();
    this.anchors.dispose();
    this.term.dispose();
    this.host = null;
    this.view = null;
    this.listeners.clear();
  }

  /** A link opens only on a modifier-click (Cmd on macOS, Ctrl elsewhere), so selecting or clicking terminal text never navigates, and only to http or https. */
  private activateLink(event: MouseEvent, target: string): void {
    if (!(isDarwin() ? event.metaKey : event.ctrlKey)) return;
    const validated = validateExternalUrl(target);
    if (validated.ok) this.view?.openLink?.(validated.url);
  }

  /** Name the link's real target (an OSC 8 link's text can say anything) and how it opens. */
  private showLinkTip(event: MouseEvent, target: string): void {
    const host = this.host;
    if (!host) return;
    const tip = this.linkTip ?? document.createElement("div");
    this.linkTip = tip;
    tip.setAttribute("role", "tooltip");
    tip.dataset.testid = "terminal-link-tooltip";
    tip.className = "pointer-events-none absolute z-10 max-w-[min(32rem,calc(100%-0.5rem))] rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md";
    const url = document.createElement("div");
    url.className = "break-all font-mono";
    url.textContent = target;
    const hint = document.createElement("div");
    hint.className = "text-muted-foreground";
    const openable = validateExternalUrl(target).ok && this.view?.openLink !== undefined;
    tip.dataset.openable = String(openable);
    hint.textContent = openable ? this.t("ptyTerminal.linkOpenHint", { modifier: isDarwin() ? "⌘" : "Ctrl" }) : this.t("ptyTerminal.linkBlocked");
    tip.replaceChildren(url, hint);
    host.appendChild(tip);
    // Below the pointer, or above it when the row is near the bottom edge; always inside the terminal's box.
    const box = host.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    const left = Math.max(4, Math.min(event.clientX - box.left, box.width - size.width - 4));
    const below = event.clientY - box.top + 18;
    tip.style.left = `${left}px`;
    tip.style.top = `${below + size.height > box.height ? Math.max(4, event.clientY - box.top - size.height - 8) : below}px`;
  }

  private hideLinkTip(): void {
    this.linkTip?.remove();
  }

  private setState(change: Partial<LiveTerminalState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  private bumpBlocks(): void {
    if (!this.disposed) this.setState({ blockRevision: this.state.blockRevision + 1 });
  }

  /**
   * Size the terminal to its host. A host with no box (a hidden pane, a side panel set aside) proposes nothing, so the terminal and its shell keep the
   * size they had: nobody sees the hidden one, and a shell resized to it would redraw for nothing. `immediate` is for a size that is not on its way
   * anywhere (the first layout, a font change); otherwise the columns wait for the width to hold (see TerminalResizeDebouncer).
   */
  /**
   * Measure the host once the frame that changed it has been painted. A size is reported between layout and paint, and other observers
   * reported in the same step still re-render before the paint (a container hearing it crossed its narrow threshold moves a panel out of
   * the row), so the layout at the moment of the report can be one that is never shown. The task queued here runs after the paint, when the
   * layout is the one on screen; however many reports a frame makes, it measures once.
   */
  private fitOncePainted(): void {
    if (this.paintedFit !== null) return;
    this.paintedFit = setTimeout(() => {
      this.paintedFit = null;
      this.fitToHost();
    }, 0);
  }

  private cancelPaintedFit(): void {
    if (this.paintedFit === null) return;
    clearTimeout(this.paintedFit);
    this.paintedFit = null;
  }

  private fitToHost(immediate = false): void {
    const proposed = this.proposal();
    if (proposed) this.resizer.resize(proposed.cols, proposed.rows, immediate);
    // The host lost its box while a width was waiting: that width was measured in a host that is no longer shown.
    else if (!this.box) this.resizer.cancel();
  }

  /** The host's proposal, when it has a box and its cells have been measured. */
  private proposal(): { cols: number; rows: number } | null {
    if (!this.box) return null;
    // Rows from the addon; columns from the width of one cell, which the addon's own division is not (see terminalColumnsFor).
    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.rows)) return null;
    const cols = terminalColumnsFor(this.term);
    return cols === null ? null : { cols, rows: proposed.rows };
  }

  /** Give the terminal a size and tell the shell, when it is a new one. */
  private applySize(cols: number, rows: number): void {
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
    this.tellShell();
  }

  /** The shell's size is this terminal's. Sent when it differs from the last size this shell was told. */
  private tellShell(): void {
    if (!this.liveRef || this.exited) return;
    const { cols, rows } = this.term;
    if (this.told && this.told.session === this.liveRef.terminalSessionId && this.told.cols === cols && this.told.rows === rows) return;
    this.told = { session: this.liveRef.terminalSessionId, cols, rows };
    void this.api.resize(this.liveRef, cols, rows);
  }

  private renderEvent(event: TerminalDataEvent | TerminalExitEvent): void {
    if ("chunk" in event) {
      this.term.write(event.chunk);
      return;
    }
    this.exited = true;
    // A dead shell has no cursor: hide it (DECTCEM) so the tab does not look like it is waiting for input.
    this.term.write(`${diagnostic(`${this.t("ptyTerminal.exited", { code: event.exitCode })} ${this.t("ptyTerminal.exitedRestartHint")}`)}\x1b[?25l`);
    this.setState({ ended: { kind: "exited", code: event.exitCode }, inputNotice: null });
    this.bumpBlocks();
    setTerminalExited(this.tabId, true);
  }

  private acceptEvent(event: TerminalDataEvent | TerminalExitEvent): void {
    if (this.disposed || event.tabId !== this.tabId || event.lane !== "manual") return;
    if (this.liveRef && sameTerminalSession(this.liveRef, event)) {
      this.renderEvent(event);
      return;
    }
    // Output of an incarnation this view has not been told about is kept only while a spawn reply is outstanding.
    if (!this.spawning) return;
    const bytes = "chunk" in event ? new TextEncoder().encode(event.chunk).length : 0;
    // Both a chunk and the whole waiting queue stay within the replay ring ceiling.
    if (bytes > TERMINAL_REPLAY_MAX_BYTES) return;
    this.pending.push(event);
    this.pendingBytes += bytes;
    while (this.pendingBytes > TERMINAL_REPLAY_MAX_BYTES || this.pending.length > 1024) {
      const dropped = this.pending.shift();
      if (dropped && "chunk" in dropped) this.pendingBytes -= new TextEncoder().encode(dropped.chunk).length;
    }
  }

  private async spawn(request: Parameters<TerminalApi["spawn"]>[0]): Promise<TerminalSpawnResult> {
    this.spawning = true;
    try {
      return await this.api.spawn(request);
    } finally {
      this.spawning = false;
    }
  }

  /** Bring main in line with the mounted view: start the tab's shell, or tell main where the running one is now shown. */
  private async sync(): Promise<void> {
    const view = this.view;
    if (this.disposed || !view || this.state.ended !== null) return;
    if (this.liveRef === null) await this.start(view);
    else if (this.purpose !== view.purpose) await this.reattach(view);
  }

  private async start(view: LiveTerminalView): Promise<void> {
    this.resizer.flush();
    const { cols, rows } = this.term;
    setTerminalReplaying(this.tabId, true);
    try {
      const restored = takeRestoredTerminal(this.tabId);
      if (restored) this.term.write(diagnostic(this.t("ptyTerminal.restored")));
      const startCwd = restored ? restored.cwd : this.restartCwd ?? view.initialCwd;
      const spawnAt = (cwd: string | null) => this.spawn({ tabId: this.tabId, lane: "manual", purpose: view.purpose, cols, rows, ...(cwd ? { cwd } : {}) });
      let result = await spawnAt(startCwd);
      if (!result.ok && restored && startCwd && !this.disposed && (result.reason === "bad-request" || result.reason === "spawn-failed")) {
        this.term.write(diagnostic(this.t("ptyTerminal.restoredRoot")));
        result = await spawnAt(null);
      }
      if (this.disposed) return;
      if (!result.ok) {
        this.dropPending();
        this.term.write(diagnostic(this.t(result.reason === "too-many-terminals" ? "ptyTerminal.capacity" : result.reason === "still-closing" ? "ptyTerminal.stillClosing" : "ptyTerminal.manualUnavailable")));
        this.setState({ ended: { kind: "not-started" } });
        this.discardHeldInput();
        return;
      }
      await this.adopt(result, view.purpose);
    } catch {
      if (!this.disposed) {
        this.term.write(diagnostic(this.t("ptyTerminal.startFailed")));
        this.setState({ ended: { kind: "not-started" } });
        this.discardHeldInput();
      }
    } finally {
      if (!this.disposed) setTerminalReplaying(this.tabId, false);
    }
  }

  /** The running shell is shown somewhere else (side panel ↔ pane): main records the new purpose. This xterm already holds the output, so none is replayed. */
  private async reattach(view: LiveTerminalView): Promise<void> {
    const { cols, rows } = this.term;
    try {
      const result = await this.spawn({ tabId: this.tabId, lane: "manual", purpose: view.purpose, cols, rows, replay: false });
      if (this.disposed) return;
      if (!result.ok) {
        this.dropPending();
        this.term.write(diagnostic(this.t(result.reason === "still-closing" ? "ptyTerminal.stillClosing" : "ptyTerminal.manualUnavailable")));
        return;
      }
      await this.adopt(result, view.purpose);
    } catch {
      if (!this.disposed) this.term.write(diagnostic(this.t("ptyTerminal.startFailed")));
    }
  }

  /** Keep input typed while no shell is attached yet. More than a shell accepts in one piece is not kept, and the user is told. */
  private holdInput(data: string): void {
    // Counted as the shell's side counts it: what is held is sent in one write, and that write is refused whole above the limit.
    const bytes = TYPE_AHEAD_ENCODER.encode(data).length;
    if (this.typedAheadBytes + bytes > TERMINAL_INPUT_MAX_BYTES) {
      this.typedAhead = "";
      this.typedAheadBytes = 0;
      this.heldTooMuch = true;
      this.setState({ inputNotice: "too-large" });
      return;
    }
    this.typedAhead += data;
    this.typedAheadBytes += bytes;
  }

  /** The shell did not start, or ended before it could take it: what was typed for it went nowhere, and the user is told so. */
  private discardHeldInput(): void {
    if (this.typedAhead === "") return;
    this.typedAhead = "";
    this.typedAheadBytes = 0;
    this.setState({ inputNotice: "not-delivered" });
  }

  private dropPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private async adopt(result: Extract<TerminalSpawnResult, { ok: true }>, purpose: TerminalPurpose): Promise<void> {
    this.liveRef = result.session;
    this.purpose = purpose;
    this.exited = false;
    setTerminalExited(this.tabId, false);
    this.blockMarkerToken = result.blockMarkerToken;
    this.setState({ session: result.session, ended: null, inputNotice: this.heldTooMuch ? "too-large" : null });
    this.heldTooMuch = false;
    // The shell's size is this terminal's: a size the view took while the shell was starting was not sent, and a shell that was already running has
    // the size of its last view.
    this.tellShell();
    // The replay goes in before anything that can let a live chunk of this incarnation be written ahead of it.
    const waiting = this.pending;
    this.dropPending();
    for (const event of waiting) if (sameTerminalSession(result.session, event)) this.renderEvent(event);
    // What was typed while this shell was starting is this shell's. One that ended before it could take it leaves the input undelivered:
    // it is not kept for whichever shell is started next.
    if (this.exited) this.discardHeldInput();
    else if (this.typedAhead !== "") {
      const held = this.typedAhead;
      this.typedAhead = "";
      this.typedAheadBytes = 0;
      this.send(result.session, held);
    }
    const current = await this.api.control(result.session, "get");
    if (!this.disposed && current.ok && this.liveRef && sameTerminalSession(this.liveRef, result.session)) this.setState({ control: current.control });
  }
}
