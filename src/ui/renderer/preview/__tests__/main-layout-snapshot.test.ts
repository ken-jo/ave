import { describe, expect, it } from "vitest";
import { buildMainLayoutSnapshot, savedSurfaceOf } from "../main-layout-snapshot.js";
import { parseMainLayout, type MainLayoutSnapshot, type SavedMainSurface } from "../../../../shared/main-layout.js";
import { restorableLayout } from "../main-layout-restore.js";
import { leaf, splitLeaf } from "../../components/pane-tree.js";

describe("savedSurfaceOf", () => {
  it("keeps only what a restore can use", () => {
    expect(savedSurfaceOf({ tabId: "browser:0000000a-2", kind: "browser", ordinal: 1 }, "/x", "about:blank"))
      .toEqual({ kind: "browser", tabId: "browser:0000000a-2", ordinal: 1, cwd: null, url: null });
    expect(savedSurfaceOf({ tabId: "browser:0000000a-2", kind: "browser", ordinal: 1 }, null, "https://example.com/p"))
      .toEqual({ kind: "browser", tabId: "browser:0000000a-2", ordinal: 1, cwd: null, url: "https://example.com/p" });
    expect(savedSurfaceOf({ tabId: "terminal:0000000a-3", kind: "terminal", ordinal: 2 }, "/work", "https://example.com/"))
      .toEqual({ kind: "terminal", tabId: "terminal:0000000a-3", ordinal: 2, cwd: "/work", url: null });
    expect(savedSurfaceOf({ tabId: "terminal:0000000a-3", kind: "terminal", ordinal: 2 }, "C:\\work", null).cwd).toBe("C:\\work");
    expect(savedSurfaceOf({ tabId: "terminal:0000000a-3", kind: "terminal", ordinal: 2 }, "work", null).cwd).toBeNull();
  });
});

describe("buildMainLayoutSnapshot", () => {
  it("records panes, the surfaces they show, open panels and side tabs — and passes its own rules", () => {
    const tree = splitLeaf(leaf("main"), "main", "right", "group-2");
    const snapshot = buildMainLayoutSnapshot({
      tree,
      focusedId: "group-2",
      panelOpenIds: ["main", "group-9"],
      thumbnailOpenIds: ["group-2", "group-9"],
      contentById: { main: { view: "home" }, "group-2": { view: "terminal", surface: "terminal:0000000a-3" } },
      surfaceOf: (tabId) => (tabId === "terminal:0000000a-3" ? { ...savedSurfaceOf({ tabId, kind: "terminal", ordinal: 1 }, "/work", null), projectRoot: "/work" } : null),
      sideTabsOf: (paneId) => (paneId === "main" ? [savedSurfaceOf({ tabId: "browser:0000000a-4", kind: "browser", ordinal: 1 }, null, "https://example.com/")] : []),
      openSurfaceIds: ["terminal:0000000a-3"],
    });
    expect(snapshot.surfaces).toEqual({ "group-2": { kind: "terminal", tabId: "terminal:0000000a-3", ordinal: 1, cwd: "/work", url: null, projectRoot: "/work" } });
    expect(snapshot.version).toBe(2);
    expect(snapshot.sideTabs).toEqual({ main: [{ kind: "browser", tabId: "browser:0000000a-4", ordinal: 1, cwd: null, url: "https://example.com/" }] });
    // A panel id the tree no longer has is not carried.
    expect(snapshot.panelOpenIds).toEqual(["main"]);
    expect(snapshot.thumbnailOpenIds).toEqual(["group-2"]);
    expect(parseMainLayout(snapshot)).toEqual({ ok: true, layout: snapshot });
  });

  it("records every first-class tab in sidebar order, including those no pane shows", () => {
    const surfaces: Record<string, SavedMainSurface> = {
      "browser:0000000a-5": { ...savedSurfaceOf({ tabId: "browser:0000000a-5", kind: "browser", ordinal: 1 }, null, "https://example.com/"), projectRoot: "/ws" },
      "terminal:0000000a-3": { ...savedSurfaceOf({ tabId: "terminal:0000000a-3", kind: "terminal", ordinal: 1 }, "/work", null), projectRoot: "/work" },
    };
    const snapshot = buildMainLayoutSnapshot({
      tree: leaf("main"),
      focusedId: "main",
      panelOpenIds: [],
      thumbnailOpenIds: [],
      contentById: { main: { view: "terminal", surface: "terminal:0000000a-3" } },
      surfaceOf: (tabId) => surfaces[tabId] ?? null,
      sideTabsOf: () => [],
      openSurfaceIds: ["browser:0000000a-5", "terminal:0000000a-3", "browser:0000000a-9"],
    });
    expect(snapshot.openSurfaces).toEqual([surfaces["browser:0000000a-5"], surfaces["terminal:0000000a-3"]]);
    expect(parseMainLayout(snapshot)).toEqual({ ok: true, layout: snapshot });
  });
});

describe("restorableLayout", () => {
  const terminal: SavedMainSurface = { kind: "terminal", tabId: "terminal:0000000a-3", ordinal: 1, cwd: "/work/src", url: null, projectRoot: "/work" };
  const page: SavedMainSurface = { kind: "browser", tabId: "browser:0000000a-4", ordinal: 1, cwd: null, url: "https://example.com/", projectRoot: "C:\\Gone" };
  const plugin: SavedMainSurface = { kind: "plugin", tabId: "plugin:0000000a-5", ordinal: 1, pluginId: "notes", viewId: "board", title: "Notes", projectRoot: "/work" };
  const saved: MainLayoutSnapshot = {
    version: 2,
    tree: splitLeaf(leaf("main"), "main", "right", "group-2") as MainLayoutSnapshot["tree"],
    focusedId: "group-2",
    surfaces: { main: page, "group-2": terminal },
    panelOpenIds: ["main"],
    thumbnailOpenIds: [],
    sideTabs: {},
    openSurfaces: [terminal, page, plugin],
  };

  it("drops a surface whose project was removed, and one this window cannot show, naming each", () => {
    const { layout, dropped } = restorableLayout(saved, ["/ws", "/work/"]);
    expect(layout.surfaces).toEqual({ "group-2": terminal });
    expect(layout.openSurfaces).toEqual([terminal]);
    expect(layout.panelOpenIds).toEqual(["main"]);
    expect(dropped).toEqual([
      "browser:0000000a-4: its project is not open",
      "plugin:0000000a-5: this window does not show plugin surfaces",
    ]);
  });

  it("keeps a surface whose root matches a live one by identity, not spelling", () => {
    expect(restorableLayout(saved, ["/work", "c:/gone"]).layout.openSurfaces).toEqual([terminal, page]);
  });
});
