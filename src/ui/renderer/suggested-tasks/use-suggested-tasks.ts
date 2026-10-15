/**
 * Installation point and loader for suggested tasks.
 *
 * `SuggestedTasksProviderContext` is where a provider is chosen. Its default
 * is the static provider, so no wiring is needed today; a future app-level
 * `<SuggestedTasksProviderContext.Provider value={merged}>` swaps or merges in
 * another source without the empty-state UI changing.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { staticSuggestedTasksProvider, type SuggestedTask, type SuggestedTasksProvider } from "./provider.js";

export const SuggestedTasksProviderContext = createContext<SuggestedTasksProvider>(staticSuggestedTasksProvider);

type SuggestedTasksState =
  | { status: "loading" }
  | { status: "ready"; tasks: readonly SuggestedTask[] }
  | { status: "error" };

export interface UseSuggestedTasksResult {
  state: SuggestedTasksState;
  /** Ask the provider again (after an error). */
  reload: () => void;
}

/**
 * Load suggestions while `enabled`. A request is aborted and its result
 * ignored when it is superseded (locale or provider change, disable, unmount),
 * so a slow provider can never paint stale cards over a newer answer.
 */
export function useSuggestedTasks(enabled: boolean): UseSuggestedTasksResult {
  const provider = useContext(SuggestedTasksProviderContext);
  const { locale, t } = useTranslation();
  const [state, setState] = useState<SuggestedTasksState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    provider
      .list({ locale, t, signal: controller.signal })
      .then((tasks) => {
        if (!controller.signal.aborted) setState({ status: "ready", tasks });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn(`[suggested-tasks] provider "${provider.id}" failed`, err);
        setState({ status: "error" });
      });
    return () => controller.abort();
    // `t` is deliberately absent: it follows `locale`, and its identity can
    // change on unrelated re-renders, which would refetch for nothing.
  }, [enabled, provider, locale, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
