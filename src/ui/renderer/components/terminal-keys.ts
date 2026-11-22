/**
 * The terminal's clipboard keys off macOS. xterm maps Ctrl+C and Ctrl+V to the control characters ^C and ^V, which is right
 * for a shell but leaves Windows and Linux without copy and paste keys; on macOS the Edit menu's Cmd+C and Cmd+V do it.
 * The bindings follow each platform's own terminal conventions:
 *   Windows: Ctrl+C copies when text is selected (and clears the selection, so the next Ctrl+C interrupts), Ctrl+V pastes,
 *            and Ctrl+Shift+C / Ctrl+Shift+V do the same.
 *   Linux:   Ctrl+Shift+C copies, Ctrl+Shift+V and Shift+Insert paste; Ctrl+C and Ctrl+V stay the shell's.
 */
import { isDarwin } from "../api-client.js";

export type TerminalPlatform = "darwin" | "win32" | "linux";
export type TerminalClipboardAction = "copy" | "paste";

interface ClipboardKey {
  readonly type: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** The platform the window runs on; the preload bridge only tells macOS apart. */
export function terminalPlatform(): TerminalPlatform {
  if (isDarwin()) return "darwin";
  return /Windows/i.test(navigator.userAgent) ? "win32" : "linux";
}

/**
 * Cmd+Up / Cmd+Down on macOS and Ctrl+Up / Ctrl+Down elsewhere scroll to the previous or next command, or null when the key is the shell's.
 * With Shift or Alt the key keeps its other meanings (selection, word movement).
 */
export function terminalCommandJump(event: ClipboardKey, platform: TerminalPlatform): "previous" | "next" | null {
  if (event.type !== "keydown" || event.shiftKey || event.altKey) return null;
  if (platform === "darwin" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  return event.key === "ArrowUp" ? "previous" : event.key === "ArrowDown" ? "next" : null;
}

/** What a key press asks of the terminal's clipboard, or null when the key is the shell's. */
export function terminalClipboardAction(event: ClipboardKey, platform: TerminalPlatform, hasSelection: boolean): TerminalClipboardAction | null {
  if (platform === "darwin" || event.type !== "keydown" || event.altKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (platform === "linux" && key === "insert" && event.shiftKey && !event.ctrlKey) return "paste";
  if (!event.ctrlKey) return null;
  if (event.shiftKey) return key === "c" ? (hasSelection ? "copy" : null) : key === "v" ? "paste" : null;
  if (platform !== "win32") return null;
  return key === "c" ? (hasSelection ? "copy" : null) : key === "v" ? "paste" : null;
}
