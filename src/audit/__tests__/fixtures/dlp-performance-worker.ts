import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import url from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { linearGrowthBound } from "../../../__tests__/support/cpu-growth.js";
import { exponentialBacktrackingRegex, homeEscapeDecoderProbe } from "./dlp-performance-mutations.js";

type Scrubber = (text: string) => string;
type Operation = "home text" | "home path" | "diagnostic secrets" | "display secrets"
  | "exponential backtracking regex";

export interface DlpPerformanceCase {
  readonly label: string;
  readonly operation: Operation;
  readonly small: string;
  readonly large: string;
  readonly unchanged?: true;
  readonly decoder?: "guard" | "full" | "quadratic";
}

export interface DlpPerformanceRequest {
  readonly cases: readonly DlpPerformanceCase[];
  readonly home?: { readonly path: string; readonly platform: "win32" | "linux" };
}

export type DlpPerformanceMessage =
  | { readonly kind: "started"; readonly label: string }
  | { readonly kind: "complete" };

// Amortize timer precision and call overhead, including on platforms that
// charge thread CPU in ticks.
const SAMPLE_CPU_MS = 25;
const SAMPLE_WINDOWS = 3;

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
  const { label, small, large, unchanged, decoder } = testCase;
  homeEscapeDecoderProbe.quadratic = decoder === "quadratic";
  for (const input of [small, large]) {
    const before = homeEscapeDecoderProbe.fullCalls;
    const output = scrub(input);
    if (unchanged) assert.ok(output === input, `DLP ${label} changed the input at ${input.length} chars`);
    if (decoder) {
      const calls = homeEscapeDecoderProbe.fullCalls - before;
      const expected = decoder === "guard" ? "zero" : "at least one";
      assert.equal(calls > 0, decoder !== "guard",
        `DLP ${label} expected ${expected} full decoder calls at ${input.length} chars, got ${calls}`);
    }
  }

  const smallWindows: number[] = [];
  const largeWindows: number[] = [];
  for (let window = 0; window < SAMPLE_WINDOWS; window++) {
    smallWindows.push(cpuMsPerCall(() => scrub(small)));
    largeWindows.push(cpuMsPerCall(() => scrub(large)));
  }
  const middle = Math.floor(SAMPLE_WINDOWS / 2);
  const smallMs = smallWindows.sort((a, b) => a - b)[middle];
  const largeMs = largeWindows.sort((a, b) => a - b)[middle];
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
  "exponential backtracking regex": (text) => scrubDiagnosticSecrets(exponentialBacktrackingRegex(text)),
};

for (const testCase of cases) {
  parentPort.postMessage({ kind: "started", label: testCase.label } satisfies DlpPerformanceMessage);
  checkGrowth(testCase, scrubbers[testCase.operation]);
}
parentPort.postMessage({ kind: "complete" } satisfies DlpPerformanceMessage);
