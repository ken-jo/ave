import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requiredValue } from "../../__tests__/support/required-value.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { mcpToolToPluginTool } from "../../mcp/plugin-tool-from-mcp.js";
import { decidePermission } from "../../permissions/decision-pipeline.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createToolEffectResolver } from "../../permissions/tool-effect-evidence.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { EnvelopeToolRef, WorkflowTemplateDraftInput } from "../../shared/workflow-template-types.js";
import { mintHostDecisionProof } from "../workflow-template-decision.js";
import { WorkflowTemplateStore } from "../workflow-template-store.js";

const actor = { who: "user", origin: "local-desktop" } as const;
const name = "example_tool";
const call = vi.fn();
const collections = ["tools", "mcpReadOnlyTools", "mcpGenerationTools", "pluginGenerationTools"] as const;
let directory: string;
let registry: ToolRegistry;
let store: WorkflowTemplateStore;

function draft(collection: EnvelopeToolRef["collection"] = "mcpGenerationTools"): WorkflowTemplateDraftInput {
  const generation = { name, effect: "generate", dataSent: false } as const;
  return {
    name: "Report", scope: { kind: "all" }, edges: [],
    stages: [{ id: "report", name: "Report", goal: "Collect sources", inputs: [], toolScope: "all", allowSubAgents: false,
      gate: { type: "human" },
      envelope: {
        tools: collection === "tools" ? [name] : [],
        mcpReadOnlyTools: collection === "mcpReadOnlyTools" ? [name] : [],
        mcpGenerationTools: collection === "mcpGenerationTools" ? [generation] : [],
        pluginGenerationTools: collection === "pluginGenerationTools" ? [generation] : [],
        readRoots: [], writePaths: [], commands: [], network: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
      },
    }],
  };
}

const path = () => join(directory, "templates.json");
const confirmVersion = async (input = draft()) => {
  const record = await store.draft(null, input);
  const { graphHash, revision } = requiredValue(record.draft);
  const response = await store.confirmDraft(record.template.id, { expectedGraphHash: graphHash, expectedDraftRevision: revision }, actor, createToolEffectResolver(registry));
  return { response, graphHash };
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "template-effect-"));
  store = new WorkflowTemplateStore(path(), () => 1);
  registry = new ToolRegistry();
  call.mockClear();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it.each(collections)("confirms and marks outward metadata for %s without changing the version", async collection => {
  const source = collection === "tools" ? "builtin" : collection === "pluginGenerationTools" ? "plugin" : "mcp";
  registry.register(createDynamicTool({
    name, source, category: "read", description: name, jsonSchema: {}, unattendedEffect: "outward", execute: call,
    ...(source === "mcp" ? { mcpServerId: "server" } : source === "plugin" ? { pluginId: "publisher" } : {}),
  }));
  const input = draft(collection);
  const { response, graphHash } = await confirmVersion(input);
  expect(response.unattended).toEqual({ ok: false, code: "outward-effect-tool", tool: { stageId: "report", collection, name } });
  expect(response.version).toMatchObject({ graphHash, stages: [{ envelope: input.stages[0].envelope }] });
  const current = await store.get(response.version.templateId);
  expect(current.template.currentVersion).toBe(response.version.version);
  expect(current.versions).toEqual([response.version]);
});

it.each(["unregistered", "offline", "unannotated"] as const)("marks an %s server tool unknown without contacting it", async state => {
  if (state !== "unregistered") {
    registry.register(mcpToolToTool("server", name, {
      name, description: name, inputSchema: { type: "object", properties: {} },
      ...(state === "offline" ? { annotations: { readOnlyHint: true } } : {}),
    }, call));
    if (state === "offline") registry.unregisterByMcp("server");
  }
  const { response } = await confirmVersion();
  expect(response.unattended).toEqual({ ok: false, code: "tool-effect-unknown", tool: { stageId: "report", collection: "mcpGenerationTools", name } });
  expect(call).not.toHaveBeenCalled();
});

it("returns no mark for safe evidence and keeps marked and unmarked confirmations byte-equal on disk", async () => {
  const record = await store.draft(null, draft());
  const { graphHash, revision } = requiredValue(record.draft);
  const original = await readFile(path());
  const args = [record.template.id, { expectedGraphHash: graphHash, expectedDraftRevision: revision }, actor] as const;
  const marked = await store.confirmDraft(...args, createToolEffectResolver(registry));
  expect(marked.unattended.ok).toBe(false);
  const markedFile = await readFile(path());
  await writeFile(path(), original);
  registry.register(mcpToolToTool("server", name, {
    name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
  }, call));
  const safe = await store.confirmDraft(...args, createToolEffectResolver(registry));
  expect(safe.unattended).toEqual({ ok: true });
  expect(safe.version).toEqual(marked.version);
  expect(await readFile(path())).toEqual(markedFile);
});

it("refuses a marked version at attach under the interim limit", async () => {
  const { response } = await confirmVersion();
  expect(response.unattended).toMatchObject({ ok: false, code: "tool-effect-unknown" });
  const { templateId, version, graphHash } = response.version;
  const before = await readFile(path());
  await expect(store.attachSchedule({ templateId, version, graphHash, scheduleId: "daily" },
    mintHostDecisionProof("local-desktop"), { kind: "all" })).rejects.toMatchObject({ code: "schedule-requires-read-only" });
  expect(await readFile(path())).toEqual(before);
});

it("marks a plugin tool with only a false read declaration unknown and denies unattended use", async () => {
  const tool = mcpToolToPluginTool("example", {
    name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false },
    _meta: { ui: { visibility: ["model"] } },
  }, call);
  registry.register(tool);
  const { response } = await confirmVersion(draft("pluginGenerationTools"));
  expect(response.unattended).toEqual({ ok: false, code: "tool-effect-unknown", tool: { stageId: "report", collection: "pluginGenerationTools", name } });

  expect(decidePermission({
    mode: "default", headless: true, tool: { name: tool.name, kind: tool.category, source: "plugin" },
    unattended: {
      runKey: "run", stageId: "report", workspaceRoot: directory, isolation: { proven: true },
      envelope: requiredValue(response.version.stages[0].envelope),
    },
    unattendedEffect: tool.unattendedEffect,
    reviewer: { status: "success", level: "low" },
  })).toMatchObject({ outcome: "deny", reasonCode: "outside-envelope" });
  expect(call).not.toHaveBeenCalled();
});

it("keeps an external tool that failed qualification eligible for an attended approval card", async () => {
  registry.register(mcpToolToTool("server", name, {
    name, description: name, inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, call));
  const { response } = await confirmVersion();
  expect(response.unattended).toMatchObject({ ok: false, code: "outward-effect-tool" });
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("default");
  expect(manager.checkDetailed(name, "mcp", "network", undefined, { headless: false }).decision).toBe("ask");
});

it("defines both reason codes and the confirmation mark in English and Korean", () => {
  expect(en["workflowTemplates.unattendedMark"]).toBe("can't run unattended: {tool} {reason}");
  expect(ko["workflowTemplates.unattendedMark"]).toBe("무인 실행 불가: {tool} {reason}");
  for (const code of ["outward-effect-tool", "tool-effect-unknown"] as const) {
    const key = `reasonCodes.${code}` as const;
    expect(en[key]).toBeTruthy();
    expect(ko[key]).toMatch(/[가-힣]/u);
  }
});
