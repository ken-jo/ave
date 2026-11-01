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
    super("Selected container backend requires native streams; workers require stdio control v1. Update the process adapter and its client before starting it");
    this.name = "WorkerTransportUnsupportedError";
  }
}
