import { AssertionError } from "node:assert";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { build } from "esbuild";
import { beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { afterQueuedCallbacks, deferred } from "../../__tests__/support/deferred.js";
import { fill, GENERIC_HOME_FAMILIES, MIXED_ESCAPE_FRAGMENT, secretFamiliesAt, WINDOWS_SEPARATOR_HOMES, WINDOWS_SEPARATOR_INPUTS } from "./fixtures/dlp-performance-inputs.js";
import type { DlpPerformanceCase, DlpPerformanceRequest } from "./fixtures/dlp-performance-worker.js";

const PROBE_DEADLINE_SECONDS = 10;
const WORKER_DEADLINE_SECONDS = 10;
const BATCH_DEADLINE_SECONDS = 120;
const SUITE_CASE_TIMEOUT_MS = 180_000;
const POSIX_HOME = { path: "/srv/fixtures/habitat", platform: "linux" } as const;
const SECRET_OPERATIONS = ["diagnostic secrets", "display secrets"] as const;
let workerSource: string;

function instrumentHomeDecoder(source: string): string {
  const entry = "export function decodeHomeEscapes(text: string, family: HomeEscapeFamily): string {";
  const escapeRead = "width = readHomeEscape(text, index, output, jsHex);";
  for (const marker of [entry, escapeRead]) {
    if (source.split(marker).length !== 2) throw new Error(`DLP worker could not locate a unique decoder site: ${marker}`);
  }
  return 'import { homeEscapeDecoderProbe } from "./__tests__/fixtures/dlp-performance-mutations.js";\n'
    + source.replace(entry, `${entry}\n  if (family === "full") homeEscapeDecoderProbe.fullCalls++;`)
      .replace(escapeRead, "width = homeEscapeDecoderProbe.quadratic && family === 'full' && homeEscapeDecoderProbe.isEntityTerminatorMissing(text, index)"
        + " ? -1 : readHomeEscape(text, index, output, jsHex);");
}

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/dlp-performance-worker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{
      name: "instrument-home-decoder",
      setup(builder) {
        builder.onLoad({ filter: /home-path-decode\.ts$/ }, async ({ path }) => ({
          contents: instrumentHomeDecoder(await readFile(path, "utf8")),
          loader: "ts",
          resolveDir: dirname(path),
        }));
      },
    }],
  });
  workerSource = outputFiles[0].text;
});

async function runProbes(request: DlpPerformanceRequest, {
  probeSeconds = PROBE_DEADLINE_SECONDS,
  batchSeconds = BATCH_DEADLINE_SECONDS,
  source = workerSource,
  createWorker = (source: string, options: WorkerOptions) => new Worker(source, options),
} = {}): Promise<void> {
  const [first] = request.cases;
  if (!first) throw new Error("DLP worker requires at least one probe");
  const worker = createWorker(source, { eval: true, execArgv: [], workerData: request });
  const { promise, resolve } = deferred<Error | undefined>();
  let settled = false;
  let complete = false;
  let started = 0;
  let activeLabel = first.label;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<number> | undefined;

  function settle(error?: Error): void {
    if (settled) return;
    settled = true;
    worker.off("message", handleMessage);
    clearTimeout(phaseTimer);
    clearTimeout(batchTimer);
    resolve(error);
  }

  function armDeadline(seconds: number, message: string): void {
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => settle(new AssertionError({ message })), seconds * 1_000);
  }

  function handleMessage(message: unknown): void {
    if (settled) return;
    if (!complete && typeof message === "object" && message !== null && "kind" in message) {
      const next = request.cases[started];
      if (message.kind === "started" && next && "label" in message && message.label === next.label) {
        started++;
        activeLabel = next.label;
        armDeadline(probeSeconds, `DLP ${activeLabel} exceeded ${probeSeconds} s: likely super-linear backtracking`);
        return;
      }
      if (message.kind === "complete" && started === request.cases.length) {
        complete = true;
        armDeadline(WORKER_DEADLINE_SECONDS, `DLP worker for ${activeLabel} did not exit within ${WORKER_DEADLINE_SECONDS} s`);
        return;
      }
    }
    settle(new AssertionError({ message: `DLP ${activeLabel} received an unexpected worker message` }));
  }

  const batchTimer = setTimeout(() => settle(new AssertionError({
    message: `DLP batch exceeded ${batchSeconds} s while running ${activeLabel}`,
  })), batchSeconds * 1_000);
  armDeadline(WORKER_DEADLINE_SECONDS, `DLP worker for ${first.label} did not start a probe within ${WORKER_DEADLINE_SECONDS} s`);
  worker.on("message", handleMessage);
  worker.once("error", settle);
  worker.once("exit", (code) => {
    if (code === 0 && complete) settle();
    else settle(new AssertionError({ message: `DLP worker for ${activeLabel} exited with code ${code} before completing the probes` }));
  });

  const terminate = async (): Promise<void> => {
    if (!settled) settle(new AssertionError({ message: `DLP test finished before ${activeLabel} completed` }));
    termination ??= worker.terminate();
    await termination;
  };
  onTestFinished(terminate);
  try {
    const error = await promise;
    if (error) throw error;
  } finally {
    await terminate();
  }
}

it.each(WINDOWS_SEPARATOR_HOMES)("bounds home redaction growth for $shape paths", async ({ shape, path }) => {
  const small = 100 * 1024;
  const large = 800 * 1024;
  const cases = WINDOWS_SEPARATOR_INPUTS.map(({ name, input }): DlpPerformanceCase => ({
    label: `${shape} ${name}`, operation: "home text", small: input(path, small), large: input(path, large), unchanged: true,
  }));
  await runProbes({ cases, home: { path, platform: "win32" } });
}, SUITE_CASE_TIMEOUT_MS);

it.each(["%", "\\u", "&#", "&#x", "&amp;", "%25", "peeling", "zeros", MIXED_ESCAPE_FRAGMENT])(
  "bounds home escape decoder growth for %s", async (shape) => {
    const input = (size: number): string => {
      if (shape === "peeling") return `%${"25".repeat(Math.floor(size / 2))}2F`;
      if (shape === "zeros") return `&#${"0".repeat(size)}47;`;
      return shape.repeat(Math.ceil(size / shape.length));
    };
    const small = input(100 * 1024);
    const large = input(800 * 1024);
    const base = { operation: "home text", small, large, unchanged: true } as const;
    const cases: DlpPerformanceCase[] = [];
    if (shape === "peeling" || shape === "zeros") {
      cases.push({ ...base, label: `full escape decoder ${shape}`, decoder: "full" });
    } else {
      cases.push({ ...base, label: `escape decoder guard ${shape}`, decoder: "guard" });
      cases.push({ ...base, label: `full escape decoder ${shape}`, small: `/${small}`, large: `/${large}`, decoder: "full" });
    }
    await runProbes({ home: POSIX_HOME, cases });
  }, SUITE_CASE_TIMEOUT_MS,
);

it("bounds growth on generic home profiles in text and path values", async () => {
  const cases = GENERIC_HOME_FAMILIES.flatMap(([unit, head]) => (["home text", "home path"] as const).map(
    (operation): DlpPerformanceCase => ({
      label: `${operation} ${JSON.stringify(head + unit)}`, operation,
      small: fill(4 * 1024, unit, head), large: fill(64 * 1024, unit, head),
    }),
  ));
  await runProbes({ cases, home: POSIX_HOME });
}, SUITE_CASE_TIMEOUT_MS);

it("bounds scrubber growth across distinct quote escape depths", async () => {
  const input = (depths: number): string => Array.from(
    { length: depths }, (_, index) => `${"\\".repeat(index + 1)}"authorization `,
  ).join("");
  const small = input(200);
  const large = input(800);
  expect(large.length).toBeGreaterThan(330_000);
  const cases = SECRET_OPERATIONS.map((operation): DlpPerformanceCase => ({
    label: `${operation} at distinct quote escape depths`, operation, small, large, unchanged: true,
  }));
  await runProbes({ cases });
}, SUITE_CASE_TIMEOUT_MS);

it("bounds scrubber growth across adversarial secret families", async () => {
  const small = secretFamiliesAt(4 * 1024);
  const large = secretFamiliesAt(64 * 1024);
  expect(large.map((input) => input.length)).toEqual(small.map((input) => input.length + 60 * 1024));
  const cases = large.flatMap((input, index) => SECRET_OPERATIONS.map((operation): DlpPerformanceCase => ({
    label: `${operation} family ${index + 1} ${JSON.stringify(input.slice(0, 24))}`,
    operation, small: small[index], large: input,
  })));
  await runProbes({ cases });
}, SUITE_CASE_TIMEOUT_MS);

const DECODER_CONTROL: DlpPerformanceCase = {
  label: "entity decoder", operation: "home text", decoder: "full",
  small: `/${"&#".repeat(2048)}`, large: `/${"&#".repeat(16384)}`, unchanged: true,
};

it("rejects the quadratic entity decoder mutation by CPU growth", async () => {
  await runProbes({ home: POSIX_HOME, cases: [DECODER_CONTROL] });
  await expect(runProbes({ home: POSIX_HOME, cases: [{
    ...DECODER_CONTROL, label: "quadratic entity decoder", decoder: "quadratic",
  }] })).rejects.toThrow(/DLP quadratic entity decoder CPU growth .* exceeded/u);
}, SUITE_CASE_TIMEOUT_MS);

const REGEX_CONTROL: DlpPerformanceCase = {
  label: "regex near miss", operation: "diagnostic secrets",
  small: "a".repeat(5), large: "a".repeat(40), unchanged: true,
};
const REGEX_MUTATION: DlpPerformanceCase = {
  ...REGEX_CONTROL, label: "exponential backtracking regex", operation: "exponential backtracking regex",
};

function delayWorkerStartup(source: string): string {
  return `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);\n${source}`;
}

it("rejects the exponential backtracking regex mutation by deadline", async () => {
  await runProbes({ cases: [REGEX_CONTROL] });
  await expect(runProbes({ cases: [REGEX_MUTATION] }, { probeSeconds: 2, source: delayWorkerStartup(workerSource) })).rejects.toThrow(
    "DLP exponential backtracking regex exceeded 2 s: likely super-linear backtracking",
  );
}, SUITE_CASE_TIMEOUT_MS);

it("rejects an expired batch with the active probe label", async () => {
  const second = { ...REGEX_CONTROL, label: "second probe" };
  const source = delayWorkerStartup(`
    const { parentPort, workerData } = require("node:worker_threads");
    for (const { label } of workerData.cases) parentPort.postMessage({ kind: "started", label });
    parentPort.on("message", () => parentPort.close());
  `);
  const secondStarted = deferred<void>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const batch = runProbes({ cases: [REGEX_CONTROL, second] }, {
      batchSeconds: 2,
      source,
      createWorker(script, options) {
        const worker = new Worker(script, options);
        worker.on("message", ({ kind, label }) => {
          if (kind === "started" && label === second.label) secondStarted.resolve();
        });
        return worker;
      },
    });
    const expired = expect(batch).rejects.toThrow("DLP batch exceeded 2 s while running second probe");
    // Keep one second on the batch clock until the worker reports its second probe.
    vi.advanceTimersByTime(1_000);
    const advanceDeadline = Promise.race([secondStarted.promise, batch]).then(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(0);
    });
    await Promise.all([expired, advanceDeadline]);
  } finally {
    vi.useRealTimers();
  }
}, 20_000);

it("leaves no live timeouts when a worker starts a probe during termination", async () => {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    parentPort.on("message", () => {
      parentPort.postMessage({ kind: "started", label: workerData.cases[0].label });
    });
    parentPort.postMessage({ kind: "progress" });
  `;
  const batchScope = new AsyncLocalStorage<boolean>();
  const liveTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
  const hook = createHook({
    init(id, type, _triggerId, resource) {
      if (type === "Timeout" && batchScope.getStore()) liveTimeouts.set(id, resource as ReturnType<typeof setTimeout>);
    },
    destroy(id) {
      liveTimeouts.delete(id);
    },
  }).enable();
  let lateMessage: unknown;
  try {
    const batch = batchScope.run(true, () => runProbes({ cases: [REGEX_CONTROL] }, {
      source,
      createWorker(script, options) {
        const worker = new Worker(script, options);
        const terminate = worker.terminate.bind(worker);
        vi.spyOn(worker, "terminate").mockImplementationOnce(async () => {
          const acknowledgment = new AbortController();
          const timeout = setTimeout(() => acknowledgment.abort(), WORKER_DEADLINE_SECONDS * 1_000);
          let exitCode: number;
          try {
            const message = once(worker, "message", { signal: acknowledgment.signal });
            worker.postMessage("start");
            [lateMessage] = await message;
          } finally {
            clearTimeout(timeout);
            exitCode = await terminate();
          }
          return exitCode;
        });
        return worker;
      },
    }));
    await expect(batch).rejects.toThrow("DLP regex near miss received an unexpected worker message");
    expect(lateMessage).toEqual({ kind: "started", label: REGEX_CONTROL.label });
    await afterQueuedCallbacks();
    expect(liveTimeouts.size).toBe(0);
  } finally {
    hook.disable();
    for (const timeout of liveTimeouts.values()) clearTimeout(timeout);
  }
}, SUITE_CASE_TIMEOUT_MS);

it("rejects an unexpected worker message with the active probe label", async () => {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    parentPort.postMessage({ kind: "started", label: workerData.cases[0].label });
    parentPort.postMessage({ kind: "progress" });
  `;
  await expect(runProbes({ cases: [REGEX_CONTROL] }, { source })).rejects.toThrow(
    "DLP regex near miss received an unexpected worker message",
  );
}, SUITE_CASE_TIMEOUT_MS);
