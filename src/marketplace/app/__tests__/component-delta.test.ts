import { describe, expect, it } from "vitest";
import { componentDelta, componentInventory } from "../component-delta.js";
import type { AgentPluginComponents } from "../../catalog/types.js";

const DIGEST = "a".repeat(64);
const CHANGED = "b".repeat(64);
const components = (): AgentPluginComponents => ({
  skills: [{ name: "draft", hasScripts: false, digest: DIGEST }],
  mcpServers: { editor: { transport: "stdio", command: "./server/editor", cwd: "${PLUGIN_ROOT}", digest: DIGEST } },
  prompts: [], agents: [], routineTemplates: [], hooks: [],
});

describe("agent-plugin component review", () => {
  it("shows a digest change even when the component name remains", () => {
    const before = components();
    const after: AgentPluginComponents = {
      ...components(),
      mcpServers: { editor: { ...components().mcpServers.editor!, digest: CHANGED } },
      prompts: [{ name: "publish", kind: "template", digest: DIGEST }],
    };
    expect(componentInventory(after).map((item) => `${item.kind}:${item.name}`)).toEqual(["mcp:editor", "prompt:publish", "skill:draft"]);
    expect(componentDelta(before, after)).toEqual({
      added: [{ kind: "prompt", name: "publish", digest: DIGEST }],
      removed: [],
      changed: [{ kind: "mcp", name: "editor", digest: CHANGED }],
    });
  });
});
