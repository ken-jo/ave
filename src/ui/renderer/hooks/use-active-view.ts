import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import { isInstanceViewKey, parseInlineViewKey, type InlineViewKey } from "../../../shared/view-key.js";

/** The pane model owns activeView; this hook owns only restoration and persistence. */
export interface ActiveViewPane {
  /** The focused pane's view. `activeView` IS this. */
  view: InlineViewKey;
  /** Show `next` in the focused pane. */
  navigate: (next: InlineViewKey) => void;
}

export interface UseActiveViewResult {
  /** Where the main window is — the focused pane's view. */
  activeView: InlineViewKey;
  /** Navigation before the initial read wins and persists immediately; suppressing that write would restore the discarded
   * location on next launch. */
  setActiveView: (next: InlineViewKey | ((current: InlineViewKey) => InlineViewKey)) => void;
  /** Monotonic restore counts distinguish launch arrivals from user navigation; history may replace only its untouched root
   * seed. */
  restoresApplied: number;
}

/** Wait for loaded plugin views before restoring a plugin key; navigation cancels pending view restore and persists
 * immediately. Deferred sign-in intent is not yet visible here, and settings-page restore has its own unresolved
 * navigation race. */
export function useActiveView(
  api: AveApi,
  /** View keys the app has actually loaded — `toViewKey` over `pluginViews`. */
  loadedPluginViewKeys: readonly string[],
  /** The focused pane — the location this hook restores into and persists from. */
  pane: ActiveViewPane,
): UseActiveViewResult {
  const activeView = pane.view;
  // The binding, as of the last render. Held in a ref so `setActiveView` and
  // the restore path keep ONE identity for the life of the app: the pane model
  // rebuilds `navigate` whenever pane content changes, and letting that reach
  // the callbacks would re-run the settings read on every navigation and hand
  // every dep-array-omitting call site a setter that no longer persists.
  const paneRef = useRef(pane);
  paneRef.current = pane;
  // Keep the navigation-discard flag in a ref so the setter stays stable and late settings continuations see current user
  // intent.
  const userNavigatedRef = useRef(false);
  // STATE: a consumer has to re-render to observe the restore's move, and it has to land in the SAME commit as the move
  // itself or the two would be observed as separate changes.
  const [restoresApplied, setRestoresApplied] = useState(0);
  // STATE, not a ref: the "has it loaded yet?" effect must re-run when EITHER
  // the pending key or the loaded list changes. Holding this in a ref made the
  // restore depend on the list changing AFTER the settings read resolved — with
  // the opposite ordering the effect had already run and nothing re-triggered
  // it, so a perfectly valid restore was silently dropped.
  const [pendingPluginView, setPendingPluginView] = useState<InlineViewKey | null>(null);
  // Mirror the current view outside state-updater callbacks so writes run once and same-tick navigations see each other.
  const activeViewRef = useRef<InlineViewKey>(activeView);
  activeViewRef.current = activeView;
  const applyView = useCallback((next: InlineViewKey) => {
    activeViewRef.current = next;
    paneRef.current.navigate(next);
  }, []);
  // The ONE way a restore moves the window. Both restore paths go through it, so the count cannot drift from the moves it
  // describes — and a future restore path declares itself by construction rather than by remembering.
  const restoreView = useCallback((next: InlineViewKey) => {
    setRestoresApplied((applied) => applied + 1);
    applyView(next);
  }, [applyView]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        // The user got here first. A stored location that arrives after someone
        // has chosen one is stale by definition: entering it would move the
        // window off their choice, and merely HOLDING it (the plugin arm below)
        // would do the same the moment the view list loaded.
        if (userNavigatedRef.current) return;
        const stored = settings?.system?.activeView;
        if (typeof stored !== "string") return;
        const parsed = parseInlineViewKey(stored);
        // Unparseable, or a key with no inline form: stay home, silently.
        if (!parsed) return;
        // Terminals and web pages are put back by the saved main layout (`use-main-layout.ts`), which knows which surface each
        // pane held; the bare view key does not, so it is not acted on here.
        if (isInstanceViewKey(parsed.key)) return;
        if (parsed.kind === "plugin") {
          setPendingPluginView(parsed.key);
          return;
        }
        restoreView(parsed.key);
      })
      .catch(() => {
        // Non-fatal: home is a valid place to be. The next navigation persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api, restoreView]);

  useEffect(() => {
    if (!pendingPluginView) return;
    // Not there (yet). Stay home and wait: if the list never gains this key — the plugin was uninstalled — home is where the
    // app stays.
    if (!loadedPluginViewKeys.includes(pendingPluginView)) return;
    setPendingPluginView(null);
    restoreView(pendingPluginView);
  }, [restoreView, loadedPluginViewKeys, pendingPluginView]);

  const setActiveView = useCallback(
    (next: InlineViewKey | ((current: InlineViewKey) => InlineViewKey)) => {
      // Read first-navigation status before setting its discard flag; every call represents a user destination or its deferred
      // replay.
      const firstNavigation = !userNavigatedRef.current;
      userNavigatedRef.current = true;
      // Retires a restore that already arrived and is waiting on its plugin list; the flag above is what stops one that has not
      // been read yet.
      setPendingPluginView(null);
      const current = activeViewRef.current;
      const resolved = typeof next === "function" ? next(current) : next;
      applyView(resolved);
      // Persist the first navigation even when it equals the current view, because cancelling restore does not prove that view
      // is already stored.
      if (resolved !== current || firstNavigation) {
        void api.updateSettings({ system: { activeView: resolved } });
      }
    },
    [api, applyView],
  );

  return { activeView, setActiveView, restoresApplied };
}
