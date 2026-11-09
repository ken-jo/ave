import { useSyncExternalStore } from "react";
import { parseSessionTabBindingsState, type BrowserTabControlState, type BrowserTabsApi, type SessionTabBindingsState } from "../../../shared/browser-surface.js";
import type { BrowserWorkspaceTab } from "../../../shared/browser-workspace.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

interface SessionBindingsStore {
  get(): SessionTabBindingsState | null;
  subscribe(listener: () => void): () => void;
}
const bindingStores = new WeakMap<BrowserTabsApi, SessionBindingsStore>();
const noSubscription = () => () => {};
const noBindings = () => null;

function sessionBindingsStore(api: BrowserTabsApi): SessionBindingsStore {
  const existing = bindingStores.get(api);
  if (existing) return existing;
  let state: SessionTabBindingsState | null = null;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  const listeners = new Set<() => void>();
  const store: SessionBindingsStore = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        const current = ++generation;
        const accept = (value: SessionTabBindingsState) => {
          const parsed = parseSessionTabBindingsState(value);
          if (current !== generation || !parsed || state && parsed.revision <= state.revision) return;
          state = parsed;
          for (const notify of listeners) notify();
        };
        unsubscribe = api.onSessionBindingsChanged(accept);
        void api.getSessionBindings().then(accept).catch((error: unknown) => {
          if (current === generation) console.warn("Session tab bindings unavailable.", error);
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        generation++;
        unsubscribe?.();
        unsubscribe = undefined;
        state = null;
      };
    },
  };
  bindingStores.set(api, store);
  return store;
}

/** One window subscription supplies host selection and sidebar ownership before pages are constructed. */
export function useSessionTabBindings(api: BrowserTabsApi | undefined): SessionTabBindingsState | null {
  const store = api ? sessionBindingsStore(api) : undefined;
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.get ?? noBindings, noBindings);
}

/** Explicit host ownership follows a tab across surfaces; control-only attribution stays local. */
export function selectSessionBrowserTabs(
  sessionId: string | null,
  workspaceTabs: readonly WorkspaceTab[],
  browserTabs: readonly BrowserWorkspaceTab[],
  control: BrowserTabControlState | null,
  agentControlledTabIds: ReadonlySet<string>,
): readonly BrowserWorkspaceTab[] {
  if (!sessionId) return [];
  const localIds = new Set(workspaceTabs.filter((tab) => tab.kind === "browser").map((tab) => tab.id));
  return browserTabs.filter((tab) => {
    const owner = control?.tabs.find((entry) => entry.rendererTabId === tab.tabId)?.owner;
    if (owner) return owner.sessionId === sessionId || owner.directParentSessionId === sessionId;
    return localIds.has(tab.tabId) && agentControlledTabIds.has(tab.tabId);
  });
}
