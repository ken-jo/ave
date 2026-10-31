type AbortableDeadlineTerminationReason =
  | "deadline"
  | "caller-abort"
  | "error";

export type AbortableDeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: AbortableDeadlineTerminationReason;
      readonly error: Error;
    };

export interface AbortableDeadlineOptions {
  readonly deadlineMs: number;
  readonly callerAbortSignal?: AbortSignal;
  readonly createDeadlineError?: (deadlineMs: number) => Error;
}

function errorFrom(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(String(value ?? fallback));
}

/** Abort rejects immediately with the signal reason; expiry and abort clean up each other’s timer or listener. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(errorFrom(signal.reason, "aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(errorFrom(signal?.reason, "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bound waiting without cancelling work; late rejections stay observed and the caller owns cancellation. */
export async function raceWithTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop waiting on caller cancellation; late completion stays observed and the caller owns work cleanup. */
export async function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await operation;
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(errorFrom(signal.reason, "caller aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Link caller cancellation and a hard deadline; the race also bounds work that ignores the signal. */
export async function runWithAbortableDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: AbortableDeadlineOptions,
): Promise<AbortableDeadlineOutcome<T>> {
  const controller = new AbortController();
  const callerSignal = options.callerAbortSignal;
  const callerAbortError = (): Error =>
    errorFrom(callerSignal?.reason, "caller aborted");
  const deadlineError = (): Error =>
    options.createDeadlineError?.(options.deadlineMs) ??
    new Error(`deadline exceeded after ${options.deadlineMs}ms`);

  if (callerSignal?.aborted) {
    return { ok: false, reason: "caller-abort", error: callerAbortError() };
  }

  let boundaryReason: "deadline" | "caller-abort" | null = null;
  let interruptionSettled = false;
  let resolveInterruption: (outcome: AbortableDeadlineOutcome<T>) => void = () => {};
  const interruptionOutcome = new Promise<AbortableDeadlineOutcome<T>>((resolve) => {
    resolveInterruption = (outcome) => {
      if (interruptionSettled) return;
      interruptionSettled = true;
      resolve(outcome);
    };
  });

  const interrupt = (
    reason: "deadline" | "caller-abort",
    error: Error,
  ): void => {
    if (boundaryReason !== null) return;
    boundaryReason = reason;
    resolveInterruption({ ok: false, reason, error });
    controller.abort(error);
  };

  const timer = setTimeout(
    () => interrupt("deadline", deadlineError()),
    options.deadlineMs,
  );
  const onCallerAbort = (): void => {
    interrupt("caller-abort", callerAbortError());
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  // Close the subscribe-after-check race.
  if (callerSignal?.aborted) onCallerAbort();

  const taskOutcome = Promise.resolve()
    .then(() => task(controller.signal))
    .then((value): AbortableDeadlineOutcome<T> => ({ ok: true, value }))
    .catch((error): AbortableDeadlineOutcome<T> => {
      if (boundaryReason !== null) {
        return {
          ok: false,
          reason: boundaryReason,
          error: boundaryReason === "caller-abort"
            ? callerAbortError()
            : deadlineError(),
        };
      }
      if (callerSignal?.aborted) {
        return { ok: false, reason: "caller-abort", error: callerAbortError() };
      }
      return {
        ok: false,
        reason: "error",
        error: errorFrom(error, "task failed"),
      };
    });

  try {
    return await Promise.race([taskOutcome, interruptionOutcome]);
  } finally {
    interruptionSettled = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
