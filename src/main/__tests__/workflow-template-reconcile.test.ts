import { requiredValue } from "../../__tests__/support/required-value.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalTemplateGraph, graphHashOf, validateStageForConfirm, isAllReadOnlyVersion } from "../../work-board/template-graph.js";
import { WorkflowTemplateStore } from "../workflow-template-store.js";
import { mintHostDecisionProof } from "../workflow-template-decision.js";
import type { StageEnvelope, TemplateGraph } from "../../shared/workflow-template-types.js";
const envelope = (): StageEnvelope => ({ tools: ["read_file"], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 } });
const graph = (): TemplateGraph => ({ stages: [{ id: "a", name: "A", goal: "Read", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" }, envelope: envelope() }], edges: [] });
it.each(["A", "_out", "../a", "a/b", "a".repeat(33), ""])("refuses unsafe stage id %s", id => { const g = graph(); g.stages[0].id = id; expect(() => canonicalTemplateGraph(g)).toThrow(expect.objectContaining({ code: "bad-stage-id" })); });
it("accepts the stage id boundaries", () => { for (const id of ["0", "a".repeat(32)]) { const g = graph(); g.stages[0].id = id; expect(canonicalTemplateGraph(g).stages[0].id).toBe(id); } });
it("hashes folder inputs and outputs and requires upstream stage references", () => {
  const g = graph(); g.stages.push({ ...g.stages[0], id: "b", inputFiles: [{ from: "stage", stageId: "a" }, { from: "project", paths: ["docs/**"] }], outputs: ["result/**"] }); g.edges = [{ from: "a", to: "b" }];
  const hash = graphHashOf(g); const changed = structuredClone(g); changed.stages[1].outputs = ["other/**"]; expect(graphHashOf(changed)).not.toBe(hash);
  changed.stages[1].outputs = g.stages[1].outputs; changed.stages[1].inputFiles = [{ from: "project", paths: ["assets/**"] }]; expect(graphHashOf(changed)).not.toBe(hash);
  g.edges = []; expect(() => canonicalTemplateGraph(g)).toThrow();
});
it.each(["/absolute", "C:/absolute", "../out", "a/../out", "a\\..\\out", "\\server\\out"])("refuses nonrelative folder glob %s", path => {
  for (const field of ["outputs", "inputFiles"] as const) { const g = graph(); Object.assign(g.stages[0], field === "outputs" ? { outputs: [path] } : { inputFiles: [{ from: "project", paths: [path] }] }); expect(() => graphHashOf(g)).toThrow(); }
});
it("bounds folder declarations", () => {
  for (const patch of [{ outputs: Array(33).fill("**") }, { inputFiles: Array(65).fill({ from: "project", paths: ["**"] }) }, { inputFiles: [{ from: "project", paths: Array(65).fill("**") }] }]) { const g = graph(); Object.assign(g.stages[0], patch); expect(() => graphHashOf(g)).toThrow(expect.objectContaining({ code: "too-many-entries" })); }
});
it.each(["outputs-need-human-gate", "outward-tool-declared", "setup-outside-commands", "tools-broader-than-scope", "bad-stage-id", "too-many-entries", "host-shell", "floor-target", "secret-path", "user-owned-surface"] as const)("returns confirm refusal %s", code => {
  const g = graph(); const s = g.stages[0];
  if (code === "outputs-need-human-gate") { s.gate = { type: "auto", pass: { kind: "stage_ok" } }; requiredValue(s.envelope).outputs = ["publish"]; }
  if (code === "outward-tool-declared") requiredValue(s.envelope).mcpGenerationTools = [{ name: "media.send", effect: "generate", dataSent: true }];
  if (code === "setup-outside-commands") g.setupCommands = ["prepare assets"];
  if (code === "tools-broader-than-scope") requiredValue(s.envelope).tools = ["write_file"];
  if (code === "bad-stage-id") s.id = "_join";
  if (code === "too-many-entries") requiredValue(s.envelope).tools = Array(257).fill("read_file");
  if (code === "host-shell") requiredValue(s.envelope).tools = ["host_shell"];
  if (code === "floor-target") requiredValue(s.envelope).writePaths = [".git/config"];
  if (code === "secret-path") requiredValue(s.envelope).readRoots = ["/project/.env"];
  if (code === "user-owned-surface") requiredValue(s.envelope).tools = ["browser_click"];
  expect(validateStageForConfirm(s, g)).toContain(code);
});
it("uses command prefixes at token boundaries and permits branch-only automatic gates", () => {
  const g = graph(); const s = g.stages[0]; s.gate = { type: "auto", pass: { kind: "stage_ok" } }; requiredValue(s.envelope).outputs = ["branch"]; requiredValue(s.envelope).commands = ["prepare"];
  g.setupCommands = ["prepare assets"]; expect(validateStageForConfirm(s, g)).toEqual([]);
  g.setupCommands = ["prepare-other"]; expect(validateStageForConfirm(s, g)).toContain("setup-outside-commands");
});
it("has one conservative read-only predicate", () => {
  const g = graph(); expect(isAllReadOnlyVersion(g)).toBe(true);
  for (const patch of [{ allowSubAgents: true }, { requestedOutputs: ["send"] }, { envelope: { ...envelope(), mcpReadOnlyTools: ["media.read"] } }, { envelope: { ...envelope(), network: [{ host: "example.com" }] } }, { envelope: { ...envelope(), outputs: ["branch"] } }]) { const changed = graph(); Object.assign(changed.stages[0], patch); expect(isAllReadOnlyVersion(changed)).toBe(false); }
});
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "template-reconcile-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const proof = () => mintHostDecisionProof("local-desktop");
it("confirm refuses a typed list without mutating the draft", async () => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const g = graph(); g.setupCommands = ["prepare"]; requiredValue(g.stages[0].envelope).tools = ["write_file"];
  const r = await store.draft(null, { ...g, name: "Template", scope: { kind: "all" } }); const before = await readFile(join(dir, "templates.json"), "utf8");
  await expect(store.confirmDraft(r.template.id, { expectedGraphHash: requiredValue(r.draft).graphHash, expectedDraftRevision: requiredValue(r.draft).revision }, { who: "user", origin: "local-desktop" })).rejects.toMatchObject({ code: "envelope-refused", refusals: ["setup-outside-commands", "tools-broader-than-scope"] });
  expect(await readFile(join(dir, "templates.json"), "utf8")).toBe(before);
});
it("retains stable attachment ids and detach history with readers", async () => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const r = await store.draft(null, { ...graph(), name: "Template", scope: { kind: "all" } }); const v = await store.confirmDraft(r.template.id, { expectedGraphHash: requiredValue(r.draft).graphHash, expectedDraftRevision: requiredValue(r.draft).revision }, { who: "user", origin: "local-desktop" }); const request = { templateId: v.templateId, version: 1, graphHash: v.graphHash, scheduleId: "daily" };
  await expect(store.attachSchedule(request, { origin: "local-desktop", auditId: "forged", decidedAt: new Date().toISOString() } as never)).rejects.toMatchObject({ code: "invalid-input" });
  const a = await store.attachSchedule(request, proof()); expect(a.id).toBeTruthy(); expect(await store.getAttachment(a.id)).toEqual(a); expect(await store.listByTemplate(v.templateId)).toEqual([a]); expect(await store.listByRoutine("daily")).toEqual([a]);
  await expect(store.detachSchedule(a.id, { origin: "local-desktop" } as never)).rejects.toMatchObject({ code: "invalid-input" });
  expect(await store.detachSchedule(a.id, proof())).toBe(true); const detached = await store.getAttachment(a.id); expect(detached).toMatchObject({ ...a, detachedAt: expect.any(String) }); expect(await store.detachSchedule(a.id, proof())).toBe(false);
  const b = await store.attachSchedule(request, proof()); expect(b.id).not.toBe(a.id); expect(await store.listByRoutine("daily")).toEqual([detached, b]);
});

it("uses transitive upstream inputs and binds their stage references", () => {
  const g = graph(); g.stages.push({ ...g.stages[0], id: "b" }, { ...g.stages[0], id: "c", inputFiles: [{ from: "stage", stageId: "a" }] }); g.edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
  const hash = graphHashOf(g); g.stages[2].inputFiles = [{ from: "stage", stageId: "b" }]; expect(graphHashOf(g)).not.toBe(hash);
  g.stages[2].inputFiles = [{ from: "stage", stageId: "c" }]; expect(() => graphHashOf(g)).toThrow();
  g.stages[2].inputFiles = [{ from: "stage", stageId: "missing" }]; expect(() => graphHashOf(g)).toThrow();
});
it("retains pre-folder canonical hashes when optional fields are absent", () => {
  const g = graph(); delete g.stages[0].envelope;
  expect(canonicalTemplateGraph(g)).toEqual({ stages: [{ ...g.stages[0], kind: "plan" }], edges: [] });
});
it("refuses non-human output gates at confirmation", async () => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const g = graph(); g.stages[0].gate = { type: "auto", pass: { kind: "stage_ok" } }; requiredValue(g.stages[0].envelope).outputs = ["send"];
  const r = await store.draft(null, { ...g, name: "Template", scope: { kind: "all" } });
  await expect(store.confirmDraft(r.template.id, { expectedGraphHash: requiredValue(r.draft).graphHash, expectedDraftRevision: requiredValue(r.draft).revision }, { who: "user", origin: "local-desktop" })).rejects.toMatchObject({ code: "envelope-refused", refusals: ["outputs-need-human-gate"] });
});
it.each([null, 1, {}, { from: "project" }, { from: "stage", stageId: "_out" }])("refuses malformed folder input with a typed error %j", entry => {
  const g = graph(); g.stages[0].inputFiles = [entry] as never; expect(() => graphHashOf(g)).toThrow(expect.objectContaining({ code: "invalid-input" }));
});
