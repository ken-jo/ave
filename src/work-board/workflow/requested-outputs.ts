import type { OutputExecution } from "./shipped-shapes.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { replaceStagedFile } from "../../lib/atomic-file.js";
import {
  appOwnedSandboxTempRoot, ensureSandboxPrivateRoot, ensureSandboxTempPrincipalDir, getUserReadDenies, protectedReadDenyMatcher,
} from "../../permissions/asrt-sandbox.js";
import { hasNonWhitespaceControlChars, hasInvisibleOrReorderingChars } from "../../shared/display-safe-text.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { hasOnlyKeys, isPlainRecord } from "../../shared/is-record.js";
import { canonicalWorkflowJson, outputHashOf } from "../../shared/workflow-template-output.js";
import type { RequestedOutput, RequestedOutputDecl, TemplateStage, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import { createStageRequestOutputTool } from "../../tools/stage-request-output.js";
import { isWorkspaceGlob } from "../template-graph.js";
import { type HostGit, configuredWorkflowPush, executeWorkflowPush, isWorkflowPush } from "./host-git.js";
import { holdDir, realWithin } from "./owned-fs.js";
import type { RunRef } from "./stage-workspace.js";
import { copySeedFiles, hashSeedFile } from "./workspace-seed.js";

export type OutputRefusal = "output-not-declared" | "remote-not-configured" | "too-many" | "args-too-large"
  | "file-outside-workspace" | "file-unreadable" | "needs-human-gate"
  | "output-remote-local-unsupported" | "output-operands-unverified" | "output-file-unbound" | "output-file-read-denied";
const MAX_REQUESTED_OUTPUTS = 10;
const MAX_ARGS_BYTES = 32 * 1024;
const MAX_OUTPUT_FILES = 5_000;
const MAX_OUTPUT_FILE_BYTES = 512 * 1024 * 1024;

type OutputFile = NonNullable<RequestedOutput["files"]>[number];
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
    workspace: OutputWorkspace; canExecute: () => boolean }): Promise<OutputExecution>;
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

export function relativeOutputFile(path: unknown): path is string {
  return isWorkspaceGlob(path) && !/[:*?\\]/u.test(path) && !hasInvisibleOrReorderingChars(path)
    && path.split("/").every(segment => segment !== "" && segment !== "." && !/[. ]$/u.test(segment));
}

class OutputFileError extends Error {
  constructor(readonly code: "file-outside-workspace" | "file-unreadable") { super(code); }
}

async function outputFiles(root: string, paths: readonly unknown[]): Promise<OutputFile[]> {
  if (paths.length > MAX_OUTPUT_FILES) throw new OutputFileError("file-unreadable");
  if (!paths.every(relativeOutputFile) || new Set(paths).size !== paths.length) throw new OutputFileError("file-outside-workspace");
  const canonicalRoot = await realpath(root);
  const dir = holdDir(canonicalRoot);
  const files: OutputFile[] = [];
  let bytesLeft = MAX_OUTPUT_FILE_BYTES;
  for (const path of paths) {
    const resolved = await realpath(join(canonicalRoot, path));
    if (!realWithin(canonicalRoot, resolved)) throw new OutputFileError("file-outside-workspace");
    const digest = await hashSeedFile(dir, path, bytesLeft);
    bytesLeft -= digest.size;
    files.push({ path, ...digest });
  }
  return files;
}

export async function acceptRequestedOutput(input: OutputIntake, git: HostGit, operandsOf: GovernedOutputAdapter["operands"]): Promise<Accepted> {
  const { raw, stage, workspaceRoot, run, repository } = input;
  if (stage.gate.type !== "human") return { ok: false, code: "needs-human-gate" };
  if (!isPlainRecord(raw)) return { ok: false, code: "output-not-declared" };
  const decl = declaredOutputOf(stage, raw.toolName, raw.owner, raw.ownerId);
  if (!decl) return { ok: false, code: "output-not-declared" };
  if (!hasOnlyKeys(raw, ["toolName", "owner", "ownerId", "args", "files", "summary"])
    || typeof raw.summary !== "string" || raw.summary.length > 400 || hasNonWhitespaceControlChars(raw.summary)) {
    return { ok: false, code: "args-too-large" };
  }
  let args: string;
  let paths: readonly string[] = [];
  if (isWorkflowPush(decl)) {
    const bound = raw.files === undefined && repository !== undefined
      ? await configuredWorkflowPush(git, repository, run.runId, raw.args) : undefined;
    if (!bound || "code" in bound) return { ok: false, code: bound?.code ?? "remote-not-configured" };
    args = canonicalWorkflowJson(bound.binding);
  } else {
    if (!isPlainRecord(raw.args)) return { ok: false, code: "args-too-large" };
    try { args = canonicalWorkflowJson(raw.args); } catch { return { ok: false, code: "args-too-large" }; }
  }
  if (Buffer.byteLength(args) > MAX_ARGS_BYTES || hasInvisibleOrReorderingChars(args)
    || (!isWorkflowPush(decl) && maskSensitiveData(args).masked !== args)) {
    return { ok: false, code: "args-too-large" };
  }
  let files: OutputFile[] | undefined;
  if (!isWorkflowPush(decl)) {
    const operands = operandsOf(decl, JSON.parse(args), workspaceRoot);
    if (typeof operands === "string") return { ok: false, code: operands };
    paths = operands.paths;
  }
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files) || raw.files.length > MAX_OUTPUT_FILES) return { ok: false, code: "file-unreadable" };
    if (!raw.files.every(relativeOutputFile) || new Set(raw.files).size !== raw.files.length) return { ok: false, code: "file-outside-workspace" };
    const declared = new Set(raw.files);
    if (declared.size !== paths.length || paths.some(path => !declared.has(path))) return { ok: false, code: "output-file-unbound" };
  }
  if (paths.length) {
    try { files = await outputFiles(workspaceRoot, paths); }
    catch (error) { return { ok: false, code: error instanceof OutputFileError ? error.code : "file-unreadable" }; }
  }
  return { ok: true, output: { id: randomUUID(), decl: { ...decl }, args, ...(files?.length && { files }), summary: maskSensitiveData(raw.summary).masked } };
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

export type OutputOperands = { input: Record<string, unknown>; paths: readonly string[] }
  | "output-operands-unverified" | "file-outside-workspace" | "output-file-unbound" | "output-file-read-denied";

export interface GovernedOutputAdapter {
  operands(decl: RequestedOutputDecl, args: Record<string, unknown>, workspace: string): OutputOperands;
  invoke(input: {
    output: RequestedOutput; args: Record<string, unknown>; root: string; workspace: string; surface: WebContents;
    recheck: () => Promise<boolean>;
  }): Promise<OutputExecution["status"] | Extract<OutputOperands, string>>;
}

export function createRequestedOutputHooks(git: HostGit, adapter: GovernedOutputAdapter): RequestedOutputHooks {
  return {
    accept: input => acceptRequestedOutput(input, git, adapter.operands),
    async execute({ run, output, approvalSurface, workspace, canExecute }) {
      const { id, decl, files } = output;
      const args: unknown = JSON.parse(output.args);
      if (!isPlainRecord(args) || canonicalWorkflowJson(args) !== output.args) return { id, status: "failed", detail: "output-execution-failed" };
      if (!canExecute()) return { id, status: "failed", detail: "output-execution-interrupted" };
      if (isWorkflowPush(decl)) return { id, ...await executeWorkflowPush(git, workspace.repository, run.runId, args, canExecute) };
      if (!approvalSurface || approvalSurface.isDestroyed()) return { id, status: "denied", detail: "user-keyboard-required" };
      const paths = files?.map(file => file.path) ?? [];
      const verifySources = () => {
        const operands = adapter.operands(decl, args, workspace.root);
        if (typeof operands === "string") return operands;
        const bound = new Set(operands.paths);
        if (bound.size !== paths.length || paths.some(path => !bound.has(path))) return "output-operands-unverified";
      };
      const refusal = verifySources();
      if (refusal !== undefined) return { id, status: "failed", detail: refusal };
      const parent = paths.length && decl.owner === "plugin"
        ? ensureSandboxTempPrincipalDir({ kind: "plugin", id: decl.ownerId }).dir : tmpdir();
      const root = await realpath(await mkdtemp(join(parent, "ave-output-")));
      let staged: string | undefined;
      try {
        const target = holdDir(root);
        if (files?.length) {
          try {
            staged = await realpath(await mkdtemp(join(ensureSandboxPrivateRoot(appOwnedSandboxTempRoot()), "ave-output-")));
            const source = holdDir(await realpath(workspace.root));
            const readRefusal = verifySources();
            if (readRefusal !== undefined) return { id, status: "failed", detail: readRefusal };
            const copied = await copySeedFiles(source, holdDir(staged), paths,
              new Map(files.map(file => [file.path, file.sha256])), false, MAX_OUTPUT_FILE_BYTES);
            if (canonicalWorkflowJson(copied) !== canonicalWorkflowJson(files)) return { id, status: "failed", detail: "output-file-changed" };
          } catch { return { id, status: "failed", detail: "output-file-changed" }; }
        }
        let dispatchRefusal: Extract<OutputOperands, string> | "output-file-changed" | undefined;
        const recheck = async () => {
          dispatchRefusal = verifySources();
          if (dispatchRefusal !== undefined || !canExecute() || approvalSurface.isDestroyed()) return false;
          if (staged !== undefined) {
            const denied = protectedReadDenyMatcher(getUserReadDenies());
            if (paths.some(path => denied(join(root, path)) !== undefined)) {
              dispatchRefusal = "output-file-read-denied";
              return false;
            }
            try {
              // The staged bytes stay on the sandbox read floor until the executor allows this call.
              replaceStagedFile(staged, root, undefined, () => target.check());
              staged = undefined;
            } catch {
              dispatchRefusal = "output-file-changed";
              return false;
            }
          }
          return true;
        };
        const status = await adapter.invoke({ output, args, root, workspace: workspace.root, surface: approvalSurface, recheck });
        if (dispatchRefusal !== undefined) return { id, status: "failed", detail: dispatchRefusal };
        if (status !== "done" && status !== "denied" && status !== "failed" && status !== "pending") {
          return { id, status: "failed", detail: status };
        }
        return { id, status, ...(status === "failed" ? { detail: "output-execution-failed" } : {}) };
      } finally {
        if (staged !== undefined) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
