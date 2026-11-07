import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { formatAgentPluginTemplatePrompt } from "../../shared/agent-plugin-prompt.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly observedToolNames: string[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((input.tools ?? []).map((tool) => tool.name));
    yield* this.turns[this.index++] ?? [];
  }
}

// One run: the model calls `toolName` once, then ends the turn.
const toolThenEnd = (id: string, toolName: string): StreamEvent[][] => [
  [{ type: "tool_call", id, name: toolName, input: {} }, { type: "message_complete", stopReason: "tool_use" }],
  [{ type: "text_delta", text: "done" }, { type: "message_complete", stopReason: "end_turn" }],
];

function makeLoop(provider: LLMProvider, opts: {
  disabledPluginIds?: string[];
  approvalGate?: { requestAndWait: (request: { id: string }) => Promise<unknown> };
} = {}): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "request_plugin",
    description: "activate a plugin",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", required: ["pluginId"], properties: { pluginId: { type: "string" } } },
    execute: async () => ({ output: "unreachable", isError: false }),
  }));
  for (const [pluginId, name] of [["egress-probe", "egress_probe"], ["other-plugin", "other_tool"]] as const) {
    toolRegistry.register(createDynamicTool({
      name,
      description: `${pluginId} ${name}`,
      source: "plugin",
      pluginId,
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: `${name}-ran`, isError: false }),
    }));
  }
  const loop = new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system", setToolScope: () => {} },
    toolRegistry,
    // Default mode: the scope admits the call, the permission tree still decides it.
    permissionManager: new PermissionManager(join(mkdtempSync(join(tmpdir(), "ave-pscope-")), "permissions.json")),
    ...(opts.approvalGate ? { approvalGate: opts.approvalGate } : {}),
    memoryManager: { sessions: { saveSession: () => {}, listSessions: () => [] } },
    pluginRuntime: {
      listPluginIds: () => ["egress-probe", "other-plugin"],
      isPluginEnabled: (pluginId: string) => !(opts.disabledPluginIds ?? []).includes(pluginId),
    },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

const promptEnvelope = formatAgentPluginTemplatePrompt({
  id: "extension:egress-probe:egress-probe",
  packageName: "egress-probe",
  version: "1.0.0",
  name: "egress-probe",
  description: "",
  body: "TOOL: egress_probe {}",
}, "");

function promptTurn(turnScopedPluginIds?: string[]) {
  return {
    inputOrigin: "plugin-prompt-emitted" as const,
    ...(turnScopedPluginIds ? { turnScopedPluginIds: new Set(turnScopedPluginIds) } : {}),
  };
}

function toolResults(loop: ConversationLoop): Array<{ toolName?: string; content: string; isError?: boolean }> {
  return loop.getHistory().getMessages()
    .filter((message) => message.role === "tool_result") as Array<{ toolName?: string; content: string; isError?: boolean }>;
}

function allowOnceGate() {
  return {
    requestAndWait: vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "allow-once" as const })),
  };
}

const OUT_OF_SCOPE = /pluginId=(egress-probe|other-plugin)/u;

describe("user-selected plugin prompt scope", () => {
  it("lets the prompt run call its own plugin's tool, still through the approval card", async () => {
    const provider = new ScriptedProvider(toolThenEnd("tu-1", "egress_probe"));
    const approvalGate = allowOnceGate();
    const loop = makeLoop(provider, { approvalGate });

    await loop.runTurn(promptEnvelope, undefined, undefined, promptTurn(["egress-probe"]));

    expect(provider.observedToolNames[0]).toContain("egress_probe");
    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    const [result] = toolResults(loop);
    expect(result?.content).not.toMatch(OUT_OF_SCOPE);
    expect(result?.content).toContain("egress_probe-ran");
  });

  it("keeps a different plugin's tool out of scope in that run", async () => {
    const provider = new ScriptedProvider(toolThenEnd("tu-1", "other_tool"));
    const loop = makeLoop(provider);

    await loop.runTurn(promptEnvelope, undefined, undefined, promptTurn(["egress-probe"]));

    expect(provider.observedToolNames[0]).toContain("egress_probe");
    expect(provider.observedToolNames[0]).not.toContain("other_tool");
    const [result] = toolResults(loop);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("pluginId=other-plugin");
  });

  it("does not carry the scope into the next turn", async () => {
    const provider = new ScriptedProvider([
      ...toolThenEnd("tu-1", "egress_probe"),
      ...toolThenEnd("tu-2", "egress_probe"),
    ]);
    const loop = makeLoop(provider, { approvalGate: allowOnceGate() });

    await loop.runTurn(promptEnvelope, undefined, undefined, promptTurn(["egress-probe"]));
    await loop.runTurn("again", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.observedToolNames[2]).not.toContain("egress_probe");
    const results = toolResults(loop);
    expect(results[0]?.content).toContain("egress_probe-ran");
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain("pluginId=egress-probe");
  });

  it("carries the plugin forward when request_plugin activates it in the prompt turn", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "tu-1", name: "request_plugin", input: { pluginId: "egress-probe" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "activated" }, { type: "message_complete", stopReason: "end_turn" }],
      [{ type: "text_delta", text: "next" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const loop = makeLoop(provider);

    await loop.runTurn(promptEnvelope, undefined, undefined, promptTurn(["egress-probe"]));
    await loop.runTurn("again", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.observedToolNames[2]).toContain("egress_probe");
  });

  it("scopes nothing for an unknown, disabled or non-prompt-origin plugin id", async () => {
    for (const [turnOptions, disabledPluginIds] of [
      [promptTurn(["not-installed"]), []],
      [promptTurn(["egress-probe"]), ["egress-probe"]],
      [{ ...userKeyboardTurn(), turnScopedPluginIds: new Set(["egress-probe"]) }, []],
    ] as const) {
      const provider = new ScriptedProvider(toolThenEnd("tu-1", "egress_probe"));
      const loop = makeLoop(provider, { disabledPluginIds: [...disabledPluginIds] });
      const input = turnOptions.inputOrigin === "plugin-prompt-emitted" ? promptEnvelope : "run the probe";

      await loop.runTurn(input, undefined, undefined, turnOptions);

      expect(provider.observedToolNames[0]).not.toContain("egress_probe");
      const [result] = toolResults(loop);
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain("pluginId=egress-probe");
    }
  });
});
