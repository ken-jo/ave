import { maskSensitiveData } from "./dlp.js";

export function maskArgsForDisplay(value: unknown, detections: Set<string>): unknown {
  if (typeof value === "string") {
    const { masked, detections: hits } = maskSensitiveData(value);
    for (const h of hits) detections.add(h);
    return masked;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskArgsForDisplay(v, detections));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskArgsForDisplay(v, detections);
    }
    return out;
  }
  return value;
}

/** Whether the ordinary approval card preserves the JSON argument values and keys. */
export function approvalArgsAreDisplayable(args: unknown): boolean {
  return JSON.stringify(maskArgsForDisplay(args, new Set())) === JSON.stringify(args);
}
