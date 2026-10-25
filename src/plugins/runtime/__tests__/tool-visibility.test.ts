/** Visibility readers never apply semantic defaults; malformed normalized declarations fail to the minimal governed surface. */
import { describe, it, expect, vi } from "vitest";
import type { Tool } from "../../types.js";
import { toolVisibility, isModelVisible, isAppVisible, isUiOnly } from "../tool-visibility.js";

function tool(meta: Tool["_meta"]): Tool {
  return { name: "t", inputSchema: { type: "object", properties: {} }, _meta: meta };
}

describe("toolVisibility — explicit arrays are returned verbatim (pure reader, no re-default)", () => {
  it.each([
    [["model"] as const],
    [["app"] as const],
    [["model", "app"] as const],
  ])("returns %j verbatim and does NOT warn", (vis) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(toolVisibility(tool({ ui: { visibility: [...vis] } }))).toEqual([...vis]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("toolVisibility — fail-closed defensive backstop (never app-only)", () => {
  const brokenCases: Array<[string, Tool]> = [
    ["_meta absent", { name: "t", inputSchema: { type: "object", properties: {} } }],
    ["_meta.ui absent", tool({ "ave/pathFields": ["p"] })],
    ["visibility []", tool({ ui: { visibility: [] } })],
    ["visibility bogus", tool({ ui: { visibility: ["bogus" as "model"] } })],
  ];

  it.each(brokenCases)("%s → resolves ['model'] (governed) AND warns", (_label, t) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const vis = toolVisibility(t);
      // Fail closed to a governed surface, never app-only.
      expect(vis).toEqual(["model"]);
      expect(vis).not.toContain("app");
      const warned = warnSpy.mock.calls.some((args) =>
        args.some(
          (a) =>
            (typeof a === "string" && /explicit _meta\.ui\.visibility/.test(a)) ||
            (typeof a === "object" && a !== null && (a as { event?: string }).event === "tool-visibility-missing"),
        ),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the backstop is fail-closed w.r.t. the bypass: isUiOnly is false for a missing-visibility tool", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t: Tool = { name: "t", inputSchema: { type: "object", properties: {} } };
      expect(isModelVisible(t)).toBe(true);
      expect(isAppVisible(t)).toBe(false);
      expect(isUiOnly(t)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("isModelVisible / isAppVisible / isUiOnly — SoT §2.3 membership", () => {
  it("model-only → model-visible, not ui-only", () => {
    const t = tool({ ui: { visibility: ["model"] } });
    expect(isModelVisible(t)).toBe(true);
    expect(isAppVisible(t)).toBe(false);
    expect(isUiOnly(t)).toBe(false);
  });

  it("dual → model AND app visible, not ui-only (model wins → governed)", () => {
    const t = tool({ ui: { visibility: ["model", "app"] } });
    expect(isModelVisible(t)).toBe(true);
    expect(isAppVisible(t)).toBe(true);
    expect(isUiOnly(t)).toBe(false);
  });

  it("app-only → ui-only (the ONLY isUiOnly=true case — the bypass surface)", () => {
    const t = tool({ ui: { visibility: ["app"] } });
    expect(isModelVisible(t)).toBe(false);
    expect(isAppVisible(t)).toBe(true);
    expect(isUiOnly(t)).toBe(true);
  });
});
