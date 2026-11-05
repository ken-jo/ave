import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../hooks/use-sessions.js";
import type { SidebarSurface } from "../../../hooks/use-sidebar-items.js";
import { bucketEntries, recencyBucket, treeEntries } from "../project-tree-model.js";

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

  it("files rows under 이번 주, 지난주 and 이전 by age, with pinned rows under their own header", () => {
    expect([recencyBucket(NOW - 6.9 * DAY, NOW), recencyBucket(NOW - 8 * DAY, NOW), recencyBucket(NOW - 15 * DAY, NOW)])
      .toEqual(["thisWeek", "lastWeek", "older"]);
    const isPinned = (id: string) => id === "p";
    const entries = treeEntries({ sessions: [session("p", 40), session("a", 1), session("b", 10), session("c", 11), session("d", 50)], surfaces: [], isPinned, surfaceAt: () => NOW });
    expect(bucketEntries(entries, NOW, isPinned).map(({ bucket, entries: rows }) => [bucket, rows.map((row) => row.key)])).toEqual([
      ["pinned", ["session:p"]],
      ["thisWeek", ["session:a"]],
      ["lastWeek", ["session:b", "session:c"]],
      ["older", ["session:d"]],
    ]);
  });

  it("refuses a conversation whose time cannot be read", () => {
    expect(() => treeEntries({ sessions: [{ id: "x", title: "x", modifiedAt: "soon" } as SessionSummary], surfaces: [], isPinned: () => false, surfaceAt: () => NOW }))
      .toThrow("session-time-invalid");
  });
});
