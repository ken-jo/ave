import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import url from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { linearGrowthBound } from "../../../__tests__/support/cpu-growth.js";
import { exponentialBacktrackingRegex, quadraticEntityDecoder } from "./dlp-performance-mutations.js";

type Scrubber = (text: string) => string;
type Operation = "home text" | "home path" | "diagnostic secrets" | "display secrets"
  | "quadratic entity decoder" | "exponential backtracking regex";

export interface DlpPerformanceCase {
  readonly label: string;
  readonly operation: Operation;
  readonly small: string;
  readonly large: string;
  readonly unchanged?: true;
}

export interface DlpPerformanceRequest {
  readonly cases: readonly DlpPerformanceCase[];
  readonly home?: { readonly path: string; readonly platform: "win32" | "linux" };
}

export type DlpPerformanceMessage =
  | { readonly kind: "started"; readonly label: string }
  | { readonly kind: "complete" };

// Amortize timer precision and call overhead, including on platforms that
// charge thread CPU in ticks. Warm both inputs before taking either sample.
const SAMPLE_CPU_MS = 25;

function cpuMsPerCall(run: () => string): number {
  const started = process.threadCpuUsage();
  let calls = 0;
  let elapsedMs: number;
  do {
    run();
    calls++;
    const { user, system } = process.threadCpuUsage(started);
    elapsedMs = (user + system) / 1_000;
  } while (elapsedMs < SAMPLE_CPU_MS);
  return elapsedMs / calls;
}

function checkGrowth(testCase: DlpPerformanceCase, scrub: Scrubber): void {
  const { label, small, large, unchanged } = testCase;
  for (const input of [small, large]) {
    const output = scrub(input);
    if (unchanged) assert.ok(output === input, `DLP ${label} changed the input at ${input.length} chars`);
  }

  const smallMs = cpuMsPerCall(() => scrub(small));
  const largeMs = cpuMsPerCall(() => scrub(large));
  const growth = largeMs / smallMs;
  const bound = linearGrowthBound(large.length / small.length);
  assert.ok(growth < bound,
    `DLP ${label} CPU growth ${growth.toFixed(1)}x exceeded ${bound.toFixed(1)}x `
    + `(${smallMs.toFixed(3)} ms at ${small.length} chars, ${largeMs.toFixed(3)} ms at ${large.length} chars)`);
}

assert.ok(parentPort, "DLP performance probes require a worker");
const { cases, home } = workerData as DlpPerformanceRequest;
if (home) {
  os.homedir = () => home.path;
  os.platform = () => home.platform;
  const { pathToFileURL } = url;
  url.pathToFileURL = (path) => pathToFileURL(path, { windows: home.platform === "win32" });
  syncBuiltinESMExports();
}

// The home redactor captures platform and home at import time. Load it after
// configuring the builtins in this worker's isolate.
const { redactFsPath, redactHomePathsInText } =
  require("../../dlp-filter.js") as typeof import("../../dlp-filter.js");
const { scrubDiagnosticSecrets, scrubSecretsForLLM } =
  require("../../../shared/dlp.js") as typeof import("../../../shared/dlp.js");
if (home) {
  assert.equal(redactHomePathsInText(`${home.path}/fixture.txt`), "[home]/fixture.txt", "DLP worker home fixture was not applied");
}
const scrubbers: Record<Operation, Scrubber> = {
  "home text": redactHomePathsInText,
  "home path": redactFsPath,
  "diagnostic secrets": scrubDiagnosticSecrets,
  "display secrets": scrubSecretsForLLM,
  "quadratic entity decoder": (text) => redactHomePathsInText(quadraticEntityDecoder(text)),
  "exponential backtracking regex": (text) => scrubDiagnosticSecrets(exponentialBacktrackingRegex(text)),
};

for (const testCase of cases) {
  parentPort.postMessage({ kind: "started", label: testCase.label } satisfies DlpPerformanceMessage);
  checkGrowth(testCase, scrubbers[testCase.operation]);
}
parentPort.postMessage({ kind: "complete" } satisfies DlpPerformanceMessage);
