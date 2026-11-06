import { AsyncLocalStorage } from "node:async_hooks";
import type { RoutineRunMetrics } from "../shared/routines-types.js";
import type { TokenUsage } from "./llm/types.js";
import type { SubscriptionUsageTelemetry } from "../shared/subscription-runtime.js";
import { aggregateSubscriptionUsage } from "./turn/subscription-usage-telemetry.js";

type UsageSource = () => { usage?: TokenUsage; subscriptionUsage: readonly SubscriptionUsageTelemetry[] };
const routineUsageContext = new AsyncLocalStorage<{ sources: Set<UsageSource>; observedSessionId?: string }>();

export function observeRoutineSession(sessionId: string): void {
  const context = routineUsageContext.getStore();
  if (context) context.observedSessionId = sessionId;
}

/** Observe the query loop's existing usage accumulator, including partial usage when it throws. */
export function observeRoutineTurnUsage(source: UsageSource): void {
  routineUsageContext.getStore()?.sources.add(source);
}

/** Each invocation owns its sources; concurrent fires and earlier chat turns cannot leak into this run. */
export function captureRoutineRun<T>(run: () => Promise<T>): { result: Promise<T>; metrics: () => RoutineRunMetrics; sessionId: () => string | undefined } {
  const sources = new Set<UsageSource>();
  const context = { sources, observedSessionId: undefined as string | undefined };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let durationMs: number | undefined;
  const result = routineUsageContext.run(context, async () => {
    try {
      return await run();
    } finally {
      durationMs = Math.max(0, performance.now() - started);
    }
  });
  return { result, sessionId: () => context.observedSessionId, metrics: () => {
    if (durationMs === undefined) throw new Error("Routine run has not ended");
    let tokens: RoutineRunMetrics["tokens"];
    for (const source of sources) {
      const { usage, subscriptionUsage } = source();
      let current: NonNullable<RoutineRunMetrics["tokens"]>;
      if (subscriptionUsage.length > 0) {
        const total = aggregateSubscriptionUsage(subscriptionUsage);
        current = { input: total.inputTokens, output: total.outputTokens + total.reasoningOutputTokens, total: total.totalTokens };
      } else if (usage !== undefined) {
        const input = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0));
        current = { input, output: usage.outputTokens, total: input + usage.outputTokens };
      } else continue;
      tokens = { input: (tokens?.input ?? 0) + current.input, output: (tokens?.output ?? 0) + current.output, total: (tokens?.total ?? 0) + current.total };
    }
    return { startedAt, durationMs, ...(tokens !== undefined ? { tokens } : {}) };
  } };
}
