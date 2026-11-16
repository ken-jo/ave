import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowTemplateStore } from "../workflow-template-store.js";
import { canonicalTemplateGraph, graphHashOf, WorkflowTemplateError } from "../../work-board/template-graph.js";
import type { WorkflowTemplateDraftInput } from "../../shared/workflow-template-types.js";

const input = (): WorkflowTemplateDraftInput => ({
  name: "Delivery", scope: { kind: "all" },
  stages: [
    { id: "plan", name: "Plan", goal: "Read and plan", inputs: [], toolScope: "read", gate: { type: "human" }, allowSubAgents: false },
    { id: "build", name: "Build", goal: "Implement", inputs: ["plan"], toolScope: "all", gate: { type: "auto", pass: { kind: "stage_ok" } }, allowSubAgents: true },
  ], edges: [{ from: "plan", to: "build" }],
});
const actor = { who: "user", origin: "local-desktop" } as const;
let dir: string;
let path: string;
let store: WorkflowTemplateStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "templates-")); path = join(dir, "templates.json"); store = new WorkflowTemplateStore(path); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function confirmed() {
  const record = await store.draft(null, input());
  const version = await store.confirm(record.template.id, { expectedGraphHash: record.draft!.graphHash }, actor);
  return { id: record.template.id, version };
}
describe("workflow template store", () => {
  it("round trips drafts, versions and confirmation provenance", async () => {
    const { id, version } = await confirmed();
    expect(version).toMatchObject({ templateId: id, version: 1, confirmation: { templateId: id, version: 1, graphHash: version.graphHash, who: "user", origin: "local-desktop", at: expect.any(String) } });
    expect(await new WorkflowTemplateStore(path).get(id)).toEqual(await store.get(id));
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });
  it("edits a draft and confirms n+1 without mutating a confirmed version", async () => {
    const { id, version } = await confirmed();
    const next = input(); next.stages[1].goal = "Implement carefully"; next.basedOn = 1;
    const draft = await store.draft(id, next);
    expect(draft.draft).not.toHaveProperty("version");
    expect(await store.resolveVersion({ templateId: id, version: 1, graphHash: version.graphHash })).toEqual(version);
    const v2 = await store.confirm(id, { expectedGraphHash: draft.draft!.graphHash }, actor);
    expect(v2.version).toBe(2); expect(v2.basedOn).toBe(1);
    const returned = await store.get(id); returned.versions[0].stages[0].goal = "forged";
    expect((await store.get(id)).versions[0]).toEqual(version);
    await expect(store.draft(id, { ...input(), version: 1 } as never)).rejects.toMatchObject({ code: "confirmed-version-immutable" });
  });
  it("rejects stale confirmations, missing versions and mismatched pins clearly", async () => {
    const { id, version } = await confirmed();
    const first = await store.draft(id, input()); const edited = input(); edited.stages[0].goal = "Changed";
    await store.draft(id, edited);
    await expect(store.confirm(id, { expectedGraphHash: first.draft!.graphHash }, actor)).rejects.toMatchObject({ code: "stale-draft" });
    await expect(store.resolveVersion({ templateId: id, version: 99, graphHash: version.graphHash })).rejects.toMatchObject({ code: "unknown-version" });
    await expect(store.resolveVersion({ templateId: id, version: 1, graphHash: "a".repeat(64) })).rejects.toMatchObject({ code: "graph-hash-mismatch" });
  });
  it("archives softly while retaining old pinned versions", async () => {
    const { id, version } = await confirmed(); await store.archive(id);
    expect(await store.list()).toEqual([]); expect((await store.get(id)).template.archivedAt).toBeTruthy();
    expect(await store.resolveVersion({ templateId: id, version: 1, graphHash: version.graphHash })).toEqual(version);
    await expect(store.draft(id, input())).rejects.toMatchObject({ code: "template-archived" });
  });
  it("emits changed after each successful draft, confirm and archive only", async () => {
    let changes = 0; const unsubscribe = store.changed.subscribe(() => { changes++; });
    const { id } = await confirmed(); await store.archive(id); expect(changes).toBe(3); unsubscribe();
  });
  it("serializes concurrent confirmations and rejects reserved remote provenance", async () => {
    const r = await store.draft(null, input()); const request = { expectedGraphHash: r.draft!.graphHash };
    const results = await Promise.allSettled([store.confirm(r.template.id, request, actor), store.confirm(r.template.id, request, actor)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const d = await store.draft(r.template.id, input());
    await expect(store.confirm(r.template.id, { expectedGraphHash: d.draft!.graphHash }, { who: "user", origin: "tailnet-surface" })).rejects.toMatchObject({ code: "invalid-input" });
  });
  it("refuses tampered confirmed bytes rather than inventing a valid hash", async () => {
    await confirmed(); const data = JSON.parse(await readFile(path, "utf8")); data.templates[0].versions[0].stages[0].goal = "tampered";
    await writeFile(path, JSON.stringify(data)); await expect(new WorkflowTemplateStore(path).list()).rejects.toMatchObject({ code: "graph-hash-mismatch" });
  });
});
describe("canonical graph hash", () => {
  it("accepts and hashes the model verdict pass kind distinctly from stage success", async () => {
    const graph = input();
    graph.stages[1].gate = { type: "auto", pass: { kind: "model_verdict" } };
    expect(canonicalTemplateGraph(graph).stages.find(stage => stage.id === "build")!.gate).toEqual(graph.stages[1].gate);
    const hash = graphHashOf(graph);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(graphHashOf(input()));
    const draft = await store.draft(null, graph);
    const version = await store.confirm(draft.template.id, { expectedGraphHash: hash }, actor);
    expect(version.graphHash).toBe(hash);
    expect((await new WorkflowTemplateStore(path).get(draft.template.id)).versions[0]).toEqual(version);
  });
  it("rejects an unknown automatic pass kind", () => {
    const graph = input();
    Object.assign(graph.stages[1].gate, { pass: { kind: "unknown" } });
    expect(() => canonicalTemplateGraph(graph)).toThrow(WorkflowTemplateError);
    expect(() => graphHashOf(graph)).toThrow("invalid-input");
  });
  it("ignores object, stage, edge and input ordering", () => {
    const a = input(); a.stages.push({ ...a.stages[1], id: "review", name: "Review", inputs: ["plan", "build"], gate: { type: "human" } }); a.edges.push({ from: "build", to: "review" }, { from: "plan", to: "review" });
    const permuted = { stages: a.stages.map(s => Object.fromEntries(Object.entries({ ...s, inputs: [...s.inputs].reverse() }).reverse())).reverse(), edges: [...a.edges].reverse().map(e => ({ to: e.to, from: e.from })) };
    expect(graphHashOf(permuted)).toBe(graphHashOf(a));
  });
  it.each(["name", "goal", "toolScope", "allowSubAgents", "agentName", "gate", "inputs", "edges"])("binds semantic field %s", field => {
    const a = input(); const b = input();
    if (field === "edges") { b.edges = []; b.stages[1].inputs = []; }
    else if (field === "inputs") b.stages[1].inputs = [];
    else Object.assign(b.stages[1], { [field]: ({ name: "Other", goal: "Other", toolScope: "read", allowSubAgents: false, agentName: "reviewer", gate: { type: "auto", pass: { kind: "check_exit_zero", command: "check" } } } as Record<string, unknown>)[field] });
    expect(graphHashOf(b)).not.toBe(graphHashOf(a));
  });
  it("binds stage identity, gate type and check command bytes", () => {
    const a = input(); a.stages[1].gate = { type: "auto", pass: { kind: "check_exit_zero", command: "check-a" } };
    const b = structuredClone(a); b.stages[1].gate = { type: "auto", pass: { kind: "check_exit_zero", command: "check-b" } };
    expect(graphHashOf(a)).not.toBe(graphHashOf(b));
    b.stages[1].gate = { type: "human" }; expect(graphHashOf(a)).not.toBe(graphHashOf(b));
    const c = input(); c.stages[1].id = "implement"; c.edges[0].to = "implement";
    expect(graphHashOf(input())).not.toBe(graphHashOf(c));
  });
  it("rejects cycles, duplicate ids, unknown options and non-ancestor inputs", () => {
    const a = input(); a.edges.push({ from: "build", to: "plan" }); expect(() => graphHashOf(a)).toThrow();
    const b = input(); b.stages[1].id = "plan"; expect(() => graphHashOf(b)).toThrow();
    expect(() => graphHashOf({ ...input(), stages: [{ ...input().stages[0], extra: true }] })).toThrow();
    const c = input(); c.edges = []; expect(() => graphHashOf(c)).toThrow();
  });
});
