// Invalid telemetry sink names must fail rather than silently produce no trace.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

import {
  buildMainBoundaryBundle,
  childBundleDir,
  repositoryRoot,
} from "../../../plugins/isolation/__tests__/child-entry-bundle.js";

import {
  configureTracing,
  createStepTracer,
  decisionAttributes,
  parseTelemetrySpec,
  TURN_SPAN_NAME,
} from "../tracing.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ave-tracing-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  context.disable();
  trace.disable();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseTelemetrySpec", () => {
  it.each(["1", "otlp:https://collector.invalid/v1/traces", "file:remote", "true"])(
    "never interprets AVE_TRACE=%s as remote export authority", (legacy) => {
      vi.stubEnv("AVE_TRACE", legacy);
      expect(parseTelemetrySpec(undefined)).toHaveProperty("kind", legacy === "1" ? "file" : "off");
      expect(parseTelemetrySpec("off")).toEqual({ kind: "off" });
      expect(parseTelemetrySpec("invalid")).toHaveProperty("error");
      expect(parseTelemetrySpec("file:local.jsonl")).toEqual({ kind: "file", path: "local.jsonl" });
    },
  );
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["off", "off"],
  ])("treats %s as off", (_label, raw) => {
    expect(parseTelemetrySpec(raw)).toEqual({ kind: "off" });
  });

  it("accepts an OTLP http(s) collector and normalizes the URL", () => {
    expect(parseTelemetrySpec("otlp:http://127.0.0.1:4318/v1/traces")).toEqual({
      kind: "otlp",
      url: "http://127.0.0.1:4318/v1/traces",
    });
  });

  it("accepts a file sink and keeps the path verbatim", () => {
    expect(parseTelemetrySpec("file:/var/log/ave/spans.jsonl")).toEqual({
      kind: "file",
      path: "/var/log/ave/spans.jsonl",
    });
  });

  it.each([
    ["a sink with no separator", "otlp"],
    ["an unknown sink", "syslog:/dev/log"],
    ["an empty target", "file:"],
    ["a non-URL otlp target", "otlp:not a url"],
    ["a non-http otlp scheme", "otlp:file:///tmp/spans"],
  ])("reports %s as an error rather than silently disabling", (_label, raw) => {
    const spec = parseTelemetrySpec(raw);
    expect(spec).toHaveProperty("error");
    expect((spec as { error: string }).error).toContain("AVE_TELEMETRY");
  });
});

describe("step events", () => {
  it("uses a standalone span without an active span and drops content and unbounded metadata", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    const emitter = createStepTracer("standalone-session", provider.getTracer("test"));
    emitter.step("LLM_STREAM_ERROR", {
      round: 2, inputLen: 50, reopenedThink: false, textLen: Infinity,
      prompt: "private-prompt", toolArgs: { path: "private-file" },
      providerError: { messagePreview: "private-error" }, request: { content: "private-request" },
      status: "private-status", model: "private-model", toolNames: ["private-tool"],
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toEqual({ "ave.session_id": "standalone-session" });
    expect(spans[0].events[0].attributes).toEqual({
      "ave.step": "LLM_STREAM_ERROR", "ave.step.round": 2, "ave.step.inputLen": 50, "ave.step.reopenedThink": false,
    });
    expect(JSON.stringify(spans[0].events)).not.toContain("private-");
    await provider.shutdown();
  });
  it("keeps closed diagnostic codes and drops free text under the same keys", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    const emitter = createStepTracer("codes-session", provider.getTracer("test"));
    emitter.step("PREFLIGHT_GUARD", { outcome: "skipped", reason: "recovery-budget-exhausted" });
    emitter.step("LLM_STREAM_ERROR", { classification: "rate-limit", reason: "Private reason: C:\secret" });
    emitter.step("COMPACTION_RESULT", { status: "applied", triggerSource: "force-recover" });
    const events = exporter.getFinishedSpans().map((span) => span.events[0].attributes);
    expect(events).toEqual([
      { "ave.step": "PREFLIGHT_GUARD", "ave.step.outcome": "skipped", "ave.step.reason": "recovery-budget-exhausted" },
      { "ave.step": "LLM_STREAM_ERROR", "ave.step.classification": "rate-limit" },
      { "ave.step": "COMPACTION_RESULT", "ave.step.status": "applied", "ave.step.triggerSource": "force-recover" },
    ]);
    await provider.shutdown();
  });
});

describe("decisionAttributes", () => {
  it("flattens kind, branch, reason and data under one prefix", () => {
    expect(decisionAttributes({
      kind: "length.continuation",
      branch: "stop",
      reason: "cap",
      data: { continuationsRun: 3, cap: 3, carryTextChars: 120 },
    })).toEqual({
      "ave.decision.kind": "length.continuation",
      "ave.decision.branch": "stop",
      "ave.decision.reason": "cap",
      "ave.decision.data.continuationsRun": 3,
      "ave.decision.data.cap": 3,
      "ave.decision.data.carryTextChars": 120,
    });
  });

  it("omits an absent reason instead of writing an empty one", () => {
    expect(decisionAttributes({ kind: "tool_batch", branch: "single" })).toEqual({
      "ave.decision.kind": "tool_batch",
      "ave.decision.branch": "single",
    });
  });
});

describe("configureTracing", () => {
  it("routes the legacy switch through the local exporter and caps step events", async () => {
    const home = tempDir();
    vi.stubEnv("AVE_HOME", home);
    const spec = parseTelemetrySpec(undefined, "1");
    expect(spec).toMatchObject({ kind: "file", legacyLocal: true });
    if (!("kind" in spec) || spec.kind !== "file") throw new Error("Expected local sink");
    const handle = await configureTracing(spec, "local-test");
    const stepTracer = createStepTracer("legacy-session", handle.tracer);
    handle.tracer.startActiveSpan(TURN_SPAN_NAME, span => {
      for (let round = 0; round < 200; round++) stepTracer.step("LLM_STREAM", { round });
      span.end();
    });
    await handle.shutdown();
    const lines = readFileSync(spec.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]);
    expect(written.events).toHaveLength(128);
    expect(written.events[0]).toMatchObject({ name: "ave.step", attributes: { "ave.step": "LLM_STREAM", "ave.step.round": 72 } });
    expect(written.events.map((event: { attributes: Record<string, unknown> }) => event.attributes["ave.step.round"]))
      .toEqual(Array.from({ length: 128 }, (_, index) => index + 72));
    expect(readdirSync(join(home, "traces"))).toEqual(["spans"]);
  });

  it("leaves tracing off when the legacy sink cannot be prepared", async () => {
    const home = join(tempDir(), "not-a-directory");
    writeFileSync(home, "");
    vi.stubEnv("AVE_HOME", home);
    const spec = parseTelemetrySpec(undefined, "1");
    if (!("kind" in spec) || spec.kind !== "file") throw new Error("Expected local sink");
    const handle = await configureTracing(spec, "local-test");
    expect(handle.tracer.startSpan("probe").isRecording()).toBe(false);
    await handle.shutdown();
  });

  it("registers nothing when tracing is off and hands back a non-recording tracer", async () => {
    const handle = await configureTracing({ kind: "off" }, "0.0.0-test");

    expect(handle.enabled).toBe(false);
    const span = handle.tracer.startSpan(TURN_SPAN_NAME);
    expect(span.isRecording()).toBe(false);
    span.end();
    await expect(handle.forceFlush()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("treats a malformed spec as off rather than throwing at the caller", async () => {
    const handle = await configureTracing({ error: "bad spec" }, "0.0.0-test");

    expect(handle.enabled).toBe(false);
    await handle.shutdown();
  });

  it("exports completed spans without shutting down, then records subsequent work", async () => {
    const path = join(tempDir(), "spans.jsonl");
    const previous = '{"legacy":"preserved"}\n';
    writeFileSync(path, previous);
    const handle = await configureTracing({ kind: "file", path }, "9.9.9-test");
    expect(handle.enabled).toBe(true);

    const span = handle.tracer.startSpan(TURN_SPAN_NAME, {
      attributes: { "ave.session_id": "session-under-test" },
    });
    span.addEvent("ave.decision", { "ave.decision.kind": "early_exit" });
    span.end();
    await handle.forceFlush();

    expect(readFileSync(path, "utf8").startsWith(previous)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(1);
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]) as {
      name: string;
      traceId: string;
      spanId: string;
      durationMs: number;
      attributes: Record<string, unknown>;
      events: Array<{ name: string; attributes: Record<string, unknown> }>;
    };
    expect(written.name).toBe(TURN_SPAN_NAME);
    expect(written.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(written.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(written.durationMs).toBeGreaterThanOrEqual(0);
    expect(written.attributes["ave.session_id"]).toBe("session-under-test");
    expect(written.events).toEqual([
      expect.objectContaining({
        name: "ave.decision",
        attributes: { "ave.decision.kind": "early_exit" },
      }),
    ]);
    handle.tracer.startSpan("after-flush").end();
    await handle.shutdown();
    expect(readFileSync(path, "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line).name))
      .toEqual([TURN_SPAN_NAME, "after-flush"]);
  });
});

// Exercise default-only split dependency chunks; the test loader would hide packaged ESM interop failures.
describe("configureTracing through the shipped bundle boundary", () => {
  const bundleDir = childBundleDir("tracing-bundle");
  let bundled: typeof import("../tracing.js");

  beforeAll(async () => {
    await buildMainBoundaryBundle({
      entryPoints: { tracing: join(repositoryRoot(), "src/engine/telemetry/tracing.ts") },
      outdir: bundleDir,
      splitting: true,
    });
    expect(readdirSync(join(bundleDir, "chunks")).length).toBeGreaterThan(0);
    bundled = (await import(
      pathToFileURL(join(bundleDir, "tracing.mjs")).href
    )) as typeof import("../tracing.js");
  });

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it("resolves the OpenTelemetry SDK from a split ESM chunk and writes a span", async () => {
    const path = join(tempDir(), "spans.jsonl");
    const handle = await bundled.configureTracing({ kind: "file", path }, "9.9.9-bundle");
    expect(handle.enabled).toBe(true);
    handle.tracer.startSpan("bundle-probe").end();
    await handle.shutdown();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { name: string }).name).toBe("bundle-probe");
  });

  it("constructs the OTLP exporter from its chunk", async () => {
    const handle = await bundled.configureTracing(
      { kind: "otlp", url: "http://127.0.0.1:9/v1/traces" },
      "9.9.9-bundle",
    );
    expect(handle.enabled).toBe(true);
    await handle.shutdown();
  });
});
