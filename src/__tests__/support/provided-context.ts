/** Swap one value global setup provides to workers, for a guard test that needs a run configured another way. */
import type { ProvidedContext } from "vitest";

// Vitest has no public setter for provided values; `inject` reads them from the worker state under this name.
const WORKER_STATE = "__vitest_worker__";

export function withProvidedContext<K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K], body: () => void): void {
  const state = (globalThis as Record<string, unknown>)[WORKER_STATE] as { providedContext?: Record<string, unknown> } | undefined;
  const provided = state?.providedContext;
  if (!provided) throw new Error(`withProvidedContext: no vitest worker state at globalThis.${WORKER_STATE}; vitest changed how inject reads it`);
  const had = Object.hasOwn(provided, key);
  const saved = provided[key];
  provided[key] = value;
  try {
    body();
  } finally {
    if (had) provided[key] = saved;
    else delete provided[key];
  }
}
