// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceTabs } from "../workspace-tabs.js";
import { useMainSurfaces, type MainSurface } from "../main-surfaces.js";
import { clearActiveSurface, getActiveSurface, showActiveSurface } from "../active-surface.js";

describe("useWorkspaceTabs", () => {
  it("gives terminals distinct numbers across main and side stores while preserving moves", () => {
    const main = renderHook(() => useMainSurfaces());
    const sideA = renderHook(() => useWorkspaceTabs());
    const sideB = renderHook(() => useWorkspaceTabs());
    let surface!: MainSurface;
    act(() => { surface = main.result.current.create("terminal"); });
    act(() => sideA.result.current.addTab("terminal"));
    act(() => sideB.result.current.ensureContainerTab("terminal"));
    const terminals = [surface.ordinal, sideA.result.current.tabs[0]!.ordinal, sideB.result.current.tabs[0]!.ordinal];
    expect(new Set(terminals).size).toBe(3);
    expect(new Set([surface.tabId, sideA.result.current.tabs[0]!.id, sideB.result.current.tabs[0]!.id]).size).toBe(3);
    act(() => { main.result.current.release(surface.tabId); });
    act(() => sideA.result.current.adoptTab({ id: surface.tabId, kind: "terminal", ordinal: surface.ordinal }, null));
    expect(sideA.result.current.tabs.find((tab) => tab.id === surface.tabId)?.ordinal).toBe(surface.ordinal);
  });

  it("repairs colliding restored terminal numbers across stores before displaying them", () => {
    const main = renderHook(() => useMainSurfaces());
    const side = renderHook(() => useWorkspaceTabs());
    const tabId = "terminal:restored-main";
    act(() => main.result.current.adopt({ tabId, kind: "terminal", ordinal: 1, url: null }));
    act(() => side.result.current.adoptTab({ id: "terminal:restored-side", kind: "terminal", ordinal: 1 }, null));
    expect(main.result.current.get(tabId)?.ordinal).not.toBe(side.result.current.tabs[0]!.ordinal);
    const restoredOrdinal = side.result.current.tabs[0]!.ordinal;
    act(() => side.result.current.addTab("terminal"));
    expect(side.result.current.tabs[1]!.ordinal).toBeGreaterThan(restoredOrdinal);
  });

  it.each(["tab", "container"])("forgets the active surface on a store-level %s close", (method) => {
    const { result, unmount } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const tabId = result.current.activeTabId!;
    showActiveSurface({ kind: "browser", tabId, label: "Browser 1" });
    try {
      act(() => {
        if (method === "tab") result.current.closeTab(tabId);
        else result.current.closeContainerTab("browser");
      });
      expect(result.current.tabs).toHaveLength(0);
      expect(getActiveSurface()).toBeNull();
    } finally {
      unmount();
      clearActiveSurface();
    }
  });

  it("forgets a browser surface when its ephemeral tab is replaced by preview content", () => {
    const { result, unmount } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral({ source: "browser", url: "https://a.example/" }));
    const tabId = result.current.activeTabId!;
    showActiveSurface({ kind: "browser", tabId, label: "Page" });
    try {
      act(() => result.current.openInEphemeral({ source: "preview", targetId: "preview:1" }));
      expect(result.current.activeTabId).toBe(tabId);
      expect(result.current.tabs[0]?.kind).toBe("preview");
      expect(getActiveSurface()).toBeNull();
    } finally {
      unmount();
      clearActiveSurface();
    }
  });

  it("forgets a browser surface replaced after a matching preview tab closes in the same batch", () => {
    const { result, unmount } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openPinned({ source: "preview", targetId: "preview:1" }));
    const previewId = result.current.activeTabId!;
    act(() => result.current.openInEphemeral({ source: "browser", url: "https://a.example/" }));
    const tabId = result.current.activeTabId!;
    showActiveSurface({ kind: "browser", tabId, label: "Page" });
    try {
      act(() => {
        result.current.closeTab(previewId);
        result.current.openInEphemeral({ source: "preview", targetId: "preview:1" });
      });
      expect(result.current.tabs).toEqual([expect.objectContaining({ id: tabId, kind: "preview" })]);
      expect(getActiveSurface()).toBeNull();
    } finally {
      unmount();
      clearActiveSurface();
    }
  });

  it("preserves the active surface when releasing it to another store", () => {
    const { result, unmount } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const tabId = result.current.activeTabId!;
    const surface = { kind: "browser" as const, tabId, label: "Browser 1" };
    showActiveSurface(surface);
    try {
      act(() => { result.current.releaseTab(tabId); });
      expect(result.current.tabs).toHaveLength(0);
      expect(getActiveSurface()).toEqual(surface);
    } finally {
      unmount();
      clearActiveSurface();
    }
  });

  it("preserves a surface released before the preceding render's passive effects run", () => {
    const { result, unmount } = renderHook(() => {
      const store = useWorkspaceTabs();
      useLayoutEffect(() => {
        if (store.tabs.length !== 2) return;
        const browser = store.tabs.find((tab) => tab.kind === "browser");
        if (browser) store.releaseTab(browser.id);
      }, [store.tabs, store.releaseTab]);
      return store;
    });
    act(() => result.current.addTab("browser"));
    const surface = { kind: "browser" as const, tabId: result.current.activeTabId!, label: "Browser 1" };
    showActiveSurface(surface);
    try {
      act(() => result.current.addTab("preview"));
      expect(result.current.tabs).toEqual([expect.objectContaining({ kind: "preview" })]);
      expect(getActiveSurface()).toEqual(surface);
    } finally {
      unmount();
      clearActiveSurface();
    }
  });

  it("forgets a closed surface even when it was released and readopted in one batch", () => {
    const { result, unmount } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const browser = result.current.tabs[0]!;
    showActiveSurface({ kind: "browser", tabId: browser.id, label: "Browser 1" });
    try {
      act(() => {
        result.current.releaseTab(browser.id);
        result.current.adoptTab(browser, "https://a.example/");
      });
      act(() => result.current.closeTab(browser.id));
      expect(result.current.tabs).toHaveLength(0);
      expect(getActiveSurface()).toBeNull();
    } finally {
      unmount();
      clearActiveSurface();
    }
  });

  it("starts empty (no default tabs) with no active tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });

  it("addTab appends a tab of the kind and activates it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const added = result.current.tabs.at(-1)!;
    expect(added.kind).toBe("browser");
    expect(added.ordinal).toBe(1);
    expect(result.current.activeTabId).toBe(added.id);
  });

  it("addTab supports the preview kind (launcher 'review')", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("preview"));
    const added = result.current.tabs.at(-1)!;
    expect(added.kind).toBe("preview");
    expect(result.current.activeTabId).toBe(added.id);
  });

  it("addTab supports the subagent kind (launcher 'sub-agents')", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("subagent"));
    const added = result.current.tabs.at(-1)!;
    expect(added.kind).toBe("subagent");
    expect(added.ordinal).toBe(1);
    expect(result.current.activeTabId).toBe(added.id);
  });

  it("ensureContainerTab reuses an existing container tab and activates it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.ensureContainerTab("subagent"));
    const subagentId = result.current.activeTabId!;
    act(() => result.current.addTab("terminal"));
    expect(result.current.activeTabId).not.toBe(subagentId);
    act(() => result.current.ensureContainerTab("subagent"));
    expect(result.current.tabs.filter((tab) => tab.kind === "subagent" && tab.content === null)).toHaveLength(1);
    expect(result.current.activeTabId).toBe(subagentId);
  });

  it("addTab assigns per-kind ordinals and unique ids", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    act(() => result.current.addTab("terminal"));
    act(() => result.current.addTab("browser"));
    expect(result.current.tabs.map((tab) => tab.kind)).toEqual(["browser", "terminal", "browser"]);
    expect(result.current.tabs.filter((tab) => tab.kind === "browser").map((tab) => tab.ordinal)).toEqual([1, 2]);
    expect(result.current.tabs[1]!.ordinal).toBeGreaterThan(0);
    const ids = result.current.tabs.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mints tab ids that are unique across every store in the window", () => {
    // One store per chat group; main keys PTYs (and guests) by tab id globally.
    const groupA = renderHook(() => useWorkspaceTabs());
    const groupB = renderHook(() => useWorkspaceTabs());
    act(() => groupA.result.current.addTab("terminal"));
    act(() => groupB.result.current.addTab("terminal"));
    act(() => groupA.result.current.openInEphemeral({ source: "browser", url: "https://example.com" }));
    act(() => groupB.result.current.openPinned({ source: "browser", url: "https://example.com" }));
    const ids = [...groupA.result.current.tabs, ...groupB.result.current.tabs].map((tab) => tab.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^(terminal|browser):[0-9a-f]{8}-\d+$/);
  });

  it("closeTab removes the tab and falls back to the previous tab when closing the active one", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    act(() => result.current.addTab("terminal"));
    const firstId = result.current.tabs[0]!.id;
    const activeId = result.current.activeTabId!;
    act(() => result.current.closeTab(activeId));
    expect(result.current.tabs.some((tab) => tab.id === activeId)).toBe(false);
    // Fallback = the tab before the closed one.
    expect(result.current.activeTabId).toBe(firstId);
  });

  it("closeContainerTab closes the launcher tab of that kind and leaves content tabs alone", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("terminal"));
    act(() => result.current.ensureContainerTab("subagent"));
    act(() => result.current.closeContainerTab("subagent"));
    expect(result.current.tabs.map((tab) => tab.kind)).toEqual(["terminal"]);
    expect(result.current.activeTabId).toBe(result.current.tabs[0]!.id);
    // Nothing of the kind open: the state is untouched (same reference).
    const before = result.current.tabs;
    act(() => result.current.closeContainerTab("subagent"));
    expect(result.current.tabs).toBe(before);
  });

  it("closing the last tab empties the workspace (no never-empty guard) and clears the active tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("file-browser"));
    const onlyId = result.current.tabs[0]!.id;
    act(() => result.current.closeTab(onlyId));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });

  it("setBrowserTabUrl sets and clears the per-tab manual url, and closeTab drops it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const tabId = result.current.activeTabId!;
    act(() => result.current.setBrowserTabUrl(tabId, "https://example.com/"));
    expect(result.current.browserUrlByTab[tabId]).toBe("https://example.com/");
    act(() => result.current.setBrowserTabUrl(tabId, null));
    expect(tabId in result.current.browserUrlByTab).toBe(false);
    act(() => result.current.setBrowserTabUrl(tabId, "https://again.example/"));
    act(() => result.current.closeTab(tabId));
    expect(tabId in result.current.browserUrlByTab).toBe(false);
  });

  it("addTab creates a pinned container tab (content null)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("terminal"));
    const tab = result.current.tabs.at(-1)!;
    expect(tab.mode).toBe("pinned");
    expect(tab.content).toBeNull();
  });

  const A = { source: "preview", targetId: "a" } as const;
  const B = { source: "browser", url: "https://b.example/" } as const;

  const ephemeralCount = (tabs: { mode: string }[]) => tabs.filter((t) => t.mode === "ephemeral").length;

  it("openInEphemeral opens a single ephemeral content tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    expect(result.current.tabs).toHaveLength(1);
    const tab = result.current.tabs[0]!;
    expect(tab.mode).toBe("ephemeral");
    expect(tab.content).toEqual(A);
    expect(result.current.activeTabId).toBe(tab.id);
  });

  it("openInEphemeral replaces the ephemeral slot in place (no second ephemeral)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    const firstId = result.current.tabs[0]!.id;
    act(() => result.current.openInEphemeral(B));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]!.id).toBe(firstId);
    expect(result.current.tabs[0]!.content).toEqual(B);
    expect(result.current.tabs[0]!.mode).toBe("ephemeral");
  });

  it("openInEphemeral of the same content re-activates without creating a tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.openInEphemeral(A));
    expect(result.current.tabs).toHaveLength(1);
  });

  it("promoteToPinned frees the ephemeral slot so the next open appends", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    const id = result.current.tabs[0]!.id;
    act(() => result.current.promoteToPinned(id));
    expect(result.current.tabs[0]!.mode).toBe("pinned");
    act(() => result.current.openInEphemeral(B));
    expect(result.current.tabs).toHaveLength(2);
    expect(ephemeralCount(result.current.tabs)).toBe(1);
  });

  it("openPinned appends a pinned tab and leaves the ephemeral slot untouched", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.openPinned(B));
    expect(result.current.tabs).toHaveLength(2);
    expect(ephemeralCount(result.current.tabs)).toBe(1);
  });

  it("openPinned of existing ephemeral content promotes it (no new tab)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.openPinned(A));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]!.mode).toBe("pinned");
  });

  it("openInEphemeral of pinned content keeps it pinned (no demote)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openPinned(A));
    act(() => result.current.openInEphemeral(A));
    expect(result.current.tabs[0]!.mode).toBe("pinned");
  });

  it("replacing an ephemeral browser tab drops its manual url", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(B));
    const id = result.current.tabs[0]!.id;
    act(() => result.current.setBrowserTabUrl(id, "https://manual.example/"));
    act(() => result.current.openInEphemeral(A));
    expect(id in result.current.browserUrlByTab).toBe(false);
  });

  it("keeps at most one ephemeral tab across a mixed sequence (invariant)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.addTab("terminal"));
    act(() => result.current.openInEphemeral(B));
    act(() => result.current.openPinned({ source: "preview", targetId: "c" }));
    act(() => result.current.openInEphemeral({ source: "preview", targetId: "d" }));
    expect(ephemeralCount(result.current.tabs)).toBeLessThanOrEqual(1);
  });

  describe("url-safety at the store boundary", () => {
    it("opens background agent tabs without changing the user's selected surface", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.addTab("terminal"));
      const selected = result.current.activeTabId;
      act(() => result.current.openAgentBrowserTab("https://a.example/", "background-op", false));
      expect(result.current.activeTabId).toBe(selected);
      expect(result.current.tabs).toHaveLength(2);
    });
    it("opens an exact blank bootstrap only with an agent request id", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      let tabId: string | null = null;
      act(() => {
        tabId = result.current.openAgentBrowserTab("about:blank", "browser-op-blank", true);
      });
      expect(tabId).not.toBeNull();
      expect(result.current.tabs).toEqual([expect.objectContaining({
        id: tabId,
        content: { source: "browser", url: "about:blank" },
        agentRequestId: "browser-op-blank",
      })]);
    });

    it.each(["", " "])("rejects a blank bootstrap without a non-empty request id (%j)", (requestId) => {
      const { result } = renderHook(() => useWorkspaceTabs());
      let tabId: string | null = "unset";
      act(() => {
        tabId = result.current.openAgentBrowserTab("about:blank", requestId, true);
      });
      expect(tabId).toBeNull();
      expect(result.current.tabs).toEqual([]);
    });

    it.each(["about:blank#fragment", "about:blank?script=1", "ABOUT:blank", " about:blank ", "javascript:alert(1)", "data:text/html,<script>1</script>"])("refuses a non-exact agent bootstrap URL (%s)", (url) => {
      const { result } = renderHook(() => useWorkspaceTabs());
      let tabId: string | null = "unset";
      act(() => {
        tabId = result.current.openAgentBrowserTab(url, "browser-op-blank", true);
      });
      expect(tabId).toBeNull();
      expect(result.current.tabs).toEqual([]);
    });

    it("keeps blank bootstraps out of ordinary content opening", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.openPinned({ source: "browser", url: "about:blank" }));
      act(() => result.current.openInEphemeral({ source: "browser", url: "about:blank" }));
      expect(result.current.tabs).toEqual([]);
    });

    it("openInEphemeral rejects a browser url carrying credentials", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.openInEphemeral({ source: "browser", url: "https://user:pass@evil.example/" }));
      expect(result.current.tabs).toEqual([]);
    });

    it("openPinned rejects a non-http(s) browser url", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.openPinned({ source: "browser", url: "ftp://files.example/" }));
      expect(result.current.tabs).toEqual([]);
    });

    it("openInEphemeral normalizes a scheme-less browser url via the SOT validator", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.openInEphemeral({ source: "browser", url: "example.com" }));
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0]!.content).toEqual({ source: "browser", url: "https://example.com/" });
    });
  });

  describe("pruneContentTabs (session switch)", () => {
    it("keeps a preview-content tab whose target still resolves", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.openPinned({ source: "preview", targetId: "keep-me" }));
      act(() => result.current.pruneContentTabs((id) => id === "keep-me"));
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0]!.content).toEqual({ source: "preview", targetId: "keep-me" });
    });

    it("does not leak session A preview-content tabs into session B, while browser + container tabs persist", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      // Session A workspace: a preview-content tab (session-scoped target id), a browser-content tab (self-contained url), and a
      // launcher container tab.
      act(() => result.current.openPinned({ source: "preview", targetId: "search-hit:tA:/a.md:" }));
      act(() => result.current.openPinned({ source: "browser", url: "https://kept.example/" }));
      act(() => result.current.addTab("terminal"));
      const previewTabId = result.current.tabs.find((tab) => tab.content?.source === "preview")!.id;

      // Switch to session B: only B's targets resolve; A's preview id is gone.
      act(() => result.current.pruneContentTabs((id) => id === "json:tB"));

      expect(result.current.tabs.some((tab) => tab.id === previewTabId)).toBe(false);
      expect(result.current.tabs.some((tab) => tab.content?.source === "preview")).toBe(false);
      expect(result.current.tabs.some((tab) => tab.content?.source === "browser")).toBe(true);
      expect(result.current.tabs.some((tab) => tab.content === null)).toBe(true);
      expect(result.current.tabs).toHaveLength(2);
    });

    it("re-points the active tab when the active tab was pruned", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.openPinned({ source: "preview", targetId: "a" }));
      act(() => result.current.addTab("terminal"));
      const previewTabId = result.current.tabs.find((tab) => tab.content?.source === "preview")!.id;
      act(() => result.current.setActiveTabId(previewTabId));
      expect(result.current.activeTabId).toBe(previewTabId);

      act(() => result.current.pruneContentTabs(() => false));

      expect(result.current.tabs.some((tab) => tab.id === previewTabId)).toBe(false);
      expect(result.current.activeTabId).not.toBe(previewTabId);
      expect(result.current.tabs.some((tab) => tab.id === result.current.activeTabId)).toBe(true);
    });

    it("is a no-op (stable reference) when nothing is pruned", () => {
      const { result } = renderHook(() => useWorkspaceTabs());
      act(() => result.current.addTab("terminal"));
      act(() => result.current.openPinned({ source: "browser", url: "https://kept.example/" }));
      const before = result.current.tabs;
      act(() => result.current.pruneContentTabs(() => true));
      expect(result.current.tabs).toBe(before);
    });
  });
});

describe("useWorkspaceTabs moves", () => {
  it("releases a tab without closing it and adopts one with its id, number and address", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("terminal"));
    act(() => result.current.addTab("browser"));
    const [terminal, browser] = result.current.tabs;
    let released: ReturnType<typeof result.current.releaseTab>;
    act(() => { released = result.current.releaseTab(terminal!.id); });
    expect(released!).toEqual(terminal);
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([browser!.id]);
    expect(result.current.releaseTab("missing")).toBeUndefined();

    act(() => result.current.adoptTab({ id: "browser:77", kind: "browser", ordinal: 4 }, "https://example.com/"));
    const adopted = result.current.tabs.at(-1)!;
    expect(adopted).toEqual({ id: "browser:77", kind: "browser", ordinal: 4, mode: "pinned", content: null });
    expect(result.current.activeTabId).toBe("browser:77");
    expect(result.current.browserUrlByTab["browser:77"]).toBe("https://example.com/");
    // Adopting a tab already held only activates it.
    act(() => result.current.setActiveTabId(browser!.id));
    act(() => result.current.adoptTab({ id: "browser:77", kind: "browser", ordinal: 4 }, null));
    expect(result.current.tabs.filter((tab) => tab.id === "browser:77")).toHaveLength(1);
    expect(result.current.activeTabId).toBe("browser:77");
  });
});

describe("window tab id scope", () => {
  it("two renderers (windows) mint disjoint terminal ids", async () => {
    vi.resetModules();
    const windowA = await import("../workspace-tabs.js");
    vi.resetModules();
    const windowB = await import("../workspace-tabs.js");
    const idsA = [windowA.mintTabId("terminal"), windowA.mintTabId("terminal")];
    const idsB = [windowB.mintTabId("terminal"), windowB.mintTabId("terminal")];
    for (const id of [...idsA, ...idsB]) expect(id).toMatch(/^terminal:[0-9a-f]{8}-\d+$/);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
  });

  it("reserving another scope's id does not move this window's counter", async () => {
    vi.resetModules();
    const tabs = await import("../workspace-tabs.js");
    const first = tabs.mintTabId("terminal");
    const scope = first.slice("terminal:".length, "terminal:".length + 8);
    const foreign = scope === "00000000" ? "terminal:00000001-50" : "terminal:00000000-50";
    tabs.reserveTabIds([foreign]);
    expect(tabs.mintTabId("terminal")).toBe(`terminal:${scope}-2`);
    tabs.reserveTabIds([`terminal:${scope}-40`]);
    expect(tabs.mintTabId("terminal")).toBe(`terminal:${scope}-41`);
  });
});
