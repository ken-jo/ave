import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeBrowserNavigationUrl } from "./url-safety.js";
import { publishLiveWebTabs, withdrawLiveWebTabs } from "./web-surfaces.js";
import { parseTabId } from "../../../shared/tab-id.js";
import { isBrowserBlankBootstrap } from "../../../shared/browser-tools.js";
import { forgetActiveSurface } from "./active-surface.js";
import { terminalOrdinal } from "./terminal-ordinal.js";

/** Keep tab state above panel unmount; start empty, keep at most one reusable ephemeral content slot, and pin explicit
 * launcher tabs. */

export type WorkspaceTabKind =
  | "file-browser"
  | "preview"
  | "browser"
  | "terminal"
  | "subagent"
  // The conversation's tool activity — every plugin and tool call, in full. A container tab like `terminal`: it lists, it
  // does not point at one item.
  | "activity"
  // Side-chat kind is absent from the launcher until its independent conversation loop can provide a reachable body.
  | "side-chat";
export type WorkspaceTabMode = "ephemeral" | "pinned";

/** Identity source of a content tab. The content-tab `kind` is derived from the source (`browser` → browser viewer,
 * `preview` → preview-target viewer). */
export type WorkspaceTabContentRef =
  | { source: "preview"; targetId: string }
  | { source: "browser"; url: string };

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  ordinal: number;
  mode: WorkspaceTabMode;
  /** `null` = launcher container tab (always pinned); non-null = content tab. */
  content: WorkspaceTabContentRef | null;
  /** Set on a browser tab opened for the agent's `browser_tab_new`: main's request id, echoed on the tab's bind so main can
   * tell the agent opened it. */
  agentRequestId?: string;
}

export interface WorkspaceTabsStore {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  browserUrlByTab: Record<string, string>;
  setActiveTabId: (id: string) => void;
  /** Launcher: append a new pinned CONTAINER tab of the given kind and activate it. Never touches the ephemeral slot. Every
   * tab is closeable. */
  addTab: (kind: WorkspaceTabKind) => void;
  /** Programmatic launcher: activate the existing pinned CONTAINER tab of this kind, or create one if it does not exist. Used
   * by event-driven surfaces such as sub-agent spawns where repeated events must not duplicate tabs. */
  ensureContainerTab: (kind: WorkspaceTabKind) => void;
  /** Content routing (left-click). Opens `content` in the single ephemeral slot: reuse the tab already showing this content
   * (keeping its mode), else replace the existing ephemeral tab in-place, else append a new ephemeral tab. */
  openInEphemeral: (content: WorkspaceTabContentRef) => void;
  /** Content routing (double-click / open-and-keep). Opens `content` as a pinned tab: reuse (and promote) an existing tab for
   * this content, else append a new pinned tab. Never touches the ephemeral slot. */
  openPinned: (content: WorkspaceTabContentRef) => void;
  /** Promote a tab to pinned (double-click / pin button). Idempotent. */
  promoteToPinned: (id: string) => void;
  /** Prune session-scoped content targets on switch; URL content and launcher containers remain valid across sessions. */
  pruneContentTabs: (isResolvable: (targetId: string) => boolean) => void;
  closeTab: (id: string) => void;
  /** Close the launcher container tab of this kind, if one is open. */
  closeContainerTab: (kind: WorkspaceTabKind) => void;
  /** Set (or clear, with `null`) the manually-typed address for a browser tab. */
  setBrowserTabUrl: (tabId: string, url: string | null) => void;
  /** Hand a tab out to the main area. The tab leaves this store WITHOUT being closed: its PTY or page lives on under the same
   * id wherever it lands. */
  releaseTab: (id: string) => WorkspaceTab | undefined;
  /** Take in a tab that moved here (from the main area), as a pinned container tab with its id and number unchanged, and make
   * it the active one. A browser tab's page keeps its address through `url`. */
  adoptTab: (tab: Pick<WorkspaceTab, "id" | "kind" | "ordinal">, url: string | null) => void;
  /** Whether this store holds `id` now (read from the latest state, not a render). */
  hasTab: (id: string) => boolean;
  /** Open a NEW pinned browser tab for the agent (`browser_tab_new`) and activate it. Never reuses a tab showing the same
   * url: the agent gets a tab of its own. Returns the new tab's id, or null for an unsafe url. */
  openAgentBrowserTab: (url: string, agentRequestId: string, active: boolean) => string | null;
}

function contentKey(ref: WorkspaceTabContentRef): string {
  return ref.source === "browser" ? `browser:${ref.url}` : `preview:${ref.targetId}`;
}

/**
 * Validate/normalize a content ref at the store boundary. Browser urls pass
 * through the url-safety SOT validator (rejects non-http(s) / credential-laden
 * urls, prepends https:// when scheme-less) so the store cannot hold an unsafe
 * url — this is the defense-in-depth the url-safety header advertises. Preview
 * refs pass through unchanged. `null` means "reject; do not open".
 */
function normalizeContentRef(ref: WorkspaceTabContentRef): WorkspaceTabContentRef | null {
  if (ref.source !== "browser") return ref;
  const url = normalizeBrowserNavigationUrl(ref.url);
  return url ? { source: "browser", url } : null;
}

function contentKind(ref: WorkspaceTabContentRef): WorkspaceTabKind {
  return ref.source === "browser" ? "browser" : "preview";
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  browserUrlByTab: Record<string, string>;
}

const EMPTY_STATE: WorkspaceState = { tabs: [], activeTabId: null, browserUrlByTab: {} };

/**
 * Tab ids are minted from ONE counter per renderer (= per window), not per
 * store. Every chat group mounts its own store, but main keys live resources
 * by tab id across the whole window — the PTY map in `pty-manager.ts` is
 * global — so a per-store counter let a second group's `terminal:1` attach to
 * the first group's shell. Window-unique ids also let a tab move between the
 * side panel and the main area without being renamed.
 */
let nextWindowTabId = 1;
// Unique to this renderer — this window, this launch (`shared/tab-id.ts`).
const WINDOW_TAB_SCOPE = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("");

export function mintTabId(kind: WorkspaceTabKind): string {
  return `${kind}:${WINDOW_TAB_SCOPE}-${nextWindowTabId++}`;
}

/** Whether this window minted `id` in this launch (so its absence means it was closed or moved, not lost). */
export function isTabIdOfThisLaunch(id: string): boolean {
  return parseTabId(id)?.scope === WINDOW_TAB_SCOPE;
}

/** Tabs restored from a saved layout keep their ids. Ids from another scope (an earlier launch) cannot meet this one's; one
 * from this scope moves the counter past it, so a tab minted afterwards cannot take it. */
export function reserveTabIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const parsed = parseTabId(id);
    if (parsed && parsed.scope === WINDOW_TAB_SCOPE && parsed.n >= nextWindowTabId) nextWindowTabId = parsed.n + 1;
  }
}

function withTabClosed(prev: WorkspaceState, id: string): WorkspaceState {
  const closingIndex = prev.tabs.findIndex((tab) => tab.id === id);
  if (closingIndex < 0) return prev;
  const tabs = prev.tabs.filter((tab) => tab.id !== id);
  let activeTabId = prev.activeTabId;
  if (activeTabId === id) {
    // Fall back to the tab before the closed one; empties → null (launcher).
    const fallback = tabs[Math.max(0, closingIndex - 1)] ?? tabs[0] ?? null;
    activeTabId = fallback ? fallback.id : null;
  }
  const browserUrlByTab = { ...prev.browserUrlByTab };
  delete browserUrlByTab[id];
  return { tabs, activeTabId, browserUrlByTab };
}

export function useWorkspaceTabs(): WorkspaceTabsStore {
  const [state, setState] = useState<WorkspaceState>(EMPTY_STATE);
  // The committed state, for `releaseTab`, which must answer in the same event.
  const stateRef = useRef(state);
  stateRef.current = state;
  const previousTabsRef = useRef(state.tabs);
  const releasedTabIdsRef = useRef(new Set<string>());
  // Retire surfaces from committed lists, including batched closes and replacements. A release transfers the surface to
  // another store.
  useEffect(() => {
    const nextKinds = new Map(state.tabs.map((tab) => [tab.id, tab.kind]));
    for (const tab of previousTabsRef.current) {
      if ((tab.kind === "browser" || tab.kind === "terminal") && nextKinds.get(tab.id) !== tab.kind) {
        if (!releasedTabIdsRef.current.delete(tab.id)) forgetActiveSurface(tab.id);
      }
    }
    previousTabsRef.current = state.tabs;
  }, [state.tabs]);
  const nextOrdinalRef = useRef<Record<Exclude<WorkspaceTabKind, "terminal">, number>>({
    "file-browser": 1,
    preview: 1,
    browser: 1,
    subagent: 1,
    activity: 1,
    "side-chat": 1,
  });

  // The browser tabs this store holds keep their guests alive in the window's web-surface layer; a tab that leaves the store
  // (closed, pruned, replaced by other content) lets its guest go.
  const [liveSource] = useState(() => Symbol("workspace-tabs"));
  const liveBrowserKey = state.tabs.filter((tab) => tab.kind === "browser").map((tab) => tab.id).join("\n");
  useEffect(() => {
    publishLiveWebTabs(liveSource, new Set(liveBrowserKey ? liveBrowserKey.split("\n") : []));
  }, [liveSource, liveBrowserKey]);
  useEffect(() => () => withdrawLiveWebTabs(liveSource), [liveSource]);

  const setActiveTabId = useCallback((id: string) => {
    setState((prev) => (prev.activeTabId === id ? prev : { ...prev, activeTabId: id }));
  }, []);

  const addTab = useCallback((kind: WorkspaceTabKind) => {
    setState((prev) => {
      const id = mintTabId(kind);
      const ordinal = kind === "terminal" ? terminalOrdinal(id) : nextOrdinalRef.current[kind]++;
      const tab: WorkspaceTab = { id, kind, ordinal, mode: "pinned", content: null };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const ensureContainerTab = useCallback((kind: WorkspaceTabKind) => {
    setState((prev) => {
      const existing = prev.tabs.find((tab) => tab.kind === kind && tab.content === null);
      if (existing) {
        return prev.activeTabId === existing.id ? prev : { ...prev, activeTabId: existing.id };
      }
      const id = mintTabId(kind);
      const ordinal = kind === "terminal" ? terminalOrdinal(id) : nextOrdinalRef.current[kind]++;
      const tab: WorkspaceTab = { id, kind, ordinal, mode: "pinned", content: null };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const openInEphemeral = useCallback((rawContent: WorkspaceTabContentRef) => {
    const content = normalizeContentRef(rawContent);
    if (!content) return;
    const key = contentKey(content);
    const kind = contentKind(content);
    setState((prev) => {
      // R1: a tab already shows this content — activate it, keep its mode.
      const existing = prev.tabs.find((tab) => tab.content && contentKey(tab.content) === key);
      if (existing) {
        return prev.activeTabId === existing.id ? prev : { ...prev, activeTabId: existing.id };
      }
      // R2: replace the single ephemeral slot in-place (same id / position).
      const ephemeral = prev.tabs.find((tab) => tab.mode === "ephemeral");
      if (ephemeral) {
        const browserUrlByTab = { ...prev.browserUrlByTab };
        delete browserUrlByTab[ephemeral.id];
        return {
          tabs: prev.tabs.map((tab) =>
            tab.id === ephemeral.id ? { ...tab, kind, content, mode: "ephemeral" } : tab,
          ),
          activeTabId: ephemeral.id,
          browserUrlByTab,
        };
      }
      // R3: no ephemeral slot — append a new ephemeral content tab.
      const id = mintTabId(kind);
      const tab: WorkspaceTab = { id, kind, ordinal: 0, mode: "ephemeral", content };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const openPinned = useCallback((rawContent: WorkspaceTabContentRef) => {
    const content = normalizeContentRef(rawContent);
    if (!content) return;
    const key = contentKey(content);
    const kind = contentKind(content);
    setState((prev) => {
      // R1: reuse an existing tab for this content, promoting it if ephemeral.
      const existing = prev.tabs.find((tab) => tab.content && contentKey(tab.content) === key);
      if (existing) {
        return {
          ...prev,
          tabs: prev.tabs.map((tab) => (tab.id === existing.id ? { ...tab, mode: "pinned" } : tab)),
          activeTabId: existing.id,
        };
      }
      // R4: append a new pinned content tab; leave the ephemeral slot alone.
      const id = mintTabId(kind);
      const tab: WorkspaceTab = { id, kind, ordinal: 0, mode: "pinned", content };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const promoteToPinned = useCallback((id: string) => {
    setState((prev) => {
      const target = prev.tabs.find((tab) => tab.id === id);
      if (!target || target.mode === "pinned") return prev;
      return {
        ...prev,
        tabs: prev.tabs.map((tab) => (tab.id === id ? { ...tab, mode: "pinned" } : tab)),
      };
    });
  }, []);

  const pruneContentTabs = useCallback((isResolvable: (targetId: string) => boolean) => {
    setState((prev) => {
      const tabs = prev.tabs.filter((tab) =>
        tab.content?.source === "preview" ? isResolvable(tab.content.targetId) : true,
      );
      if (tabs.length === prev.tabs.length) return prev;
      const survivingIds = new Set(tabs.map((tab) => tab.id));
      let activeTabId = prev.activeTabId;
      if (activeTabId != null && !survivingIds.has(activeTabId)) {
        // Active tab was pruned — fall back to the last survivor (or launcher).
        activeTabId = tabs.at(-1)?.id ?? null;
      }
      const browserUrlByTab: Record<string, string> = {};
      for (const [tabId, url] of Object.entries(prev.browserUrlByTab)) {
        if (survivingIds.has(tabId)) browserUrlByTab[tabId] = url;
      }
      return { tabs, activeTabId, browserUrlByTab };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((prev) => withTabClosed(prev, id));
  }, []);

  const closeContainerTab = useCallback((kind: WorkspaceTabKind) => {
    setState((prev) => {
      const container = prev.tabs.find((tab) => tab.kind === kind && tab.content === null);
      return container ? withTabClosed(prev, container.id) : prev;
    });
  }, []);

  const openAgentBrowserTab = useCallback((rawUrl: string, agentRequestId: string, active: boolean): string | null => {
    const content: WorkspaceTabContentRef | null = isBrowserBlankBootstrap(rawUrl, agentRequestId)
      ? { source: "browser", url: rawUrl }
      : normalizeContentRef({ source: "browser", url: rawUrl });
    if (!content) return null;
    // The id is taken here, outside the updater: an updater runs at flush time, and the caller needs the id now.
    const id = mintTabId("browser");
    const tab: WorkspaceTab = { id, kind: "browser", ordinal: 0, mode: "pinned", content, agentRequestId };
    setState((prev) => ({ ...prev, tabs: [...prev.tabs, tab], activeTabId: active ? id : prev.activeTabId }));
    return id;
  }, []);

  const setBrowserTabUrl = useCallback((tabId: string, url: string | null) => {
    setState((prev) => {
      if (url == null) {
        if (!(tabId in prev.browserUrlByTab)) return prev;
        const browserUrlByTab = { ...prev.browserUrlByTab };
        delete browserUrlByTab[tabId];
        return { ...prev, browserUrlByTab };
      }
      return { ...prev, browserUrlByTab: { ...prev.browserUrlByTab, [tabId]: url } };
    });
  }, []);

  const releaseTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((each) => each.id === id);
    if (!tab) return undefined;
    releasedTabIdsRef.current.add(id);
    setState((prev) => withTabClosed(prev, id));
    return tab;
  }, []);

  const hasTab = useCallback((id: string) => stateRef.current.tabs.some((tab) => tab.id === id), []);

  const adoptTab = useCallback((incoming: Pick<WorkspaceTab, "id" | "kind" | "ordinal">, url: string | null) => {
    releasedTabIdsRef.current.delete(incoming.id);
    // A tab that keeps its number here must not see a later tab of its kind take it again.
    if (incoming.kind !== "terminal" && nextOrdinalRef.current[incoming.kind] <= incoming.ordinal) nextOrdinalRef.current[incoming.kind] = incoming.ordinal + 1;
    setState((prev) => {
      if (prev.tabs.some((tab) => tab.id === incoming.id)) return { ...prev, activeTabId: incoming.id };
      const ordinal = incoming.kind === "terminal" ? terminalOrdinal(incoming.id, incoming.ordinal) : incoming.ordinal;
      const tab: WorkspaceTab = { id: incoming.id, kind: incoming.kind, ordinal, mode: "pinned", content: null };
      return {
        tabs: [...prev.tabs, tab],
        activeTabId: tab.id,
        browserUrlByTab: url ? { ...prev.browserUrlByTab, [tab.id]: url } : prev.browserUrlByTab,
      };
    });
  }, []);

  return useMemo(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      browserUrlByTab: state.browserUrlByTab,
      setActiveTabId,
      addTab,
      ensureContainerTab,
      openInEphemeral,
      openPinned,
      promoteToPinned,
      pruneContentTabs,
      closeTab,
      closeContainerTab,
      setBrowserTabUrl,
      releaseTab,
      adoptTab,
      hasTab,
      openAgentBrowserTab,
    }),
    [state, setActiveTabId, addTab, ensureContainerTab, openInEphemeral, openPinned, promoteToPinned, pruneContentTabs, closeTab, setBrowserTabUrl, releaseTab, adoptTab, hasTab, openAgentBrowserTab],
  );
}
