/** `verifying-installation`: an installed engine's runtime admission is running; it is not cancellable. */
type DocumentEngineInstallationPhase = "absent" | "downloading" | "verifying" | "installing"
  | "verifying-installation" | "ready" | "cancelling" | "error" | "unsupported";

export type DocumentEngineInstallationError = "download-failed" | "integrity-failed" | "signature-failed"
  | "install-failed" | "unsupported-platform" | "cancelled";

export interface DocumentEngineInstallationState {
  phase: DocumentEngineInstallationPhase;
  version: string;
  downloadBytes: number;
  downloadedBytes: number;
  installedBytes: number;
  error?: DocumentEngineInstallationError;
}
