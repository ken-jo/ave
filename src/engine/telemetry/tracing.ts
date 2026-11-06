// Keep tracing SDKs behind dynamic imports so default-off runs never evaluate them.
// Turn logic sees only the tracer API; this module owns sinks and span vocabulary.
import { context as otelContext, trace, type Tracer } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import { join } from "node:path";
import { aveHome } from "../../shared/ave-home.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { appendFileSync } from "node:fs";
import { createLogger } from "../../lib/logger.js";
import type { TurnDecisionEvent } from "../turn/types.js";

const log = createLogger("ave");

export const TURN_SPAN_NAME = "ave.turn";
export const TOOL_SPAN_PREFIX = "execute_tool ";
export const DECISION_EVENT_NAME = "ave.decision";

// Off registers no tracer provider.
export type TelemetrySpec =
  | { kind: "off" }
  | { kind: "otlp"; url: string }
  | { kind: "file"; path: string; legacyLocal?: boolean }
  | { error: string };

export interface TracingHandle {
  readonly tracer: Tracer;
  readonly enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Explicit sinks take precedence; the legacy switch can request only a local file. */
export function parseTelemetrySpec(
  raw: string | undefined,
  legacyTrace: string | undefined = process.env.AVE_TRACE,
): TelemetrySpec {
  const value = raw?.trim() ?? "";
  if (value.length === 0 && legacyTrace === "1") {
    return { kind: "file", path: join(aveHome(), "traces", "spans", "trace-spans.jsonl"), legacyLocal: true };
  }
  if (value.length === 0 || value === "off") return { kind: "off" };
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { error: `AVE_TELEMETRY must be "off", "otlp:<url>" or "file:<path>", got "${value}"` };
  }
  const kind = value.slice(0, separator);
  const target = value.slice(separator + 1).trim();
  if (target.length === 0) {
    return { error: `AVE_TELEMETRY "${kind}" needs a target, got "${value}"` };
  }
  if (kind === "otlp") {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return { error: `AVE_TELEMETRY otlp target is not a URL: "${target}"` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: `AVE_TELEMETRY otlp target must be http(s), got "${url.protocol}"` };
    }
    return { kind: "otlp", url: url.toString() };
  }
  if (kind === "file") return { kind: "file", path: target };
  return { error: `AVE_TELEMETRY sink must be "otlp" or "file", got "${kind}"` };
}

export function decisionAttributes(
  event: TurnDecisionEvent,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    "ave.decision.kind": event.kind,
    "ave.decision.branch": event.branch,
  };
  if (event.reason !== undefined) attributes["ave.decision.reason"] = event.reason;
  for (const [key, value] of Object.entries(event.data ?? {})) {
    attributes[`ave.decision.data.${key}`] = value;
  }
  return attributes;
}

interface ExportedSpanLine {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timeMs: number; attributes: Record<string, unknown> }>;
  status: { code: number; message?: string };
}

function hrTimeToMs(time: readonly [number, number]): number {
  return time[0] * 1e3 + time[1] / 1e6;
}

/** Append JSON lines using the shape consumed by trace readers. */
function createFileSpanExporter(path: string): SpanExporter {
  const writeSpans = (spans: readonly ReadableSpan[]): void => {
    if (spans.length === 0) return;
    const lines = spans
      .map((span) => {
        const context = span.spanContext();
        const line: ExportedSpanLine = {
          traceId: context.traceId,
          spanId: context.spanId,
          ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeMs: hrTimeToMs(span.startTime),
          endTimeMs: hrTimeToMs(span.endTime),
          durationMs: hrTimeToMs(span.duration),
          attributes: span.attributes,
          events: span.events.map((event) => ({
            name: event.name,
            timeMs: hrTimeToMs(event.time),
            attributes: event.attributes ?? {},
          })),
          status: span.status,
        };
        return JSON.stringify(line);
      })
      .join("\n");
    appendFileSync(path, `${lines}\n`, { mode: 0o600 });
  };

  return {
    export(spans, done) {
      try {
        writeSpans(spans);
        // Keep result codes numeric to avoid eagerly importing the tracing SDK.
        done({ code: 0 });
      } catch (err) {
        done({ code: 1, error: err as Error });
      }
    },
    async shutdown() {
      // Writes are synchronous; only the processor itself needs flushing.
    },
    async forceFlush() {},
  };
}

function offHandle(): TracingHandle {
  return {
    tracer: trace.getTracer("ave"),
    enabled: false,
    async forceFlush() {},
    async shutdown() {},
  };
}

/** Install async context with the provider so generated spans nest under the active turn. */
export async function configureTracing(
  spec: TelemetrySpec,
  appVersion: string,
): Promise<TracingHandle> {
  if ("error" in spec || spec.kind === "off") return offHandle();
  if (spec.kind === "file" && spec.legacyLocal) {
    // An unusable legacy sink leaves tracing off; a debugging switch must not stop boot.
    try {
      await openFeatureNamespace("traces").childDir("spans");
    } catch (err) {
      log.warn("tracing: AVE_TRACE sink unavailable, tracing off: %s", (err as Error).message);
      return offHandle();
    }
  }

  const [
    { BatchSpanProcessor, TracerProvider },
    { resourceFromAttributes },
    { AsyncLocalStorageContextManager },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/context-async-hooks"),
  ]);
  const exporter = spec.kind === "file"
    ? createFileSpanExporter(spec.path)
    : new (await import("@opentelemetry/exporter-trace-otlp-http")).OTLPTraceExporter({
        url: spec.url,
      });
  const provider = new TracerProvider({
    spanLimits: { attributePerEventCountLimit: 32 },
    resource: resourceFromAttributes({
      "service.name": "ave",
      "service.version": appVersion,
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const tracer = provider.getTracer("ave");
  const [{ registerTelemetry }, { OpenTelemetry }] = await Promise.all([
    import("ai"),
    import("@ai-sdk/otel"),
  ]);
  registerTelemetry(new OpenTelemetry({ tracer, usage: true }));
  log.info(`telemetry: tracing to ${spec.kind === "file" ? spec.path : spec.url}`);

  return {
    tracer,
    enabled: true,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}

export type TraceStepName =
  | "REQUEST_ENTRY"         // 1. renderer → main IPC
  | "ROUTE_RESOLVE"         // 2. Resolve the input route
  | "TURN_ORCHESTRATE"      // 3. Enter runTurn()
  | "HISTORY_APPEND"        // 4. Append user message
  | "PROMPT_ASSEMBLE"       // 5. Assemble system prompt
  | "LLM_STREAM"            // 6. Start provider.streamTurn
  | "LLM_STREAM_ERROR"      // 6b. Structure provider.streamTurn error
  | "TOOL_SCHEMA_REJECTED"  // 6c. provider 400(invalid_function_parameters) -> drop tool and retry round
  | "REASONING_ACCUMULATE"  // 7. Finish accumulating reasoning_delta for the round
  | "TOOL_EXECUTE"          // 8. ToolExecutor.executeAll
  | "ROUND_COMMIT"          // 9. Commit assistant_round
  | "POST_TURN"             // 10. PostTurnHookChain.run
  | "GUIDANCE_INJECTED"     // out-of-band — mid-stream "guide" utterance consumed at round boundary
  | "LENGTH_CONTINUATION"   // Continue a truncated answer.
  | "REASONING_ONLY_CONTINUATION" // out-of-band — end_turn round with reasoning but no answer and no tool call -> re-prompt for the action the reasoning named
  | "PREFLIGHT_GUARD"       // out-of-band — runPreflightGuard decision: fired / skipped / not-reached, and why
  | "COMPACTION_RESULT";    // out-of-band — outcome of an LLM compaction triggered by PREFLIGHT_GUARD: applied / noop / error

export interface ConversationTracer {
  step(name: TraceStepName, meta?: Record<string, unknown>): void;
}

// Only known scalar measurements cross the export boundary. Objects, names and error text stay local.
const STEP_MEASUREMENTS = [
  "inputLen", "historySize", "promptLen", "activePlugins", "round", "assistantRoundIndex",
  "toolCount", "len", "continuationsRun", "carryTextLen", "reopenedThink", "thoughtLen",
  "textLen", "toolCallCount", "nudgesRun", "removedCount", "estimatedAfter", "compactNum",
  "estimated", "contextTokensIn", "threshold", "contextWindow",
  "loadedToolCount", "deferredCatalogCount",
] as const;
const STEP_LABELS: Readonly<Record<string, readonly string[]>> = {
  route: ["command", "llm"],
  role: ["user"],
  status: ["noop", "applied", "error"],
  outcome: ["fired", "skipped", "not-reached"],
  stopReason: ["end_turn", "tool_use", "max_tokens", "length", "stream-error", "aborted", "round-cap"],
};
// Closed kebab-case codes (guard reasons, compaction triggers, stream error classes); free text never matches.
const STEP_CODES = ["reason", "triggerSource", "classification"] as const;
const STEP_CODE = /^[a-z][a-z-]{0,47}$/;

/** Emit bounded events through the span provider; never open a second trace writer. */
export function createStepTracer(sessionId: string, tracer: Tracer = trace.getTracer("ave")): ConversationTracer {
  return {
    step(name, meta) {
      const attributes: Record<string, string | number | boolean> = { "ave.step": name };
      for (const key of STEP_MEASUREMENTS) {
        const value = meta?.[key];
        if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
          attributes[`ave.step.${key}`] = value;
        }
      }
      for (const [key, labels] of Object.entries(STEP_LABELS)) {
        const value = meta?.[key];
        if (typeof value === "string" && labels.includes(value)) attributes[`ave.step.${key}`] = value;
      }
      for (const key of STEP_CODES) {
        const value = meta?.[key];
        if (typeof value === "string" && STEP_CODE.test(value)) attributes[`ave.step.${key}`] = value;
      }
      const active = trace.getActiveSpan();
      if (active) {
        active.addEvent("ave.step", attributes);
      } else {
        const span = tracer.startSpan("ave.step", { attributes: { "ave.session_id": sessionId } });
        span.addEvent("ave.step", attributes);
        span.end();
      }
    },
  };
}
