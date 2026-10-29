/** One host shell per tab. Unmount detaches the view; tab close owns the PTY. */
import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AveApi } from "../types.js";
import { useOptionalTheme } from "../theme/ThemeProvider.js";
import { TerminalBlocksBar } from "./TerminalBlocksBar.js";
import { useTranslation } from "../../../i18n/react.js";
import { useSurfaceMount } from "../preview/surface-mounts.js";
import { noteTerminalTabLabel } from "../preview/terminal-tab-labels.js";
import { setTerminalAttended, setTerminalReplaying } from "../preview/terminal-attention.js";
import { takeRestoredTerminal } from "../preview/main-layout-restore.js";
import { sameTerminalSession, type TerminalSessionRef, type TerminalSessionInfo, type TerminalDataEvent, type TerminalExitEvent } from "../../../shared/terminal-session.js";
import type { AttachTextResult } from "../preview/composer-targets.js";

/** Delay before re-listing blocks after an Enter, so the shell has echoed. */
const ENTER_RELIST_DELAY_MS = 150;
const PENDING_OUTPUT_BYTES = 256 * 1024;
const INTEGRATION_UNAVAILABLE_KEYS = {
  "unsupported-shell": "ptyTerminal.integrationUnsupportedShell",
  "missing-home": "ptyTerminal.integrationMissingHome",
  "custom-launch": "ptyTerminal.integrationCustomLaunch",
  "setup-failed": "ptyTerminal.integrationSetupFailed",
} as const;

/** Dim-yellow ANSI wrapper for host-emitted diagnostic lines in the buffer. */
function diagnostic(text: string): string {
  return `\r\n\x1b[33m${text}\x1b[0m\r\n`;
}

/** Resolve concrete terminal colors from root tokens; canvas cannot resolve CSS variables and inherited lookups on deep
 * hosts are expensive. */
function terminalTheme(host: HTMLElement): ITheme {
  const style = getComputedStyle(host.ownerDocument.documentElement);
  const readToken = (name: string, fallbackTriple: string): string => {
    const raw = style.getPropertyValue(name).trim();
    return `hsl(${raw || fallbackTriple})`;
  };
  return {
    background: readToken("--background", "222.2 84% 4.9%"),
    foreground: readToken("--foreground", "210 40% 98%"),
  };
}

interface PtyTerminalViewProps {
  api: AveApi;
  tabId: string;
  /** The tab's visible name ("Terminal 2"), used when a block is attached. */
  tabLabel: string;
  /** Hand a block's text to the chat composer; false when it is full. */
  onAttachText?: (text: string) => AttachTextResult;
  /** Where a NEW shell starts. Only the first spawn of a tab reads it — a remount replays the running shell, which is
   * wherever it already is. */
  initialCwd?: string | null;
  /** Whether the user is looking at this terminal when it is on screen: a side panel's front tab is (default); a main pane is
   * while it has focus, so a terminal in the other half of a split still rings. */
  attended?: boolean;
}

/**
 * One terminal tab may be on screen in one place only (side panel or a main
 * pane). The view that holds the tab's single mount attaches to the PTY; any
 * other view of the same tab shows a notice and takes over once the holder
 * unmounts — see `surface-mounts.ts`.
 */
export function PtyTerminalView({
  location,
  ...props
}: PtyTerminalViewProps & {
  /** Where this view is mounted: "side-panel" or "pane:<id>". */
  location: string;
}) {
  const { t } = useTranslation();
  const mount = useSurfaceMount(props.tabId, location);
  // The name its egress card in the approval lane and Settings use for it.
  useEffect(() => noteTerminalTabLabel(props.tabId, props.tabLabel), [props.tabId, props.tabLabel]);
  if (!mount.owned) {
    return (
      <div
        className="flex h-full min-h-0 w-full items-center justify-center bg-background p-4 text-center text-sm text-muted-foreground"
        data-testid="pty-terminal-mounted-elsewhere"
        data-owner-location={mount.ownerLocation ?? ""}
      >
        {t("ptyTerminal.mountedElsewhere")}
      </div>
    );
  }
  return <AttachedPtyTerminal key={props.tabId} {...props} />;
}

function AttachedPtyTerminal({ api, tabId, tabLabel, onAttachText, initialCwd, attended = true }: PtyTerminalViewProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Read once, at the spawn: a later report must not respawn anything.
  const initialCwdRef = useRef(initialCwd ?? null);
  // Attention is "seen" only while the terminal is both attended and on screen; the box is measured by the resize observer
  // below.
  const attendedRef = useRef(attended);
  attendedRef.current = attended;
  const hasBoxRef = useRef(false);
  const [blockRevision, setBlockRevision] = useState(0);
  const termRef = useRef<Terminal | null>(null);
  // Changes after the applied theme's values were written to :root — another theme or the same one updated in place.
  const appliedRevision = useOptionalTheme()?.appliedRevision ?? 0;

  useEffect(() => {
    const host = hostRef.current;
    const terminalApi = api.terminal;
    // `terminal` is only ever undefined in test fixtures that cast a partial object to AveApi — production preload always
    // defines it.
    if (!host || !terminalApi) return;

    let disposed = false;
    let liveRef: TerminalSessionRef | null = null;
    setSession(null);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: terminalTheme(host),
      scrollback: 5000,
      allowProposedApi: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const safeFit = (): { cols: number; rows: number } => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet — ResizeObserver retries */
      }
      return { cols: term.cols, rows: term.rows };
    };

    const { cols, rows } = safeFit();

    const bumpBlocks = (): void => {
      if (!disposed) setBlockRevision((value) => value + 1);
    };
    // OSC 133 A (prompt) and D (command finished) end a block; C starts one. Returning false leaves the sequence to xterm's
    // default handling.
    const markerSub = term.parser.registerOscHandler(133, (data) => {
      const marker = data.charAt(0);
      if (marker === "A" || marker === "C" || marker === "D") bumpBlocks();
      return false;
    });
    let enterTimer: ReturnType<typeof setTimeout> | null = null;

    // Forward keystrokes → PTY stdin.
    const inputSub = term.onData((data) => {
      if (!liveRef) return;
      void terminalApi.input(liveRef, data);
      if (data.includes("\r")) {
        if (enterTimer !== null) clearTimeout(enterTimer);
        enterTimer = setTimeout(() => {
          enterTimer = null;
          bumpBlocks();
        }, ENTER_RELIST_DELAY_MS);
      }
    });

    // Replay precedes spawn's reply. Buffer by incarnation until the host confirms it.
    let pending: Array<TerminalDataEvent | TerminalExitEvent> = [];
    let pendingBytes = 0;
    const renderEvent = (event: TerminalDataEvent | TerminalExitEvent): void => {
      if ("chunk" in event) term.write(event.chunk);
      else { term.write(diagnostic(t("ptyTerminal.exited", { code: event.exitCode }))); bumpBlocks(); }
    };
    const acceptEvent = (event: TerminalDataEvent | TerminalExitEvent): void => {
      if (disposed || event.tabId !== tabId || event.lane !== "manual") return;
      if (liveRef) {
        if (sameTerminalSession(liveRef, event)) renderEvent(event);
        return;
      }
      const bytes = "chunk" in event ? new TextEncoder().encode(event.chunk).length : 0;
      // Both a chunk and the whole waiting queue stay within the replay ring ceiling.
      if (bytes > PENDING_OUTPUT_BYTES) return;
      pending.push(event);
      pendingBytes += bytes;
      while (pendingBytes > PENDING_OUTPUT_BYTES || pending.length > 1024) {
        const dropped = pending.shift();
        if (dropped && "chunk" in dropped) pendingBytes -= new TextEncoder().encode(dropped.chunk).length;
      }
    };
    const offData = terminalApi.onData(acceptEvent);
    const offExit = terminalApi.onExit(acceptEvent);

    setTerminalReplaying(tabId, true);
    const restored = takeRestoredTerminal(tabId);
    if (restored) term.write(diagnostic(t("ptyTerminal.restored")));
    const startCwd = restored ? restored.cwd : initialCwdRef.current;
    const spawnAt = (cwd: string | null) =>
      terminalApi.spawn({ tabId, lane: "manual", cols, rows, ...(cwd ? { cwd } : {}) });
    const start = async () => {
      let result = await spawnAt(startCwd);
      if (!result.ok && restored && startCwd && !disposed && (result.reason === "bad-request" || result.reason === "spawn-failed")) {
        term.write(diagnostic(t("ptyTerminal.restoredRoot")));
        result = await spawnAt(null);
      }
      if (disposed) return;
      if (!result.ok) {
        pending = [];
        term.write(diagnostic(t(result.reason === "too-many-terminals" ? "ptyTerminal.capacity" : result.reason === "still-closing" ? "ptyTerminal.stillClosing" : "ptyTerminal.manualUnavailable")));
        return;
      }
      liveRef = result.session;
      setSession(result.session);
      for (const event of pending) if (sameTerminalSession(result.session, event)) renderEvent(event);
      pending = [];
      pendingBytes = 0;
      bumpBlocks();
    };
    void start().catch(() => {
      if (!disposed) term.write(diagnostic(t("ptyTerminal.startFailed")));
    }).finally(() => { if (!disposed) setTerminalReplaying(tabId, false); });

    // The user is looking at this terminal while its host has a box: a hidden pane or a side panel set aside lays it out at
    // zero size.
    const reportAttended = () => {
      hasBoxRef.current = host.offsetWidth > 0 && host.offsetHeight > 0;
      setTerminalAttended(tabId, attendedRef.current && hasBoxRef.current);
    };
    reportAttended();

    // Resize the PTY when the pane changes size.
    const resizeObserver = new ResizeObserver(() => {
      reportAttended();
      const dims = safeFit();
      if (liveRef) void terminalApi.resize(liveRef, dims.cols, dims.rows);
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      setTerminalAttended(tabId, false);
      resizeObserver.disconnect();
      if (enterTimer !== null) clearTimeout(enterTimer);
      markerSub.dispose();
      inputSub.dispose();
      offData();
      offExit();
      termRef.current = null;
      term.dispose();
      // NOTE: PTY is intentionally NOT killed here — it survives unmount and is torn down on tab close (closeWorkspaceTab →
      // terminal.kill).
    };
  }, [api, tabId]);

  // Focus moving to or from this terminal's pane.
  useEffect(() => {
    if (termRef.current) setTerminalAttended(tabId, attended && hasBoxRef.current);
  }, [tabId, attended]);

  // Re-tint the live terminal when the applied theme changes: its options take a new theme in place, so the shell,
  // scrollback and cursor are kept.
  useEffect(() => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;
    term.options.theme = terminalTheme(host);
  }, [appliedRevision]);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
      data-testid="chat-side-panel-pty-terminal"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-l-4 border-l-primary border-border px-2 py-1 text-xs" data-testid="terminal-host-identity">
        <span className="rounded bg-primary/(--opacity-subtle) px-1.5 py-0.5 font-medium text-primary">{t("ptyTerminal.hostLabel")}</span>
        <span className="text-muted-foreground">{t("ptyTerminal.noAgentAccess")}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={session?.currentCwd ?? session?.initialCwd}>
          {session?.currentCwd ? t("ptyTerminal.currentCwd", { cwd: session.currentCwd }) : session ? t("ptyTerminal.initialCwd", { cwd: session.initialCwd }) : ""}
        </span>
      </div>
      <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">
        {t("ptyTerminal.manualEnvironment")}
      </p>
      {session?.integrationUnavailableReason ? <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground" data-testid="terminal-integration-unavailable">
        {t(INTEGRATION_UNAVAILABLE_KEYS[session.integrationUnavailableReason])}
      </p> : null}
      {api.terminal && session ? (
        <TerminalBlocksBar
          terminalApi={api.terminal}
          key={`${session.lane}/${session.terminalSessionId}`}
          session={session}
          tabLabel={`${tabLabel} · ${session.terminalSessionId}`}
          revision={blockRevision}
          {...(onAttachText ? { onAttachText } : {})}
          onSession={setSession}
        />
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}
