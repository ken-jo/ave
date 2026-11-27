import type { OutputExecution } from "./shipped-shapes.js";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { approvalArgsAreDisplayable, MAX_REQUESTED_OUTPUT_ARGS_BYTES, requestedOutputArgsError } from "../../shared/approval-args-display.js";
import type { TailnetControllerAuthority } from "../../shared/chat-origin.js";
import type { RequestedOutputGateBinding } from "../../shared/requested-output-card.js";
import { hasNonWhitespaceControlChars, hasInvisibleOrReorderingChars } from "../../shared/display-safe-text.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { hasOnlyKeys, isPlainRecord } from "../../shared/is-record.js";
import { canonicalWorkflowJson, outputHashOf } from "../../shared/workflow-template-output.js";
import type { RequestedOutput, RequestedOutputDecl, TemplateStage, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import { createStageRequestOutputTool } from "../../tools/stage-request-output.js";
import { type HostGit, configuredWorkflowPush, executeWorkflowPush, isWorkflowPush } from "./host-git.js";
import type { RunRef } from "./stage-workspace.js";

export type OutputRefusal = "output-not-declared" | "remote-not-configured" | "too-many" | "args-too-large"
  | "needs-human-gate" | "output-remote-local-unsupported" | "output-args-not-displayable";
const MAX_REQUESTED_OUTPUTS = 10;

export interface OutputApprovalSurface {
  readonly desktop: WebContents | null;
  readonly controller?: TailnetControllerAuthority;
}

type Accepted = { ok: true; output: RequestedOutput } | { ok: false; code: OutputRefusal };
type OutputWorkspace = { root: string; repository?: string };

interface OutputIntake {
  stage: TemplateStage;
  workspaceRoot: string;
  raw: unknown;
  run: RunRef;
  repository?: string;
}

export interface RequestedOutputHooks {
  accept(input: OutputIntake): Promise<Accepted>;
  execute(input: { run: RunRef; stageId: string; output: RequestedOutput; approvalSurface: WebContents | null;
    binding?: RequestedOutputGateBinding; controller?: TailnetControllerAuthority;
    workspace: OutputWorkspace; canExecute: () => boolean; signal: AbortSignal;
    /** The run's effect authority (WorkBoardStore.runAuthority), checked by the push at process launch. */
    authority: AbortSignal }): Promise<OutputExecution>;
}

export function declaredOutputOf(
  stage: TemplateStage, toolName: unknown, owner: unknown, ownerId: unknown,
): RequestedOutputDecl | undefined {
  return stage.requestedOutputs?.find(entry => entry.toolName === toolName && entry.owner === owner && entry.ownerId === ownerId);
}

export function requestedOutputsMatchStage(stage: TemplateStage, outputs: readonly RequestedOutput[]): boolean {
  return stage.gate.type === "human" && outputs.every(({ decl }) => declaredOutputOf(stage, decl.toolName, decl.owner, decl.ownerId) !== undefined);
}

export function requestedOutputHash(stage: WorkItemStageRun): string | undefined {
  return stage.output !== undefined && stage.requestedOutputs?.length ? outputHashOf(stage.output, stage.requestedOutputs) : undefined;
}

export async function acceptRequestedOutput(input: OutputIntake, git: HostGit): Promise<Accepted> {
  const { raw, stage, run, repository } = input;
  if (stage.gate.type !== "human") return { ok: false, code: "needs-human-gate" };
  if (!isPlainRecord(raw)) return { ok: false, code: "output-not-declared" };
  const decl = declaredOutputOf(stage, raw.toolName, raw.owner, raw.ownerId);
  if (!decl) return { ok: false, code: "output-not-declared" };
  if (!hasOnlyKeys(raw, ["toolName", "owner", "ownerId", "args", "summary"])
    || typeof raw.summary !== "string" || raw.summary.length > 400 || hasNonWhitespaceControlChars(raw.summary)) {
    return { ok: false, code: "args-too-large" };
  }
  const push = isWorkflowPush(decl);
  let args: string;
  if (push) {
    const bound = repository !== undefined ? await configuredWorkflowPush(git, repository, run.runId, raw.args) : undefined;
    if (!bound || "code" in bound) return { ok: false, code: bound?.code ?? "remote-not-configured" };
    args = canonicalWorkflowJson(bound.binding);
  } else {
    if (!isPlainRecord(raw.args)) return { ok: false, code: "args-too-large" };
    try { args = canonicalWorkflowJson(raw.args); } catch { return { ok: false, code: "args-too-large" }; }
  }
  const displayError = push ? (Buffer.byteLength(args) > MAX_REQUESTED_OUTPUT_ARGS_BYTES || hasInvisibleOrReorderingChars(args) ? "args-too-large" : undefined)
    : requestedOutputArgsError(JSON.parse(args), args);
  if (displayError !== undefined) return { ok: false, code: displayError };
  return { ok: true, output: { id: randomUUID(), decl: { ...decl }, args, summary: maskSensitiveData(raw.summary).masked } };
}

export function stageOutputIntake(hooks: RequestedOutputHooks, scope: Omit<OutputIntake, "raw">) {
  const outputs: RequestedOutput[] = [];
  let pending = 0;
  let open = true;
  const tool = createStageRequestOutputTool(scope.stage.requestedOutputs ?? [], async raw => {
    if (!open) return { ok: false, code: "output-not-declared" };
    if (outputs.length + pending >= MAX_REQUESTED_OUTPUTS) return { ok: false, code: "too-many" };
    pending++;
    try {
      const accepted = await hooks.accept({ ...scope, raw });
      if (!accepted.ok) return accepted;
      if (!open) return { ok: false, code: "output-not-declared" };
      outputs.push(accepted.output);
      return { ok: true, id: accepted.output.id };
    } finally { pending--; }
  });
  return { tool, close: () => { open = false; return [...outputs]; } };
}

export interface GovernedOutputAdapter {
  invoke(input: {
    output: RequestedOutput; surface: WebContents | null; cwd: string; signal: AbortSignal; canExecute: () => boolean;
    binding: RequestedOutputGateBinding; projectRoot?: string; controller?: TailnetControllerAuthority;
  }): Promise<OutputExecution["status"] | "output-args-not-displayable" | "output-execution-not-dispatched">;
}

export function createRequestedOutputHooks(git: HostGit, adapter: GovernedOutputAdapter, defaultWorkspaceRoot: string): RequestedOutputHooks {
  return {
    accept: input => acceptRequestedOutput(input, git),
    async execute({ run, output, approvalSurface, binding, controller, workspace, canExecute, signal, authority }) {
      const { id, decl } = output;
      const args: unknown = JSON.parse(output.args);
      if (!isPlainRecord(args) || canonicalWorkflowJson(args) !== output.args) return { id, status: "failed", detail: "output-execution-failed" };
      if (signal.aborted || !canExecute()) return { id, status: "failed", detail: "output-execution-interrupted" };
      if (isWorkflowPush(decl)) {
        const { pairedShare, pairedShareGuard } = controller ?? {};
        if (controller && (!pairedShare || !pairedShareGuard)) return { id, status: "failed", detail: "output-execution-interrupted" };
        const refresh = pairedShare && pairedShareGuard ? () => pairedShareGuard.refreshCurrent(pairedShare) : undefined;
        return { id, ...await executeWorkflowPush(git, workspace.repository, run.runId, args, canExecute, authority, refresh) };
      }
      if (!binding) return { id, status: "denied", detail: "user-gesture-required" };
      if (!approvalArgsAreDisplayable(args) || requestedOutputArgsError(args, output.args)) return { id, status: "failed", detail: "output-args-not-displayable" };
      const status = await adapter.invoke({ output, surface: approvalSurface, binding, controller, signal: AbortSignal.any([signal, authority]),
        canExecute, projectRoot: run.projectRoot, cwd: run.projectRoot ?? defaultWorkspaceRoot });
      if (status === "output-args-not-displayable" || status === "output-execution-not-dispatched") return { id, status: "failed", detail: status };
      if (signal.aborted && status !== "done") return { id, status: "failed", detail: "output-execution-interrupted" };
      return { id, status, ...(status === "failed" ? { detail: "output-execution-failed" } : {}) };
    },
  };
}
