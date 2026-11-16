import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mintHostDecisionProof } from "../workflow-template-decision.js";
import { WorkflowTemplateStore } from "../workflow-template-store.js";
import { canonicalTemplateGraph, graphHashOf } from "../../work-board/template-graph.js";
import type { StageEnvelope, WorkflowTemplateDraftInput } from "../../shared/workflow-template-types.js";
const envelope = (): StageEnvelope => ({ tools: ["read_file"], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 5, minutes: 10, costUsd: 1 } });
const input = (): WorkflowTemplateDraftInput => ({ name: "Daily report", scope: { kind: "all" }, stages: [{ id: "research", name: "Research", goal: "Gather sources", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" }, envelope: envelope(), requestedOutputs: [] }], edges: [], setupCommands: [] });
const proof = () => mintHostDecisionProof("local-desktop");
const actor = { who: "user", origin: "local-desktop" } as const;
let dir: string; let path: string; let store: WorkflowTemplateStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "capabilities-")); path = join(dir, "templates.json"); store = new WorkflowTemplateStore(path); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function confirm(graph = input()) { const r = await store.draft(null, graph); return store.confirm(r.template.id, { expectedGraphHash: r.draft!.graphHash }, actor); }
it.each(["tools", "writePaths", "readRoots", "network", "commands", "mcpReadOnlyTools", "mcpGenerationTools", "pluginGenerationTools", "outputs", "rounds", "minutes", "costUsd", "dataSent", "effect", "setupCommands", "requestedOutputs"])("hash binds capability field %s", field => {
  const a = input(); a.stages[0].toolScope = "all"; const b = structuredClone(a); const e = b.stages[0].envelope!;
  if (field === "setupCommands") b.setupCommands = ["prepare-assets"];
  else if (field === "requestedOutputs") b.stages[0].requestedOutputs = ["publish"];
  else if (field === "rounds" || field === "minutes" || field === "costUsd") e.budget[field]++;
  else if (field === "dataSent" || field === "effect") { a.stages[0].envelope!.mcpGenerationTools = [{ name: "media.render", effect: "generate", dataSent: true }]; e.mcpGenerationTools = [{ name: "media.render", effect: field === "effect" ? "fetch" : "generate", dataSent: field !== "dataSent" }]; }
  else Object.assign(e, { [field]: ({ tools: ["read_file", "list_files"], writePaths: ["assets/**"], readRoots: ["/cache"], network: [{ host: "api.example.com", port: 443 }], commands: ["render"], mcpReadOnlyTools: ["sources.read"], mcpGenerationTools: [{ name: "media.render", effect: "generate", dataSent: true }], pluginGenerationTools: [{ name: "media.render", effect: "fetch", dataSent: false }], outputs: ["publish"] } as Record<string, unknown>)[field] });
  expect(graphHashOf(b)).not.toBe(graphHashOf(a));
});
it("canonicalises domains without losing port distinctions", () => {
  const a = input(); a.stages[0].envelope!.network = [{ host: "B.EXAMPLE.COM" }, { host: "a.example.com", port: 443 }, { host: "b.example.com" }];
  const b = structuredClone(a); b.stages[0].envelope!.network = [{ host: "a.example.com", port: 443 }, { host: "b.example.com" }];
  expect(canonicalTemplateGraph(a).stages[0].envelope!.network).toEqual(b.stages[0].envelope!.network);
  expect(graphHashOf(a)).toBe(graphHashOf(b)); b.stages[0].envelope!.network[0].port = 8443; expect(graphHashOf(a)).not.toBe(graphHashOf(b));
});
it.each(["https://example.com", "*.example.com", "example.com/path", "bad..example", "-bad.example", "example.com:443", " example.com", ""]) ("rejects invalid domain %s", host => { const a = input(); a.stages[0].envelope!.network = [{ host }]; expect(() => graphHashOf(a)).toThrow(); });
it.each(["publish", "upload", "post", "send", "push", "merge", "purchase", "deploy"])("rejects outward envelope entries: %s", action => {
  for (const field of ["tools", "mcpReadOnlyTools", "mcpGenerationTools", "pluginGenerationTools"] as const) {
    const a = input(); Object.assign(a.stages[0].envelope!, { [field]: field.endsWith("GenerationTools") ? [{ name: "media." + action, effect: "generate", dataSent: true }] : ["media_" + action] });
    expect(() => graphHashOf(a)).toThrow(expect.objectContaining({ code: "forbidden-envelope-tool" }));
  }
  const a = input(); a.stages[0].envelope!.mcpGenerationTools = [{ name: "media.render", effect: action, dataSent: true } as never];
  expect(() => graphHashOf(a)).toThrow(expect.objectContaining({ code: "forbidden-envelope-tool" }));
});
it("persists setup, generation declarations and requested outputs without executing them", async () => {
  const a = input(); a.setupCommands = ["prepare-assets"]; a.stages[0].envelope!.commands = ["prepare-assets"]; a.stages[0].toolScope = "all"; a.stages[0].requestedOutputs = ["publish", "upload", "post", "send", "push", "merge"]; a.stages[0].envelope!.mcpGenerationTools = [{ name: "media.render", effect: "generate", dataSent: true }];
  const v = await confirm(a); expect(v.setupCommands).toEqual(a.setupCommands); expect(v.stages[0].requestedOutputs).toEqual([...a.stages[0].requestedOutputs!].sort()); expect(await new WorkflowTemplateStore(path).resolveVersion(v)).toEqual(v);
});
it("binds an attachment to the exact tuple and keeps v1 after confirming v2", async () => {
  const v = await confirm(); const request = { templateId: v.templateId, version: v.version, graphHash: v.graphHash, scheduleId: "daily" };
  const attachment = await store.attachSchedule(request, proof()); expect(attachment).toEqual({ ...request, id: expect.any(String), ...actor, at: expect.any(String) });
  const draft = input(); draft.stages[0].goal = "New sources"; const r = await store.draft(v.templateId, draft); await store.confirm(v.templateId, { expectedGraphHash: r.draft!.graphHash }, actor);
  const record = await new WorkflowTemplateStore(path).get(v.templateId); expect(record.scheduleAttachments).toEqual([attachment]); expect(record.template.currentVersion).toBe(2);
  await expect(store.attachSchedule({ ...request, graphHash: "a".repeat(64) }, proof())).rejects.toMatchObject({ code: "graph-hash-mismatch" });
  await expect(store.attachSchedule({ ...request, version: 99 }, proof())).rejects.toMatchObject({ code: "unknown-version" });
  await expect(store.attachSchedule(request, mintHostDecisionProof("tailnet-surface"))).rejects.toMatchObject({ code: "invalid-input" });
});
it.each(["toolScope", "generation", "commands", "writes", "setup"])("refuses non-read-only schedule attachment: %s", async field => {
  const a = input(); if (field === "toolScope") a.stages[0].toolScope = "all"; if (field === "generation") a.stages[0].envelope!.pluginGenerationTools = [{ name: "media.render", effect: "generate", dataSent: false }]; if (field === "commands") a.stages[0].envelope!.commands = ["render"]; if (field === "writes") a.stages[0].envelope!.writePaths = ["**"]; if (field === "setup") a.setupCommands = ["prepare"];
  a.stages[0].toolScope = field === "generation" ? "all" : a.stages[0].toolScope; if (field === "setup") a.stages[0].envelope!.commands = ["prepare"];
  const v = await confirm(a); const bytes = await readFile(path, "utf8"); await expect(store.attachSchedule({ templateId: v.templateId, version: v.version, graphHash: v.graphHash, scheduleId: "daily" }, proof())).rejects.toMatchObject({ code: "schedule-requires-read-only" }); expect(await readFile(path, "utf8")).toBe(bytes);
});
it("refuses tampered attachment tuples on load", async () => {
  const v = await confirm(); await store.attachSchedule({ templateId: v.templateId, version: 1, graphHash: v.graphHash, scheduleId: "daily" }, proof());
  const file = JSON.parse(await readFile(path, "utf8")); file.templates[0].scheduleAttachments[0].graphHash = "a".repeat(64); await writeFile(path, JSON.stringify(file)); await expect(store.get(v.templateId)).rejects.toMatchObject({ code: "graph-hash-mismatch" });
});
it("keeps attachment creation out of every routine write path", async () => {
  const sources = ["src/tools/routine-schedule.ts", "src/main/routines-store.ts", "src/ipc/domains/routines.ts", ...((await readdir("src/routines")).filter(p => p.endsWith(".ts")).map(p => "src/routines/" + p))];
  for (const source of sources) { const text = await readFile(source, "utf8"); expect(text, source).not.toMatch(/attachSchedule|templateAttachSchedule|scheduleAttachments|workflow-template-store/); }
});

it("uses empty network and declared tool defaults and explicit write/output defaults", () => {
  const a = input(); a.stages[0].envelope = { budget: { rounds: 1, minutes: 1, costUsd: 0 } } as StageEnvelope;
  expect(canonicalTemplateGraph(a).stages[0].envelope).toEqual({ tools: [], writePaths: ["**"], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [], outputs: ["branch"], budget: { rounds: 1, minutes: 1, costUsd: 0 } });
});
it.each([0, -1, 65536, 1.5, "443"])("rejects invalid domain port %s", port => { const a = input(); a.stages[0].envelope!.network = [{ host: "example.com", port } as never]; expect(() => graphHashOf(a)).toThrow(); });
it("requires a data disclosure flag and a bounded budget on generation declarations", () => {
  const a = input(); a.stages[0].envelope!.mcpGenerationTools = [{ name: "media.render", effect: "generate" } as never]; expect(() => graphHashOf(a)).toThrow();
  a.stages[0].envelope = envelope(); a.stages[0].envelope.budget.rounds = 0; expect(() => graphHashOf(a)).toThrow();
  a.stages[0].envelope = envelope(); a.stages[0].envelope.budget.minutes = Infinity; expect(() => graphHashOf(a)).toThrow();
  a.stages[0].requestedOutputs = ["unknown" as never]; expect(() => graphHashOf(a)).toThrow();
});
it("binds setup command order and preserves it through confirmation", async () => {
  const a = input(); a.setupCommands = ["prepare", "render"]; a.stages[0].envelope!.commands = ["prepare", "render"]; const b = structuredClone(a); b.setupCommands!.reverse(); expect(graphHashOf(a)).not.toBe(graphHashOf(b)); expect((await confirm(a)).setupCommands).toEqual(a.setupCommands);
});
it("allows only explicit reattachment to move a schedule pin", async () => {
  const v1 = await confirm(); const request = { templateId: v1.templateId, version: 1, graphHash: v1.graphHash, scheduleId: "daily" }; await store.attachSchedule(request, proof());
  const draft = input(); draft.stages[0].goal = "Different sources"; const r = await store.draft(v1.templateId, draft); const v2 = await store.confirm(v1.templateId, { expectedGraphHash: r.draft!.graphHash }, actor);
  await store.attachSchedule({ ...request, version: 2, graphHash: v2.graphHash }, proof()); expect((await store.listByRoutine("daily")).filter(a => !a.detachedAt)).toEqual([expect.objectContaining({ version: 2, graphHash: v2.graphHash })]);
  await store.archive(v1.templateId); await expect(store.attachSchedule(request, proof())).rejects.toMatchObject({ code: "template-archived" });
});

it.each(["media.publishVideo", "media.HTTPPost", "git_push", "assets.uploadFile", "message.sendEmail", "review.mergeBranch"])("rejects outward action naming variants: %s", name => { const a = input(); a.stages[0].envelope!.mcpGenerationTools = [{ name, effect: "generate", dataSent: true }]; expect(() => graphHashOf(a)).toThrow(expect.objectContaining({ code: "forbidden-envelope-tool" })); });
it("rejects attachment data smuggled into a template draft", async () => { await expect(store.draft(null, { ...input(), scheduleAttachments: [{ scheduleId: "daily" }] } as never)).rejects.toMatchObject({ code: "invalid-input" }); });
