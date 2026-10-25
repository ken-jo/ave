import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { getApi } from "../api-client.js";
import type { AppMode } from "../MainToolbar.js";
import { readInitialAppMode } from "../utils/read-initial-app-mode.js";

type Api = ReturnType<typeof getApi>;

export interface UseAppModeResult {
  appMode: AppMode;
  setAppMode: (next: AppMode) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  sidePanelOpen: boolean;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
}

/** Seed app mode before paint, guard no-op writes, and treat sidebar defaults as mode-transition choices; optional window
 * resize IPC may be absent. */
export function useAppMode(api: Api): UseAppModeResult {
  // Seed from the persisted workspace mode injected by the main process
  // (preload's `window.__aveInitialAppMode`). Reading it at initializer time
  // — before first paint — makes the shell render the saved mode's layout on
  // frame 0 (expanded rail for work, collapsed for chat) with no wrong-mode
  // flash followed by a post-mount tween. Defaults to "work" on first run /
  // non-Electron harness.
  const [appMode, setAppModeState] = useState<AppMode>(readInitialAppMode);
  // Sidebar collapse is owned by the shell (the floating-card Sidebar reads it
  // as a prop and never manages its own state). Seeded from the same persisted
  // mode so the rail starts at the correct width on frame 0 (no post-mount
  // width tween). The rail width is coupled to appMode on each transition (see
  // the effect below): work expands it, chat collapses it — a per-transition
  // default, NOT a lock.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readInitialAppMode() === "chat");

  // The right-docked work panel (ChatSidePanel), toggled from the title bar. Chat-mode only affordance: opening it widens
  // the OS window (resizeForSidePanel) and closing it restores the normal chat bounds.
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  // Persist appMode to host settings and update local state. Guarded against
  // no-op writes (same mode) so a re-render or repeated toggle never fires a
  // redundant IPC write. Stable identity (useCallback with only `api`) so it is
  // safe in effect deps — no unstable-callback render loop (#1312 guard).
  const setAppMode = useCallback((next: AppMode) => {
    setAppModeState((prev) => {
      if (prev === next) return prev;
      // Persist the new mode so the next boot seeds from it. Fire-and-forget: a failed write only means the next launch falls
      // back to the previous saved value — never blocks the toggle or surfaces an error toast.
      void api.updateSettings({ system: { appMode: next } });
      return next;
    });
  }, [api]);
  // Mode changes set a sidebar default, not a lock; manual collapse/expand remains until the next transition.
  useEffect(() => {
    setSidebarCollapsed(appMode === "chat");
  }, [appMode]);
  // Resize the OS window to match the mode on mode CHANGES only. The window is
  // already created at the persisted mode's bounds (main.ts initialMainWindowBounds),
  // so firing resizeForMode on the initial mount would issue a same-target tween
  // — a needless animation on boot. The first-run ref skips that mount call;
  // subsequent toggles resize as before. The bridge is optional (absent in
  // jsdom / non-Electron); guard accordingly.
  const resizeForModeMountedRef = useRef(false);
  useEffect(() => {
    if (!resizeForModeMountedRef.current) {
      resizeForModeMountedRef.current = true;
      return;
    }
    void api.window?.resizeForMode?.(appMode);
  }, [appMode, api]);
  // Side panel is a chat-mode affordance: resize the OS window when it toggles
  // (opening docks the work panel, closing restores the chat bounds). Guarded on
  // chat mode so work mode never issues a side-panel resize. Bridge is optional
  // (absent in jsdom / non-Electron).
  useEffect(() => {
    if (appMode !== "chat") return;
    void api.window?.resizeForSidePanel?.(sidePanelOpen);
  }, [appMode, api, sidePanelOpen]);
  return {
    appMode,
    setAppMode,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidePanelOpen,
    setSidePanelOpen,
  };
}
