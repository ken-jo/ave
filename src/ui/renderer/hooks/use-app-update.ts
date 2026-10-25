import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type { AppUpdateBadgeState } from "../MainToolbar.js";

const INSTALL_HANDOFF_SAFETY_RELEASE_MS = 10_000;

/** Live host events own update state; guard duplicate clicks during IPC and keep install confirmation inside main's
 * install-now handler. */
export function useAppUpdate(
  api: AveApi,
  /**
   * Called when "apply update" can't self-install (unsigned macOS build) — the
   * main process has opened the release page and returned
   * `reason: "manual-install-required"`. The consumer surfaces a toast so the
   * badge click isn't a silent no-op.
   */
  onNeedsManualInstall?: () => void,
): {
  state: AppUpdateBadgeState;
  inFlight: boolean;
  download: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
} {
  const [state, setState] = useState<AppUpdateBadgeState>({ kind: "idle" });
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);
  const hasLiveStateRef = useRef(false);
  const installSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInstallSafetyTimer = useCallback(() => {
    if (installSafetyTimerRef.current === null) return;
    clearTimeout(installSafetyTimerRef.current);
    installSafetyTimerRef.current = null;
  }, []);

  const releaseInFlight = useCallback(() => {
    clearInstallSafetyTimer();
    inFlightRef.current = false;
    setInFlight(false);
  }, [clearInstallSafetyTimer]);

  const scheduleInstallSafetyRelease = useCallback(() => {
    clearInstallSafetyTimer();
    installSafetyTimerRef.current = setTimeout(() => {
      releaseInFlight();
    }, INSTALL_HANDOFF_SAFETY_RELEASE_MS);
  }, [clearInstallSafetyTimer, releaseInFlight]);

  useEffect(() => {
    let alive = true;
    hasLiveStateRef.current = false;
    const unsubscribe = api.onAppUpdateState((next) => {
      hasLiveStateRef.current = true;
      setState(next);
      // State broadcast = main process accepted (or progressed past) our last in-flight action. Clear the gate so subsequent
      // clicks (e.g., retry after error) are not silently blocked.
      if (inFlightRef.current) {
        releaseInFlight();
      }
    });
    void api
      .getAppUpdateState()
      .then((s) => {
        if (alive && !hasLiveStateRef.current) setState(s);
      })
      .catch(() => {
        /* state stays idle — non-fatal */
      });
    return () => {
      alive = false;
      clearInstallSafetyTimer();
      unsubscribe();
    };
  }, [api, clearInstallSafetyTimer, releaseInFlight]);

  const download = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await api.downloadAppUpdate();
      if (!result.ok) {
        releaseInFlight();
      }
    } catch {
      // Main-side logs warn; on rejection we release the gate so the user can retry. State broadcast normally clears this — only
      // matters on a hard IPC failure where no state change arrives.
      releaseInFlight();
    }
  }, [api, releaseInFlight]);

  const install = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await api.installAppUpdate();
      if (!result.ok) {
        // Unsigned macOS builds require manual installation; show the notice after main opens the release page.
        if (result.reason === "manual-install-required") {
          onNeedsManualInstall?.();
        }
        releaseInFlight();
        return;
      }
      // Keep the gate locked while the updater-owned shutdown handoff is expected to close the app. If the app remains alive,
      // release after a bounded delay so the badge cannot stay disabled forever.
      scheduleInstallSafetyRelease();
    } catch {
      releaseInFlight();
    }
  }, [api, releaseInFlight, scheduleInstallSafetyRelease, onNeedsManualInstall]);

  const skip = useCallback(async () => {
    if (inFlightRef.current) return;
    if (state.kind !== "available" && state.kind !== "downloaded") return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await api.skipAppUpdate();
      if (!result.ok) {
        releaseInFlight();
      }
    } catch {
      releaseInFlight();
    }
  }, [api, releaseInFlight, state.kind]);

  return { state, inFlight, download, install, skip };
}
