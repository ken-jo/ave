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
    });
    const d = getToolCategoryDescriptor("read");
    expect(d.riskWeight).toBe(0.05);
    expect(listKnownCategories()).toEqual(["read"]);
  });

  it("re-registering the same category overwrites the previous descriptor", () => {
    registerToolCategory({
      name: "read",
      riskWeight: 0.1,
    });
    registerToolCategory({
      name: "read",
      riskWeight: 0.3,
    });
    expect(getToolCategoryDescriptor("read").riskWeight).toBe(0.3);
  });
});
