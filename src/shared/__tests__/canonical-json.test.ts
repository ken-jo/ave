/** Canonical JSON sorts object keys and maps top-level undefined to null. */
import { describe, it, expect } from "vitest";
import { canonicalStringify } from "../canonical-json.js";

describe("canonicalStringify", () => {
  it("drops keys whose value is undefined — matches JSON.stringify", () => {
    const input = { a: undefined, b: 1 };
    expect(canonicalStringify(input)).toBe('{"b":1}');
    expect(canonicalStringify(input)).toBe(JSON.stringify(input));
  });

  it("sorts keys deterministically regardless of insertion order", () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("serialises top-level undefined as null (RFC 8259 — no undefined token)", () => {
    expect(canonicalStringify(undefined)).toBe("null");
  });

  it("serialises null as null", () => {
    expect(canonicalStringify(null)).toBe("null");
  });

  it("serialises primitives identically to JSON.stringify", () => {
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify("hello")).toBe('"hello"');
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(false)).toBe("false");
  });

  it("serialises arrays of primitives identically to JSON.stringify (element order preserved)", () => {
    const arr = [3, 1, 2];
    expect(canonicalStringify(arr)).toBe(JSON.stringify(arr));
  });

  it("recursively canonicalizes nested objects within arrays (RFC 8785 JCS — #828)", () => {
    expect(canonicalStringify([{ b: 2, a: 1 }])).toBe('[{"a":1,"b":2}]');
    expect(canonicalStringify([{ a: 1, b: 2 }])).toBe('[{"a":1,"b":2}]');
    expect(canonicalStringify({ items: [{ z: 9, a: 1 }, { y: 2, b: 8 }] })).toBe(
      '{"items":[{"a":1,"z":9},{"b":8,"y":2}]}',
    );
  });

  it("handles nested objects with undefined values", () => {
    const input = { a: { x: undefined, y: 2 }, b: 1 };
    expect(canonicalStringify(input)).toBe('{"a":{"y":2},"b":1}');
  });

  it("produces same result as JSON.stringify for objects with no undefined values", () => {
    const obj = { z: 3, a: 1, m: 2 };
    // Equality with ordinary JSON requires sorted keys and no undefined values.
    const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
    expect(canonicalStringify(obj)).toBe(JSON.stringify(sorted));
  });

  describe("cycle guard + depth cap (#797)", () => {
    it("does not stack-overflow on a self-referencing object", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      expect(() => canonicalStringify(obj)).not.toThrow();
      expect(canonicalStringify(obj)).toContain('"[Circular]"');
    });

    it("does not stack-overflow on a mutual cycle (a → b → a)", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b", a };
      a.b = b;
      expect(() => canonicalStringify(a)).not.toThrow();
      expect(canonicalStringify(a)).toContain('"[Circular]"');
    });

    it("caps deeply nested objects with [MaxDepth] marker", () => {
      let leaf: Record<string, unknown> = { v: 1 };
      for (let i = 0; i < 200; i++) {
        leaf = { nested: leaf };
      }
      expect(() => canonicalStringify(leaf)).not.toThrow();
      expect(canonicalStringify(leaf)).toContain('"[MaxDepth]"');
    });

    it("sibling objects sharing structure across separate calls each serialize cleanly", () => {
      // Each root gets its own cycle set; sharing across calls is not a cycle.
      const shared = { x: 1 };
      const a = { shared };
      const b = { shared };
      expect(canonicalStringify(a)).toBe(canonicalStringify(b));
      expect(canonicalStringify(a)).not.toContain('"[Circular]"');
    });

    it("a shared (non-cyclic) sub-object referenced twice in ONE tree serializes both, not [Circular]", () => {
      // Detect cycles by ancestor path so sibling shared objects keep stable canonical hashes.
      const shared = { x: 1 };
      const root = { a: shared, b: shared };
      const out = canonicalStringify(root);
      expect(out).not.toContain('"[Circular]"');
      expect(out).toBe('{"a":{"x":1},"b":{"x":1}}');
    });

    it("a value shared between two array elements serializes both, not [Circular]", () => {
      const shared = { k: "v" };
      const out = canonicalStringify([shared, shared]);
      expect(out).not.toContain('"[Circular]"');
      expect(out).toBe('[{"k":"v"},{"k":"v"}]');
    });
  });
});
