/**
 * `app-missing`: LibreOffice, which the user installs like any other app, is not installed. `absent`: it is, and Ave's
 * import extension is not. `verifying-installation`: the found app's admission is running; it is not cancellable.
 */
type DocumentEngineInstallationPhase = "app-missing" | "absent" | "downloading" | "verifying" | "installing"
  | "verifying-installation" | "ready" | "cancelling" | "error" | "unsupported";

export type DocumentEngineInstallationError = "download-failed" | "integrity-failed" | "signature-failed"
  | "install-failed" | "unsupported-platform" | "cancelled" | "app-missing";

export interface DocumentEngineInstallationState {
  phase: DocumentEngineInstallationPhase;
  version: string;
  downloadBytes: number;
  downloadedBytes: number;
  installedBytes: number;
  error?: DocumentEngineInstallationError;
  /**
   * Linux only: the engine is unsupported there until the slice 8 flip (lead decision 2026-11-28), but a confined payload
   * an earlier Ave installed is still on disk and may be removed. Absent everywhere else.
   */
  legacyPayload?: true;
}
