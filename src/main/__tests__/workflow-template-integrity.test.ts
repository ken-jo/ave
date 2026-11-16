import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowTemplateStore } from "../workflow-template-store.js";
import { WorkBoardStore } from "../work-board-store.js";
import { graphHashOf } from "../../work-board/template-graph.js";
import { assertTemplateRunFields } from "../../work-board/template-run-fields.js";
import type { WorkflowTemplateDraftInput, WorkflowTemplateRecord } from "../../shared/workflow-template-types.js";
const graph = (): WorkflowTemplateDraftInput => ({ name: "Read", scope: { kind: "all" }, stages: [{ id: "a", name: "A", goal: "Read", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" } }], edges: [] });
const actor = { who: "user", origin: "local-desktop" } as const;
function shown(record: WorkflowTemplateRecord) {
  if (!record.draft) throw new Error("Missing draft");
  return { expectedGraphHash: record.draft.graphHash, expectedDraftRevision: record.draft.revision };
}
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "template-integrity-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
it.each(["version", "attachment"])("refuses handwritten remote %s authority even with a recomputed graph hash", async kind => {
  const file = join(dir, "templates.json"); const store = new WorkflowTemplateStore(file);
  const draft = await store.draft(null, graph()); const version = await store.confirmDraft(draft.template.id, shown(draft), actor);
  const raw = JSON.parse(await readFile(file, "utf8")); const record = raw.templates[0];
  if (kind === "version") {
    const forged = graph(); forged.stages[0].goal = "Forged";
    const hash = graphHashOf(forged);
    record.versions.push({ ...version, stages: forged.stages, graphHash: hash, version: 2, confirmation: { ...version.confirmation, version: 2, graphHash: hash, origin: "tailnet-surface" } });
    record.template.currentVersion = 2;
    await writeFile(file, JSON.stringify(raw));
    await expect(store.resolveVersion({ templateId: draft.template.id, version: 2, graphHash: hash })).rejects.toMatchObject({ code: "invalid-template-file" });
  } else {
    record.scheduleAttachments = [{ id: "attachment", scheduleId: "daily", templateId: draft.template.id, version: 1, graphHash: version.graphHash, who: "user", at: version.confirmedAt, origin: "tailnet-surface" }];
    await writeFile(file, JSON.stringify(raw));
    await expect(store.getAttachment("attachment")).rejects.toMatchObject({ code: "invalid-template-file" });
  }
});
it.each(["name", "scope", "description", "identical"])("invalidates the shown revision after a %s redraft with the same graph", async field => {
  const file = join(dir, "templates.json"); const store = new WorkflowTemplateStore(file, () => 1);
  const first = await store.draft(null, graph()); const changed = graph();
  if (field === "name") changed.name = "Other";
  if (field === "scope") changed.scope = { kind: "project", projectRoot: "/project/example" };
  if (field === "description") changed.description = "Other";
  const second = await store.draft(first.template.id, changed);
  expect(second.draft?.graphHash).toBe(first.draft?.graphHash);
  expect(second.draft).toHaveProperty("revision", expect.any(String));
  expect(Reflect.get(second.draft ?? {}, "revision")).not.toBe(Reflect.get(first.draft ?? {}, "revision"));
  const restarted = new WorkflowTemplateStore(file);
  await expect(restarted.confirmDraft(first.template.id, shown(first), actor)).rejects.toMatchObject({ code: "stale-draft" });
  expect(await restarted.confirmDraft(first.template.id, shown(second), actor)).toMatchObject({ version: 1 });
});
it("pins the legacy golden hash and omits empty optional graph collections", () => {
  const base = graph(); const empty = graph(); empty.setupCommands = [];
  Object.assign(empty.stages[0], { inputFiles: [], outputs: [], requestedOutputs: [] });
  expect(graphHashOf(base)).toBe("541b3b89854fffbeb43a12878e806896e4bf76380f586044cbf28407d87827c6");
  expect(graphHashOf(empty)).toBe(graphHashOf(base));
});
it("validates the stage result hash independently of requested-output approvals", () => {
  const row = { templateId: "template", runId: "run", runTemplateVersion: 1, runTemplateGraphHash: "a".repeat(64), stageRuns: [{ stageId: "a", attempt: 1, status: "passed", resultHash: "bad" }] };
  expect(() => assertTemplateRunFields(row)).toThrow(expect.objectContaining({ code: "invalid-template-run" }));
  row.stageRuns[0].resultHash = "b".repeat(64); expect(() => assertTemplateRunFields(row)).not.toThrow();
});
it.each([ { attempt: 4 }, { status: "future" }, { gate: { type: "human", status: "cancelled", revision: 0 } } ])("keeps an unreadable row untouched while other items work %j", async patch => {
  const file = join(dir, "board.json");
  const ordinary = { id: 1, title: "Ordinary", status: "planned", priority: "medium", created_at: "2026-01-01", updated_at: "2026-01-01" };
  const unreadable = { ...ordinary, id: 2, templateId: "template", runId: "run", runStatus: "executing", runTemplateVersion: 1, runTemplateGraphHash: "a".repeat(64), stageRuns: [{ stageId: "a", attempt: 1, status: "running", ...patch }], future: { preserve: true }, due_at: "2026-01-01T00:00:00+09:00" };
  await writeFile(file, JSON.stringify({ version: 1, nextId: 3, items: [ordinary, unreadable] }));
  const store = new WorkBoardStore(file); await expect(store.load()).resolves.toBeUndefined();
  expect(await store.list()).toMatchObject({ status: "ok", items: [expect.objectContaining({ id: 2, templateRunError: "invalid-template-run" }), expect.objectContaining({ id: 1 })] });
  expect(await store.get(2)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
  await expect(store.beginRun(2, "new-run", "2026-01-01")).rejects.toMatchObject({ code: "invalid-template-run" });
  const mutate = vi.fn(value => value); await expect(store.updateStageRun(2, "run", mutate)).rejects.toMatchObject({ code: "invalid-template-run" }); expect(mutate).not.toHaveBeenCalled();
  await expect(store.decidePlan(2, { runId: "run", planHash: "a".repeat(64), status: "approved" })).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(await store.update(1, { title: "Working" })).toMatchObject({ status: "updated" });
  expect(await store.create({ title: "New" })).toMatchObject({ status: "created" });
  expect(await store.beginRun(1, "ordinary-run", "2026-01-01")).toMatchObject({ status: "updated" });
  await store.reconcileInterruptedRuns();
  const persisted = JSON.parse(await readFile(file, "utf8")); expect(persisted.items.find((value: { id: number }) => value.id === 2)).toEqual(unreadable);
  expect(await new WorkBoardStore(file).get(2)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
});

it("provides nullable template readers while retaining pinned history", async () => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json"));
  expect(await store.getTemplate("missing")).toBeNull(); expect(await store.getVersion("missing", 1)).toBeNull();
  const draft = await store.draft(null, graph()); const version = await store.confirmDraft(draft.template.id, shown(draft), actor);
  expect(await store.getVersion(draft.template.id, 2)).toBeNull();
  expect(await store.getTemplate(draft.template.id)).toMatchObject({ currentVersion: 1 });
  await store.archive(draft.template.id);
  expect(await store.getTemplate(draft.template.id)).toHaveProperty("archivedAt");
  expect(await store.getVersion(draft.template.id, 1)).toEqual(version);
});
it.each(["generate", "fetch"] as const)("accepts declared %s tools with an explicit data-sent flag", async effect => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const input = graph(); input.stages[0].toolScope = "all";
  input.stages[0].envelope = { tools: [], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [], mcpGenerationTools: [{ name: "media.render", effect, dataSent: true }], pluginGenerationTools: [{ name: "sources.lookup", effect, dataSent: false }], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 } };
  const draft = await store.draft(null, input);
  expect(await store.confirmDraft(draft.template.id, shown(draft), actor)).toMatchObject({ stages: [{ envelope: input.stages[0].envelope }] });
});

it("persists the stage result hash in the run summary", async () => {
  const store = new WorkBoardStore(join(dir, "board.json"));
  const created = await store.create({ title: "Template", templateId: "template" });
  if (created.status !== "created") throw new Error("Missing item");
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  const resultHash = "b".repeat(64);
  expect(await store.beginRun(created.itemId, "run", "2026-01-01", { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "a", attempt: 1, status: "waiting", resultHash }] })).toMatchObject({ status: "updated", item: { stageRuns: [{ resultHash }], runHistory: [{ stageRuns: [{ resultHash }] }] } });
});
