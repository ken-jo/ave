import { parentPort, workerData } from "node:worker_threads";
import { measureCpuGrowth, type CpuGrowth, type CpuGrowthOptions } from "../../__tests__/support/cpu-growth.js";
import { scrubDiagnosticSecrets } from "../../shared/dlp.js";
import { scrubSecretsForLLM } from "../dlp-filter.js";

export type DlpCpuProbe =
  | { kind: "unchanged"; text: string }
  | { kind: "growth"; small: string[]; large: string[]; options: CpuGrowthOptions };

export type DlpCpuProbeResult =
  | { kind: "unchanged"; samples: Array<{ unchanged: boolean; elapsedMs: number }> }
  | { kind: "growth"; samples: Array<CpuGrowth & { index: number; scrubber: string }> };

const scrubbers = [scrubDiagnosticSecrets, scrubSecretsForLLM];

function measure(probe: DlpCpuProbe): DlpCpuProbeResult {
  if (probe.kind === "unchanged") {
    return { kind: probe.kind, samples: scrubbers.map(scrub => {
      const started = performance.now();
      const unchanged = scrub(probe.text) === probe.text;
      return { unchanged, elapsedMs: performance.now() - started };
    }) };
  }
  return { kind: probe.kind, samples: probe.large.flatMap((input, index) => scrubbers.map(scrub => ({
    index,
    scrubber: scrub.name,
    ...measureCpuGrowth(() => scrub(probe.small[index]), () => scrub(input), probe.options),
  }))) };
}

if (!parentPort) throw new Error("DLP CPU probe requires a worker port");
parentPort.postMessage(measure(workerData as DlpCpuProbe));
