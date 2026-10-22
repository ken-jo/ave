import { describe, expect, it } from "vitest";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { openWorkbookWorkspace } from "../workbook-parser-workspace.js";

const LINEAR_MEMORY_PAGE_BYTES = 64 * 1024;

describe("workbook parser workspace", () => {
  it("refuses retained array buffers within the maximum linear memory", async () => {
    const workspace = await openWorkbookWorkspace();
    try {
      const result = workspace.context.evalCode("const retained = []; for (let i = 0; i < 320; i++) retained.push(new Uint8Array(1024 * 1024));");
      expect(result.error).toBeDefined();
      if (!result.error) { result.value.dispose(); throw new Error("Expected bounded allocation refusal."); }
      const message = workspace.context.getProp(result.error, "message");
      try { expect(workspace.context.getString(message)).toMatch(/out of memory/i); }
      finally { message.dispose(); result.error.dispose(); }
      expect(workspace.memory.buffer.byteLength).toBeGreaterThan(PREVIEW_DOCUMENT_LIMITS.initialWorkbookMemoryBytes);
      expect(workspace.memory.buffer.byteLength).toBeLessThanOrEqual(PREVIEW_DOCUMENT_LIMITS.maxWorkbookMemoryBytes);
      const extraPages = (PREVIEW_DOCUMENT_LIMITS.maxWorkbookMemoryBytes - workspace.memory.buffer.byteLength) / LINEAR_MEMORY_PAGE_BYTES + 1;
      expect(() => workspace.memory.grow(extraPages)).toThrow(RangeError);
    } finally { workspace.dispose(); }
  });

  it("does not expose host modules, filesystem or network callbacks", async () => {
    const workspace = await openWorkbookWorkspace();
    try {
      const result = workspace.context.evalCode("JSON.stringify([typeof process, typeof require, typeof fetch, typeof std, typeof os])");
      expect(result.error).toBeUndefined();
      if (result.error) { result.error.dispose(); throw new Error("Expected a working workspace."); }
      try { expect(JSON.parse(workspace.context.getString(result.value))).toEqual(Array(5).fill("undefined")); }
      finally { result.value.dispose(); }
    } finally { workspace.dispose(); }
  });

  it("interrupts non-allocating parser work at its deadline", async () => {
    const workspace = await openWorkbookWorkspace();
    try {
      const result = workspace.context.evalCode("for (;;) {}");
      expect(result.error).toBeDefined();
      if (!result.error) { result.value.dispose(); throw new Error("Expected deadline interruption."); }
      const message = workspace.context.getProp(result.error, "message");
      try { expect(workspace.context.getString(message)).toMatch(/interrupted/i); }
      finally { message.dispose(); result.error.dispose(); }
      expect(Date.now()).toBeGreaterThanOrEqual(workspace.deadline);
    } finally { workspace.dispose(); }
  });
});
