import { constants, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { TableDocumentError } from "../table-document-error.js";

const file = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  lstat: (await importOriginal<typeof import("node:fs/promises")>()).lstat, open: file.open,
}));
import { readJudgedDocumentInput, readPreviewDocumentInput } from "../preview-document-input.js";

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

  it("reads a document for the model only from the file its judged path still names after the read", async () => {
    const folder = join(dir, "sheets");
    const elsewhere = join(dir, "elsewhere", ".ssh");
    mkdirSync(folder);
    mkdirSync(elsewhere, { recursive: true });
    const judged = join(folder, "table.csv");
    const protectedFile = join(elsewhere, "table.csv");
    writeFileSync(judged, "a,b\n1,2");
    writeFileSync(protectedFile, "key,PROTECTED");
    // The folder, or the last name (a second name for the protected file), leads into the protected folder from just
    // before the open until the first read, so the name and the descriptor agree right after the open; it is back before
    // anything looks at the path again. The open lacks the flag that refuses a link, as on Windows.
    const swaps = {
      folder: {
        to: () => { renameSync(folder, `${folder}.orig`); symlinkSync(elsewhere, folder, "junction"); },
        back: () => { unlinkSync(folder); renameSync(`${folder}.orig`, folder); },
      },
      "last name": {
        to: () => { renameSync(judged, `${judged}.orig`); linkSync(protectedFile, judged); },
        back: () => { unlinkSync(judged); renameSync(`${judged}.orig`, judged); },
      },
    };
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const swapAroundOpen = (swap: { to: () => void; back: () => void }) =>
      file.open.mockImplementationOnce(async (target: string, flags: number) => {
        swap.to();
        opened = await actual.open(target, flags & ~(constants.O_NOFOLLOW ?? 0));
        const read = opened.read.bind(opened);
        vi.spyOn(opened, "read").mockImplementationOnce((async (...readArgs: Parameters<FileHandle["read"]>) => {
          swap.back();
          return read(...readArgs);
        }) as FileHandle["read"]);
        return opened;
      });
    for (const [label, swap] of Object.entries(swaps)) {
      swapAroundOpen(swap);
      await expect(readJudgedDocumentInput(judged), label).rejects.toMatchObject({ code: "read-failed" });
      expect(opened?.fd, label).toBe(-1);
      // Control: through the reader that judges no path (the engine's own files), the same swap does reach the other
      // file, so the refusal above is the judged path's check.
      swapAroundOpen(swap);
      expect((await readPreviewDocumentInput(judged)).toString(), label).toBe("key,PROTECTED");
    }
    // Nothing swapped: the judged read takes the file.
    expect((await readJudgedDocumentInput(judged)).toString()).toBe("a,b\n1,2");
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
