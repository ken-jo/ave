import type { PreviewDocumentError } from "../shared/preview-document.js";

export class TableDocumentError extends Error {
  constructor(readonly code: PreviewDocumentError, message: string, readonly bytes?: number) {
    super(message);
    this.name = "TableDocumentError";
  }
}
