import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  inspectModelTransportStructure,
  isProductionSource,
} from "../../../__tests__/support/model-transport-structure.js";
import { createProvider } from "../provider-factory.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function readProductionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(absolute);
        continue;
      }
      const path = relative(REPO_ROOT, absolute).split(sep).join("/");
      if (isProductionSource(path)) sources.set(path, readFileSync(absolute, "utf8"));
    }
  };
  walk(join(REPO_ROOT, "src"));
  return sources;
}

const production = readProductionSources();
const ADAPTER = "src/engine/llm/vercel/adapter.ts";
const CHAT_ROUTE = "src/engine/turn/provider.ts";

function mutate(changes: Record<string, string | ((source: string) => string)>): string[] {
  const sources = new Map(production);
  for (const [file, change] of Object.entries(changes)) {
    const before = sources.get(file) ?? "";
    const after = typeof change === "string" ? change : change(before);
    // A mutation that changes nothing would prove nothing.
    expect(after).not.toBe(before);
    sources.set(file, after);
  }
  return inspectModelTransportStructure(sources).violations;
}

function replaceOnce(source: string, search: string, replacement: string): string {
  expect(source.split(search)).toHaveLength(2);
  return source.replace(search, replacement);
}

describe("model transport structure", () => {
  it("holds for the production tree", () => {
    expect(production.size).toBeGreaterThan(500);
    expect(inspectModelTransportStructure(production).violations).toEqual([]);
  });

  it("matches the reviewed inventory of retirement evidence", () => {
    // Each line is one place production code decides what proves a route retired. Change it only with that decision.
    expect(inspectModelTransportStructure(production).probeSites).toEqual([
      { file: "src/engine/llm/provider-factory.ts", probe: "cfg.getRetiredModelId" },
      { file: "src/engine/llm/provider-factory.ts", probe: "config.getRetiredModelId" },
      {
        file: "src/engine/llm/vercel/fallback-chain.ts",
        probe: "retirement ? (model) => retirement.getBlockedModelId?.() ?? retirement.getRetiredModelId({ ...entry, model }) : noRetirementEvidence",
      },
      { file: "src/engine/system-subagent-route.ts", probe: "getRetiredModelId" },
      { file: "src/engine/system-subagent-route.ts", probe: "getRetiredModelId" },
      { file: "src/engine/system-subagent-route.ts", probe: "({ model: modelId }) => getRetiredModelId(modelId)" },
      {
        file: CHAT_ROUTE,
        probe: "(route: { provider: LLMVendor; model: string; baseUrl?: string; presetId?: string }): string | undefined => { const { modelListCache } = deps.settingsService.get(\"llm\"); const retirement = resolveModelRetirement({ vendor: route.provider, model: route.model, baseUrl: route.baseUrl, listing: modelListCache?.[llmModelListCacheKey(route.provider, route.baseUrl, route.presetId)], }); return retirement === \"unlisted\" ? route.model : undefined; }",
      },
      {
        file: CHAT_ROUTE,
        probe: "(model) => routeRetirement.getBlockedModelId() ?? routeRetirement.getRetiredModelId({ provider: vendor, model, baseUrl: effectiveBaseUrl, presetId: routeRetirement.primaryPresetId, })",
      },
      { file: "src/main/chatgpt-plan/transport.ts", probe: "(wireModel) => runtime.getRetiredModelId(wireModel)" },
      { file: "src/main/memory-map/provider-embeddings.ts", probe: "noRetirementEvidence" },
    ]);
  });

  it("requires retirement evidence in the provider config type", () => {
    // @ts-expect-error A transport cannot be configured without saying what retires its route.
    const provider = createProvider({ vendor: "openai", apiKey: "fixture-key" });
    expect(provider.vendor).toBe("openai");
  });

  describe("in-memory mutations", () => {
    it("rejects a new file that builds an SDK transport of its own", () => {
      expect(mutate({
        "src/engine/llm/side-transport.ts": [
          'import { createOpenAI } from "@ai-sdk/openai";',
          'export const sideModel = createOpenAI({ apiKey: "k" }).chat("model");',
        ].join("\n"),
      })).toEqual(["src/engine/llm/side-transport.ts: imports the model SDK (@ai-sdk/openai) outside the gated transport"]);
    });

    it("rejects a new file that dispatches through the SDK with a destructured dynamic import", () => {
      expect(mutate({
        "src/main/side-dispatch.ts": 'export async function send() { const { streamText } = await import("ai"); return streamText; }',
      })).toEqual(["src/main/side-dispatch.ts: loads the model SDK (ai) dynamically"]);
    });

    it("rejects a dispatch function named beside the telemetry registration", () => {
      expect(mutate({
        "src/engine/telemetry/tracing.ts": (source) => replaceOnce(source, "const [{ registerTelemetry }, {", "const [{ registerTelemetry, streamText }, {"),
      })).toEqual(["src/engine/telemetry/tracing.ts: names an SDK dispatch function beside its telemetry registration"]);
    });

    it("rejects a destructured factory call inside the adapter", () => {
      expect(mutate({
        [ADAPTER]: (source) => `${source}\nexport function sideChat(apiKey: string) { const { chat } = createOpenAI({ apiKey }); return chat; }\n`,
      })).toEqual([`${ADAPTER}: createOpenAI(…) is not given the gated wire fetch`]);
    });

    it("rejects an aliased factory, which could be called without the gate", () => {
      expect(mutate({
        [ADAPTER]: (source) => `${source}\nexport const sideFactories = { open: createOpenAI };\n`,
      })).toEqual([`${ADAPTER}: createOpenAI is aliased or passed around instead of being called with a gated fetch`]);
    });

    it("rejects a factory handed the raw fetch", () => {
      expect(mutate({
        [ADAPTER]: (source) => replaceOnce(
          source,
          "const wireFetch = this.wireFetch(modelId);",
          "const wireFetch = this.customFetch ?? globalThis.fetch;",
        ),
      })).not.toEqual([]);
    });

    it("rejects a gate whose predicate was emptied", () => {
      expect(mutate({
        [ADAPTER]: (source) => replaceOnce(source, "() => this.extras.getRetiredModelId?.(modelId)", "() => undefined"),
      })).toEqual([expect.stringContaining("wireFetch must be exactly")]);
    });

    it("rejects route evidence replaced by a function that answers nothing", () => {
      expect(mutate({
        [CHAT_ROUTE]: (source) => replaceOnce(
          source,
          "getRetiredModelId: (model) => routeRetirement.getBlockedModelId() ?? routeRetirement.getRetiredModelId({",
          "getRetiredModelId: () => undefined, unused: (model: string) => routeRetirement.getRetiredModelId({",
        ),
      })).toEqual([`${CHAT_ROUTE}: supplies a getRetiredModelId that answers nothing; name noRetirementEvidence`]);
    });

    it("rejects the adapter constructed outside the factory", () => {
      expect(mutate({
        "src/main/side-wire.ts": [
          'import { VercelUnifiedProvider } from "../engine/llm/vercel/adapter.js";',
          'export const sideWire = new VercelUnifiedProvider("openai", "k");',
        ].join("\n"),
      })).toEqual(expect.arrayContaining(["src/main/side-wire.ts: reaches VercelUnifiedProvider outside the provider factory"]));
    });

    it("rejects a factory that stops forwarding the evidence to the adapter", () => {
      expect(mutate({
        "src/engine/llm/provider-factory.ts": (source) => replaceOnce(source, "              getRetiredModelId: cfg.getRetiredModelId,\n", ""),
      })).toEqual(["src/engine/llm/provider-factory.ts: constructs VercelUnifiedProvider without the config's getRetiredModelId"]);
    });
  });
});
