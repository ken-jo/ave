import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowTemplateStore } from "../workflow-template-store.js";
import { WorkBoardStore } from "../work-board-store.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import { graphHashOf } from "../../work-board/template-graph.js";
import { assertWorkflowRunRecord } from "../../work-board/template-run-fields.js";
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
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  const run = { runId: "run", itemId: 1, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01", stageRuns: [{ stageId: "a", attempt: 1, status: "passed", resultHash: "bad" }] };
  expect(() => assertWorkflowRunRecord(run)).toThrow(expect.objectContaining({ code: "invalid-template-run" }));
  run.stageRuns[0].resultHash = resultHashOf("stored stage output"); expect(() => assertWorkflowRunRecord(run)).not.toThrow();
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

it("persists the stage result hash in the run record", async () => {
  const store = new WorkBoardStore(join(dir, "board.json"));
  const created = await store.create({ title: "Template", templateId: "template" });
  if (created.status !== "created") throw new Error("Missing item");
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  const output = "stored stage output"; const resultHash = resultHashOf(output);
  expect(await store.beginRun(created.itemId, "run", "2026-01-01", { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "a", attempt: 1, status: "awaiting_gate", output, resultHash }] })).toMatchObject({ status: "updated", item: { runId: "run" } });
  expect(await store.getRun(created.itemId)).toMatchObject({ status: "found", run: { stageRuns: [{ output, resultHash }] } });
});
