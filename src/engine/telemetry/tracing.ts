// Keep tracing SDKs behind dynamic imports so default-off runs never evaluate them.
// Turn logic sees only the tracer API; this module owns sinks and span vocabulary.
import { context as otelContext, trace, type Tracer } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
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
  | { kind: "file"; path: string }
  | { error: string };

export interface TracingHandle {
  readonly tracer: Tracer;
  readonly enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Empty and off disable tracing; reject unknown sink names instead of silently losing evidence. */
export function parseTelemetrySpec(raw: string | undefined): TelemetrySpec {
  const value = raw?.trim() ?? "";
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
