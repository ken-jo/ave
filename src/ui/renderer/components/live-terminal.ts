/**
 * One xterm per terminal tab, alive from the tab's first view until the tab closes. A view attaches it to its host
 * element and detaches it on unmount; the screen, scrollback, markers and decorations stay in the instance, so switching
 * tabs or moving a tab between the side panel and a pane shows exactly what was there. Output that arrives while no
 * view is mounted is still written. Only a window that has no instance for the tab (a reload) gets main's bounded replay.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { validateExternalUrl } from "../../../shared/external-url.js";
import { isDarwin } from "../api-client.js";
import { terminalClipboardAction, terminalPlatform } from "./terminal-keys.js";
import { XtermBlockAnchors, viewBlockId } from "./terminal-block-anchors.js";
import { setTerminalAttended, setTerminalExited, setTerminalReplaying } from "../preview/terminal-attention.js";
import { takeRestoredTerminal } from "../preview/main-layout-restore.js";
import {
  sameTerminalSession, TERMINAL_REPLAY_MAX_BYTES, type HostTerminalControlState, type TerminalApi, type TerminalDataEvent, type TerminalExitEvent,
  type TerminalPurpose, type TerminalSessionInfo, type TerminalSessionRef, type TerminalSpawnResult,
} from "../../../shared/terminal-session.js";

/** Delay before re-listing blocks after an Enter, so the shell has echoed. */
const ENTER_RELIST_DELAY_MS = 150;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface LiveTerminalStyle {
  readonly terminalPalette: ITheme;
  readonly terminalFont: { readonly family: string; readonly size: number; readonly lineHeight: number };
}

/** What a mounted view shows of its terminal. A new object on every change. */
export interface LiveTerminalState {
  readonly session: TerminalSessionInfo | null;
  readonly control: HostTerminalControlState | null;
  readonly blockRevision: number;
  /** Why no shell is running in this tab: its process exited, or it could not be started. Null while one runs or is starting. */
  readonly ended: { readonly kind: "exited"; readonly code: number } | { readonly kind: "not-started" } | null;
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
}

/** Dim-yellow ANSI wrapper for host-emitted diagnostic lines in the buffer. */
function diagnostic(text: string): string {
  return `\r\n\x1b[33m${text}\x1b[0m\r\n`;
}

export class LiveTerminal {
  readonly term: Terminal;
  readonly anchors: XtermBlockAnchors;
  private readonly fitAddon = new FitAddon();
  private state: LiveTerminalState = { session: null, control: null, blockRevision: 0, ended: null };
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
      scrollback: 5000,
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
      const action = terminalClipboardAction(event, terminalPlatform(), this.term.hasSelection());
      if (action === null) return true;
      event.preventDefault();
      if (action === "copy") this.copySelection(true);
      else this.pasteClipboard();
      return false;
    });
    // Forward keystrokes → PTY stdin.
    const inputSub = this.term.onData((data) => {
      // No shell is running: nothing takes the keys, and Enter starts a new one.
      if (this.state.ended !== null) {
        if (data === "\r") this.restart();
        return;
      }
      if (!this.liveRef) return;
      void this.api.input(this.liveRef, data);
      if (data.includes("\r")) {
        if (this.enterTimer !== null) clearTimeout(this.enterTimer);
        this.enterTimer = setTimeout(() => {
          this.enterTimer = null;
          this.bumpBlocks();
        }, ENTER_RELIST_DELAY_MS);
      }
    });
    this.disposers.push(
      () => markerSub.dispose(),
      () => inputSub.dispose(),
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
    this.fitToHost();
    // Resize the PTY when the pane changes size.
    this.observer = new ResizeObserver(() => {
      this.reportAttended();
      this.fitToHost();
    });
    this.observer.observe(host);
    this.chain = this.chain.then(() => this.sync());
  }

  /** Stop showing this terminal in `host`. The instance and its shell stay; the tab's close disposes them. */
  detach(host: HTMLElement): void {
    if (this.host !== host) return;
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
    this.term.options.theme = style.terminalPalette;
    this.term.options.fontFamily = style.terminalFont.family;
    this.term.options.fontSize = style.terminalFont.size;
    this.term.options.lineHeight = style.terminalFont.lineHeight;
    if (this.host) this.fitToHost();
  }

  /** Copy the selected text. `clear` drops the selection afterwards, the convention where Ctrl+C both copies and interrupts, so the next Ctrl+C reaches the shell. */
  copySelection(clear = false): void {
    const text = this.term.getSelection();
    if (text.length === 0) return;
    void navigator.clipboard.writeText(text);
    if (clear) this.term.clearSelection();
  }

  /** Paste the clipboard's text through xterm, which brackets it when the shell asked for bracketed paste. */
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
    this.setState({ session: null, control: null, ended: null });
    // Show the cursor the exit hid.
    this.term.write("\x1b[?25h");
    this.chain = this.chain.then(() => this.sync());
  }

  /** The tab closed: release the xterm. Main ends the shell. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.enterTimer !== null) clearTimeout(this.enterTimer);
    this.hideLinkTip();
    for (const dispose of this.disposers) dispose();
    setTerminalAttended(this.tabId, false);
    setTerminalReplaying(this.tabId, false);
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

  private fit(): { cols: number; rows: number } {
    try {
      this.fitAddon.fit();
    } catch {
      /* host not laid out yet — ResizeObserver retries */
    }
    return { cols: this.term.cols, rows: this.term.rows };
  }

  private fitToHost(): void {
    const dims = this.fit();
    if (this.liveRef && !this.exited) void this.api.resize(this.liveRef, dims.cols, dims.rows);
  }

  private renderEvent(event: TerminalDataEvent | TerminalExitEvent): void {
    if ("chunk" in event) {
      this.term.write(event.chunk);
      return;
    }
    this.exited = true;
    // A dead shell has no cursor: hide it (DECTCEM) so the tab does not look like it is waiting for input.
    this.term.write(`${diagnostic(`${this.t("ptyTerminal.exited", { code: event.exitCode })} ${this.t("ptyTerminal.exitedRestartHint")}`)}\x1b[?25l`);
    this.setState({ ended: { kind: "exited", code: event.exitCode } });
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
    const { cols, rows } = this.fit();
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
        return;
      }
      await this.adopt(result, view.purpose);
    } catch {
      if (!this.disposed) {
        this.term.write(diagnostic(this.t("ptyTerminal.startFailed")));
        this.setState({ ended: { kind: "not-started" } });
      }
    } finally {
      if (!this.disposed) setTerminalReplaying(this.tabId, false);
    }
  }

  /** The running shell is shown somewhere else (side panel ↔ pane): main records the new purpose. This xterm already holds the output, so none is replayed. */
  private async reattach(view: LiveTerminalView): Promise<void> {
    const { cols, rows } = this.fit();
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
    this.setState({ session: result.session, ended: null });
    // The replay goes in before anything that can let a live chunk of this incarnation be written ahead of it.
    const waiting = this.pending;
    this.dropPending();
    for (const event of waiting) if (sameTerminalSession(result.session, event)) this.renderEvent(event);
    const current = await this.api.control(result.session, "get");
    if (!this.disposed && current.ok && this.liveRef && sameTerminalSession(this.liveRef, result.session)) this.setState({ control: current.control });
  }
}
