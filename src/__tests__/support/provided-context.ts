/** Swap one value global setup provides to workers, for a guard test that needs a run configured another way. */
import type { ProvidedContext } from "vitest";

// Vitest has no public setter for provided values; `inject` reads them from the worker state under this name.
const WORKER_STATE = "__vitest_worker__";

/** `body` must be synchronous: the value is put back when it returns, so awaited work would run against the restored value.
 * A Promise-returning body fails to type-check, and is refused at run time too. */
export function withProvidedContext<K extends keyof ProvidedContext, R>(
  key: K,
  value: ProvidedContext[K],
  body: (() => R) & (R extends PromiseLike<unknown> ? never : unknown),
): R {
  const state = (globalThis as Record<string, unknown>)[WORKER_STATE] as { providedContext?: Record<string, unknown> } | undefined;
  const provided = state?.providedContext;
  if (!provided) throw new Error(`withProvidedContext: no vitest worker state at globalThis.${WORKER_STATE}; vitest changed how inject reads it`);
  const had = Object.hasOwn(provided, key);
  const saved = provided[key];
  provided[key] = value;
  try {
    const result = body();
    if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
      throw new Error("withProvidedContext: body returned a promise; the provided value is restored before awaited work runs, so pass a synchronous body");
    }
    return result;
  } finally {
    if (had) provided[key] = saved;
    else delete provided[key];
  }
}
