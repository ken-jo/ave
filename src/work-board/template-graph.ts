import { createHash } from "node:crypto";
import { canonicalWorkflowJson } from "../shared/workflow-template-output.js";
import type { StageEnvelope, StageGenerationTool, RequestedOutputKind, TemplateGraph, TemplateStage, WorkflowTemplateDraftInput, WorkflowTemplateErrorCode, EnvelopeRefusal, StageInputDecl } from "../shared/workflow-template-types.js";
import { isSensitivePath, protectedControlEntryFor } from "../permissions/sensitive-paths.js";
import { hasOnlyKeys, isPlainRecord, isRecord } from "../shared/is-record.js";

export class WorkflowTemplateError extends Error {
  constructor(readonly code: WorkflowTemplateErrorCode, message: string = code, readonly refusals?: EnvelopeRefusal[]) { super(message); this.name = "WorkflowTemplateError"; }
}
export function requireTemplate(condition: unknown, code: WorkflowTemplateErrorCode = "invalid-input"): asserts condition {
  if (!condition) throw new WorkflowTemplateError(code);
}
export function isTemplateId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function isGraphHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function isTemplateVersion(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function isStageId(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value); }
export function isWorkspaceGlob(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2048 && ![...value].some(character => character.charCodeAt(0) < 32) && !/^(?:[a-z]:|[/\\])/i.test(value) && !value.split(/[/\\]/).includes(".."); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
export function hasTemplateKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && hasOnlyKeys(value, keys);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

const REQUESTED_OUTPUT_KINDS: readonly RequestedOutputKind[] = ["publish", "upload", "post", "send", "push", "merge", "purchase"];
function workspaceGlobs(raw: unknown, max: number): string[] {
  requireTemplate(Array.isArray(raw)); requireTemplate(raw.length <= max, "too-many-entries");
  requireTemplate(raw.every(isWorkspaceGlob)); return [...raw];
}
function stringList(raw: unknown, fallback: string[] = []): string[] {
  const value = raw === undefined ? fallback : raw;
  requireTemplate(Array.isArray(value) && value.every(v => text(v, 2048)));
  requireTemplate(value.length <= 256, "too-many-entries");
  return [...new Set(value as string[])].sort(compare);
}
function isOutwardAction(value: string): boolean {
  return /(?:^|[^a-z])(publish|upload|post|send|push|merge|purchase|deploy)(?:$|[^a-z])/.test(value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
}
function envelopeTools(raw: unknown): string[] {
  const tools = stringList(raw);
  requireTemplate(tools.every(name => !isOutwardAction(name)), "forbidden-envelope-tool");
  return tools;
}
function generationTools(raw: unknown): StageGenerationTool[] {
  if (raw === undefined) return [];
  requireTemplate(Array.isArray(raw)); requireTemplate(raw.length <= 256, "too-many-entries");
  const tools = raw.map((tool: unknown): StageGenerationTool => {
    requireTemplate(hasTemplateKeys(tool, ["name", "effect", "dataSent"]) && text(tool.name, 256));
    requireTemplate(!isOutwardAction(tool.name) && !(typeof tool.effect === "string" && isOutwardAction(tool.effect)), "forbidden-envelope-tool");
    requireTemplate((tool.effect === "generate" || tool.effect === "fetch") && typeof tool.dataSent === "boolean");
    return { name: tool.name, effect: tool.effect, dataSent: tool.dataSent };
  }).sort((a, b) => compare(a.name, b.name));
  requireTemplate(new Set(tools.map(t => t.name)).size === tools.length);
  return tools;
}
function requestedOutputs(raw: unknown): RequestedOutputKind[] {
  const outputs = stringList(raw);
  requireTemplate(outputs.every(kind => REQUESTED_OUTPUT_KINDS.includes(kind as RequestedOutputKind)));
  return outputs as RequestedOutputKind[];
}
function canonicalEnvelope(raw: unknown): StageEnvelope {
  requireTemplate(hasTemplateKeys(raw, ["tools", "writePaths", "readRoots", "network", "commands", "mcpReadOnlyTools", "mcpGenerationTools", "pluginGenerationTools", "outputs", "budget"]));
  const network = raw.network === undefined ? [] : raw.network;
  requireTemplate(Array.isArray(network)); requireTemplate(network.length <= 256, "too-many-entries");
  const entries = network.map((entry: unknown) => {
    requireTemplate(hasTemplateKeys(entry, ["host", "port"]) && typeof entry.host === "string");
    const host = entry.host.toLowerCase();
    requireTemplate(host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
    requireTemplate(entry.port === undefined || (Number.isInteger(entry.port) && (entry.port as number) >= 1 && (entry.port as number) <= 65535));
    return { host, ...(entry.port === undefined ? {} : { port: entry.port as number }) };
  }).sort((a, b) => compare(a.host, b.host) || (a.port ?? 0) - (b.port ?? 0));
  const uniqueNetwork = entries.filter((entry, i) => i === 0 || entry.host !== entries[i - 1].host || entry.port !== entries[i - 1].port);
  const budget = raw.budget;
  requireTemplate(hasTemplateKeys(budget, ["rounds", "minutes", "costUsd"]) && Number.isSafeInteger(budget.rounds) && (budget.rounds as number) > 0 && typeof budget.minutes === "number" && Number.isFinite(budget.minutes) && budget.minutes > 0 && typeof budget.costUsd === "number" && Number.isFinite(budget.costUsd) && budget.costUsd >= 0);
  const outputs = stringList(raw.outputs, ["branch"]);
  requireTemplate(outputs.every(kind => kind === "branch" || REQUESTED_OUTPUT_KINDS.includes(kind as RequestedOutputKind)));
  const writePaths = stringList(raw.writePaths, ["**"]);
  requireTemplate(writePaths.every(isWorkspaceGlob));
  return { tools: envelopeTools(raw.tools), writePaths, readRoots: stringList(raw.readRoots), network: uniqueNetwork, commands: stringList(raw.commands), mcpReadOnlyTools: envelopeTools(raw.mcpReadOnlyTools), mcpGenerationTools: generationTools(raw.mcpGenerationTools), pluginGenerationTools: generationTools(raw.pluginGenerationTools), outputs: outputs as StageEnvelope["outputs"], budget: { rounds: budget.rounds as number, minutes: budget.minutes, costUsd: budget.costUsd } };
}

// Lift this interim restriction when unattended evaluation and isolation are available.
export function isAllReadOnlyVersion(graph: TemplateGraph): boolean {
  return !graph.setupCommands?.length && graph.stages.every(stage => stage.toolScope === "read" && !stage.allowSubAgents && !stage.requestedOutputs?.length && (!stage.envelope || (stage.envelope.mcpReadOnlyTools.length === 0 && stage.envelope.outputs.length === 0 && stage.envelope.network.length === 0 && stage.envelope.writePaths.length === 0 && stage.envelope.commands.length === 0 && stage.envelope.mcpGenerationTools.length === 0 && stage.envelope.pluginGenerationTools.length === 0)));
}

// Absent or empty optional collections are omitted; required members retain their canonical defaults.
export function canonicalTemplateGraph(raw: unknown): TemplateGraph {
  requireTemplate(isRecord(raw) && Array.isArray(raw.stages) && raw.stages.length > 0 && raw.stages.length <= 12 && Array.isArray(raw.edges) && raw.edges.length <= 132);
  const stages = raw.stages.map((s: unknown): TemplateStage => {
    requireTemplate(hasTemplateKeys(s, ["id", "name", "goal", "kind", "inputs", "toolScope", "agentName", "allowSubAgents", "gate", "envelope", "requestedOutputs", "inputFiles", "outputs"]));
    requireTemplate(isStageId(s.id), "bad-stage-id");
    requireTemplate(text(s.name, 40) && text(s.goal, 400));
    requireTemplate(Array.isArray(s.inputs) && s.inputs.length <= 12 && s.inputs.every(isTemplateId) && new Set(s.inputs).size === s.inputs.length);
    requireTemplate(s.toolScope === "read" || s.toolScope === "all");
    requireTemplate(s.agentName === undefined || text(s.agentName, 128));
    requireTemplate(s.kind === undefined || s.kind === "plan");
    requireTemplate(s.allowSubAgents === undefined || typeof s.allowSubAgents === "boolean");
    const g = s.gate;
    requireTemplate(isRecord(g));
    if (g.type === "human") requireTemplate(hasTemplateKeys(g, ["type"]));
    else {
      requireTemplate(g.type === "auto" && hasTemplateKeys(g, ["type", "pass"]) && isRecord(g.pass));
      const p = g.pass;
      requireTemplate(((p.kind === "stage_ok" || p.kind === "model_verdict") && hasTemplateKeys(p, ["kind"])) || (p.kind === "check_exit_zero" && text(p.command, 2000) && hasTemplateKeys(p, ["kind", "command"])));
    }
    if (s.inputFiles !== undefined) {
      requireTemplate(Array.isArray(s.inputFiles)); requireTemplate(s.inputFiles.length <= 64, "too-many-entries");
      for (const entry of s.inputFiles) {
        requireTemplate(isRecord(entry));
        requireTemplate(hasTemplateKeys(entry, entry.from === "project" ? ["from", "paths"] : ["from", "stageId"]));
        if (entry.from === "project") workspaceGlobs(entry.paths, 64);
        else requireTemplate(entry.from === "stage" && isStageId(entry.stageId));
      }
    }
    return { id: s.id, name: s.name, goal: s.goal, inputs: [...s.inputs].sort(compare), toolScope: s.toolScope, ...(s.agentName !== undefined ? { agentName: s.agentName as string } : {}), allowSubAgents: s.allowSubAgents === true, gate: structuredClone(g) as TemplateStage["gate"], ...(Array.isArray(s.inputFiles) && s.inputFiles.length > 0 ? { inputFiles: structuredClone(s.inputFiles) as StageInputDecl[] } : {}), ...(Array.isArray(s.outputs) && s.outputs.length > 0 ? { outputs: workspaceGlobs(s.outputs, 32) } : {}), ...(s.envelope !== undefined ? { envelope: canonicalEnvelope(s.envelope) } : {}), ...(Array.isArray(s.requestedOutputs) && s.requestedOutputs.length > 0 ? { requestedOutputs: requestedOutputs(s.requestedOutputs) } : {}) };
  }).sort((a, b) => compare(a.id, b.id));
  const ids = new Set(stages.map(s => s.id)); requireTemplate(ids.size === stages.length);
  const edgeKeys = new Set<string>();
  const edges = raw.edges.map((e: unknown) => {
    requireTemplate(hasTemplateKeys(e, ["from", "to"]) && isTemplateId(e.from) && isTemplateId(e.to) && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    const key = JSON.stringify([e.from, e.to]); requireTemplate(!edgeKeys.has(key)); edgeKeys.add(key);
    return { from: e.from, to: e.to };
  }).sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
  const ancestors = (id: string, visiting = new Set<string>()): Set<string> => {
    requireTemplate(!visiting.has(id)); const next = new Set(visiting).add(id); const found = new Set<string>();
    for (const e of edges.filter(e => e.to === id)) { found.add(e.from); for (const a of ancestors(e.from, next)) found.add(a); }
    return found;
  };
  for (const s of stages) { const before = ancestors(s.id); requireTemplate(s.inputs.every(id => before.has(id)) && (s.inputFiles ?? []).every(input => input.from === "project" || before.has(input.stageId))); }
  const roots = stages.filter(s => !edges.some(e => e.to === s.id));
  if (roots.length === 1 && roots[0].toolScope === "read" && roots[0].gate.type === "human") roots[0].kind = "plan";
  for (const rawStage of raw.stages) requireTemplate(rawStage.kind === undefined || rawStage.kind === stages.find(s => s.id === rawStage.id)?.kind);
  if (raw.setupCommands !== undefined) requireTemplate(Array.isArray(raw.setupCommands) && raw.setupCommands.length <= 256 && raw.setupCommands.every(command => text(command, 8192)));
  return { stages, edges, ...(Array.isArray(raw.setupCommands) && raw.setupCommands.length > 0 ? { setupCommands: [...raw.setupCommands as string[]] } : {}) };
}
export function graphHashOf(graph: unknown): string {
  return createHash("sha256").update(canonicalWorkflowJson(canonicalTemplateGraph(graph)), "utf8").digest("hex");
}
export function parseTemplateDraft(raw: unknown): WorkflowTemplateDraftInput {
  requireTemplate(isRecord(raw));
  requireTemplate(!("version" in raw) && !("confirmedAt" in raw), "confirmed-version-immutable");
  requireTemplate(hasTemplateKeys(raw, ["name", "scope", "description", "basedOn", "stages", "edges", "setupCommands"]) && text(raw.name, 60));
  requireTemplate(raw.description === undefined || (typeof raw.description === "string" && raw.description.length <= 8192));
  requireTemplate(raw.basedOn === undefined || isTemplateVersion(raw.basedOn));
  const scope = raw.scope;
  requireTemplate(isRecord(scope) && ((scope.kind === "all" && hasTemplateKeys(scope, ["kind"])) || (scope.kind === "project" && hasTemplateKeys(scope, ["kind", "projectRoot"]) && text(scope.projectRoot, 2048))));
  return { name: raw.name, scope: structuredClone(scope) as WorkflowTemplateDraftInput["scope"], ...(raw.description !== undefined ? { description: raw.description as string } : {}), ...(raw.basedOn !== undefined ? { basedOn: raw.basedOn as number } : {}), ...canonicalTemplateGraph(raw) };
}

const READ_ENVELOPE_TOOLS = new Set(["read_file", "view_image", "read_document", "open_document", "list_files", "glob_files", "grep_files", "read_tool_result_chunk"]);
/** Declaration checks only; runtime tool resolution and effect enforcement remain separate. */
export function validateStageForConfirm(stage: TemplateStage, template: TemplateGraph): EnvelopeRefusal[] {
  const refusals: EnvelopeRefusal[] = [];
  if (!isStageId(stage.id)) refusals.push("bad-stage-id");
  try { if (stage.outputs !== undefined) workspaceGlobs(stage.outputs, 32); if (stage.inputFiles !== undefined) { requireTemplate(stage.inputFiles.length <= 64, "too-many-entries"); for (const entry of stage.inputFiles) if (entry.from === "project") workspaceGlobs(entry.paths, 64); } }
  catch (error) { if (error instanceof WorkflowTemplateError && error.code === "too-many-entries") refusals.push("too-many-entries"); }
  const envelope = stage.envelope;
  if (!envelope) return refusals;
  try { canonicalEnvelope(envelope); }
  catch (error) {
    if (error instanceof WorkflowTemplateError) {
      if (error.code === "forbidden-envelope-tool") refusals.push("outward-tool-declared");
      if (error.code === "too-many-entries") refusals.push("too-many-entries");
    } else throw error;
  }
  if (envelope.outputs.some(kind => kind !== "branch") && stage.gate.type !== "human") refusals.push("outputs-need-human-gate");
  if ((template.setupCommands ?? []).some(command => !envelope.commands.some(prefix => command === prefix || command.startsWith(`${prefix} `) || command.startsWith(`${prefix}\t`)))) refusals.push("setup-outside-commands");
  if (stage.toolScope === "read" && (envelope.tools.some(tool => !READ_ENVELOPE_TOOLS.has(tool)) || envelope.mcpGenerationTools.length > 0 || envelope.pluginGenerationTools.length > 0)) refusals.push("tools-broader-than-scope");
  if (envelope.tools.some(tool => ["host_shell", "host_bash", "host_powershell"].includes(tool))) refusals.push("host-shell");
  if (envelope.tools.some(tool => tool.startsWith("browser_") || tool.startsWith("terminal_"))) refusals.push("user-owned-surface");
  for (const path of [...envelope.writePaths, ...envelope.readRoots]) {
    if (protectedControlEntryFor(path)) refusals.push("floor-target");
    if (isSensitivePath(path, "read")) refusals.push("secret-path");
  }
  return [...new Set(refusals)];
}
