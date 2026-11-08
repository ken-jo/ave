import { useEffect, useRef } from "react";
import {
  matchesResolvedShortcut,
  type ShortcutKeyEvent,
  type ShortcutPlatform,
  type ShortcutResolutionInput,
} from "../../../shared/shortcuts.js";
import { isDarwin } from "../api-client.js";
import { getShortcutSettings, isShortcutCaptureActive } from "./use-shortcuts.js";

/** Back/forward keys come from the registry (⌘[ / ⌘] on macOS by default, to avoid Option-arrow word navigation); ignore
 * history chords while editable elements have focus. */
export interface ViewHistoryShortcutHandlers {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/** True when the keystroke belongs to whatever the user is typing into. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

/** Which navigation a keystroke asks for, or null. Exported so the decision can be tested directly on both platforms
 * without synthesizing a whole app. */
export function viewHistoryIntent(
  event: ShortcutKeyEvent,
  darwin: boolean,
  input: ShortcutResolutionInput = getShortcutSettings(),
): "back" | "forward" | null {
  if (isShortcutCaptureActive()) return null;
  const platform: ShortcutPlatform = darwin ? "darwin" : "other";
  if (matchesResolvedShortcut("app.viewBack", event, input, platform)) return "back";
  if (matchesResolvedShortcut("app.viewForward", event, input, platform)) return "forward";
  return null;
}

export function useViewHistoryShortcuts(handlers: ViewHistoryShortcutHandlers): void {
  // Stable ref so the listener attaches once instead of re-binding on every navigation (the handlers change identity
  // whenever history moves).
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const darwin = isDarwin();
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const intent = viewHistoryIntent(event, darwin);
      if (!intent) return;
      const current = handlersRef.current;
      if (intent === "back" && current.canGoBack) {
        event.preventDefault();
        current.goBack();
      } else if (intent === "forward" && current.canGoForward) {
        event.preventDefault();
        current.goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
