import { mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { TableDocumentError } from "../table-document-error.js";

const file = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  lstat: (await importOriginal<typeof import("node:fs/promises")>()).lstat, open: file.open,
}));
import { readPreviewDocumentInput } from "../preview-document-input.js";

let dir: string;
let path: string;
let opened: FileHandle | undefined;
let onOpened: ((handle: FileHandle) => void) | undefined;

beforeEach(async () => {
  const cache = join(process.cwd(), ".cache");
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, "document-input-"));
  path = join(dir, "table.csv");
  writeFileSync(path, "a,b\n1,2");
  onOpened = undefined;
  opened = undefined;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  file.open.mockImplementation(async (...args: Parameters<typeof actual.open>) => {
    opened = await actual.open(...args);
    onOpened?.(opened);
    return opened;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("bounded document input", () => {
  it("does not allow a caller to widen the maximum byte ceiling", async () => {
    await expect(readPreviewDocumentInput(path, undefined, PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1)).rejects.toMatchObject({ code: "too-large" });
    expect(opened).toBeUndefined();
  });

  it("honors a narrower caller byte cap without widening the document limit", async () => {
    await expect(readPreviewDocumentInput(path, undefined, 3)).rejects.toMatchObject({ code: "too-large" });
    expect(opened?.fd).toBe(-1);
  });

  it("closes a superseded read before allocating its input buffer", async () => {
    const controller = new AbortController();
    onOpened = (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await stat();
        controller.abort(new TableDocumentError("superseded", "Request was replaced."));
        return info;
      });
      vi.spyOn(handle, "read");
    };
    await expect(readPreviewDocumentInput(path, controller.signal)).rejects.toMatchObject({ code: "superseded" });
    expect(opened?.read).not.toHaveBeenCalled();
    expect(opened?.fd).toBe(-1);
  });

  it("reads the opened descriptor when the checked pathname is replaced", async () => {
    onOpened = (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await stat();
        renameSync(path, `${path}.opened`);
        writeFileSync(path, "replacement");
        truncateSync(path, PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1);
        return info;
      });
    };
    expect((await readPreviewDocumentInput(path)).toString()).toBe("a,b\n1,2");
    expect(opened?.fd).toBe(-1);
    await expect(readPreviewDocumentInput(path)).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses a descriptor that is not the checked pathname's file", async () => {
    // A link swapped in before the open is followed on Windows; the pathname
    // then names a different file than the descriptor.
    onOpened = () => {
      renameSync(path, `${path}.opened`);
      writeFileSync(path, "a,b\n1,2");
    };
    await expect(readPreviewDocumentInput(path)).rejects.toMatchObject({ code: "read-failed" });
    expect(opened?.fd).toBe(-1);
  });

  it("bounds growth after fstat and closes the descriptor on refusal", async () => {
    let requested = (): number => 0;
    onOpened = (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await stat();
        truncateSync(path, PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1);
        return info;
      });
      const read = vi.spyOn(handle, "read");
      requested = () => read.mock.calls.reduce((sum, args) => sum + (args as unknown as [Buffer, number, number, number])[2], 0);
    };
    await expect(readPreviewDocumentInput(path)).rejects.toMatchObject({ code: "too-large" });
    expect(requested()).toBeLessThanOrEqual(Buffer.byteLength("a,b\n1,2") + 1);
    expect(opened?.fd).toBe(-1);
  });

  it("reports growth below the byte ceiling as a changed read", async () => {
    onOpened = (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await stat();
        truncateSync(path, info.size + 1);
        return info;
      });
    };
    await expect(readPreviewDocumentInput(path)).rejects.toMatchObject({ code: "read-failed" });
    expect(opened?.fd).toBe(-1);
  });

  it("refuses a shrinking source instead of returning a partial successful file", async () => {
    onOpened = (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await stat();
        truncateSync(path, 0);
        return info;
      });
    };
    await expect(readPreviewDocumentInput(path)).rejects.toMatchObject({ code: "read-failed" });
    expect(opened?.fd).toBe(-1);
  });

  it("refuses non-files and oversize files before allocating an input buffer", async () => {
    await expect(readPreviewDocumentInput(dir)).rejects.toMatchObject({ code: "not-a-file" });
    truncateSync(path, PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1);
    await expect(readPreviewDocumentInput(path)).rejects.toMatchObject({
      code: "too-large", bytes: PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1,
    });
    expect(opened?.fd).toBe(-1);
  });
});
