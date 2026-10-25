/** A caller deadline may fire while handler work continues; retain operation and account leases until actual settlement. */
export class PluginRuntimeDetachedOperationError extends Error {
  readonly settlement: Promise<unknown>;

  constructor(error: Error, settlement: Promise<unknown>) {
    super(error.message, { cause: error });
    this.name = "PluginRuntimeDetachedOperationError";
    this.settlement = settlement;
  }
}

export function isPluginRuntimeDetachedOperationError(
  error: unknown,
): error is PluginRuntimeDetachedOperationError {
  return error instanceof PluginRuntimeDetachedOperationError;
}
