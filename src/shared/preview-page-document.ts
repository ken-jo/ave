import type { PreviewDocumentFormat, PreviewTableDocument } from "./preview-document.js";

export type PreviewPageFormat = "pptx" | "pdf";
export type PreviewAnyFormat = PreviewDocumentFormat | PreviewPageFormat;
export type PreviewDocumentFor<F extends PreviewAnyFormat> = F extends PreviewPageFormat
  ? PreviewPageDocument : PreviewTableDocument;

export const PAGE_PREVIEW_LIMITS = Object.freeze({
  maxPages: 200,
  maxParagraphs: 500,
  maxTextChars: 50_000,
  maxXmlBytes: 2 * 1024 * 1024,
  maxXmlDepth: 100,
  maxPixels: 2_000_000,
  maxSide: 1600,
  maxScale: 1.5,
  maxPngBytes: 2 * 1024 * 1024,
  maxPngChunks: 512,
  maxPngMetadataBytes: 4096,
});

export function previewPageFormatOf(path: string): PreviewPageFormat | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  return extension === "pptx" || extension === "pdf" ? extension : null;
}

export interface PreviewPageDocument {
  format: PreviewPageFormat;
  totalPages: number;
  pagesTruncated: boolean;
  page: {
    index: number;
    paragraphs: string[];
    textTruncated: boolean;
    /** Only a bounded, host-rendered PNG; no source document bytes or links. */
    png: string | null;
    width: number;
    height: number;
  };
}
