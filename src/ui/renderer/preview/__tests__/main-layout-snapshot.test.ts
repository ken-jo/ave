import { describe, expect, it } from "vitest";
import { buildMainLayoutSnapshot, savedSurfaceOf } from "../main-layout-snapshot.js";
import { parseMainLayout } from "../../../../shared/main-layout.js";
import { leaf, splitLeaf } from "../../components/pane-tree.js";

describe("savedSurfaceOf", () => {
  it("keeps only what a restore can use", () => {
    expect(savedSurfaceOf({ tabId: "browser:0000000a-2", kind: "browser", ordinal: 1 }, "/x", "about:blank"))
      .toEqual({ kind: "browser", tabId: "browser:0000000a-2", ordinal: 1, cwd: null, url: null });
    expect(savedSurfaceOf({ tabId: "browser:0000000a-2", kind: "browser", ordinal: 1 }, null, "https://example.com/p"))
      .toEqual({ kind: "browser", tabId: "browser:0000000a-2", ordinal: 1, cwd: null, url: "https://example.com/p" });
    expect(savedSurfaceOf({ tabId: "terminal:0000000a-3", kind: "terminal", ordinal: 2 }, "/work", "https://example.com/"))
      .toEqual({ kind: "terminal", tabId: "terminal:0000000a-3", ordinal: 2, cwd: "/work", url: null });
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
      surfaceOf: (tabId) => (tabId === "terminal:0000000a-3" ? savedSurfaceOf({ tabId, kind: "terminal", ordinal: 1 }, "/work", null) : null),
      sideTabsOf: (paneId) => (paneId === "main" ? [savedSurfaceOf({ tabId: "browser:0000000a-4", kind: "browser", ordinal: 1 }, null, "https://example.com/")] : []),
    });
    expect(snapshot.surfaces).toEqual({ "group-2": { kind: "terminal", tabId: "terminal:0000000a-3", ordinal: 1, cwd: "/work", url: null } });
    expect(snapshot.sideTabs).toEqual({ main: [{ kind: "browser", tabId: "browser:0000000a-4", ordinal: 1, cwd: null, url: "https://example.com/" }] });
    // A panel id the tree no longer has is not carried.
    expect(snapshot.panelOpenIds).toEqual(["main"]);
    expect(snapshot.thumbnailOpenIds).toEqual(["group-2"]);
    expect(parseMainLayout(snapshot)).toEqual({ ok: true, layout: snapshot });
  });
});
