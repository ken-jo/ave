import { describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../../types.js";
import { handleChatSend, type ChatSendContext } from "../chat.js";
import { formatAgentPluginTemplatePrompt, type AgentPluginTemplatePrompt } from "../../../shared/agent-plugin-prompt.js";
import { formatAppMessageEnvelope } from "../../../shared/mcp-app-message-source.js";
import { bindMessageSendPayload, LOOPBACK_CONVERSATION_ACTOR } from "../../../main/conversation-command-port.js";

const completedTurn = { text: "done", toolCalls: [], route: "default", stopReason: "end_turn" } as const;

const EXTENSION_TEMPLATE: AgentPluginTemplatePrompt = {
  id: "extension:egress-probe:egress-probe",
  packageName: "egress-probe",
  version: "1.0.0",
  name: "egress-probe",
  description: "",
  body: "TOOL: egress_probe {}",
};
const OTHER_EXTENSION_TEMPLATE: AgentPluginTemplatePrompt = {
  ...EXTENSION_TEMPLATE,
  id: "extension:other-plugin:draft",
  packageName: "other-plugin",
  name: "draft",
};
const PACKAGE_TEMPLATE: AgentPluginTemplatePrompt = {
  ...EXTENSION_TEMPLATE,
  id: "agent-plugin:writer-plugin:draft",
  packageName: "writer-plugin",
  name: "draft",
};

function makeFixture() {
  const runTurn = vi.fn(async (..._args: unknown[]) => completedTurn);
  const deps = {
    conversationLoop: { getSessionId: () => "session-pscope", getSessionKind: () => "subagent", runTurn },
    settingsService: { get: () => undefined },
    auditLogger: { log: vi.fn() },
    personaPromptStore: { listTemplates: () => [EXTENSION_TEMPLATE, OTHER_EXTENSION_TEMPLATE, PACKAGE_TEMPLATE] },
  } as unknown as IpcDeps;
  const context: ChatSendContext = {
    createStreamEventSink: () => vi.fn(),
    allocateStreamId: () => 7,
    trackStreamTurn: (factory) => factory(),
  };
  return { deps, context, runTurn };
}

async function scopeFor(payload: Record<string, unknown>): Promise<ReadonlySet<string> | undefined> {
  const fixture = makeFixture();
  await handleChatSend(fixture.deps, payload, fixture.context);
  expect(fixture.runTurn).toHaveBeenCalledOnce();
  const options = fixture.runTurn.mock.calls[0]?.[3] as { turnScopedPluginIds?: ReadonlySet<string> };
  return options.turnScopedPluginIds;
}

describe("chat send plugin-prompt scope", () => {
  const envelope = formatAgentPluginTemplatePrompt(EXTENSION_TEMPLATE, "");

  it("scopes the installed extension template's own plugin for the turn", async () => {
    const scope = await scopeFor({ input: envelope, inputOrigin: "plugin-prompt-emitted", pluginPromptId: EXTENSION_TEMPLATE.id });
    expect([...(scope ?? [])]).toEqual(["egress-probe"]);
  });

  it("scopes nothing for a forged, unknown or mismatched template identity", async () => {
    for (const payload of [
      // Unknown template id.
      { input: envelope, inputOrigin: "plugin-prompt-emitted", pluginPromptId: "extension:egress-probe:missing" },
      // Real template id that is not the one whose envelope is being sent.
      { input: envelope, inputOrigin: "plugin-prompt-emitted", pluginPromptId: OTHER_EXTENSION_TEMPLATE.id },
      // Malformed id.
      { input: envelope, inputOrigin: "plugin-prompt-emitted", pluginPromptId: "egress-probe" },
      // Envelope text alone never scopes.
      { input: envelope, inputOrigin: "plugin-prompt-emitted" },
      // Package template without a runtime plugin.
      {
        input: formatAgentPluginTemplatePrompt(PACKAGE_TEMPLATE, ""),
        inputOrigin: "plugin-prompt-emitted",
        pluginPromptId: PACKAGE_TEMPLATE.id,
      },
    ]) {
      expect(await scopeFor(payload)).toBeUndefined();
    }
  });

  it("ignores a template id on a non-plugin-prompt origin", async () => {
    expect(await scopeFor({
      input: formatAppMessageEnvelope("hello", "app:test-server"), inputOrigin: "app-emitted", pluginPromptId: EXTENSION_TEMPLATE.id,
    })).toBeUndefined();
  });

  it("never lets a non-desktop transport supply a template selection", () => {
    const bound = bindMessageSendPayload(LOOPBACK_CONVERSATION_ACTOR, {
      input: envelope, inputOrigin: "plugin-prompt-emitted", pluginPromptId: EXTENSION_TEMPLATE.id,
    }) as Record<string, unknown>;
    expect(bound).not.toHaveProperty("pluginPromptId");
  });
});
