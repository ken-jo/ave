import { createDynamicTool, type Tool } from "./base.js";
import { PluginStudioStore } from "../studio/store.js";
import type { StudioWriteRequest } from "../shared/plugin-studio.js";
import { resolveStudioReferences, type StudioReferenceSources } from "../studio/references.js";

function answer(run: () => Promise<unknown>): Promise<{ output: string; isError: boolean }> {
  return run().then((value) => ({ output: JSON.stringify(value), isError: false }),
    (error: unknown) => ({ output: JSON.stringify({ error: error instanceof Error ? error.message : "Studio failed" }), isError: true }));
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
        return { draft: view.draft, files: view.files.map((file) => file.path), diagnostics: view.diagnostics, errors: view.errors };
      }),
    }),
    createDynamicTool({
      name: "plugin_studio_read", source: "builtin", category: "meta", decisionOverride: "ask",
      description: "Read a plugin draft and its package texts from Studio.",
      jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      isReadOnly: () => true,
      execute: (raw) => answer(() => store.readDraft(String((raw as { name?: unknown })?.name ?? ""))),
    }),
    createDynamicTool({
      name: "plugin_studio_validate", source: "builtin", category: "meta", decisionOverride: "ask",
      description: "Validate a plugin draft and return grouped diagnostics and advisory lint findings.",
      jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      isReadOnly: () => true,
      execute: (raw) => answer(async () => {
        const view = await store.readDraft(String((raw as { name?: unknown })?.name ?? ""));
        return { treeDigest: view.treeDigest, diagnostics: view.diagnostics, lint: view.lint, errors: view.errors, components: view.components };
      }),
    }),
  ];
}
