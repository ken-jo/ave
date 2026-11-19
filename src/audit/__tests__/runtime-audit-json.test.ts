import { describe, expect, it } from "vitest";
import { serializeRuntimeAuditData } from "../runtime-audit-json.js";
describe("bounded runtime audit JSON", () => {
  it.each([0, 497, 498])("preserves a payload that fits the output bound: %i", (length) => {
    const data = "x".repeat(length);
    expect(serializeRuntimeAuditData(data)).toBe(JSON.stringify(data));
  });
  it.each([
    { name: "boundary", data: "x".repeat(499) },
    { name: "path", data: { path: `D:\\fixtures\\${"long-root\\".repeat(60)}output` } },
    { name: "escapes", data: { detail: '"\\\r\n😀'.repeat(150) } },
  ])("encodes overflow as a bounded truncation marker: $name", ({ data }) => {
    const serialized = JSON.stringify(data);
    expect(serialized.length).toBeGreaterThan(500);
    const output = serializeRuntimeAuditData(data) ?? "";
    expect(output.length).toBeLessThanOrEqual(500);
    const marker = JSON.parse(output) as { truncated: boolean; originalLength: number; preview: string };
    expect(marker).toMatchObject({ truncated: true, originalLength: serialized.length });
    expect(marker.preview.length).toBeGreaterThan(0);
    expect(serialized.startsWith(marker.preview)).toBe(true);
    expect(marker.preview).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
  it("preserves an absent payload", () => { expect(serializeRuntimeAuditData(undefined)).toBeUndefined(); });
});
