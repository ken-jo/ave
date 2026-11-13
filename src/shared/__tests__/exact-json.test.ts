import { describe, expect, it } from "vitest";
import { exactCanonicalStringify } from "../exact-json.js";
import { canonicalStringify } from "../canonical-json.js";

function nested(value: string): Record<string, unknown> {
  let result: Record<string, unknown> = { value };
  for (let index = 0; index < 105; index++) result = { child: result };
  return result;
}

describe("lossless exact consent identity", () => {
  it("normalizes only object-key order while retaining arrays and literal values", () => {
    expect(exactCanonicalStringify({ b: [1, "two", null], a: true }))
      .toBe(exactCanonicalStringify({ a: true, b: [1, "two", null] }));
    expect(exactCanonicalStringify({ a: [1, 2] })).not.toBe(exactCanonicalStringify({ a: [2, 1] }));
    expect(exactCanonicalStringify({ value: "[MaxDepth]" })).toBe('{"value":"[MaxDepth]"}');
  });

  it("refuses deep inputs that collide under the display-oriented serializer", () => {
    const first = nested("allowed");
    const second = nested("changed");
    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
    expect(() => exactCanonicalStringify(first)).toThrow("nesting limit");
    expect(() => exactCanonicalStringify(second)).toThrow("nesting limit");
  });

  it.each([undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol("value"), new Date(0)])
    ("rejects non-JSON values rather than replacing them", value => {
      expect(() => exactCanonicalStringify({ value })).toThrow();
    });

  it("rejects cycles and sparse arrays while allowing repeated non-cyclic objects", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => exactCanonicalStringify(cycle)).toThrow();
    expect(() => exactCanonicalStringify(new Array(2))).toThrow();
    const shared = { value: "same" };
    expect(exactCanonicalStringify([shared, shared])).toBe('[{"value":"same"},{"value":"same"}]');
  });

  it("does not evaluate getters when deriving permission identity", () => {
    const input = Object.defineProperty({}, "value", { enumerable: true, get: () => { throw new Error("Getter ran"); } });
    expect(() => exactCanonicalStringify(input)).toThrow("accessor");
  });
});
