import { beforeEach, describe, expect, it, vi } from "vitest";
import { pdfFixture } from "../../__tests__/support/page-document-fixtures.js";
import { parsePageDocument } from "../page-document-reader.js";
import { TableDocumentError } from "../table-document-error.js";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument,
  GlobalWorkerOptions: {},
}));

beforeEach(() => { getDocument.mockReset(); });

describe("page document factory errors", () => {
  it("classifies a synchronous document factory error as a corrupt document", async () => {
    getDocument.mockImplementationOnce(() => { throw new Error("Document factory failed synchronously"); });
    const result = parsePageDocument(pdfFixture(), "pdf", 0);
    await expect(result).rejects.toBeInstanceOf(TableDocumentError);
    await expect(result).rejects.toMatchObject({ code: "corrupt-document" });
    expect(getDocument).toHaveBeenCalledOnce();
  });

  it("preserves the encrypted classification when cleanup has no loading task", async () => {
    const error = new Error("Document requires a password");
    error.name = "PasswordException";
    getDocument.mockImplementationOnce(() => { throw error; });
    const result = parsePageDocument(pdfFixture(), "pdf", 0);
    await expect(result).rejects.toBeInstanceOf(TableDocumentError);
    await expect(result).rejects.toMatchObject({ code: "encrypted" });
    expect(getDocument).toHaveBeenCalledOnce();
  });
});
