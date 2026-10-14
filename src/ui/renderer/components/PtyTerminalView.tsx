/**
 * PtyTerminalView — xterm.js frontend for the real interactive PTY terminal
 * (#1444). One instance per workspace terminal tab. The PTY itself lives in the
 * MAIN process (pty-manager.ts) inside the ASRT sandbox; this component only
 * renders output and forwards keystrokes/resize over the internal `terminal`
 * IPC surface.
 *
 * LIFECYCLE: `spawn` is idempotent per `tabId` — mounting (or re-mounting after
 * a ChatSidePanel unmount) replays the main-side scrollback rather than starting
 * a fresh shell, so the terminal state survives rail close / session switch. On
 * unmount we dispose the xterm instance + IPC subscriptions but DO NOT kill the
 * PTY (the tab-close path in the store owns kill).
 *
 * i18n: process/diagnostic lines (spawn failure, exit) are written into the
 * xterm BUFFER as terminal content — the same channel a real shell prints
 * "[Process completed]" on — not into localized app chrome. The block strip
 * above the terminal (TerminalBlocksBar) carries its own catalog keys.
 *
 * BLOCKS: the main process records each command as a block. This view only
 * tells the strip when to re-list: xterm's own parser reports every OSC 133
 * marker (so a marker split across output chunks is still seen once), and an
 * Enter keystroke covers shells that send no markers.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AveApi } from "../types.js";
import { errorMessage } from "../../../shared/error-message.js";
import { useOptionalTheme } from "../theme/ThemeProvider.js";
import { TerminalBlocksBar } from "./TerminalBlocksBar.js";

/** Delay before re-listing blocks after an Enter, so the shell has echoed. */
const ENTER_RELIST_DELAY_MS = 150;

/** Dim-yellow ANSI wrapper for host-emitted diagnostic lines in the buffer. */
function diagnostic(text: string): string {
  return `\r\n\x1b[33m${text}\x1b[0m\r\n`;
}

/**
 * xterm's canvas renderer cannot resolve CSS custom properties, so the ACTIVE
 * theme tokens are read off the DOM and handed to xterm as concrete colors —
 * no source-level color literal (color-token-gate compliant).
 */
function terminalTheme(host: HTMLElement): ITheme {
  const readToken = (name: string, fallbackTriple: string): string => {
    const raw = getComputedStyle(host).getPropertyValue(name).trim();
    return `hsl(${raw || fallbackTriple})`;
  };
  return {
    background: readToken("--background", "222.2 84% 4.9%"),
    foreground: readToken("--foreground", "210 40% 98%"),
  };
}

export function PtyTerminalView({
  api,
  tabId,
  tabLabel,
  onAttachText,
}: {
  api: AveApi;
  tabId: string;
  /** The tab's visible name ("Terminal 2"), used when a block is attached. */
  tabLabel: string;
  /** Hand a block's text to the chat composer; false when it is full. */
  onAttachText?: (text: string) => boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [blockRevision, setBlockRevision] = useState(0);
  const termRef = useRef<Terminal | null>(null);
  // Changes after the applied theme's values were written to :root — another
  // theme or the same one updated in place.
  const appliedRevision = useOptionalTheme()?.appliedRevision ?? 0;

  useEffect(() => {
    const host = hostRef.current;
    const terminalApi = api.terminal;
    // `terminal` is only ever undefined in test fixtures that cast a partial
    // object to AveApi — production preload always defines it.
    if (!host || !terminalApi) return;

    let disposed = false;
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
    // OSC 133 A (prompt) and D (command finished) end a block; C starts one.
    // Returning false leaves the sequence to xterm's default handling.
    const markerSub = term.parser.registerOscHandler(133, (data) => {
      const marker = data.charAt(0);
      if (marker === "A" || marker === "C" || marker === "D") bumpBlocks();
      return false;
    });
    let enterTimer: ReturnType<typeof setTimeout> | null = null;

    // Forward keystrokes → PTY stdin.
    const inputSub = term.onData((data) => {
      void terminalApi.input(tabId, data);
      if (data.includes("\r")) {
        if (enterTimer !== null) clearTimeout(enterTimer);
        enterTimer = setTimeout(() => {
          enterTimer = null;
          bumpBlocks();
        }, ENTER_RELIST_DELAY_MS);
      }
    });

    // Main → renderer output / exit.
    const offData = terminalApi.onData((payload) => {
      if (payload.tabId !== tabId) return;
      term.write(payload.chunk);
    });
    const offExit = terminalApi.onExit((payload) => {
      if (payload.tabId !== tabId) return;
      term.write(diagnostic(`[process exited: code ${payload.exitCode}]`));
      bumpBlocks();
    });

    // Spawn (or replay). Fail-closed reasons surface as a buffer diagnostic.
    void terminalApi
      .spawn({ tabId, cols, rows })
      .then((res) => {
        if (disposed) return;
        if (!res.ok) term.write(diagnostic(`[terminal unavailable] ${res.message}`));
      })
      .catch((err: unknown) => {
        if (!disposed) {
          term.write(diagnostic(`[terminal error] ${errorMessage(err)}`));
        }
      });

    // Resize the PTY when the pane changes size.
    const resizeObserver = new ResizeObserver(() => {
      const dims = safeFit();
      void terminalApi.resize(tabId, dims.cols, dims.rows);
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (enterTimer !== null) clearTimeout(enterTimer);
      markerSub.dispose();
      inputSub.dispose();
      offData();
      offExit();
      termRef.current = null;
      term.dispose();
      // NOTE: PTY is intentionally NOT killed here — it survives unmount and is
      // torn down on tab close (closeWorkspaceTab → terminal.kill).
    };
  }, [api, tabId]);

  // Re-tint the live terminal when the applied theme changes: its options take
  // a new theme in place, so the shell, scrollback and cursor are kept.
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
      {api.terminal ? (
        <TerminalBlocksBar
          terminalApi={api.terminal}
          tabId={tabId}
          tabLabel={tabLabel}
          revision={blockRevision}
          {...(onAttachText ? { onAttachText } : {})}
        />
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}
