/** One filesystem or process check with a blocking and a non-blocking form that must observe the same fact. */
interface SyncAsyncCheck<T = unknown> {
  sync(): T;
  /** Receives the async driver's performance.now() deadline when it has one. */
  async(deadline?: number): Promise<T>;
}

/** A policy written once as a generator; each driver performs its checks and feeds the results back. */
export type Checks<T> = Generator<SyncAsyncCheck, T, unknown>;

export function* check<T>(sync: () => T, async: SyncAsyncCheck<T>["async"]): Checks<T> {
  return (yield { sync, async }) as T;
}

export function runChecksSync<T>(checks: Checks<T>): T {
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = step.value.sync();
    } catch (error) {
      step = checks.throw(error);
      continue;
    }
    step = checks.next(value);
  }
  return step.value;
}

export function throwPastDeadline(deadline: number | undefined, message: string): void {
  if (deadline !== undefined && performance.now() >= deadline) throw new DOMException(message, "TimeoutError");
}

/** With a deadline, the driver stops before each check and after each result once it has passed. */
export async function runChecksAsync<T>(checks: Checks<T>, deadline?: number, timeoutMessage = "Checks timed out"): Promise<T> {
  throwPastDeadline(deadline, timeoutMessage);
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value.async(deadline);
    } catch (error) {
      throwPastDeadline(deadline, timeoutMessage);
      step = checks.throw(error);
      continue;
    }
    throwPastDeadline(deadline, timeoutMessage);
    step = checks.next(value);
  }
  return step.value;
}
