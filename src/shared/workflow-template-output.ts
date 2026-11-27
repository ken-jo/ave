import { createHash } from "node:crypto";
import { isRecord } from "./is-record.js";
import type { RequestedOutput, WorkItemStageRun } from "./workflow-template-types.js";

export const LOCAL_BRANCH_OUTPUT = { kind: "branch", owner: "host", ownerId: "host:git", toolName: "git_branch" } as const;

export function stageOutputBranch(runId: string, stageId: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(stageId)) return undefined;
  return `ave/run-${runId}/${stageId}`;
}
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

export function hasMatchingOutputHash(stage: WorkItemStageRun, submitted: string | undefined): boolean {
  const requests = stage.requestedOutputs;
  if (!requests?.length) return stage.outputHash === undefined && submitted === undefined;
  return stage.output !== undefined && submitted !== undefined && submitted === stage.outputHash
    && submitted === outputHashOf(stage.output, requests);
}
