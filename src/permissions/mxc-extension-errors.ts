import { t } from "../i18n/index.js";

export class MxcProcessContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcProcessContractError";
  }
}

export class MxcProcessCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcProcessCleanupError";
  }
}

export class MxcSupervisorLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcSupervisorLostError";
  }
}

export class MxcCapabilityUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcCapabilityUnavailableError";
  }
}

export class WorkerTransportUnsupportedError extends Error {
  readonly code = "worker-transport-unsupported";
  constructor() {
    super(t("be_mxcExtensionErrors.workerTransportUnsupported", { code: "worker-transport-unsupported" }));
    this.name = "WorkerTransportUnsupportedError";
  }
}

/** Extension backend readiness is checking or rejected: the start is refused, never run unconfined. A contract error, so
 * callers that treat readiness refusals as `MxcProcessContractError` keep doing so. */
export class MxcExtensionReadinessRefusedError extends MxcProcessContractError {
  readonly code = "extension-readiness-refused";
  constructor() {
    super(t("be_mxcExtensionErrors.readinessRefused", { code: "extension-readiness-refused" }));
    this.name = "MxcExtensionReadinessRefusedError";
  }
}

/** A selected container backend refuses a holder adapter that still creates processes through the legacy wrap. */
export class MxcNativeEntryRequiredError extends Error {
  readonly code = "native-entry-required";
  constructor() {
    super(t("be_mxcExtensionErrors.nativeEntryRequired", { code: "native-entry-required" }));
    this.name = "MxcNativeEntryRequiredError";
  }
}
