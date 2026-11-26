export class HostExitAbortError extends Error {
  readonly hostExit = true as const;

  constructor() {
    super("application shutdown");
    this.name = "HostExitAbortError";
  }
}

export function isHostExitAbort(reason: unknown): boolean {
  return reason instanceof HostExitAbortError;
}
