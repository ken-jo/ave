import { describe, expect, it } from "vitest";
import { browserDragData } from "../browser-drag-data.js";

const origin = "https://a.example:443";
const payload = () => ({ items: [{ mimeType: "text/plain", data: "native selected text" }], dragOperationsMask: 1 });

describe("browser drag data", () => {
  it("copies and freezes only bounded browser text", () => {
    const source = payload();
    const result = browserDragData(source, origin);
    source.items[0]!.data = "changed after capture";
    expect(result.items[0]!.data).toBe("native selected text");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(result).not.toHaveProperty("files");
  });
  it("narrows the documented native all-effects sentinel to copy/link/move", () => {
    expect(browserDragData({ ...payload(), dragOperationsMask: -1 }, origin).dragOperationsMask).toBe(19);
  });
  it.each([
    { ...payload(), files: ["/private/secret"] },
    { ...payload(), files: "file" },
    { ...payload(), path: "/private/secret" },
    { ...payload(), items: [{ mimeType: "application/octet-stream", data: "x" }] },
    { ...payload(), items: [{ mimeType: "text/plain", data: "file:///private/secret" }] },
    { ...payload(), items: [{ mimeType: "text/plain", data: "C:\\private\\secret" }] },
    { ...payload(), items: [{ mimeType: "text/plain", data: "x".repeat(65537) }] },
    { ...payload(), items: Array.from({ length: 17 }, () => ({ mimeType: "text/plain", data: "x" })) },
    { ...payload(), items: [{ mimeType: "text/html", data: "text", baseURL: "https://b.example/" }] },
    { ...payload(), dragOperationsMask: 4 },
    { ...payload(), dragOperationsMask: -2 },
    { ...payload(), dragOperationsMask: 4294967297 },
    { ...payload(), dragOperationsMask: 0 },
  ])("rejects unsupported data without retaining paths", (data) => {
    expect(() => browserDragData(data, origin)).toThrowError(expect.objectContaining({ code: "invalid-drag-data" }));
  });
});
