// Pin category weights so changes to the permission matrix are deliberate.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  clearCategoryRegistry,
  getToolCategoryDescriptor,
  listKnownCategories,
  registerStandardCategories,
  registerToolCategory,
} from "../category-registry.js";
import type { ToolCategory } from "../../tools/types.js";

// Restore the standard set at file teardown so other tests in the same vitest worker (which cache module state) don't observe an empty registry left over by the lookup-errors describe block.
afterAll(() => {
  clearCategoryRegistry();
  registerStandardCategories();
});

describe("Category Registry — registerStandardCategories", () => {
  beforeEach(() => {
    clearCategoryRegistry();
    registerStandardCategories();
  });

  it("populates all 5 standard axes", () => {
    const known = listKnownCategories().sort();
    expect(known).toEqual(["meta", "network", "read", "shell", "write"].sort());
  });

  it.each(["strict", "default", "auto", "allow"] as const)("allows ordinary reads in %s mode", (mode) => {
    expect(getToolCategoryDescriptor("read").decisionFor({ mode, source: "builtin", headless: false })).toBe("allow");
    expect(getToolCategoryDescriptor("read").decisionFor({ mode, source: "builtin", headless: true })).toBe("allow");
  });

  it.each(["write", "shell", "network"] as const)("delegates %s approval policy to the decision pipeline", (kind) => {
    const descriptor = getToolCategoryDescriptor(kind);
    for (const mode of ["strict", "default"] as const) {
      expect(descriptor.decisionFor({ mode, source: "builtin", headless: false })).toBe("ask");
      expect(descriptor.decisionFor({ mode, source: "builtin", headless: true })).toBe("deny");
    }
    for (const headless of [false, true]) {
      expect(descriptor.decisionFor({ mode: "auto", source: "builtin", headless })).toBe("reviewer");
      expect(descriptor.decisionFor({ mode: "allow", source: "builtin", headless })).toBe("allow");
    }
  });

  it("meta descriptor keeps override host-only and denies external sources", () => {
    const d = getToolCategoryDescriptor("meta");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: false })).toBe("override");
    expect(d.decisionFor({ mode: "auto", source: "plugin", headless: true })).toBe("deny");
    expect(d.decisionFor({ mode: "allow", source: "mcp", headless: false })).toBe("deny");
  });

  it("riskWeight ordering matches Phase 3 classifier expectation: shell > network > write > read > meta", () => {
    const w = (c: ToolCategory) => getToolCategoryDescriptor(c).riskWeight;
    expect(w("shell")).toBeGreaterThan(w("network"));
    expect(w("network")).toBeGreaterThan(w("write"));
    expect(w("write")).toBeGreaterThan(w("read"));
    expect(w("read")).toBeGreaterThan(w("meta"));
  });
});

describe("Category Registry — lookup errors", () => {
  beforeEach(() => {
    clearCategoryRegistry();
  });

  it("throws when accessing an unregistered category — fail closed", () => {
    expect(() => getToolCategoryDescriptor("read")).toThrow(
      /Unknown tool category 'read'/,
    );
  });

  it("listKnownCategories is empty before registration", () => {
    expect(listKnownCategories()).toEqual([]);
  });

  it("supports custom registration (Open-Closed)", () => {
    registerToolCategory({
      name: "read",
      riskWeight: 0.05,
      decisionFor: () => "allow",
    });
    const d = getToolCategoryDescriptor("read");
    expect(d.riskWeight).toBe(0.05);
    expect(listKnownCategories()).toEqual(["read"]);
  });

  it("re-registering the same category overwrites the previous descriptor", () => {
    registerToolCategory({
      name: "read",
      riskWeight: 0.1,
      decisionFor: () => "allow",
    });
    registerToolCategory({
      name: "read",
      riskWeight: 0.3,
      decisionFor: () => "ask",
    });
    expect(getToolCategoryDescriptor("read").riskWeight).toBe(0.3);
    expect(getToolCategoryDescriptor("read").decisionFor({
      mode: "default",
      source: "builtin",
      headless: false,
    })).toBe("ask");
  });
});
