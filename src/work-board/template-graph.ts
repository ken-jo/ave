import { createHash } from "node:crypto";
import type { TemplateGraph, TemplateStage, WorkflowTemplateDraftInput, WorkflowTemplateErrorCode } from "../shared/workflow-template-types.js";
import { hasOnlyKeys, isPlainRecord, isRecord } from "../shared/is-record.js";

export class WorkflowTemplateError extends Error {
  constructor(readonly code: WorkflowTemplateErrorCode) { super(code); this.name = "WorkflowTemplateError"; }
}
export function requireTemplate(condition: unknown, code: WorkflowTemplateErrorCode = "invalid-input"): asserts condition {
  if (!condition) throw new WorkflowTemplateError(code);
}
export function isTemplateId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function isGraphHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function isTemplateVersion(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
export function hasTemplateKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && hasOnlyKeys(value, keys);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function canonicalTemplateGraph(raw: unknown): TemplateGraph {
  requireTemplate(isRecord(raw) && Array.isArray(raw.stages) && raw.stages.length > 0 && raw.stages.length <= 12 && Array.isArray(raw.edges) && raw.edges.length <= 132);
  const stages = raw.stages.map((s: unknown): TemplateStage => {
    requireTemplate(hasTemplateKeys(s, ["id", "name", "goal", "kind", "inputs", "toolScope", "agentName", "allowSubAgents", "gate"]));
    requireTemplate(isTemplateId(s.id) && text(s.name, 40) && text(s.goal, 400));
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
      requireTemplate((p.kind === "stage_ok" && hasTemplateKeys(p, ["kind"])) || (p.kind === "check_exit_zero" && text(p.command, 2000) && hasTemplateKeys(p, ["kind", "command"])));
    }
    return { id: s.id, name: s.name, goal: s.goal, inputs: [...s.inputs].sort(compare), toolScope: s.toolScope, ...(s.agentName !== undefined ? { agentName: s.agentName as string } : {}), allowSubAgents: s.allowSubAgents === true, gate: structuredClone(g) as TemplateStage["gate"] };
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
  for (const s of stages) { const before = ancestors(s.id); requireTemplate(s.inputs.every(id => before.has(id))); }
  const roots = stages.filter(s => !edges.some(e => e.to === s.id));
  if (roots.length === 1 && roots[0].toolScope === "read" && roots[0].gate.type === "human") roots[0].kind = "plan";
  for (const rawStage of raw.stages) requireTemplate(rawStage.kind === undefined || rawStage.kind === stages.find(s => s.id === rawStage.id)?.kind);
  return { stages, edges };
}
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
  return value;
}
export function graphHashOf(graph: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortedKeys(canonicalTemplateGraph(graph))), "utf8").digest("hex");
}
export function parseTemplateDraft(raw: unknown): WorkflowTemplateDraftInput {
  requireTemplate(isRecord(raw));
  requireTemplate(!("version" in raw) && !("confirmedAt" in raw), "confirmed-version-immutable");
  requireTemplate(hasTemplateKeys(raw, ["name", "scope", "description", "basedOn", "stages", "edges"]) && text(raw.name, 60));
  requireTemplate(raw.description === undefined || (typeof raw.description === "string" && raw.description.length <= 8192));
  requireTemplate(raw.basedOn === undefined || isTemplateVersion(raw.basedOn));
  const scope = raw.scope;
  requireTemplate(isRecord(scope) && ((scope.kind === "all" && hasTemplateKeys(scope, ["kind"])) || (scope.kind === "project" && hasTemplateKeys(scope, ["kind", "projectRoot"]) && text(scope.projectRoot, 2048))));
  return { name: raw.name, scope: structuredClone(scope) as WorkflowTemplateDraftInput["scope"], ...(raw.description !== undefined ? { description: raw.description as string } : {}), ...(raw.basedOn !== undefined ? { basedOn: raw.basedOn as number } : {}), ...canonicalTemplateGraph(raw) };
}
