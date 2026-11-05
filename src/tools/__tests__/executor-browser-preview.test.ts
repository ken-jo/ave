// A display thumbnail rides the per-call metadata to the chat only from a host tool: a plugin or connector result that carries
// one is dropped, so no outside code can put an image into the transcript view.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ToolSource } from "../types.js";

const PREVIEW = { dataUrl: "data:image/jpeg;base64,QUdFTlQ=", width: 320, height: 180 };

async function previewOf(source: ToolSource, extra: Record<string, unknown> = {}): Promise<{ content: string; browserPreview: unknown }> {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: "preview_probe",
    description: "returns a thumbnail",
    source,
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    ...extra,
    execute: async () => ({ output: "captured", isError: false, browserPreview: PREVIEW }),
  }));
  // Outside tools ask first; the user allows this one call so the result itself reaches the executor.
  const approvals = { requestAndWait: async () => ({ choice: "allow-once" as const }) };
  const executor = new ToolExecutor(registry, undefined, new PermissionManager("/tmp/nonexistent-browser-preview.json"), undefined, approvals as never);
  let browserPreview: unknown = "not-called";
  const [result] = await executor.executeConversationTools(
    [{ id: `tu-preview-${source}`, name: "preview_probe", input: {} }],
    {
      executionCwd: resolve("test-fixtures", "browser-preview"),
      sessionId: "sess-preview",
      permissionContext: userPermissionContext(),
      callbacks: { onToolEnd: (_name, _result, _isError, meta) => { browserPreview = meta.browserPreview; } },
    },
  );
  return { content: result!.content as string, browserPreview };
}

describe("browser preview on per-call metadata", () => {
  it("carries a builtin tool's validated thumbnail", async () => {
    await expect(previewOf("builtin")).resolves.toEqual({ content: "captured", browserPreview: PREVIEW });
  });

  it("drops a thumbnail from a plugin or connector tool, keeping its result", async () => {
    await expect(previewOf("plugin", { pluginId: "preview-plugin" })).resolves.toEqual({ content: "captured", browserPreview: undefined });
    await expect(previewOf("mcp", { mcpServerId: "preview-server", mcpReadOnlyHint: true })).resolves.toEqual({ content: "captured", browserPreview: undefined });
  });
});
