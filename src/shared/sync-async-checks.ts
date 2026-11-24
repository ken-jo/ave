/** One filesystem or process check with a blocking and a non-blocking form that must observe the same fact. */
interface SyncAsyncCheck<T = unknown> {
  sync(): T;
  async(): Promise<T>;
}

/** A policy written once as a generator; each driver performs its checks and feeds the results back. */
export type Checks<T> = Generator<SyncAsyncCheck, T, unknown>;

export function* check<T>(sync: () => T, async: () => Promise<T>): Checks<T> {
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

export async function runChecksAsync<T>(checks: Checks<T>): Promise<T> {
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value.async();
    } catch (error) {
      step = checks.throw(error);
      continue;
    }
    step = checks.next(value);
  }
  return step.value;
}
