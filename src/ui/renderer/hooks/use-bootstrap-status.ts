import { useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type { AppBootstrapStatus } from "../../../shared/bootstrap-status.js";

/** Pull the recorded bootstrap snapshot for cold starts, but let live events outrank it; do not auto-clear results. */
export interface BootstrapStatusState {
  status: AppBootstrapStatus | null;
  /** True between `start` and a terminal (complete/error) event. */
  installing: boolean;
}

export function useBootstrapStatus(
  api: AveApi,
): BootstrapStatusState & { dismiss: () => void; retry: () => Promise<void> } {
  const [status, setStatus] = useState<AppBootstrapStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const liveEventRef = useRef(false);

  useEffect(() => {
    let alive = true;
    liveEventRef.current = false;
    // Subscribe first: an event emitted while the pull is in flight must be seen, and must be the one that survives.
    const unsubscribe = api.onBootstrapStatus((next) => {
      if (!alive) return;
      liveEventRef.current = true;
      setStatus(next);
      setInstalling(next.phase === "start");
    });
    void api
      .getBootstrapStatus()
      .then((snapshot) => {
        if (!alive || liveEventRef.current || !snapshot) return;
        setStatus(snapshot);
        setInstalling(snapshot.phase === "start");
      })
      .catch(() => {
        /* no snapshot — the subscription still covers every later event */
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  return {
    status,
    installing,
    dismiss: () => setStatus(null),
    // The host re-emits start/complete/error during the retry, so the hook doesn't need to mutate `status` itself — let the
    // IPC subscription drive the banner update.
    retry: async () => {
      try {
        await api.retryBootstrap();
      } catch {
        /* the host's error event will surface via onBootstrapStatus */
      }
    },
  };
}
