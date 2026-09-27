import { describe, expect, it } from "vitest";
import { deriveAgentPluginComponents, parseAgentPluginRoutineTemplates, type AgentPluginFile } from "../agent-plugin-components.js";
import { parseContent } from "../kinds.js";

const data = (path: string, text: string): AgentPluginFile => ({ path, data: Buffer.from(text) });
const packageFiles = (): AgentPluginFile[] => [
  data("plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer-plugin", version: "1.0.0", description: "Writes drafts" })),
  data("skills/draft/SKILL.md", "---\nname: draft\ndescription: Write a draft\n---\nWrite a draft.\n"),
  data("skills/draft/scripts/run.sh", "#!/bin/sh\nprintf draft\n"),
  data("ai.agent-connector.ave/prompts/draft.md", "---\nname: draft\ndescription: Write a draft\nkind: template\n---\nDraft {args}\n"),
  data("ai.agent-connector.ave/agents/review/AGENTS.md", "---\nname: review\ndescription: Review drafts\n---\nReview the draft.\n"),
  data("ai.agent-connector.ave/routines.json", JSON.stringify({ version: 1, templates: [{ id: "daily", title: "Daily draft", description: "Write a draft", trigger: "schedule", schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } }, execution: "llm-session", prePrompt: "Write a draft" }] })),
  data("mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { editor: { type: "stdio", command: "./server/editor", args: ["${PLUGIN_ROOT}/server/config.json"] } } })),
  data("server/editor", "#!/bin/sh\n"),
  data("server/config.json", "{}"),
];

describe("agent-plugin component authority", () => {
  it("derives stable digests from bytes and refuses a descriptor mismatch", () => {
    const files = packageFiles();
    const components = deriveAgentPluginComponents(files);
    expect(deriveAgentPluginComponents([...files].reverse())).toEqual(components);
    expect(components.skills).toMatchObject([{ name: "draft", hasScripts: true }]);
    expect(components.prompts).toMatchObject([{ name: "draft", kind: "template" }]);
    expect(components.agents).toMatchObject([{ name: "review" }]);
    expect(components.routineTemplates).toMatchObject([{ id: "daily" }]);
    expect(components.mcpServers.editor).toMatchObject({ command: "./server/editor", cwd: "${PLUGIN_ROOT}" });
    const context = { name: "writer-plugin", version: "1.0.0", payload: { manifest: "plugin.json", components }, english: {}, sourceOrigin: "custom" as const, unknownMessageKeys: "refuse" as const };
    expect(parseContent("agent-plugin", files, context)).toEqual({ kind: "agent-plugin", components, files });
    expect(() => parseContent("agent-plugin", files, { ...context, payload: { ...context.payload, components: { ...components, agents: [] } } }))
      .toThrow("agent-plugin components differ from the package tree");
  });

  it("changes only the referencing server digest when a server file changes", () => {
    const files = packageFiles();
    const original = deriveAgentPluginComponents(files);
    const changed = deriveAgentPluginComponents(files.map((file) => file.path === "server/config.json" ? data(file.path, "{\"mode\":\"new\"}") : file));
    expect(changed.mcpServers.editor?.digest).not.toBe(original.mcpServers.editor?.digest);
    expect(changed.skills).toEqual(original.skills);
    expect(changed.prompts).toEqual(original.prompts);
    expect(changed.agents).toEqual(original.agents);
    expect(changed.routineTemplates).toEqual(original.routineTemplates);
  });

  it("holds bundled instruction bodies to the host limits", () => {
    const files = packageFiles();
    const oversizedSkill = files.map((file) => file.path === "skills/draft/SKILL.md"
      ? data(file.path, `---\nname: draft\ndescription: Write a draft\n---\n${"x".repeat(8193)}`) : file);
    expect(() => deriveAgentPluginComponents(oversizedSkill)).toThrow("invalid SKILL.md");
    const oversizedAgent = files.map((file) => file.path === "ai.agent-connector.ave/agents/review/AGENTS.md"
      ? data(file.path, `---\nname: review\ndescription: Review drafts\n---\n${"x".repeat(16385)}`) : file);
    expect(() => deriveAgentPluginComponents(oversizedAgent)).toThrow("invalid agent name or body");
  });

  it("accepts routine prefill objects and rejects schedules the add flow cannot use", () => {
    const template = { id: "daily", title: "Daily draft", description: "Write a draft", trigger: "schedule",
      schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } }, execution: "llm-session", prePrompt: "Write\na draft",
      suggestedScope: { pluginIds: ["writer-extension"] } };
    const read = (entry: unknown) => parseAgentPluginRoutineTemplates(Buffer.from(JSON.stringify({ version: 1, templates: [entry] })));
    expect(read(template)).toMatchObject([template]);
    expect(() => read({ ...template, schedule: "0 9 * * *" })).toThrow("must be an object");
    expect(() => read({ ...template, schedule: { repeat: { kind: "daily" } } })).toThrow("needs at");
    expect(() => read({ ...template, schedule: { repeat: { kind: "cron", expression: "invalid" } } })).toThrow("invalid cron repeat");
    expect(() => read({ ...template, prePrompt: undefined })).toThrow("needs prePrompt");
    expect(() => read({ ...template, suggestedScope: { pluginIds: ["../wrong"] } })).toThrow("invalid suggestedScope");
  });
});
