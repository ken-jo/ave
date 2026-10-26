import type { DocumentOpenRequest } from "../../../shared/document-open.js";
import type { AvePreviewApi } from "../types.js";

export interface DocumentPanelHost {
  sessionId: () => string | null;
  isVisible: () => boolean;
  openDocument: (path: string, expiresAt: number) => Promise<boolean>;
}
const hosts: DocumentPanelHost[] = [];
let unsubscribe: (() => void) | undefined;

/** Route only to a visible tile that still holds the exact originating conversation. */
export async function openDocumentInPanel(path: string, sessionId: string, expiresAt: number): Promise<boolean> {
  if (Date.now() >= expiresAt) return false;
  const host = hosts.find((candidate) => candidate.sessionId() === sessionId && candidate.isVisible());
  if (!host) return false;
  return host.openDocument(path, expiresAt);
}

export function registerDocumentPanelHost(api: AvePreviewApi | undefined, host: DocumentPanelHost): () => void {
  hosts.push(host);
  if (!unsubscribe && api?.onDocumentOpen) {
    unsubscribe = api.onDocumentOpen((request: DocumentOpenRequest) => {
      void openDocumentInPanel(request.path, request.sessionId, request.expiresAt).then((opened) =>
        api.acknowledgeDocumentOpen({ requestId: request.requestId, sessionId: request.sessionId, opened }),
      ).catch(() => undefined);
    });
  }
  return () => {
    const index = hosts.indexOf(host);
    if (index >= 0) hosts.splice(index, 1);
    if (hosts.length === 0) { unsubscribe?.(); unsubscribe = undefined; }
  };
}
