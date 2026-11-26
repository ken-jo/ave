import { AssertionError } from "node:assert";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { beforeAll, expect, it } from "vitest";
import { fill, GENERIC_HOME_FAMILIES, MIXED_ESCAPE_FRAGMENT, secretFamiliesAt } from "./fixtures/dlp-performance-inputs.js";
import type { DlpPerformanceCase, DlpPerformanceMessage, DlpPerformanceRequest } from "./fixtures/dlp-performance-worker.js";

const PROBE_DEADLINE_SECONDS = 10;
const SUITE_CASE_TIMEOUT_MS = 180_000;
const POSIX_HOME = { path: "/srv/fixtures/habitat", platform: "linux" } as const;
const SECRET_OPERATIONS = ["diagnostic secrets", "display secrets"] as const;
let workerSource: string;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/dlp-performance-worker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  workerSource = outputFiles[0].text;
});

function runProbes(request: DlpPerformanceRequest, deadlineSeconds = PROBE_DEADLINE_SECONDS): Promise<void> {
  const [first] = request.cases;
  if (!first) throw new Error("DLP worker requires at least one probe");
  const worker = new Worker(workerSource, { eval: true, execArgv: [], workerData: request });
  return new Promise((resolve, reject) => {
    let complete = false;
    let deadline: ReturnType<typeof setTimeout>;
    const stopWatching = (): void => {
      clearTimeout(deadline);
      worker.off("message", handleMessage);
    };
    const armDeadline = (seconds: number, message: string): void => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        stopWatching();
        worker.unref();
        void worker.terminate();
        reject(new AssertionError({ message }));
      }, seconds * 1_000);
    };
    const handleMessage = (message: DlpPerformanceMessage): void => {
      if (message.kind === "started") {
        armDeadline(deadlineSeconds, `DLP ${message.label} exceeded ${deadlineSeconds} s: likely super-linear backtracking`);
      } else {
        complete = true;
        armDeadline(PROBE_DEADLINE_SECONDS, `DLP worker for ${first.label} did not exit within ${PROBE_DEADLINE_SECONDS} s`);
      }
    };
    armDeadline(PROBE_DEADLINE_SECONDS, `DLP worker for ${first.label} did not start a probe within ${PROBE_DEADLINE_SECONDS} s`);
    worker.on("message", handleMessage);
    worker.once("error", (error) => {
      stopWatching();
      reject(error);
    });
    worker.once("exit", (code) => {
      stopWatching();
      if (code === 0 && complete) resolve();
      else reject(new Error(`DLP worker exited with code ${code} before completing the probes`));
    });
  });
}

it.each([
  { shape: "UNC", path: String.raw`\\server\share\alice` },
  { shape: "extended", path: String.raw`\\?\D:\fixtures\alice` },
  { shape: "drive", path: String.raw`D:\fixtures\alice` },
])("bounds home redaction growth for $shape paths", async ({ shape, path }) => {
  const firstSeparator = path.indexOf("\\");
  const prefix = path.slice(0, firstSeparator);
  const nearMiss = `${path.slice(firstSeparator).replace(/^\\+/u, "").slice(0, -1)}X`;
  const small = 100 * 1024;
  const large = 800 * 1024;
  const cases = [
    { name: "separator run", input: (size: number) => `${"\\".repeat(size - 9)}near-miss` },
    { name: "near-miss name", input: (size: number) => prefix + "\\".repeat(size - prefix.length - nearMiss.length) + nearMiss },
  ].map(({ name, input }): DlpPerformanceCase => ({
    label: `${shape} ${name}`, operation: "home text", small: input(small), large: input(large), unchanged: true,
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
    await runProbes({ home: POSIX_HOME, cases: [{
      label: `escape decoder ${shape}`, operation: "home text", small: input(100 * 1024), large: input(800 * 1024),
      unchanged: shape === MIXED_ESCAPE_FRAGMENT ? true : undefined,
    }] });
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
  label: "entity decoder", operation: "home text",
  small: "&#".repeat(2048), large: "&#".repeat(16384), unchanged: true,
};

it("rejects the quadratic entity decoder mutation by CPU growth", async () => {
  await runProbes({ home: POSIX_HOME, cases: [DECODER_CONTROL] });
  await expect(runProbes({ home: POSIX_HOME, cases: [{
    ...DECODER_CONTROL, label: "quadratic entity decoder", operation: "quadratic entity decoder",
  }] })).rejects.toThrow(/DLP quadratic entity decoder CPU growth .* exceeded/u);
}, SUITE_CASE_TIMEOUT_MS);

const REGEX_CONTROL: DlpPerformanceCase = {
  label: "regex near miss", operation: "diagnostic secrets",
  small: "a".repeat(5), large: "a".repeat(40), unchanged: true,
};

it("rejects the exponential backtracking regex mutation by deadline", async () => {
  await runProbes({ cases: [REGEX_CONTROL] });
  await expect(runProbes({ cases: [{
    ...REGEX_CONTROL, label: "exponential backtracking regex", operation: "exponential backtracking regex",
  }] }, 2)).rejects.toThrow("DLP exponential backtracking regex exceeded 2 s: likely super-linear backtracking");
}, SUITE_CASE_TIMEOUT_MS);
