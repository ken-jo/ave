import { createHash } from "node:crypto";
import { isRecord } from "./is-record.js";
import type { RequestedOutput } from "./workflow-template-types.js";
export function canonicalWorkflowJson(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : isRecord(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, ordered(v[key])])) : v;
  return JSON.stringify(ordered(value));
}
export function resultHashOf(output: string): string {
  return createHash("sha256").update(output, "utf8").digest("hex");
}
export function outputHashOf(output: string, requestedOutputs: readonly RequestedOutput[]): string {
  return createHash("sha256").update(canonicalWorkflowJson({ output, requestedOutputs }), "utf8").digest("hex");
}
