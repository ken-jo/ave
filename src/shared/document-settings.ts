/** User-owned policy for agent requests to show a document. */
export type DocumentOpenMode = "direct" | "link";

export interface DocumentSettings {
  openMode: DocumentOpenMode;
  /**
   * The user's "open in editor" command, for example `edit --goto {file}:{line}`; empty when none is set. Main splits it
   * into a program and arguments and starts it without a shell, only when the user clicks "open in editor".
   */
  editorCommand: string;
}

export function isDocumentOpenMode(value: unknown): value is DocumentOpenMode {
  return value === "direct" || value === "link";
}
