import { createDynamicTool, type Tool } from "./base.js";
import { PluginStudioStore } from "../studio/store.js";
import type { StudioDraftView, StudioWriteRequest } from "../shared/plugin-studio.js";
import { resolveStudioReferences, type StudioReferenceSources } from "../studio/references.js";

function answer(run: () => Promise<unknown>): Promise<{ output: string; isError: boolean }> {
  return run().then((value) => ({ output: JSON.stringify(value), isError: false }),
    (error: unknown) => ({ output: JSON.stringify({ error: error instanceof Error ? error.message : "Studio failed" }), isError: true }));
}

function modelView(view: StudioDraftView): Record<string, unknown> {
  return {
    draft: view.draft,
    treeDigest: view.treeDigest,
    reviewStatus: view.reviewStatus,
    files: view.files.map((file) => ({ path: file.path, text: file.path === "mcp.json" ? null : file.text })),
    diagnostics: view.diagnostics,
    errors: view.errors.map((error) => error.includes("mcp.json") ? "Connector package validation failed; review it in Studio" : error),
    lint: view.lint.map((item) => item.path.startsWith("mcp.json") ? { ...item, matched: "[redacted]" } : item),
    connectorStatuses: view.connectorStatuses,
    components: view.components ? { ...view.components, mcpServers: Object.fromEntries(Object.entries(view.components.mcpServers)
      .map(([name, server]) => [name, { transport: server.transport, argsCount: server.transport === "stdio" ? (server.args ?? []).length : 0,
        envCount: server.transport === "stdio" ? Object.keys(server.env ?? {}).length : 0, digest: server.digest }])) } : null,
  };
}

/** The model may draft and inspect; these tools never install or share. */
export function createPluginStudioTools(store: PluginStudioStore = new PluginStudioStore(), sources: StudioReferenceSources = {}): Tool[] {
  return [
    createDynamicTool({
      name: "plugin_studio_draft", source: "builtin", category: "meta", decisionOverride: "ask",
      description: "Create or update a plugin draft in Studio. The user reviews and installs it separately.",
      jsonSchema: { type: "object", required: ["name"], properties: {
        name: { type: "string" }, version: { type: "string" }, description: { type: "string" },
        files: { type: "array", items: { type: "object", required: ["path", "text"], properties: { path: { type: "string" }, text: { type: "string" } } } },
        removePaths: { type: "array", items: { type: "string" } },
        references: { type: "array", items: { type: "object", required: ["kind", "name"], properties: { kind: { type: "string", enum: ["skill", "routine", "connector", "prompt", "agent"] }, name: { type: "string" } } } },
      } },
      execute: (raw, ctx) => answer(async () => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Draft request must be an object");
        const input = raw as StudioWriteRequest;
        if (typeof input.name !== "string") throw new Error("Draft name is required");
        const sessionId = ctx.metadata?.sessionId;
        if (typeof sessionId !== "string" || !sessionId) throw new Error("Draft requires a conversation session");
        const view = await store.writeDraft(input, sessionId, await resolveStudioReferences(input, sources));
        return { draft: view.draft, reviewStatus: view.reviewStatus, files: view.files.map((file) => file.path), diagnostics: view.diagnostics,
          errors: modelView(view).errors, connectorStatuses: view.connectorStatuses };
      }),
    }),
    createDynamicTool({
      name: "plugin_studio_read", source: "builtin", category: "meta", decisionOverride: "ask",
      description: "Read a plugin draft and its package texts from Studio.",
      jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      isReadOnly: () => true,
      execute: (raw) => answer(async () => modelView(await store.readDraft(String((raw as { name?: unknown })?.name ?? "")))),
    }),
    createDynamicTool({
      name: "plugin_studio_validate", source: "builtin", category: "meta", decisionOverride: "ask",
      description: "Validate a plugin draft and return grouped diagnostics and advisory lint findings.",
      jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      isReadOnly: () => true,
      execute: (raw) => answer(async () => {
        const view = await store.readDraft(String((raw as { name?: unknown })?.name ?? ""));
        const safe = modelView(view);
        return { treeDigest: safe.treeDigest, reviewStatus: safe.reviewStatus, diagnostics: safe.diagnostics, lint: safe.lint,
          errors: safe.errors, components: safe.components, connectorStatuses: safe.connectorStatuses };
      }),
    }),
  ];
}
