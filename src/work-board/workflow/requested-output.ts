import { redactHomePathsInText } from "../../audit/dlp-filter.js";
import { hasControlChars, hasInvisibleOrReorderingChars, hasNonWhitespaceControlChars } from "../../shared/display-safe-text.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { hasExactKeys, isPlainRecord } from "../../shared/is-record.js";
import { canonicalWorkflowJson, LOCAL_BRANCH_OUTPUT, stageOutputBranch } from "../../shared/workflow-template-output.js";
import type { RequestedOutput, TemplateStage } from "../../shared/workflow-template-types.js";
import { isTemplateId, isWorkspaceGlob } from "../template-graph.js";

const MAX_REQUESTS = 10;
const MAX_RESULT_CHARS = 48_000;
const MAX_ARGS_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = MAX_REQUESTS * (MAX_ARGS_BYTES + 2048) + 6 * MAX_RESULT_CHARS;
const ARG_FIELDS = {
  upload: ["destination", "path"],
  "send-message": ["recipient", "text"],
  "publish-post": ["destination", "text"],
  "external-write": ["target", "data"],
} as const;

function isPush(decl: RequestedOutput["decl"]): boolean {
  return decl.kind === "external-write" && decl.owner === "host" && decl.ownerId === "host:git" && decl.toolName === "git_push";
}

function declarations(stage: TemplateStage): RequestedOutput["decl"][] {
  if (stage.gate.type !== "human") return [];
  return [
    ...(stage.envelope?.outputs.includes("branch") ? [LOCAL_BRANCH_OUTPUT] : []),
    ...(stage.requestedOutputs ?? []).filter(decl => decl.kind !== "other" && (!stage.envelope || stage.envelope.outputs.includes(decl.kind))),
  ];
}

export function requestedOutputPrompt(stage: TemplateStage): string | undefined {
  if (!stageCollectsRequestedOutputs(stage)) return undefined;
  const allowed = declarations(stage);
  const choices = allowed.map(decl => {
    const fields = decl.kind === "branch" ? [] : isPush(decl) ? ["remote"] : decl.kind === "other" ? [] : ARG_FIELDS[decl.kind];
    return { ...decl, args: Object.fromEntries(fields.map(field => [field, "<string>"])) };
  });
  return [
    'Return a single JSON object with exactly "result" (your stage result as a string) and "requestedOutputs" (an array, empty if no effect is needed). Do not wrap it in a code fence.',
    'Each requested output is data for human review. Use one of the exact kind, owner, ownerId, toolName and args shapes below, plus a unique "id" (letters, digits, underscore or hyphen) and a short "summary". Do not perform the requested effect yourself.',
    'Use a stage-relative file path for an upload and a configured remote name for a push request. The host chooses the branch name.',
    JSON.stringify(choices),
  ].join("\n");
}

function singleLine(value: unknown, max = 2048): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    && !hasControlChars(value) && !hasInvisibleOrReorderingChars(value);
}

function reviewable(value: string): boolean {
  return redactHomePathsInText(value) === value && maskSensitiveData(value).masked === value;
}

function matchesArgs(decl: RequestedOutput["decl"], args: Record<string, unknown>): boolean {
  if (decl.kind === "branch") return hasExactKeys(args, []);
  if (isPush(decl)) return hasExactKeys(args, ["remote"]) && typeof args.remote === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(args.remote);
  if (decl.kind === "other") return false;
  if (!hasExactKeys(args, ARG_FIELDS[decl.kind])) return false;
  if (decl.kind === "upload") {
    return singleLine(args.destination) && singleLine(args.path) && isWorkspaceGlob(args.path)
      && !/[:*?\\]/u.test(args.path) && args.path.split("/").every(part => part !== "" && part !== "." && !/[. ]$/u.test(part));
  }
  const address = decl.kind === "send-message" ? args.recipient : decl.kind === "publish-post" ? args.destination : args.target;
  const body = decl.kind === "external-write" ? args.data : args.text;
  return singleLine(address) && typeof body === "string" && body.trim().length > 0
    && !hasNonWhitespaceControlChars(body) && reviewable(body);
}

function parseRequest(allowed: readonly RequestedOutput["decl"][], raw: unknown, branch: string | undefined): RequestedOutput | undefined {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ["id", "kind", "toolName", "owner", "ownerId", "args", "summary"])
    || !isTemplateId(raw.id) || !isPlainRecord(raw.args) || typeof raw.summary !== "string"
    || raw.summary.length > 400 || hasNonWhitespaceControlChars(raw.summary)) return undefined;
  const decl = allowed.find(candidate =>
    candidate.kind === raw.kind && candidate.toolName === raw.toolName && candidate.owner === raw.owner && candidate.ownerId === raw.ownerId);
  if (!decl || !matchesArgs(decl, raw.args) || !reviewable(canonicalWorkflowJson(decl))) return undefined;
  const needsBranch = decl.kind === "branch" || isPush(decl);
  if (needsBranch && branch === undefined) return undefined;
  const args = canonicalWorkflowJson(needsBranch ? { ...raw.args, branch } : raw.args);
  if (Buffer.byteLength(args, "utf8") > MAX_ARGS_BYTES || !reviewable(args)
    || !Object.values(raw.args).every(value => typeof value === "string" && reviewable(value))) return undefined;
  return { id: raw.id, decl, args, summary: raw.summary };
}

export function collectRequestedOutputs(stage: TemplateStage, runId: string, text: string):
  { ok: true; output: string; requestedOutputs?: RequestedOutput[] } | { ok: false } {
  if (!stageCollectsRequestedOutputs(stage)) return { ok: true, output: text.slice(0, MAX_RESULT_CHARS) };
  const allowed = declarations(stage);
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return { ok: false };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false }; }
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ["result", "requestedOutputs"]) || typeof raw.result !== "string"
    || !Array.isArray(raw.requestedOutputs) || raw.requestedOutputs.length > MAX_REQUESTS) return { ok: false };
  const outputs: RequestedOutput[] = [];
  const ids = new Set<string>();
  const branch = stageOutputBranch(runId, stage.id);
  for (const entry of raw.requestedOutputs as unknown[]) {
    const request = parseRequest(allowed, entry, branch);
    if (!request || ids.has(request.id) || (request.decl.kind === "branch" && outputs.some(output => output.decl.kind === "branch"))) return { ok: false };
    outputs.push(request);
    ids.add(request.id);
  }
  return { ok: true, output: raw.result.slice(0, MAX_RESULT_CHARS), ...(outputs.length > 0 && { requestedOutputs: outputs }) };
}

/** Stored requests must still be the canonical requests that intake would have accepted for this exact stage. */
export function requestedOutputsMatchStage(stage: TemplateStage, runId: string, outputs: readonly RequestedOutput[]): boolean {
  const allowed = declarations(stage);
  const branch = stageOutputBranch(runId, stage.id);
  let branches = 0;
  return outputs.length <= MAX_REQUESTS && new Set(outputs.map(output => output.id)).size === outputs.length && outputs.every(output => {
    let args: unknown;
    try { args = JSON.parse(output.args); } catch { return false; }
    if (!isPlainRecord(args)) return false;
    if (output.decl.kind === "branch" || isPush(output.decl)) {
      if (args.branch !== branch || (output.decl.kind === "branch" && ++branches > 1)) return false;
      delete args.branch;
    }
    const checked = parseRequest(allowed, { id: output.id, ...output.decl, args, summary: output.summary }, branch);
    return checked !== undefined && canonicalWorkflowJson(checked) === canonicalWorkflowJson(output);
  });
}

export function stageCollectsRequestedOutputs(stage: TemplateStage): boolean {
  return stage.gate.type === "human" && (!!stage.requestedOutputs?.length || stage.envelope?.outputs.includes("branch") === true);
}
