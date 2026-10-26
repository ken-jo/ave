/** User-owned policy for agent requests to show a document. */
export type DocumentOpenMode = "direct" | "link";

export interface DocumentSettings {
  openMode: DocumentOpenMode;
}

export function isDocumentOpenMode(value: unknown): value is DocumentOpenMode {
  return value === "direct" || value === "link";
}
