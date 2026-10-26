import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import { isSidebarState, type SidebarState } from "../../../shared/sidebar-state.js";
import { MAIN_WINDOW_MIN_WIDTH } from "../../../shared/shell-geometry.js";

/** Persist explicit visibility choices while leaving an unchosen sidebar responsive to the window width. */
export function useSidebarState(api: AveApi, shellWidth: number) {
  const [chosenState, setChosenState] = useState<SidebarState>();
  const chosenStateRef = useRef<SidebarState | undefined>(undefined);
  const selectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then((settings) => {
      if (cancelled || selectedRef.current) return;
      const value = settings?.system?.sidebarState;
      if (!isSidebarState(value)) return;
      chosenStateRef.current = value;
      setChosenState(value);
    }).catch(() => {
      // Keep the width-dependent default until the user makes an explicit choice.
    });
    return () => { cancelled = true; };
  }, [api]);

  const setSidebarState = useCallback((value: SidebarState) => {
    if (chosenStateRef.current === value) return;
    selectedRef.current = true;
    chosenStateRef.current = value;
    setChosenState(value);
    void api.updateSettings({ system: { sidebarState: value } }).catch(() => {
      // Keep the local choice if persistence is temporarily unavailable.
    });
  }, [api]);

  const sidebarState = chosenState ?? (shellWidth <= MAIN_WINDOW_MIN_WIDTH ? "hidden" : "expanded");
  return { sidebarState, setSidebarState };
}
