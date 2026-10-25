import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxCapabilityInfo } from "../../../shared/sandbox-capability-info.js";
import type { AveApi } from "../types.js";

const CAPABILITY_QUERY_ATTEMPTS = 3;
const CAPABILITY_QUERY_RETRY_MS = 1_000;

/** Read the host snapshot; a failed query is uncertainty, never an execution plan. */
export function useSandboxCapability(
  permission: Pick<AveApi["permission"], "sandboxCapability"> | undefined,
  subscribeToSettings?: AveApi["onSettingsUpdated"],
) {
  const [capability, setCapability] = useState<SandboxCapabilityInfo | null>(null);
  const [statusQueryFailed, setStatusQueryFailed] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async (): Promise<SandboxCapabilityInfo | null> => {
    const current = ++generation.current;
    clearTimeout(retryTimer.current);
    let attempts = 0;
    const query = async (): Promise<SandboxCapabilityInfo | null> => {
      attempts += 1;
      try {
        if (typeof permission?.sandboxCapability !== "function") throw new Error("Sandbox capability query unavailable");
        const next = await permission.sandboxCapability();
        if (mounted.current && current === generation.current) {
          setCapability(next);
          setStatusQueryFailed(false);
        }
        return next;
      } catch {
        if (mounted.current && current === generation.current) {
          setStatusQueryFailed(true);
          if (attempts < CAPABILITY_QUERY_ATTEMPTS) {
            retryTimer.current = setTimeout(() => { void query(); }, CAPABILITY_QUERY_RETRY_MS);
          }
        }
        return null;
      }
    };
    return query();
  }, [permission]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeToSettings?.(() => { void refresh(); });
    return () => {
      mounted.current = false;
      generation.current += 1;
      clearTimeout(retryTimer.current);
      unsubscribe?.();
    };
  }, [refresh, subscribeToSettings]);

  return { capability, statusQueryFailed, refresh };
}
