import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../hooks/use-sessions.js";
import type { SidebarSurface } from "../../../hooks/use-sidebar-items.js";
import { bucketEntries, nestSessionEntries, sessionBranchExpanded, recencyBucket, treeEntries } from "../project-tree-model.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;
const session = (id: string, daysAgo: number): SessionSummary =>
  ({ id, title: id, modifiedAt: new Date(NOW - daysAgo * DAY).toISOString() }) as SessionSummary;
const surface = (tabId: string): SidebarSurface =>
  ({ tabId, kind: "terminal", ordinal: 1, url: null, boundSessionIds: [], faviconDataUrl: null }) as SidebarSurface;

describe("project tree model", () => {
  it("interleaves conversations and surfaces by recency, pinned conversations first", () => {
    const at: Record<string, number> = { "terminal:0000000a-1": NOW - 2 * DAY, "browser:0000000a-2": NOW - 9 * DAY };
    const entries = treeEntries({
      sessions: [session("old", 20), session("new", 1), session("pinned", 30), session("mid", 3)],
      surfaces: [surface("terminal:0000000a-1"), surface("browser:0000000a-2")],
      isPinned: (id) => id === "pinned",
      surfaceAt: (tabId) => at[tabId]!,
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      "session:pinned", "session:new", "surface:terminal:0000000a-1", "session:mid", "surface:browser:0000000a-2", "session:old",
    ]);
  });

  it("files rows under 지난 7일, 지난 30일 and 이전 by age, with pinned rows under their own header", () => {
    expect([recencyBucket(NOW - 6.9 * DAY, NOW), recencyBucket(NOW - 8 * DAY, NOW), recencyBucket(NOW - 29.9 * DAY, NOW), recencyBucket(NOW - 30 * DAY, NOW)])
      .toEqual(["last7Days", "last30Days", "last30Days", "older"]);
    const isPinned = (id: string) => id === "p";
    const entries = treeEntries({ sessions: [session("p", 40), session("a", 1), session("b", 10), session("c", 11), session("d", 50)], surfaces: [], isPinned, surfaceAt: () => NOW });
    expect(bucketEntries(entries, NOW, isPinned).map(({ bucket, entries: rows }) => [bucket, rows.map((row) => row.key)])).toEqual([
      ["pinned", ["session:p"]],
      ["last7Days", ["session:a"]],
      ["last30Days", ["session:b", "session:c"]],
      ["older", ["session:d"]],
    ]);
  });

  it("refuses a conversation whose time cannot be read", () => {
    expect(() => treeEntries({ sessions: [{ id: "x", title: "x", modifiedAt: "soon" } as SessionSummary], surfaces: [], isPinned: () => false, surfaceAt: () => NOW }))
      .toThrow("session-time-invalid");
  });
});

describe("sub-agent conversation branches", () => {
  const entries = (rows: SessionSummary[]) => treeEntries({ sessions: rows, surfaces: [], isPinned: () => false, surfaceAt: () => NOW });
  const child = (id: string, originSessionId: string, projectRoot?: string): SessionSummary => ({ ...session(id, 0), family: "subagent", sessionKind: "subagent", originSessionId, projectRoot });

  it("keeps children with an older parent across recency buckets and pagination", () => {
    const nested = nestSessionEntries(entries([child("child", "parent"), session("other", 1), session("parent", 40)]));
    expect(nested.map((entry) => entry.key)).toEqual(["session:other", "session:parent"]);
    expect(nested[1]).toMatchObject({ children: [{ session: { id: "child" } }] });
  });

  it("keeps deleted-parent, cross-project and self-parent children at top level", () => {
    const nested = nestSessionEntries(entries([session("parent", 1), child("orphan", "deleted"), child("other-project", "parent", "/workspace/other"), child("self", "self")]));
    expect(nested).toHaveLength(4);
    expect(nested.every((entry) => entry.kind !== "session" || entry.children?.length === 0)).toBe(true);
  });

  it("keeps malformed cycles reachable", () => {
    const nested = nestSessionEntries(entries([child("one", "two"), child("two", "one")]));
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ children: [{ children: [] }] });
  });

  it("retains ordinary descendants when breaking a malformed ancestor cycle", () => {
    const nested = nestSessionEntries(entries([child("leaf", "one"), child("one", "two"), child("two", "one")]));
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ session: { id: "one" }, children: [{ session: { id: "leaf" } }, { session: { id: "two" } }] });
  });

  it("defaults to collapsed away from the parent and expands for selection, running descendants or user choice", () => {
    const [branch] = nestSessionEntries(entries([session("parent", 2), child("child", "parent"), child("grandchild", "child")]));
    if (branch?.kind !== "session") throw new Error("missing-parent");
    expect(sessionBranchExpanded(branch, "other", () => false)).toBe(false);
    expect(sessionBranchExpanded(branch, "parent", () => false)).toBe(true);
    expect(sessionBranchExpanded(branch, "other", () => false, true)).toBe(true);
    expect(sessionBranchExpanded(branch, "parent", () => false, false)).toBe(false);
    expect(sessionBranchExpanded(branch, "grandchild", () => false, false)).toBe(true);
    expect(sessionBranchExpanded(branch, "other", (id) => id === "grandchild", false)).toBe(true);
  });
});
