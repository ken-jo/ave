import { markHostRefusal } from "./host-refusal.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";

type DocumentPanelOpener = (path: string, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
let documentPanelOpener: DocumentPanelOpener | undefined;

/** Desktop composition installs this capability; document readers never import a desktop runtime. */
export function setDocumentPanelOpener(opener: DocumentPanelOpener): void {
  documentPanelOpener = opener;
}

export async function requestDocumentPanel(path: string, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (context.headless || !documentPanelOpener) {
    const unavailable = { isError: true, output: JSON.stringify({ ok: false, error: "ui-unavailable", opened: false,
      message: "The originating document panel is unavailable.", retryable: false }) };
    return context.headless ? markHostRefusal(unavailable) : unavailable;
  }
  return documentPanelOpener(path, context);
}
