export type TemplateConfirmationOrigin = "local-desktop" | "tailnet-surface";
export type TemplateScope = { kind: "all" } | { kind: "project"; projectRoot: string };
export type StageGate = { type: "human" } | { type: "auto"; pass: { kind: "stage_ok" } | { kind: "check_exit_zero"; command: string } };
export interface TemplateStage {
  id: string;
  name: string;
  goal: string;
  kind?: "plan";
  inputs: string[];
  toolScope: "read" | "all";
  agentName?: string;
  allowSubAgents: boolean;
  gate: StageGate;
}
export interface TemplateEdge { from: string; to: string }
export interface TemplateGraph { stages: TemplateStage[]; edges: TemplateEdge[] }
export interface WorkflowTemplate {
  id: string;
  name: string;
  scope: TemplateScope;
  description?: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
export interface TemplateVersionPin { templateId: string; version: number; graphHash: string }
export interface TemplateConfirmation extends TemplateVersionPin {
  who: string;
  at: string;
  origin: TemplateConfirmationOrigin;
}
export interface TemplateVersion extends TemplateGraph, TemplateVersionPin {
  confirmedAt: string;
  confirmation: TemplateConfirmation;
  basedOn?: number;
}
export interface WorkflowTemplateDraftInput extends TemplateGraph {
  name: string;
  scope: TemplateScope;
  description?: string;
  basedOn?: number;
}
export interface WorkflowTemplateDraft extends WorkflowTemplateDraftInput {
  graphHash: string;
  updatedAt: string;
}
export interface WorkflowTemplateRecord {
  template: WorkflowTemplate;
  versions: TemplateVersion[];
  draft?: WorkflowTemplateDraft;
}
export interface WorkflowTemplateConfirmInput { expectedGraphHash: string }
export type WorkflowTemplateErrorCode =
  | "invalid-input" | "template-not-found" | "unknown-version" | "graph-hash-mismatch"
  | "confirmed-version-immutable" | "stale-draft" | "no-draft" | "template-archived"
  | "invalid-template-file" | "invalid-template-run";
export type WorkflowTemplateIpcResult<T> = { ok: true; value: T } | { ok: false; error: WorkflowTemplateErrorCode | "unauthorized-frame" | "no-store" | "user-gesture-required" | "storage-error" };

export interface WorkItemStageRun {
  stageId: string;
  attempt: number;
  status: "waiting" | "running" | "awaiting_gate" | "passed" | "failed" | "cancelled" | "rejected";
  childSessionId?: string;
  startedAt?: string;
  endedAt?: string;
  output?: string;
  outputHash?: string;
  gate?: { type: "human"; status: "pending" | "approved" | "changes_requested" | "rejected"; note?: string; decidedAt?: string; revision: number }
    | { type: "auto"; passed: boolean; evidence: string; evaluatedAt: string };
}
export type WorkItemStageRunSummary = Pick<WorkItemStageRun, "stageId" | "attempt" | "status" | "startedAt" | "endedAt" | "outputHash">;
