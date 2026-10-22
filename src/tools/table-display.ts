import type { PreviewDocumentLimits } from "../shared/preview-document.js";

export function clipTableCell(value: string, limits: Readonly<PreviewDocumentLimits>): { text: string; clipped: boolean } {
  if (value.length <= limits.maxCellChars) return { text: value, clipped: false };
  return { text: `${value.slice(0, limits.maxCellChars)}…`, clipped: true };
}
