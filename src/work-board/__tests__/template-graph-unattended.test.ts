import { expect, it } from "vitest";
import { requiredValue } from "../../__tests__/support/required-value.js";
import type { EnvelopeToolRef, StageEnvelope, TemplateGraph } from "../../shared/workflow-template-types.js";
import { createToolEffectResolver, unattendedEnvelopeTool } from "../../permissions/tool-effect-evidence.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createWebFetchTool } from "../../tools/web-fetch.js";
import { createWebSearchTool } from "../../tools/web-search.js";
import { qualifyUnattended } from "../template-graph.js";

const collections = ["tools", "mcpReadOnlyTools", "mcpGenerationTools", "pluginGenerationTools"] as const;

it.each([
  { visibility: undefined, exposed: true },
  { visibility: ["model"] as const, exposed: true },
  { visibility: ["app"] as const, exposed: false },
])("keeps scheduled MCP model exposure independent of app visibility ($visibility)", ({ visibility, exposed }) => {
  const registry = new ToolRegistry();
  const reader = mcpToolToTool("sources", "sources_read", {
    name: "read", description: "Read local fixture", inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    ...(visibility === undefined ? {} : { _meta: { ui: { visibility: [...visibility] } } }),
  }, async () => ({ text: "fixture" }));
  registry.register(reader);
  const effects = createToolEffectResolver(registry);
  const input = graph();
  const envelope = requiredValue(input.stages[0].envelope);
  for (const collection of collections) if (collection !== "mcpReadOnlyTools") envelope[collection] = [];
  expect(qualifyUnattended(input, effects)).toEqual({ ok: true });
  expect(unattendedEnvelopeTool(reader, envelope, effects)).toBe(exposed);
});

function graph(): TemplateGraph {
  const envelope: StageEnvelope = {
    tools: ["local", "later"], mcpReadOnlyTools: ["sources_read"],
    mcpGenerationTools: [{ name: "render", effect: "generate", dataSent: true }],
    pluginGenerationTools: [{ name: "fetch", effect: "fetch", dataSent: false }],
    readRoots: [], writePaths: [], commands: [], network: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
  };
  return { stages: [{ id: "first", name: "First", goal: "Review", gate: { type: "human" }, toolScope: "all", inputs: [], allowSubAgents: false, envelope }], edges: [] };
}

it.each(collections)("names the first failing entry and code for %s", collection => {
  const names = { tools: "local", mcpReadOnlyTools: "sources_read", mcpGenerationTools: "render", pluginGenerationTools: "fetch" };
  const tool = { stageId: "first", collection, name: names[collection] };
  for (const [evidence, code] of [["outward", "outward-effect-tool"], ["unknown", "tool-effect-unknown"]] as const) {
    expect(qualifyUnattended(graph(), { effectOf: t => t.collection === collection ? evidence : "safe" }))
      .toEqual({ ok: false, code, tool });
  }
});

it("checks stage and collection order before reporting a missing envelope", () => {
  const input = graph();
  input.stages.unshift({ ...input.stages[0], id: "missing", envelope: undefined });
  input.stages.push({ ...input.stages[1], id: "other" });
  const observed: Omit<EnvelopeToolRef, "stageId">[] = [];
  expect(qualifyUnattended(input, { effectOf: tool => {
    observed.push(tool);
    return tool.collection === "mcpGenerationTools" ? "outward" : "safe";
  } })).toMatchObject({ code: "outward-effect-tool", tool: { stageId: "first", collection: "mcpGenerationTools" } });
  expect(observed.map(t => t.name)).toEqual(["local", "later", "sources_read", "render"]);
  expect(qualifyUnattended(input, { effectOf: () => "safe" })).toEqual({ ok: false, code: "unattended-not-read-only" });
});

it.each(collections)("answers unknown for a null resolver with an entry in %s", collection => {
  const input = graph();
  const envelope = requiredValue(input.stages[0].envelope);
  for (const other of collections) if (other !== collection) envelope[other] = [];
  expect(qualifyUnattended(input, null)).toMatchObject({ ok: false, code: "tool-effect-unknown", tool: { collection } });
});

it("requires a resolver for an all-tools version even when it declares no tools", () => {
  const input = graph();
  const envelope = requiredValue(input.stages[0].envelope);
  for (const collection of collections) envelope[collection] = [];
  expect(qualifyUnattended(input, null)).toEqual({ ok: false, code: "unattended-not-read-only" });
  expect(qualifyUnattended(input, { effectOf: () => "unknown" })).toEqual({ ok: true });
});

it.each(["web_fetch", "web_search"])("refuses to qualify %s without an unattended network route", name => {
  const registry = new ToolRegistry();
  registry.register(createWebFetchTool(fetch));
  registry.register(createWebSearchTool({ get: () => undefined } as never, fetch));
  const input = graph();
  const envelope = requiredValue(input.stages[0].envelope);
  for (const collection of collections) envelope[collection] = [];
  envelope.tools = [name];
  expect(qualifyUnattended(input, createToolEffectResolver(registry))).toEqual({
    ok: false, code: "tool-effect-unknown", tool: { stageId: "first", collection: "tools", name },
  });
});
