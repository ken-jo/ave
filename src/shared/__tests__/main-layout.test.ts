import { describe, expect, it } from "vitest";
import { parseMainLayout, type MainLayoutSnapshot } from "../main-layout.js";

const LIMITS = { maxPanes: 4, primaryPaneId: "main" };

function layout(): MainLayoutSnapshot {
  return {
    version: 1,
    tree: {
      kind: "split",
      axis: "row",
      children: [{ kind: "leaf", chatGroupId: "main" }, { kind: "leaf", chatGroupId: "group-3" }],
      sizes: [0.5, 0.5],
    },
    focusedId: "group-3",
    surfaces: { "group-3": { kind: "terminal", tabId: "terminal:0000000a-4", ordinal: 2, cwd: "/work/repo", url: null } },
    panelOpenIds: ["main"],
    sideTabs: { main: [{ kind: "browser", tabId: "browser:0000000a-5", ordinal: 1, cwd: null, url: "https://example.com/a" }] },
  };
}

function refused(mutate: (raw: Record<string, any>) => void): string {
  const raw = structuredClone(layout()) as unknown as Record<string, any>;
  mutate(raw);
  const parsed = parseMainLayout(raw, LIMITS);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.reason;
}

describe("parseMainLayout", () => {
  it("accepts a well-formed layout as it is", () => {
    expect(parseMainLayout(layout())).toEqual({ ok: true, layout: layout() });
  });

  it("refuses a layout whole, naming the rule it broke", () => {
    expect(parseMainLayout("nope")).toEqual({ ok: false, reason: "the layout is not an object" });
    expect(refused((raw) => { raw.version = 2; })).toBe("version 2 is not 1");
    expect(refused((raw) => { raw.tree.sizes = [0.7, 0.7]; })).toMatch(/sizes sum to 1\.4/);
    expect(refused((raw) => { raw.tree.sizes = [1]; })).toMatch(/one size per child/);
    expect(refused((raw) => { raw.tree.axis = "diagonal"; })).toMatch(/axis "diagonal"/);
    expect(refused((raw) => { raw.tree.children[1].chatGroupId = "main"; })).toMatch(/pane main appears twice/);
    expect(refused((raw) => { raw.tree.children[1].chatGroupId = "../x"; })).toMatch(/is not a pane id/);
    expect(refused((raw) => { raw.tree.children[0].chatGroupId = "group-2"; })).toMatch(/no main pane/);
    expect(refused((raw) => { raw.focusedId = "group-9"; })).toMatch(/focusedId names pane "group-9"/);
    expect(refused((raw) => { raw.surfaces["group-3"].tabId = "browser:0000000a-4"; })).toMatch(/not a terminal tab id/);
    expect(refused((raw) => { raw.surfaces["group-3"].cwd = "relative/dir"; })).toMatch(/cwd must be null or a terminal's absolute path/);
    expect(refused((raw) => { raw.sideTabs.main[0].url = "file:///etc/passwd"; })).toMatch(/url must be http or https/);
    expect(refused((raw) => { raw.sideTabs.main[0].tabId = "terminal:0000000a-4"; raw.sideTabs.main[0].kind = "terminal"; raw.sideTabs.main[0].url = null; })).toMatch(/terminal:0000000a-4 is used twice/);
    expect(refused((raw) => { raw.panelOpenIds = ["group-7"]; })).toMatch(/panelOpenIds names pane "group-7"/);
    expect(refused((raw) => { raw.surfaces = { "group-8": raw.surfaces["group-3"] }; })).toMatch(/surfaces names pane "group-8"/);
  });

  it("checks only the shape without the window's limits", () => {
    const raw = structuredClone(layout()) as unknown as Record<string, any>;
    raw.tree.children[0].chatGroupId = "group-2";
    raw.panelOpenIds = [];
    raw.sideTabs = {};
    expect(parseMainLayout(raw).ok).toBe(true);
    expect(parseMainLayout(raw, LIMITS)).toEqual({ ok: false, reason: "the tree has no main pane" });
  });

  it("refuses more panes than the canvas holds", () => {
    const leaves = ["main", "group-2", "group-3", "group-4", "group-5"].map((chatGroupId) => ({ kind: "leaf", chatGroupId }));
    expect(refused((raw) => {
      raw.tree = { kind: "split", axis: "row", children: leaves, sizes: [0.2, 0.2, 0.2, 0.2, 0.2] };
      raw.focusedId = "main";
      raw.surfaces = {};
      raw.sideTabs = {};
    })).toMatch(/5 panes, more than 4/);
  });
});
