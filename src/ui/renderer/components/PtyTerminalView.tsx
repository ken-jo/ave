/** One host shell per tab. Unmount detaches the view; tab close owns the PTY and the live xterm (live-terminal.ts). */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import type { AveApi } from "../types.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { TerminalBlocksBar } from "./TerminalBlocksBar.js";
import { TerminalChangeAnnotations } from "./TerminalChangeAnnotations.js";
import { TerminalPaneHeader, type TerminalPaneAccess } from "./TerminalPaneHeader.js";
import { LiveTerminal, type LiveTerminalState } from "./live-terminal.js";
import { TerminalFindBar } from "./TerminalFindBar.js";
import { liveTerminalFor, takeTerminalFocusRequest } from "../preview/live-terminal-registry.js";
import { useTranslation } from "../../../i18n/react.js";
import { useSurfaceMount } from "../preview/surface-mounts.js";
import type { TerminalControlAction, TerminalPurpose } from "../../../shared/terminal-session.js";
import type { AttachTextResult } from "../preview/composer-targets.js";

const NO_LIVE_STATE: LiveTerminalState = { session: null, control: null, blockRevision: 0, ended: null, inputNotice: null };
const noLiveState = (): LiveTerminalState => NO_LIVE_STATE;
const subscribeNothing = (): (() => void) => () => {};
const INTEGRATION_UNAVAILABLE_KEYS = {
  "unsupported-shell": "ptyTerminal.integrationUnsupportedShell",
  "missing-home": "ptyTerminal.integrationMissingHome",
  "custom-launch": "ptyTerminal.integrationCustomLaunch",
  "setup-failed": "ptyTerminal.integrationSetupFailed",
} as const;

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
  /** A pane's header, where the terminal's identity and block controls go as one row instead of rows over the output.
   * Absent: they are drawn above the output (a side panel's tab). Null: the pane header has not committed yet. */
  headerSlot?: HTMLElement | null;
  /** Where a work panel that floats over this terminal wants the control strip repeated; null while nothing covers the terminal. */
  controlMirrorSlot?: HTMLElement | null;
  /** The directory the shell last reported (never the launch directory), for a header that shows it. */
  onCwd?: (cwd: string) => void;
  /** Close this terminal's tab; offered once its shell has ended. */
  onCloseTab?: () => void;
  /** Open a web link the user modifier-clicked in the terminal, in an Ave browser tab. */
  onOpenLink?: (url: string) => void;
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
  return <AttachedPtyTerminal key={props.tabId} {...props} purpose={location === "side-panel" ? "side-panel" : "workspace"} />;
}

/** Why hand-back was refused, as main reports the shell's prompt. */
const HAND_BACK_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  "hand-back-pending-input": "ptyTerminal.handBackPendingInput",
  "hand-back-command-running": "ptyTerminal.handBackCommandRunning",
  "hand-back-waiting-for-prompt": "ptyTerminal.handBackWaitingForPrompt",
  "hand-back-no-shell-integration": "ptyTerminal.handBackNoIntegration",
  "hand-back-exited": "ptyTerminal.handBackExited",
};

/**
 * Keyboard focus follows the terminal the user is attending to, so typing reaches the shell (and xterm shows its
 * blinking focused cursor) without a click. It moves only when nothing holds focus, or when focus is on the selected
 * tab of this terminal, the user's explicit activation of it. Any other focused element keeps it: the chat composer
 * the user is typing in, an approval card's buttons, a menu, a tab in another area, this terminal's own controls.
 */
function focusAttendedTerminal(term: Terminal, tabId: string): void {
  const active = document.activeElement;
  const activatedHere = active instanceof HTMLElement && active.getAttribute("role") === "tab" && active.getAttribute("aria-selected") === "true"
    && active.closest("[data-tab-id]")?.getAttribute("data-tab-id") === tabId;
  if (active === null || active === document.body || activatedHere) term.focus();
}

function AttachedPtyTerminal({ api, tabId, tabLabel, onAttachText, initialCwd, attended = true, headerSlot, controlMirrorSlot, onCwd, onCloseTab, onOpenLink, purpose }: PtyTerminalViewProps & { purpose: TerminalPurpose }) {
  const { t } = useTranslation();
  const [live, setLive] = useState<LiveTerminal | null>(null);
  const { session, control, blockRevision, ended, inputNotice } = useSyncExternalStore(live ? live.subscribe : subscribeNothing, live ? live.getState : noLiveState);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Read once, at the spawn: a later report must not respawn anything.
  const initialCwdRef = useRef(initialCwd ?? null);
  // Attention is "seen" only while the terminal is both attended and on screen; the live terminal measures the box.
  const attendedRef = useRef(attended);
  attendedRef.current = attended;
  const translateRef = useRef(t);
  translateRef.current = t;
  const [findOpen, setFindOpen] = useState(false);
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  // Changes after the applied theme's values were written to :root — another theme or the same one updated in place.
  const themeContext = useTheme();
  const appliedRevision = themeContext.appliedRevision;
  const appearance = themeContext.appearance;
  const terminalPalette = themeContext.appliedTheme.terminal;
  const terminalFont = appearance.terminalFont;
  const terminalStyleRef = useRef({ terminalPalette, terminalFont });
  terminalStyleRef.current = { terminalPalette, terminalFont };

  // Attach the tab's live terminal to this view's host. Unmount detaches the view; the xterm and its shell stay until the
  // tab closes (closeWorkspaceTab → terminal.kill + disposeLiveTerminal).
  useEffect(() => {
    const host = hostRef.current;
    const terminalApi = api.terminal;
    // `terminal` is only ever undefined in test fixtures that cast a partial object to AveApi — production preload always
    // defines it.
    if (!host || !terminalApi) return;
    const terminal = liveTerminalFor(tabId, () => new LiveTerminal(terminalApi, tabId, terminalStyleRef.current, translateRef.current));
    terminal.applyStyle(terminalStyleRef.current);
    terminal.attach(host, { purpose, initialCwd: initialCwdRef.current, t: translateRef.current, attended: () => attendedRef.current,
      openLink: (url) => openLinkRef.current?.(url), openFind: () => setFindOpen(true) });
    setLive(terminal);
    return () => {
      terminal.detach(host);
      setLive(null);
    };
  }, [api, tabId, purpose]);

  // A notice answered the previous control state; it no longer applies once control changes.
  useEffect(() => {
    setControlNotice(null);
  }, [control]);

  // Only a workspace mount of a shell that takes agent typing can receive approved commands; every other mount says it has no agent access.
  const workspaceTyping = purpose === "workspace" && (control === null || control.agentInput === "supported");
  // The header chip names that exposure in a word; its tooltip carries the full statement, what stays private, and why a shell takes no input.
  const access: TerminalPaneAccess = {
    chip: t("ptyTerminal.hostChip"),
    detail: t(purpose !== "workspace" ? "ptyTerminal.hostChipAgentless" : workspaceTyping ? "ptyTerminal.hostChipApproval" : "ptyTerminal.hostChipNoAgentInput"),
    about: [
      t(purpose !== "workspace" ? "ptyTerminal.hostBadge" : workspaceTyping ? "ptyTerminal.hostBadgeWorkspace" : "ptyTerminal.hostBadgeNoAgentInput"),
      t(workspaceTyping ? "ptyTerminal.workspaceEnvironment" : "ptyTerminal.manualEnvironment"),
      ...(purpose === "workspace" && control !== null && control.agentInput !== "supported"
        ? [t(control.agentInput === "powershell" ? "ptyTerminal.agentInputPowerShell" : "ptyTerminal.agentInputUnsupported")] : []),
    ],
  };

  const changeControl = (action: TerminalControlAction): void => {
    const terminalApi = api.terminal;
    if (!terminalApi || !session) return;
    setControlNotice(null);
    void terminalApi.control(session, action).then((result) => {
      if (result.ok) live?.acceptControl(session, result.control);
      else setControlNotice(t(HAND_BACK_REFUSAL_KEYS[result.error] ?? "ptyTerminal.controlFailed"));
    }, () => setControlNotice(t("ptyTerminal.controlFailed")));
  };

  // Focus moving to or from this terminal's pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attended` is the trigger; the live terminal reads its value through the view it is attached to.
  useEffect(() => {
    live?.reportAttended();
  }, [live, attended]);

  // On attach and whenever the tab or pane becomes attended. A terminal the user just opened takes the keyboard from the
  // control that opened it (the launcher keeps focus otherwise, and Enter would open another terminal); a passive
  // remount follows the rule above.
  useEffect(() => {
    if (!live) return;
    if (takeTerminalFocusRequest(tabId)) live.term.focus();
    else if (attended) focusAttendedTerminal(live.term, tabId);
  }, [attended, live, tabId]);

  // Re-tint the live terminal when the applied theme changes: its options take a new theme in place, so the shell,
  // scrollback and cursor are kept.
  useEffect(() => {
    live?.applyStyle({ terminalPalette, terminalFont });
  }, [live, appliedRevision, terminalPalette, terminalFont]);

  // Only a directory the shell reported is the current one; the launch directory is not evidence of it.
  const reportedCwd = session?.currentCwd ?? null;
  useEffect(() => {
    if (reportedCwd) onCwd?.(reportedCwd);
  }, [reportedCwd, onCwd]);
  const inlineChrome = headerSlot === undefined;
  const blocks = api.terminal && session ? (
    <TerminalBlocksBar
      terminalApi={api.terminal}
      key={`${session.lane}/${session.terminalSessionId}`}
      session={session}
      tabLabel={`${tabLabel} · ${session.terminalSessionId}`}
      revision={blockRevision}
      {...(onAttachText ? { onAttachText } : {})}
      {...(live ? { onSession: live.setSession } : {})}
    />
  ) : null;

  // Who controls the terminal, with the way to take it back. Drawn over the output, and again (under `prefix`) at the top of a work panel
  // that floats over this terminal: the controls a running agent command promises stay on screen whatever covers the output.
  const controlStrip = (prefix: "terminal" | "pane-chat-terminal"): ReactNode => control?.mode === "agent" ? (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-l-4 border-l-warning border-border bg-warning/(--opacity-subtle) px-2 py-1 text-xs" data-testid={`${prefix}-agent-control`} role="status">
      <span className="min-w-0 flex-1 truncate font-medium" title={control.command}>
        {t(control.typed ? "ptyTerminal.agentRunning" : "ptyTerminal.agentTyping", { command: control.command ?? "" })}
      </span>
      {prefix === "terminal" ? <span className="text-muted-foreground" data-testid="terminal-take-over-hint">{t("ptyTerminal.typingTakesOver")}</span> : null}
      <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-muted" data-testid={`${prefix}-take-over`} onClick={() => changeControl("take-over")}>{t("ptyTerminal.takeOver")}</button>
      <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-muted" data-testid={`${prefix}-stop-agent`} onClick={() => changeControl("stop")}>{t("ptyTerminal.stop")}</button>
    </div>
  ) : control?.mode === "taken-over" && purpose === "workspace" ? (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-l-4 border-l-primary border-border px-2 py-1 text-xs" data-testid={`${prefix}-user-control`} role="status">
      <span className="min-w-0 flex-1">{t("ptyTerminal.takenOver")}</span>
      <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-muted" data-testid={`${prefix}-hand-back`} onClick={() => changeControl("hand-back")}>{t("ptyTerminal.handBack")}</button>
    </div>
  ) : null;

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
      data-testid="chat-side-panel-pty-terminal"
    >
      {inlineChrome || headerSlot ? (() => {
        const cwdNote = session && !session.currentCwd ? t("ptyTerminal.initialCwd", { cwd: session.initialCwd }) : null;
        const header = <TerminalPaneHeader blocks={blocks} cwdNote={cwdNote} access={access}
          {...(inlineChrome ? { inline: { cwd: session?.currentCwd ?? null } } : {})} />;
        return inlineChrome ? header : createPortal(header, headerSlot!);
      })() : null}
      {controlStrip("terminal")}
      {controlMirrorSlot ? createPortal(controlStrip("pane-chat-terminal"), controlMirrorSlot) : null}
      {ended ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-l-4 border-l-muted-foreground border-border px-2 py-1 text-xs" data-testid="terminal-ended" role="status">
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium" data-testid="terminal-ended-chip">{t("ptyTerminal.endedChip")}</span>
          <span className="min-w-0 flex-1 text-muted-foreground">{ended.kind === "exited" ? t("ptyTerminal.endedExit", { code: ended.code }) : t("ptyTerminal.endedNotStarted")}</span>
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-muted" data-testid="terminal-restart"
            onClick={() => { live?.restart(); live?.term.focus(); }}>{t("ptyTerminal.restartShell")}</button>
          {onCloseTab ? <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-muted" data-testid="terminal-close-tab" onClick={onCloseTab}>{t("ptyTerminal.closeTab")}</button> : null}
        </div>
      ) : null}
      {inputNotice ? <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-destructive" data-testid="terminal-input-notice" role="alert">
        {t(inputNotice === "too-large" ? "ptyTerminal.inputTooLarge" : "ptyTerminal.inputNotDelivered")}
      </p> : null}
      {controlNotice ? <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-destructive" data-testid="terminal-control-notice" role="alert">{controlNotice}</p> : null}
      {session?.integrationUnavailableReason ? <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground" data-testid="terminal-integration-unavailable">
        {t(INTEGRATION_UNAVAILABLE_KEYS[session.integrationUnavailableReason])}
      </p> : null}
      {/* Warnings are xterm decorations on their command's row; only the review side panel overlays this area, so the
          xterm host stays its only in-flow child and no rows are taken. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="terminal-output-area">
        <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden p-1" data-testid="terminal-xterm-host" />
        {findOpen && live ? <TerminalFindBar live={live} onClose={() => setFindOpen(false)} /> : null}
        {api.terminal && session ? <TerminalChangeAnnotations key={session.terminalSessionId} terminalApi={api.terminal} session={session} revision={blockRevision} anchors={live?.anchors ?? null} /> : null}
      </div>
    </div>
  );
}
