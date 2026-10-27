import type { ObservedDocument } from "../shared/agent-observation.js";
import { previewPageFormatOf, type PreviewAnyFormat } from "../shared/preview-page-document.js";
import { readDocumentResponse } from "../tools/preview-document-protocol.js";
import { readPageDocumentResponse } from "../tools/preview-page-protocol.js";
import { readObservedTextDocument } from "./text-document.js";

export function observedSelectionIndex(document: ObservedDocument): number {
  if (document.format === "text") return 0;
  return "sheet" in document ? document.sheet.index : document.page.index;
}

export function readObservedDocument(value: unknown, baseline: ObservedDocument): ObservedDocument {
  return readObservedDocumentSelection(value, baseline.format, observedSelectionIndex(baseline));
}

export function readObservedDocumentSelection(value: unknown, format: PreviewAnyFormat | "text", index: number): ObservedDocument {
  const document = format === "text" ? readObservedTextDocument(value)
    : previewPageFormatOf(`document.${format}`) ? readPageDocumentResponse(value) : readDocumentResponse(value);
  if (document.format !== format || observedSelectionIndex(document) !== index) {
    throw new Error("Observation engine returned a different document selection.");
  }
  return document;
}
