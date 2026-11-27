import type { OutputExecution } from "./shipped-shapes.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
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
  | "file-outside-workspace" | "file-unreadable" | "needs-human-gate";
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

function relativeOutputFile(path: unknown): path is string {
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

export async function acceptRequestedOutput(input: OutputIntake, git: HostGit): Promise<Accepted> {
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
  if (isWorkflowPush(decl)) {
    const bound = raw.files === undefined && repository !== undefined
      ? await configuredWorkflowPush(git, repository, run.runId, raw.args) : undefined;
    if (!bound) return { ok: false, code: "remote-not-configured" };
    args = canonicalWorkflowJson(bound);
  } else {
    if (!isPlainRecord(raw.args)) return { ok: false, code: "args-too-large" };
    try { args = canonicalWorkflowJson(raw.args); } catch { return { ok: false, code: "args-too-large" }; }
  }
  if (Buffer.byteLength(args) > MAX_ARGS_BYTES || hasInvisibleOrReorderingChars(args)
    || (!isWorkflowPush(decl) && maskSensitiveData(args).masked !== args)) {
    return { ok: false, code: "args-too-large" };
  }
  let files: OutputFile[] | undefined;
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files)) return { ok: false, code: "file-unreadable" };
    try { files = await outputFiles(workspaceRoot, raw.files); }
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

export type GovernedOutputCall = (input: {
  output: RequestedOutput; args: Record<string, unknown>; root: string; surface: WebContents;
  recheck: () => Promise<boolean>;
}) => Promise<OutputExecution["status"]>;

export function createRequestedOutputHooks(git: HostGit, invoke: GovernedOutputCall): RequestedOutputHooks {
  return {
    accept: input => acceptRequestedOutput(input, git),
    async execute({ run, output, approvalSurface, workspace, canExecute }) {
      const { id, decl, files } = output;
      const args: unknown = JSON.parse(output.args);
      if (!isPlainRecord(args) || canonicalWorkflowJson(args) !== output.args) return { id, status: "failed", detail: "output-execution-failed" };
      if (!canExecute()) return { id, status: "failed", detail: "output-execution-interrupted" };
      if (isWorkflowPush(decl)) return { id, ...await executeWorkflowPush(git, workspace.repository, run.runId, args, canExecute) };
      if (!approvalSurface || approvalSurface.isDestroyed()) return { id, status: "denied", detail: "user-keyboard-required" };
      const recheck = async () => {
        if (!canExecute() || approvalSurface.isDestroyed()) return false;
        if (!files?.length) return true;
        try { return canonicalWorkflowJson(await outputFiles(workspace.root, files.map(file => file.path))) === canonicalWorkflowJson(files); }
        catch { return false; }
      };
      if (!await recheck()) return { id, status: "failed", detail: "output-file-changed" };
      // The target sees only copies of the approved bytes in its working folder, even if the stage folder is edited during the call.
      const root = await mkdtemp(join(tmpdir(), "ave-output-"));
      try {
        if (files?.length) {
          try {
            const source = holdDir(await realpath(workspace.root));
            const target = holdDir(await realpath(root));
            const copy = await copySeedFiles(source, target, files.map(file => file.path),
              new Map(files.map(file => [file.path, file.sha256])), false, MAX_OUTPUT_FILE_BYTES);
            if (canonicalWorkflowJson(copy) !== canonicalWorkflowJson(files)) throw new OutputFileError("file-unreadable");
          } catch { return { id, status: "failed", detail: "output-file-changed" }; }
        }
        const status = await invoke({ output, args, root, surface: approvalSurface, recheck });
        return { id, status, ...(status === "failed" ? { detail: "output-execution-failed" } : {}) };
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
