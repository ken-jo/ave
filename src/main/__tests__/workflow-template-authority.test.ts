import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requiredValue } from "../../__tests__/support/required-value.js";
import * as graph from "../../work-board/template-graph.js";
import { canonicalWorkflowJson } from "../../shared/workflow-template-output.js";
import { assertWorkflowRunRecord } from "../../work-board/template-run-fields.js";
import { WorkflowTemplateStore } from "../workflow-template-store.js";
import { WorkBoardStore } from "../work-board-store.js";
import { mintHostDecisionProof } from "../workflow-template-decision.js";
import type { RequestedOutputDecl, TemplateScope, WorkflowTemplateDraftInput } from "../../shared/workflow-template-types.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
const output = (): RequestedOutputDecl => ({ kind: "upload", toolName: "deliver", owner: "plugin", ownerId: "media" });
const input = (): WorkflowTemplateDraftInput => ({ name: "Template", scope: { kind: "all" }, stages: [{ id: "a", name: "A", goal: "Read", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" } }], edges: [] });
const actor = { who: "user", origin: "local-desktop" } as const;
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "template-authority-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function confirmVersion(store: WorkflowTemplateStore, value = input(), id: string | null = null) {
  const record = await store.draft(id, value); const draft = requiredValue(record.draft);
  return store.confirmDraft(record.template.id, { expectedGraphHash: draft.graphHash, expectedDraftRevision: draft.revision }, actor);
}
it("refuses setup commands when no all-tools stage exists", () => {
  const value = input(); value.setupCommands = ["prepare"];
  expect(() => graph.parseTemplateDraft(value)).toThrow(expect.objectContaining({ code: "envelope-refused", refusals: ["setup-outside-commands"] }));
});
it("accepts template setup commands alongside a read plan stage", async () => {
  const value = input(); value.setupCommands = ["prepare"];
  value.stages[0].envelope = { tools: ["read_file"], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 } };
  value.stages.push({ ...value.stages[0], envelope: { ...value.stages[0].envelope, tools: ["write_file"], commands: ["prepare"] }, id: "b", inputs: ["a"], toolScope: "all" }); value.edges = [{ from: "a", to: "b" }];
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const version = await confirmVersion(store, value);
  expect(version.setupCommands).toEqual(["prepare"]); expect(version.stages[0].kind).toBe("plan");
  expect(graph.validateStageForConfirm(version.stages[0], version)).toEqual([]);
});
it.each(["kind", "toolName", "owner", "ownerId"] as const)("binds the output declaration %s in graphHash", field => {
  const value = input(); value.stages[0].requestedOutputs = [output()]; const changed = structuredClone(value);
  Object.assign(requiredValue(changed.stages[0].requestedOutputs)[0], { [field]: { kind: "other", toolName: "deliver_other", owner: "server", ownerId: "other-media" }[field] });
  expect(graph.graphHashOf(changed)).not.toBe(graph.graphHashOf(value));
});
it("pins the output declaration canonical JSON and golden hash", () => {
  const value = input(); value.stages[0].requestedOutputs = [output(), { kind: "external-write", toolName: "git_push", owner: "host", ownerId: "host:git" }];
  const canonical = '{"edges":[],"stages":[{"allowSubAgents":false,"gate":{"type":"human"},"goal":"Read","id":"a","inputs":[],"kind":"plan","name":"A","requestedOutputs":[{"kind":"external-write","owner":"host","ownerId":"host:git","toolName":"git_push"},{"kind":"upload","owner":"plugin","ownerId":"media","toolName":"deliver"}],"toolScope":"read"}]}';
  expect(canonicalWorkflowJson(graph.canonicalTemplateGraph(value))).toBe(canonical);
  expect(graph.graphHashOf(value)).toBe("c33c52ad9ea9a1a3c628819be41a0d3d7a13046b124f23efea717763aee5f9c6");
  requiredValue(value.stages[0].requestedOutputs).reverse(); expect(canonicalWorkflowJson(graph.canonicalTemplateGraph(value))).toBe(canonical);
});
it.each([
  { kind: "upload", toolName: "deliver", owner: "plugin", ownerId: "host:git" },
  { kind: "upload", toolName: "deliver", owner: "server", ownerId: "host:other" },
  { kind: "external-write", toolName: "other", owner: "host", ownerId: "host:git" },
  { kind: "upload", toolName: "git_push", owner: "host", ownerId: "host:git" },
  { kind: "upload", toolName: "deliver", owner: "host", ownerId: "media" },
  { kind: "unknown", toolName: "deliver", owner: "plugin", ownerId: "media" },
  { kind: "upload", owner: "plugin", ownerId: "media" },
  { kind: "upload", toolName: "deliver", owner: "plugin" },
  "upload",
])("refuses invalid or reserved output owner declarations %j", declaration => {
  const value = input(); value.stages[0].requestedOutputs = [declaration] as never;
  expect(() => graph.graphHashOf(value)).toThrow(expect.objectContaining({ code: "invalid-input" }));
});
it("requires a human gate for output entries even without an envelope", async () => {
  const value = input(); value.stages[0].gate = { type: "auto", pass: { kind: "stage_ok" } }; value.stages[0].requestedOutputs = [output()];
  const store = new WorkflowTemplateStore(join(dir, "templates.json"));
  await expect(confirmVersion(store, value)).rejects.toMatchObject({ code: "envelope-refused", refusals: ["outputs-need-human-gate"] });
});
it("validates the same exact output declaration shape in the run record", () => {
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  const run = { runId: "run", itemId: 1, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01", stageRuns: [{ stageId: "a", attempt: 1, status: "waiting", requestedOutputs: [{ id: "out", decl: output(), args: "{}", summary: "Deliver" }] }] };
  expect(() => assertWorkflowRunRecord(run)).not.toThrow(); run.stageRuns[0].requestedOutputs[0].decl.ownerId = "host:git";
  expect(() => assertWorkflowRunRecord(run)).toThrow(expect.objectContaining({ code: "invalid-template-run" }));
});
it.each([{ kind: "all" }, { kind: "project", projectRoot: "/projects/a" }] as TemplateScope[])("records the approved scope snapshot %j", async approvedScope => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const value = input(); value.scope = approvedScope; const version = await confirmVersion(store, value);
  const attachment = await store.attachSchedule({ scheduleId: "daily", templateId: version.templateId, version: version.version, graphHash: version.graphHash }, mintHostDecisionProof("local-desktop"), approvedScope);
  expect(attachment).toHaveProperty("approvedScope", approvedScope); expect(await store.getAttachment(attachment.id)).toEqual(attachment);
});
it("refuses a scope changed between authorization and attachment without writing", async () => {
  const file = join(dir, "templates.json"); const store = new WorkflowTemplateStore(file); const version = await confirmVersion(store); const before = await readFile(file, "utf8");
  await expect(store.attachSchedule({ templateId: version.templateId, version: 1, graphHash: version.graphHash, scheduleId: "daily" }, mintHostDecisionProof("local-desktop"), { kind: "project", projectRoot: "/projects/a" })).rejects.toMatchObject({ code: "scope-changed" });
  expect(await readFile(file, "utf8")).toBe(before);
});
it("refuses attachments missing their approved scope snapshot without writing", async () => {
  const file = join(dir, "templates.json"); const store = new WorkflowTemplateStore(file); const version = await confirmVersion(store); const record = await store.get(version.templateId);
  record.scheduleAttachments = [{ id: "legacy", templateId: version.templateId, version: 1, graphHash: version.graphHash, scheduleId: "daily", who: "user", origin: "local-desktop", at: version.confirmedAt }] as never; await writeFile(file, JSON.stringify({ version: 1, templates: [record] }));
  const before = await readFile(file, "utf8");
  await expect(store.getAttachment("legacy")).rejects.toMatchObject({ code: "invalid-template-file" });
  expect(await readFile(file, "utf8")).toBe(before);
});
it("compares approved scopes in both directions and exact project identities", () => {
  const scopes: TemplateScope[] = [{ kind: "all" }, { kind: "project", projectRoot: "/projects/a" }, { kind: "project", projectRoot: "/projects/b" }];
  for (const approvedScope of scopes) for (const scope of scopes) expect(graph.attachmentScopeMatches({ approvedScope }, { scope })).toEqual(approvedScope === scope ? { ok: true } : { ok: false, code: "scope-changed" });
});
it("refuses a create-and-run project different from the approved project before writing", async () => {
  const file = join(dir, "board.json"); const store = new WorkBoardStore(file); const created = await store.create({ title: "Work", projectRoot: "/projects/a", templateId: "template" }); if (created.status !== "created") throw new Error("Missing item");
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) }; const before = await readFile(file, "utf8");
  for (const projectRoot of ["/projects/b", undefined]) await expect(store.beginRun(created.itemId, "run", "2026-01-01", { ...pin, source: { kind: "local-create-and-run", pin, projectRoot }, stageRuns: [] })).rejects.toMatchObject({ code: "project-mismatch" });
  expect(await readFile(file, "utf8")).toBe(before); await expect(readFile(join(dir, "workflow-runs.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await store.beginRun(created.itemId, "run", "2026-01-01", { ...pin, source: { kind: "local-create-and-run", pin, projectRoot: "/projects/a" }, stageRuns: [] })).toMatchObject({ status: "updated", item: { runId: "run" } });
  expect(await store.getRun(created.itemId)).toMatchObject({ status: "found", run: { runStartedBy: { projectRoot: "/projects/a" } } });
});
it("matches the create-and-run project to the row by its canonical root, and an unscoped row only to an unscoped start", async () => {
  const store = new WorkBoardStore(join(dir, "board.json"));
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  const begin = (itemId: number, runId: string, projectRoot?: string) => store.beginRun(itemId, runId, "2026-01-01", { ...pin, source: { kind: "local-create-and-run", pin, projectRoot }, stageRuns: [] });
  const scoped = await store.create({ title: "Work", projectRoot: "C:\\Projects\\A", templateId: "template" });
  const unscoped = await store.create({ title: "Work", templateId: "template" });
  if (scoped.status !== "created" || unscoped.status !== "created") throw new Error("Missing item");
  await expect(begin(unscoped.itemId, "run-u", "/projects/a")).rejects.toMatchObject({ code: "project-mismatch" });
  expect(await begin(unscoped.itemId, "run-u")).toMatchObject({ status: "updated" });
  expect(await begin(scoped.itemId, "run-s", "c:/projects/a/")).toMatchObject({ status: "updated", item: { runId: "run-s" } });
});
it.each(["scope-changed", "project-mismatch", "scope-not-authorised", "output-not-declared"] as const)("has bilingual refusal text for %s", code => {
  for (const catalog of [en, ko]) expect(Reflect.get(catalog, `reasonCodes.${code}`)).toEqual(expect.stringMatching(/\S/));
});
it("keeps the attachment pin but refuses its scope after a new confirmation", async () => {
  const store = new WorkflowTemplateStore(join(dir, "templates.json")); const version = await confirmVersion(store);
  const attachment = await store.attachSchedule({ templateId: version.templateId, version: 1, graphHash: version.graphHash, scheduleId: "daily" }, mintHostDecisionProof("local-desktop"), { kind: "all" });
  const changed = input(); changed.scope = { kind: "project", projectRoot: "/projects/a" }; await confirmVersion(store, changed, version.templateId);
  const record = await store.get(version.templateId); const stored = requiredValue(await store.getAttachment(attachment.id));
  expect(stored).toEqual(attachment); expect(graph.attachmentScopeMatches(stored, record.template)).toEqual({ ok: false, code: "scope-changed" });
});
it.each(["upload", "send-message", "publish-post", "external-write", "other"] as const)("accepts the closed output kind %s", kind => {
  const value = input(); value.stages[0].requestedOutputs = [{ ...output(), kind }]; expect(() => graph.graphHashOf(value)).not.toThrow();
});
it("refuses duplicate output targets and non-array declarations", () => {
  const value = input(); value.stages[0].requestedOutputs = [output(), { ...output(), kind: "other" }]; expect(() => graph.graphHashOf(value)).toThrow();
  value.stages[0].requestedOutputs = "upload" as never; expect(() => graph.graphHashOf(value)).toThrow();
});

it("refuses all-tools setup commands outside the stage envelope before writing", async () => {
  const value = input(); value.setupCommands = ["prepare assets"];
  value.stages[0].toolScope = "all";
  value.stages[0].envelope = { tools: ["write_file"], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 } };
  const file = join(dir, "templates.json"); const store = new WorkflowTemplateStore(file);
  const record = await store.draft(null, value); const before = await readFile(file, "utf8"); const draft = requiredValue(record.draft);
  await expect(store.confirmDraft(record.template.id, { expectedGraphHash: draft.graphHash, expectedDraftRevision: draft.revision }, actor)).rejects.toMatchObject({ code: "envelope-refused", refusals: ["setup-outside-commands"] });
  expect(await readFile(file, "utf8")).toBe(before);
});
it("compares registry snapshots exactly without normalizing root aliases", () => {
  const approvedScope = { kind: "project", projectRoot: "/projects/a" } as const;
  for (const projectRoot of ["/projects/a/", "/projects/A", "/projects/a/../a"]) expect(graph.attachmentScopeMatches({ approvedScope }, { scope: { kind: "project", projectRoot } })).toEqual({ ok: false, code: "scope-changed" });
  expect(graph.attachmentScopeMatches({}, { scope: approvedScope })).toEqual({ ok: false, code: "scope-changed" });
});

it("pins envelope defaults and ordering with setup, edges and folder declarations", () => {
  const value = {
    stages: [
      { id: "b", name: "B", goal: "Build", inputs: ["a"], toolScope: "all", gate: { type: "human" },
        inputFiles: [{ from: "stage", stageId: "a" }, { from: "project", paths: ["docs/**", "assets/**"] }], outputs: ["reports/**", "dist/**"],
        envelope: { tools: ["write_file", "read_file", "write_file"], commands: ["prepare", "check", "prepare"], network: [{ host: "Z.EXAMPLE", port: 443 }, { host: "a.example" }, { host: "z.example", port: 443 }], budget: { rounds: 2, minutes: 3, costUsd: 0 } } },
      { id: "a", name: "A", goal: "Read", inputs: [], toolScope: "read", gate: { type: "human" } },
    ],
    edges: [{ from: "a", to: "b" }], setupCommands: ["prepare assets", "check"],
  };
  const canonical = '{"edges":[{"from":"a","to":"b"}],"setupCommands":["prepare assets","check"],"stages":[{"allowSubAgents":false,"gate":{"type":"human"},"goal":"Read","id":"a","inputs":[],"kind":"plan","name":"A","toolScope":"read"},{"allowSubAgents":false,"envelope":{"budget":{"costUsd":0,"minutes":3,"rounds":2},"commands":["check","prepare"],"mcpGenerationTools":[],"mcpReadOnlyTools":[],"network":[{"host":"a.example"},{"host":"z.example","port":443}],"outputs":["branch"],"pluginGenerationTools":[],"readRoots":[],"tools":["read_file","write_file"],"writePaths":["**"]},"gate":{"type":"human"},"goal":"Build","id":"b","inputFiles":[{"from":"stage","stageId":"a"},{"from":"project","paths":["docs/**","assets/**"]}],"inputs":["a"],"name":"B","outputs":["reports/**","dist/**"],"toolScope":"all"}]}';
  expect(canonicalWorkflowJson(graph.canonicalTemplateGraph(value))).toBe(canonical);
  expect(graph.graphHashOf(value)).toBe("71d9a56f24d73bd1004107e90573e892fa90d2158dd1bfab3ec64509cbbfec87");
});
