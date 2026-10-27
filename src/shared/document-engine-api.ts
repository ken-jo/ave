import type { DocumentEngineInstallationError, DocumentEngineInstallationState } from "./document-engine.js";

export type DocumentEngineApiError = DocumentEngineInstallationError | "unauthorized" | "bad-request" | "busy";
export type DocumentEngineActionResult = { ok: true } | { ok: false; error: DocumentEngineApiError };
export type DocumentEngineStatusResult = { ok: true; state: DocumentEngineInstallationState }
  | { ok: false; error: DocumentEngineApiError };

/** Local installation controls accept no document, executable path or download target. */
export interface DocumentEngineApi {
  status(): Promise<DocumentEngineStatusResult>;
  install(): Promise<DocumentEngineActionResult>;
  cancel(): Promise<DocumentEngineActionResult>;
  uninstall(): Promise<DocumentEngineActionResult>;
}
