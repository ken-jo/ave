import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { createReadToolResultChunkTool } from "../../tools/tool-result-chunk.js";
import { createWebFetchTool, fenceWebContent } from "../../tools/web-fetch.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { MAX_AGENT_SPAWNS_PER_ROUND } from "../../shared/subagent-policy.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillStore } from "../../main/skill-store.js";
import { createSkillLoadTool } from "../../tools/skill-load.js";
import { MCP_RESOURCE_FENCE_OPEN } from "../../shared/mcp-resource-bounds.js";
import type { SubscriptionRuntimeId } from "../../shared/subscription-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { TurnCallbacks, TurnDecisionEvent } from "../turn/types.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider as FakeProvider } from "./support/conversation-loop-fixtures.js";

type AssistantRoundStopReason =
  Parameters<NonNullable<TurnCallbacks["onAssistantRound"]>>[0]["stopReason"];
import { genericToModelMessages, fullStreamToStreamEvent } from "../llm/vercel/adapter.js";
import { t } from "../../i18n/index.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT } from "../llm/output-token-limit.js";
import { DEFAULT_LLM_OUTPUT_TOKEN_LIMIT } from "../../shared/model-host-policy.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

class RecordingPromptProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly systemPrompts: string[] = [];
  readonly messages: GenericMessage[][] = [];
  readonly params: StreamTurnParams[] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.systemPrompts.push(input.systemPrompt);
    this.messages.push(input.messages);
    this.params.push(input);
    yield* this.turns[this.index++] ?? [];
  }
}

class SubscriptionRecordingPromptProvider extends RecordingPromptProvider {
  readonly subscriptionRuntime: Readonly<{
    kind: "subscription";
    provider: SubscriptionRuntimeId;
  }>;

  constructor(turns: StreamEvent[][], provider: SubscriptionRuntimeId = "codex") {
    super(turns);
    this.subscriptionRuntime = { kind: "subscription", provider };
  }
}

function withoutRuntimeMeta(messages: ReadonlyArray<GenericMessage>) {
  return messages.map((message) => {
    const { meta, ...rest } = message;
    if (!meta) return rest;
    const {
      createdAt: _createdAt,
      messageId: _messageId,
      turnSummary: _turnSummary,
      toolDisplay: _toolDisplay,
      ...stableMeta
    } = meta;
    return Object.keys(stableMeta).length > 0 ? { ...rest, meta: stableMeta } : rest;
  });
}

describe("ConversationLoop queryLoop", () => {
  it("clears per-turn prompt builder state when prompt assembly throws", async () => {
    const toolRegistry = new ToolRegistry();
    const setOriginSource = vi.fn();
    const setActiveSessionId = vi.fn();
    const setActiveRolePrompt = vi.fn();
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      systemPromptBuilder: {
        build: () => {
          throw new Error("prompt assembly failed");
        },
        setOriginSource,
        setActiveSessionId,
        setActiveRolePrompt,
        setToolScope: vi.fn(),
      },
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = new FakeProvider([]);

    await expect(loop.runTurn("질문", undefined, undefined, {
      ...userKeyboardTurn(),
      originSource: "overlay:test",
      rolePrompt: { id: "reviewer", name: "Reviewer", systemPromptAdd: "Review carefully.",
        },
    }),
    ).rejects.toThrow("prompt assembly failed");

    expect(setOriginSource).not.toHaveBeenCalled();
    expect(setActiveSessionId).toHaveBeenNthCalledWith(1, expect.any(String));
    expect(setActiveSessionId).toHaveBeenLastCalledWith(null);
    expect(setActiveRolePrompt).toHaveBeenNthCalledWith(1, {
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });
    expect(setActiveRolePrompt).toHaveBeenLastCalledWith(null);
  });
  it("routes subscription turns through the ordinary prompt, history, and tool schemas", async () => {
    const secret = "subscription-turn-secret";
    const provider = new SubscriptionRecordingPromptProvider([
      [
        { type: "tool_call", id: "subscription-list", name: "list_directory", input: { path: "src" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const build = vi.fn(() => "PROJECT_SECRET_SYSTEM_PROMPT");
    const execute = vi.fn(async () => ({ output: "src", isError: false }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute,
    }));
    const settings = {
      ...fakeLlmSettings(),
      activeChatRuntime: { kind: "subscription" as const, provider: "codex" as const },
    };
    // Inactive API-key controls must not enter a subscription request.
    settings.vendors.openai.enableThinking = true;
    settings.vendors.openai.thinkingBudgetTokens = 32_000;

    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build },
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;
    loop.getHistory().append({
      role: "user",
      content: [
        { type: "text", text: "prior ordinary text" },
        { type: "file", data: secret, mimeType: "application/secret" },
      ],
    });
    build.mockClear();

    const result = await loop.runTurn("ordinary user text", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(build).toHaveBeenCalled();
    expect(provider.systemPrompts).toEqual([
      "PROJECT_SECRET_SYSTEM_PROMPT",
      "PROJECT_SECRET_SYSTEM_PROMPT",
    ]);
    expect(provider.params[0]?.model).toBe("default");
    expect(JSON.stringify(provider.params[0]?.tools)).toContain("list_directory");
    expect(provider.params[0]?.enableThinking).toBe(false);
    expect(provider.params[0]).not.toHaveProperty("thinkingBudgetTokens");
    expect(JSON.stringify(provider.messages[0])).toContain(secret);
    expect(JSON.stringify(provider.messages[0])).toContain("ordinary user text");
    expect(execute).toHaveBeenCalledWith({ path: "src" }, expect.anything());
    expect(result).toMatchObject({
      text: "answer",
      toolCalls: [{ name: "list_directory", input: { path: "src" }, result: "src" }],
    });
  });

  it.each([
    { speed: undefined, effort: "medium" },
    { speed: "instant" as const, effort: "none" },
    { speed: "high" as const, effort: "high" },
  ])("asks a plan-usage turn for the chosen speed's effort ($speed), never the API-key budget", async ({ speed, effort }) => {
    const provider = new SubscriptionRecordingPromptProvider([
      [{ type: "text_delta", text: "ok" }, { type: "message_complete", stopReason: "end_turn" }],
    ], "chatgpt-plan");
    const settings = {
      ...fakeLlmSettings(),
      activeChatRuntime: { kind: "subscription" as const, provider: "chatgpt-plan" as const, model: "gpt-6.1-sol" },
      ...(speed === undefined ? {} : { subscriptionReasoningSpeed: speed }),
    };
    settings.vendors.openai.enableThinking = false;
    settings.vendors.openai.thinkingBudgetTokens = 32_000;
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: { get: () => settings, getSecret: () => "test-key" },
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("hello", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.params[0]).toMatchObject({ enableThinking: true, reasoningEffort: effort });
    expect(provider.params[0]).not.toHaveProperty("thinkingBudgetTokens");
  });

  it("persists persona prompt identity on the user message for retry replay", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider(endTurnScript("ok"));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      systemPromptBuilder: {
        build: () => "system",
        setActiveRolePrompt: vi.fn(),
      },
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("review this", undefined, undefined, {
      ...userKeyboardTurn(),
      rolePrompt: { id: "reviewer", name: "Reviewer", systemPromptAdd: "Review carefully.",
        origin: { kind: "agent-plugin", package: "writer-plugin", version: "1.0.0" },
      },
    });

    const [firstMessage] = withoutRuntimeMeta(loop.getHistory().getMessages());
    expect(firstMessage).toEqual({
      role: "user",
      content: "review this",
      meta: {
        activePersonaPrompt: {
          id: "reviewer",
          name: "Reviewer",
          origin: { kind: "agent-plugin", package: "writer-plugin", version: "1.0.0" },
        },
      },
    });
  });

  it("keeps the read-skill registry across user-turn boundaries", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider(endTurnScript("ok"));
    const clear = vi.fn();
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      systemPromptBuilder: {
        build: () => "system",
        setToolScope: vi.fn(),
        setActiveSessionId: vi.fn(),
      },
      toolRegistry,
      skillOverlay: { clear },
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("질문", undefined, undefined, { ...userKeyboardTurn(),
    });

    // Loaded skill bodies remain in history, so their read registry must survive turn boundaries.
    expect(clear).not.toHaveBeenCalled();
  });

  it("delivers a read skill body as a tool result that stays in history, never in the system prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-skill-turn-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "brief.md"),
        "---\nname: brief\ndescription: Brief writer\n---\nBRIEF SKILL BODY",
        "utf8",
      );
      const toolRegistry = new ToolRegistry();
      const overlay = new SkillOverlay();
      toolRegistry.register(createSkillLoadTool({
        store: new SkillStore({ userDir: dir }),
        overlay,
        approvals: {
          isApproved: async () => true,
          approve: async () => undefined,
        } as never,
        approvalGate: undefined as never,
        emit: () => undefined,
      }),
      );
      const provider = new RecordingPromptProvider([
        [
          { type: "tool_call", id: "tu-1", name: "skill_load", input: { skillName: "brief" },
          },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
        [
          { type: "text_delta", text: "next" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = new ConversationLoop(makeBasicConversationLoopDeps({
        systemPromptBuilder: {
          build: () => "system",
          setToolScope: vi.fn(),
          setActiveSessionId: vi.fn(),
        },
        toolRegistry,
        skillOverlay: overlay,
        disableSessionPersistence: true,
      }));
      (loop as { provider: LLMProvider | null }).provider = provider;

      await loop.runTurn("brief me", undefined, undefined, { ...userKeyboardTurn(),
      });
      await loop.runTurn("new topic", undefined, undefined, { ...userKeyboardTurn(),
      });

      for (const systemPrompt of provider.systemPrompts) {
        expect(systemPrompt).not.toContain("BRIEF SKILL BODY");
      }
      expect(JSON.stringify(provider.messages[0])).not.toContain("BRIEF SKILL BODY");
      expect(JSON.stringify(provider.messages[1])).toContain("BRIEF SKILL BODY");
      expect(JSON.stringify(provider.messages[2])).toContain("BRIEF SKILL BODY");
      const history = loop.getHistory().getMessages();
      const toolResult = history.find((m) => m.role === "tool_result");
      expect(toolResult).toMatchObject({ role: "tool_result", toolName: "skill_load" });
      expect(JSON.stringify(toolResult)).toContain("BRIEF SKILL BODY");
      expect(history.filter((m) => m.role === "user").map((m) => JSON.stringify(m)).join("")).not.toContain(
        "BRIEF SKILL BODY",
      );
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("records a child turn's skill read under the sessionIdOverride", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-skill-child-turn-"));
    try {
      writeFileSync(
        join(dir, "brief.md"),
        "---\nname: brief\ndescription: Brief current turn\n---\nCHILD BODY ONLY",
        "utf-8",
      );
      const overlay = new SkillOverlay();
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createSkillLoadTool({
        store: new SkillStore({ userDir: dir }),
        overlay,
        approvals: {
          isApproved: async () => true,
          approve: async () => undefined,
        } as never,
        approvalGate: undefined as never,
        emit: () => undefined,
      }),
      );
      const provider = new RecordingPromptProvider([
        [
          { type: "tool_call", id: "tu-1", name: "skill_load", input: { skillName: "brief" },
          },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "child done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = new ConversationLoop(makeBasicConversationLoopDeps({
        systemPromptBuilder: {
          build: () => "system",
          setToolScope: vi.fn(),
          setActiveSessionId: vi.fn(),
        },
        toolRegistry,
        skillOverlay: overlay,
        disableSessionPersistence: true,
      }));
      (loop as { provider: LLMProvider | null }).provider = provider;

      await loop.runTurn("brief child", undefined, undefined, {
        inputOrigin: "llm-tool-arg",
        sessionIdOverride: "child-1",
      });

      expect(overlay.list("child-1").map((entry) => entry.name)).toEqual(["brief"]);
      expect(overlay.list(loop.getSessionId())).toEqual([]);
      expect(provider.systemPrompts.join("")).not.toContain("CHILD BODY ONLY");
      expect(JSON.stringify(provider.messages[1])).toContain("CHILD BODY ONLY");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  describe("typed /<skill-name> invocation", () => {
    function makeSlashLoop(isSkillName?: (name: string) => boolean) {
      const provider = new RecordingPromptProvider(endTurnScript("model answered"));
      const loop = new ConversationLoop(makeBasicConversationLoopDeps({
        systemPromptBuilder: { build: () => "system", setToolScope: vi.fn(), setActiveSessionId: vi.fn() },
        ...(isSkillName ? { isSkillName } : {}),
        disableSessionPersistence: true,
      }));
      (loop as { provider: LLMProvider | null }).provider = provider;
      return { loop, provider };
    }

    it("sends a non-built-in /<skill> to the model with the text as typed", async () => {
      const { loop, provider } = makeSlashLoop((name) => name === "email-polish");
      const result = await loop.runTurn("/email-polish tighten this", undefined, undefined, {
        ...userKeyboardTurn(),
      });
      expect(result.route).toBe("llm");
      expect(result.text).toBe("model answered");
      expect(JSON.stringify(provider.messages[0])).toContain("/email-polish tighten this");
    });

    it("keeps an unknown /<name> on the command route", async () => {
      const { loop, provider } = makeSlashLoop((name) => name === "email-polish");
      const result = await loop.runTurn("/not-a-skill", undefined, undefined, { ...userKeyboardTurn() });
      expect(result.route).toBe("command");
      expect(provider.messages).toHaveLength(0);
    });

    it("lets a built-in command win over a skill of the same name", async () => {
      const { loop, provider } = makeSlashLoop(() => true);
      const result = await loop.runTurn("/help", undefined, undefined, { ...userKeyboardTurn() });
      expect(result.route).toBe("command");
      expect(provider.messages).toHaveLength(0);
    });

    describe("next to a custom command file of the same name", () => {
      const COMMAND_BODY = "COMMAND FILE BODY for $ARGUMENTS";
      const originalHome = process.env.AVE_HOME;
      let dir = "";

      function makeProjectSlashLoop(isSkillName: (name: string) => boolean) {
        dir = mkdtempSync(join(tmpdir(), "ave-slash-skill-vs-command-"));
        process.env.AVE_HOME = join(dir, "home");
        const project = join(dir, "project");
        const commands = join(project, ".ave", "commands");
        mkdirSync(commands, { recursive: true });
        writeFileSync(join(commands, "email-polish.md"), COMMAND_BODY);
        const made = makeSlashLoop(isSkillName);
        made.loop.initializeConversation("main", { projectRoot: project, projectName: "project" });
        return made;
      }

      function userDisplayText(loop: ConversationLoop): unknown {
        return loop.history.getMessages().find((message) => message.role === "user")?.meta?.displayText;
      }

      afterEach(async () => {
        if (originalHome === undefined) delete process.env.AVE_HOME;
        else process.env.AVE_HOME = originalHome;
        if (dir) await cleanupTmpDir(dir);
        dir = "";
      });

      it("runs the keyboard-typed command file, not the skill", async () => {
        const { loop, provider } = makeProjectSlashLoop((name) => name === "email-polish");
        const result = await loop.runTurn("/email-polish tighten this", undefined, undefined, {
          ...userKeyboardTurn(),
        });
        expect(result.route).toBe("llm");
        const sent = JSON.stringify(provider.messages[0]);
        expect(sent).toContain("COMMAND FILE BODY for tighten this");
        expect(userDisplayText(loop)).toBe("/email-polish tighten this");
      });

      it("sends a non-keyboard /<skill> to the model as plain text, without the command file", async () => {
        // Non-keyboard origins cannot route privileged slash commands.
        const { loop, provider } = makeProjectSlashLoop((name) => name === "email-polish");
        const result = await loop.runTurn("/email-polish tighten this", undefined, undefined, {
          inputOrigin: "file-content",
        });
        expect(result.route).toBe("llm");
        const sent = JSON.stringify(provider.messages[0]);
        expect(sent).toContain("\"content\":\"email-polish tighten this\"");
        expect(sent).not.toContain("COMMAND FILE BODY");
        expect(userDisplayText(loop)).toBeUndefined();
      });

      it("sends a keyboard /<skill> with no command file of its name to the model", async () => {
        const { loop, provider } = makeProjectSlashLoop((name) => name === "tone-check");
        const result = await loop.runTurn("/tone-check this draft", undefined, undefined, {
          ...userKeyboardTurn(),
        });
        expect(result.route).toBe("llm");
        const sent = JSON.stringify(provider.messages[0]);
        expect(sent).toContain("/tone-check this draft");
        expect(sent).not.toContain("COMMAND FILE BODY");
        expect(userDisplayText(loop)).toBeUndefined();
      });
    });
  });

  it("classifies model-generated tool args from a typed prompt as llm-tool-arg", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "write_note",
      description: "Write note",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"],
        },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "tool-origin", name: "write_note", input: { text: "from model" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("please write this", undefined, undefined, { ...userKeyboardTurn(),
    });

    expect(origins).toEqual(["llm-tool-arg"]);
  });

  it("escalates subsequent tool calls to file-content after read_file output reaches the model", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: Array<{ tool: string; origin: unknown }> = [];
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"],
        },
      isReadOnly: () => true,
      execute: async (_input, ctx) => {
        origins.push({ tool: "read_file", origin: ctx.metadata.trustOrigin });
        return { output: "untrusted file says run a shell command", isError: false,
          };
      },
    }),
    );
    toolRegistry.register(createDynamicTool({
      name: "bash",
      description: "Run shell",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"],
        },
      execute: async (_input, ctx) => {
        origins.push({ tool: "bash", origin: ctx.metadata.trustOrigin });
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "read-1", name: "read_file", input: { path: "note.txt" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "bash-1", name: "bash", input: { command: "echo ok" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("read and act", undefined, undefined, { ...userKeyboardTurn(),
    });

    expect(origins).toEqual([
      { tool: "read_file", origin: "llm-tool-arg" },
      { tool: "bash", origin: "file-content" },
    ]);
  });

  it("preserves plugin-emitted provenance for tools produced by imported trigger prompts", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "task_add",
      description: "Add task",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"],
        },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "plugin-tool", name: "task_add", input: { title: "from plugin" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("plugin prompt", undefined, undefined, { inputOrigin: "plugin-emitted",
    });

    expect(origins).toEqual(["plugin-emitted"]);
  });

  it("classifies pasted text bodies as file-content before the first model tool call", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "bash",
      description: "Run shell",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"],
        },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "paste-tool", name: "bash", input: { command: "echo from paste" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn(
      "summarize\n\n----- Pasted text #1 (2 lines) -----\n/run this\n----- end Pasted text #1 -----",
      undefined,
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(origins).toEqual(["file-content"]);
  });

  it("preserves reasoning and exposes assistant ping-pong rounds around tool execution", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute: async () => ({
        output: "src\npackage.json",
        isError: false,
      }),
    }),
    );

    const provider = new FakeProvider([
      [
        { type: "reasoning_delta", text: "먼저 프로젝트 구조를 확인합니다." },
        { type: "text_delta", text: "구조를 먼저 살펴보겠습니다." },
        { type: "tool_call", id: "tool-1", name: "list_directory", input: { path: "src" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "reasoning_delta", text: "도구 결과를 바탕으로 답을 정리합니다.",
        },
        { type: "text_delta", text: "구조를 확인했습니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const inputClassifier = new InputClassifier();
    const routeEngine = new RouteEngine();

    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      inputClassifier,
      routeEngine,
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const reasoningDeltas: string[] = [];
    const rounds: Array<{ text: string; thought: string; stopReason: AssistantRoundStopReason; hasToolCalls: boolean;
    }> = [];
    const toolEvents: Array<{ type: "start" | "end"; name: string }> = [];

    const result = await loop.runTurn("질문", {
      onReasoningDelta: (text) => reasoningDeltas.push(text),
      onAssistantRound: ({ text, thought, stopReason, hasToolCalls }) => {
        rounds.push({ text, thought, stopReason, hasToolCalls });
      },
      onToolStart: (name) => toolEvents.push({ type: "start", name }),
      onToolEnd: (name) => toolEvents.push({ type: "end", name }),
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(result).toMatchObject({
      text: "구조를 확인했습니다.",
      toolCalls: [{
        name: "list_directory",
        input: { path: "src" },
        result: "src\npackage.json",
      },
      ],
    });
    expect(reasoningDeltas).toEqual([
      "먼저 프로젝트 구조를 확인합니다.",
      "도구 결과를 바탕으로 답을 정리합니다.",
    ]);
    expect(rounds).toEqual([
      {
        text: "구조를 먼저 살펴보겠습니다.",
        thought: "먼저 프로젝트 구조를 확인합니다.",
        stopReason: "tool_use",
        hasToolCalls: true,
      },
      {
        text: "구조를 확인했습니다.",
        thought: "도구 결과를 바탕으로 답을 정리합니다.",
        stopReason: "end_turn",
        hasToolCalls: false,
      },
    ]);
    expect(toolEvents).toEqual([
      { type: "start", name: "list_directory" },
      { type: "end", name: "list_directory" },
    ]);
    expect(withoutRuntimeMeta(loop.getHistory().getMessages())).toEqual([
      { role: "user", content: "질문" },
      {
        role: "assistant",
        content: "구조를 먼저 살펴보겠습니다.",
        thought: "먼저 프로젝트 구조를 확인합니다.",
        // Persist tool ownership so transcript attribution survives registry loss.
        toolCalls: [
          {
            id: "tool-1",
            name: "list_directory",
            input: { path: "src" },
            source: "builtin",
            category: "read",
          },
        ],
      },
      {
        role: "tool_result",
        toolUseId: "tool-1",
        toolName: "list_directory",
        content: "src\npackage.json",
      },
      {
        role: "assistant",
        content: "구조를 확인했습니다.",
        thought: "도구 결과를 바탕으로 답을 정리합니다.",
      },
    ]);
  });

  // Cap persisted tool calls with execution; every persisted call must have a matching result.
  it("R2-CR-1: per-round fan-out cap persists only the capped slice (5) so tool_use/tool_result counts match", async () => {
    expect(MAX_AGENT_SPAWNS_PER_ROUND).toBe(5);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }),
    );

    const fifteenToolCalls = Array.from({ length: 15 }).map((_, i) => ({
      type: "tool_call" as const,
      id: `tu-${i}`,
      name: "noop",
      input: {},
    }));
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "calling many" },
        ...fifteenToolCalls,
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const inputClassifier = new InputClassifier();
    const routeEngine = new RouteEngine();
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      inputClassifier,
      routeEngine,
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("call many tools", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const messages = loop.getHistory().getMessages();
    const assistantWithTools = messages.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.toolCalls).toHaveLength(
      MAX_AGENT_SPAWNS_PER_ROUND,
    );

    const toolResults = messages.filter((m) => m.role === "tool_result");
    expect(toolResults).toHaveLength(MAX_AGENT_SPAWNS_PER_ROUND);

    const persistedIds = assistantWithTools!.toolCalls.map((tc) => tc.id);
    expect(persistedIds).toEqual(
      Array.from({ length: MAX_AGENT_SPAWNS_PER_ROUND }).map(
        (_, i) => `tu-${i}`,
      ),
    );
    const resultIds = toolResults.map(
      (m) => (m as { toolUseId: string }).toolUseId,
    );
    expect(resultIds.sort()).toEqual(persistedIds.slice().sort());
  });

  it("answers a call whose arguments never parsed with an error and keeps executing the rest", async () => {
    const executed: string[] = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput: unknown) => {
        executed.push(JSON.stringify(rawInput));
        return { output: "ok", isError: false };
      },
    }),
    );

    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "calling two" },
        { type: "tool_call", id: "tu-good", name: "noop", input: { a: 1 } },
        {
          type: "tool_call",
          id: "tu-broken",
          name: "noop",
          input: {},
          invalidInput: {
            raw: '{"command":"echo hel',
            reason: "unparsable-json",
            rawChars: 20,
          },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "call two tools",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(executed).toEqual(['{"a":1}']);
    // Malformed argument text must not replay and invalidate the next provider request.
    expect(result.text).toBe("done");

    const messages = loop.getHistory().getMessages();
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string; input: unknown }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    for (const tc of assistantWithTools!.toolCalls) {
      expect(typeof tc.input).toBe("object");
    }

    const toolResults = messages.filter((m) => m.role === "tool_result") as Array<{
      toolUseId: string; content: string; isError?: boolean;
    }>;
    expect(toolResults.map((m) => m.toolUseId).sort()).toEqual(["tu-broken", "tu-good"]);
    const broken = toolResults.find((m) => m.toolUseId === "tu-broken")!;
    expect(broken.isError).toBe(true);
    expect(broken.content).toBe(
      t("be_conversationLoop.toolCallInvalidArguments", { excerpt: '{"command":"echo hel' }),
    );

    const invalidDecisions = decisions.filter((d) => d.kind === "tool_call.invalid_arguments");
    expect(invalidDecisions).toHaveLength(1);
    expect(invalidDecisions[0]!.branch).toBe("unparsable-json");
    expect(invalidDecisions[0]!.data?.tool).toBe("noop");
    expect(invalidDecisions[0]!.data?.rawChars).toBe(20);
  });

  it("contains truncated arguments end to end, from the raw provider part to the tool_result", async () => {
    // Start at raw stream parts to cover the adapter, collector, and loop together.
    const truncated = '{"command":"echo hel';
    const rounds: Array<Array<Record<string, unknown> & { type: string }>> = [
      [
        { type: "start" },
        { type: "tool-call", toolCallId: "tu-good", toolName: "noop", input: '{"a":1}' },
        { type: "tool-call", toolCallId: "tu-broken", toolName: "noop", input: truncated },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        { type: "start" },
        { type: "text-delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop" },
      ],
    ];

    class AdapterBackedProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      private index = 0;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        const parts = rounds[this.index++] ?? [];
        async function* raw() {
          for (const part of parts) yield part;
        }
        yield* fullStreamToStreamEvent(raw(), this.vendor);
      }
    }

    const executed: string[] = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput: unknown) => {
        executed.push(JSON.stringify(rawInput));
        return { output: "ok", isError: false };
      },
    }),
    );
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = new AdapterBackedProvider();

    const result = await loop.runTurn("call two tools", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(executed).toEqual(['{"a":1}']);
    expect(result.text).toBe("done");

    const messages = loop.getHistory().getMessages();
    const toolResults = messages.filter((m) => m.role === "tool_result") as Array<{
      toolUseId: string; content: string; isError?: boolean;
    }>;
    expect(toolResults.map((m) => m.toolUseId).sort()).toEqual(["tu-broken", "tu-good"]);
    const broken = toolResults.find((m) => m.toolUseId === "tu-broken")!;
    expect(broken.isError).toBe(true);
    expect(broken.content).toBe(
      t("be_conversationLoop.toolCallInvalidArguments", { excerpt: truncated }),
    );

    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string; input: unknown }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    for (const tc of assistantWithTools!.toolCalls) {
      expect(typeof tc.input).toBe("object");
    }
    expect(JSON.stringify(assistantWithTools!.toolCalls)).not.toContain(truncated);
  });

  it.each(["long_tool", "web_fetch"])("lets the model recover a %s result through the builtin chunk tool", async (toolName) => {
    const toolRegistry = new ToolRegistry();
    const body = Array.from(
      { length: toolName === "web_fetch" ? 1_000 : 160 },
      (_, i) => `row-${i.toString().padStart(3, "0")}: ${"x".repeat(20)}`,
    ).join("\n");
    const url = "https://93.184.216.34/document";
    const input = toolName === "web_fetch" ? { url } : {};
    const offset = toolName === "web_fetch" ? 6_000 : 0;
    const longContent = toolName === "web_fetch"
      ? JSON.stringify({ url, status: 200, contentType: "text/plain", format: "text", content: fenceWebContent(body) })
      : body;
    toolRegistry.register(
      toolName === "web_fetch" ? createWebFetchTool(vi.fn(async () => new Response(body)) as unknown as typeof fetch) : createDynamicTool({
        name: "long_tool",
        description: "returns a long result",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: longContent, isError: false }),
      }),
    );
    toolRegistry.register(createReadToolResultChunkTool());

    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "long-1", name: toolName, input },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call",
          id: "chunk-1",
          name: "read_tool_result_chunk",
          input: { toolUseId: "long-1", offset, maxChars: 500 },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("call long tool then read chunk", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const messages = loop.getHistory().getMessages();
    const longResult = messages.find(
      (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
        m.role === "tool_result" && m.toolUseId === "long-1",
    );
    expect(longResult?.meta?.truncated).toBeDefined();
    expect(longResult?.content).toBe(longContent);

    const chunkResult = messages.find(
      (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
        m.role === "tool_result" && m.toolUseId === "chunk-1",
    );
    expect(chunkResult?.isError).toBeUndefined();
    const parsed = JSON.parse(chunkResult!.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      toolUseId: "long-1",
      toolName,
      offset,
      startOffset: offset,
      endOffset: offset + 500,
      nextOffset: offset + 500,
      hasMore: true,
      chunk: longContent.slice(offset, offset + 500),
    });
  });

  it("reads host-truncated tool_result chunks from file-backed artifacts after session reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-loop-artifact-"));
    try {
      const sessionId = "fbff82d3-2ddc-4460-880d-961ce6e00e6a";
      const memoryManager = new MemoryManager({ aveDir: dir });
      const longContent = `[tool_result truncated by host but this is original output]\n` + Array.from(
        { length: 160 },
        (_, i) => `row-${i.toString().padStart(3, "0")}: ${"x".repeat(20)}`,
      ).join("\n");
      await memoryManager.saveSession(sessionId, [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "long-1", name: "long_tool", input: {} }],
        },
        {
          role: "tool_result",
          toolUseId: "long-1",
          toolName: "long_tool",
          content: longContent,
          meta: {
            truncated: {
              originalLines: 160,
              originalTokens: 1200,
              originalBytes: longContent.length,
              trimmedAt: "2026-05-19T00:00:00.000Z",
            },
          },
        },
      ] as GenericMessage[]);

      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createReadToolResultChunkTool());
      const provider = new FakeProvider([
        [
          {
            type: "tool_call",
            id: "chunk-1",
            name: "read_tool_result_chunk",
            input: { toolUseId: "long-1", offset: 0, maxChars: 500 },
          },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = new ConversationLoop(makeBasicConversationLoopDeps({
        toolRegistry,
        memoryManager,
      }));
      (loop as { provider: LLMProvider | null }).provider = provider;

      expect(await loop.loadSession(sessionId)).toBe(true);
      const persistedUnknown = memoryManager.loadSession(sessionId);
      expect(persistedUnknown).not.toBeNull();
      const persisted = persistedUnknown as GenericMessage[];
      const persistedResult = persisted[1];
      expect(persistedResult?.role).toBe("tool_result");
      if (persistedResult?.role !== "tool_result") {
        throw new Error("Expected the controlled fixture to persist a tool result");
      }
      expect(persistedResult.meta?.serializedStub).toBe(true);
      loop.getHistory().clear();
      for (const message of persisted) loop.getHistory().append(message);
      const reloaded = loop
        .getHistory()
        .getMessages()
        .find(
          (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
            m.role === "tool_result" && m.toolUseId === "long-1",
        );
      expect(reloaded?.content).toContain("[tool_result truncated by host");
      expect(reloaded?.meta?.serializedStub).toBe(true);
      const recovered = loop.readToolResultForChunk("long-1");
      expect(recovered?.content).toBe(longContent);
      expect(recovered?.meta?.serializedStub).toBeUndefined();

      await loop.runTurn("read chunk", undefined, undefined, {
        ...userKeyboardTurn(),
      });

      const chunkResult = loop
        .getHistory()
        .getMessages()
        .find(
          (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
            m.role === "tool_result" && m.toolUseId === "chunk-1",
        );
      expect(chunkResult?.isError).toBeUndefined();
      const parsed = JSON.parse(chunkResult!.content) as Record<
        string,
        unknown
      >;
      expect(parsed).toMatchObject({
        toolUseId: "long-1",
        toolName: "long_tool",
        offset: 0,
        startOffset: 0,
        endOffset: 500,
        nextOffset: 500,
        hasMore: true,
        chunk: longContent.slice(0, 500),
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  // Supported runtimes continue length-truncated answers with a wire-only assistant prefill.

  it("continues a max_tokens round and returns the stitched assistant text (openai-compatible)", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn(
      "write a long answer",
      undefined,
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("Part one and part two.");
    const assistants = loop
      .getHistory()
      .getMessages()
      .filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as { content: string }).content).toBe(
      "Part one and part two.",
    );
    const round2 = provider.messages[1];
    expect(round2.at(-1)).toEqual({ role: "assistant", content: "Part one " });
  });

  it.each(["codex", "kimi-code", "grok-build", "claude-code"] as const)(
    "does not stitch a %s subscription max_tokens response without a native prefill protocol",
    async (subscriptionProvider) => {
      const toolRegistry = new ToolRegistry();
      const provider = new SubscriptionRecordingPromptProvider([
        [
          { type: "text_delta", text: "Subscription part one " },
          { type: "message_complete", stopReason: "max_tokens" },
        ],
        [
          { type: "text_delta", text: "and two." },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ], subscriptionProvider);
      const loop = new ConversationLoop(makeBasicConversationLoopDeps({
        settingsService: {
          // Subscription runtimes must not inherit prefill support from stale API-key settings.
          get: () => ({
            ...fakeLlmSettings({ provider: "openai-compatible" }),
            activeChatRuntime: { kind: "subscription", provider: subscriptionProvider },
          }),
          getSecret: () => "test-key",
        },
        toolRegistry,
      }));
      (loop as { provider: LLMProvider | null }).provider = provider;

      const result = await loop.runTurn(
        "write a long answer",
        undefined,
        undefined,
        { ...userKeyboardTurn() },
      );

      expect(result).toMatchObject({
        stopReason: "max_tokens",
        text: "Subscription part one",
      });
      expect(provider.params).toHaveLength(1);
      expect(provider.params[0]?.model).toBe("default");
      expect(provider.params[0]?.continuationPrefill).toBeUndefined();
    },
  );

  it("fires onAssistantRound exactly once (terminal) across a 2-round continued turn", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const rounds: Array<{ text: string; stopReason: string }> = [];
    await loop.runTurn(
      "write a long answer",
      {
        onAssistantRound: ({ text, stopReason }) =>
          rounds.push({ text, stopReason }),
      },
      undefined,
      { ...userKeyboardTurn() },
    );

    // Continuations keep the UI round open until the merged answer is terminal.
    expect(rounds).toEqual([
      { text: "Part one and part two.", stopReason: "end_turn" },
    ]);
  });

  it("caps runaway max_tokens continuations instead of looping forever", async () => {
    const toolRegistry = new ToolRegistry();
    let calls = 0;
    class InfiniteLengthProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text_delta", text: `chunk-${calls} ` };
        yield { type: "message_complete", stopReason: "max_tokens" };
      }
    }
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider =
      new InfiniteLengthProvider();

    const result = await loop.runTurn("runaway", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(calls).toBe(4);
    expect(result.stopReason).toBe("max_tokens");
    // Preserve whitespace between chunks; trim only the final merged answer.
    expect(result.text).toBe("chunk-1 chunk-2 chunk-3 chunk-4");
  });

  it("does NOT continue a max_tokens round for a non-openai-compatible vendor", async () => {
    const toolRegistry = new ToolRegistry();
    let calls = 0;
    class CountingProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text_delta", text: "cut off" };
        yield { type: "message_complete", stopReason: "max_tokens" };
      }
    }
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai" }),
        getSecret: () => "test-key",
      },
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider =
      new CountingProvider();

    const result = await loop.runTurn("x", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("max_tokens");
    expect(result.text).toBe("cut off");
  });

  it("continues truncation INSIDE <think> without losing or duplicating reasoning", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new RecordingPromptProvider([
      [
        { type: "reasoning_delta", text: "step1 " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "reasoning_delta", text: "step2" },
        { type: "text_delta", text: "the answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      toolRegistry,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn(
      "reason then answer",
      undefined,
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(result.text).toBe("the answer");
    expect(provider.messages[1].at(-1)).toEqual({
      role: "assistant",
      content: "<think>\nstep1 ",
    });
    const assistant = loop
      .getHistory()
      .getMessages()
      .find((m) => m.role === "assistant") as {
      content: string;
      thought?: string;
    };
    expect(assistant.content).toBe("the answer");
    expect(assistant.thought).toBe("step1 step2");
  });

  // Server resource text reaches the model; transcript display retains only the user-authored marker.
  it("keeps an attached resource's body out of the user's transcript bubble", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider(endTurnScript("ok"));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const fence = [
      `${MCP_RESOURCE_FENCE_OPEN} server="hr-mcp" uri="file:///policy.md">`,
      "SERVER BODY THE USER DID NOT WRITE",
      "</mcp-resource>",
    ].join("\n");
    await loop.runTurn("summarize [Resource #1]", undefined, undefined, {
      ...userKeyboardTurn(),
      attachments: [{ type: "text", text: fence }],
    });

    const [firstMessage] = withoutRuntimeMeta(loop.getHistory().getMessages());
    expect(firstMessage.content).toEqual([
      { type: "text", text: "summarize [Resource #1]" },
      { type: "text", text: fence },
    ]);
    const meta = (firstMessage as { meta?: { displayText?: string } }).meta;
    expect(meta?.displayText).toBe("summarize [Resource #1]");
    expect(meta?.displayText).not.toContain("SERVER BODY");
  });

  it("adds no displayText to a turn with no resource attachment", async () => {
    // Ordinary turns must not acquire a duplicate displayText copy that could drift.
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider(endTurnScript("ok"));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
      toolRegistry,
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("plain question", undefined, undefined, {
      ...userKeyboardTurn(),
      attachments: [{ type: "image", image: "data:image/png;base64,xx", mimeType: "image/png" }],
    });

    const [firstMessage] = withoutRuntimeMeta(loop.getHistory().getMessages());
    expect((firstMessage as { meta?: { displayText?: string } }).meta?.displayText)
      .toBeUndefined();
  });
});

describe("reasoning-only round is not a finished turn", () => {
  function createLoop(provider: LLMProvider): ConversationLoop {
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      disableSessionPersistence: true,
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;
    return loop;
  }

  const REASONING = "I need to retry the installation.";

  function reasoningOnlyRound(thought: string): StreamEvent[] {
    return [
      { type: "reasoning_delta", text: thought },
      { type: "message_complete", stopReason: "end_turn" },
    ];
  }

  it("re-prompts a round that ended with reasoning but no text and no tool call", async () => {
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(REASONING),
      [
        { type: "text_delta", text: "Reinstalled and verified." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "install it",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(provider.messages).toHaveLength(2);
    expect(result.text).toBe("Reinstalled and verified.");
    expect(decisions).toContainEqual({
      kind: "reasoning_only.continuation",
      branch: "continue",
      data: { nudgesRun: 0, cap: 2, thoughtChars: REASONING.length },
    });
  });

  it("replays the reasoning as an assistant turn so the wire keeps role alternation", async () => {
    // Replay reasoning as an assistant row so filtering empty rows cannot break role alternation.
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(REASONING),
      [
        { type: "text_delta", text: "Reinstalled." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);

    await loop.runTurn("install it", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const wire = genericToModelMessages(provider.messages[1]!, "openai");
    expect(wire.map((message) => message.role)).toEqual([
      "user", "assistant", "user",
    ]);
    for (const message of wire) {
      expect(JSON.stringify(message.content)).not.toBe("[]");
    }
    expect(JSON.stringify(wire[1]!.content)).toContain(REASONING);
    expect(JSON.stringify(wire[2]!.content))
      .toContain(t("be_conversationLoop.reasoningOnlyContinuePrompt"));
  });

  it("replays only the tail of a long reasoning block", async () => {
    // Replay the bounded reasoning tail to retain the next action without exhausting context.
    const head = "H".repeat(5_000);
    const tail = " and finally I will run the installer.";
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(head + tail),
      [
        { type: "text_delta", text: "Ran it." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);

    await loop.runTurn("install it", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const secondRound = provider.messages[1]!;
    const replay = secondRound[secondRound.length - 2]!;
    expect(replay.role).toBe("assistant");
    expect(replay.content).toContain(tail);
    expect(replay.content).not.toContain(head);
    expect(replay.content.length).toBe(2_000);
  });

  it("keeps the replay and the instruction on the wire only", async () => {
    const thought = "Let me verify the tokenizer.";
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(thought),
      [
        { type: "text_delta", text: "Verified." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);

    await loop.runTurn("check it", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const secondRound = provider.messages[1]!;
    const [replay, instruction] = secondRound.slice(-2);
    expect(replay!.role).toBe("assistant");
    expect(replay!.content).toBe(thought);
    expect(instruction!.role).toBe("user");

    // Replays and instructions are request-only; history keeps the committed reasoning shape.
    const persisted = loop.getHistory().getMessages();
    expect(JSON.stringify(persisted)).not.toContain(instruction!.content);
    expect(persisted.filter((message) =>
      message.role === "assistant" && message.content === thought)).toEqual([]);
    expect(persisted.filter((message) =>
      message.role === "assistant" && message.thought === thought))
      .toHaveLength(1);
  });

  it("lets queued guidance win the end-turn boundary without spending the cap", async () => {
    // Guidance takes precedence without spending the reasoning-only re-prompt budget.
    const firstThought = "First thought.";
    const secondThought = "Second thought.";
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(firstThought),
      reasoningOnlyRound(secondThought),
      [
        { type: "text_delta", text: "Done." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);
    const decisions: TurnDecisionEvent[] = [];
    // Stand in for guidance arriving through IPC while the controller marks a turn active.
    (loop as unknown as { currentAbortController: AbortController | null })
      .currentAbortController = new AbortController();
    loop.queueGuidance("use the other installer");

    await loop.runTurn(
      "install it",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { ...userKeyboardTurn() },
    );

    const secondRoundText = JSON.stringify(provider.messages[1]!);
    expect(secondRoundText).toContain("use the other installer");
    // Guidance still needs assistant replay to avoid adjacent user rows.
    const guidedWire = genericToModelMessages(provider.messages[1]!, "openai");
    expect(guidedWire.map((message) => message.role)).toEqual([
      "user", "assistant", "user",
    ]);
    for (const message of guidedWire) {
      expect(JSON.stringify(message.content)).not.toBe("[]");
    }
    expect(JSON.stringify(guidedWire[1]!.content)).toContain(firstThought);
    expect(secondRoundText)
      .not.toContain(t("be_conversationLoop.reasoningOnlyContinuePrompt"));
    expect(decisions.filter((event) =>
      event.kind === "reasoning_only.continuation")).toEqual([
      expect.objectContaining({
        branch: "continue",
        data: expect.objectContaining({
          nudgesRun: 0, thoughtChars: secondThought.length,
        }),
      }),
    ]);
    expect(JSON.stringify(provider.messages[2]!)).toContain(secondThought);
  });

  it("bounds the re-prompt so a model that only ever reasons still terminates", async () => {
    const thought = "still thinking";
    let calls = 0;
    class AlwaysReasoningProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "reasoning_delta", text: thought };
        yield { type: "message_complete", stopReason: "end_turn" };
      }
    }
    const loop = createLoop(new AlwaysReasoningProvider());
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "loop forever",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(calls).toBe(3);
    expect(result.stopReason).toBe("end_turn");
    expect(
      decisions.filter(
        (event) => event.kind === "reasoning_only.continuation"
          && event.branch === "continue",
      ),
    ).toHaveLength(2);
    expect(decisions).toContainEqual({
      kind: "reasoning_only.continuation",
      branch: "stop",
      reason: "cap",
      data: { nudgesRun: 2, cap: 2, thoughtChars: thought.length },
    });
  });

  it("ends a genuinely empty round on the first attempt", async () => {
    let calls = 0;
    class EmptyProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "message_complete", stopReason: "end_turn" };
      }
    }
    const loop = createLoop(new EmptyProvider());
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "nothing",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { ...userKeyboardTurn() },
    );

    // Without reasoning there is no intended next action to re-prompt toward.
    expect(calls).toBe(1);
    expect(result.text).toBe("");
    expect(
      decisions.filter((event) => event.kind === "reasoning_only.continuation"),
    ).toEqual([]);
  });
});

describe("ConversationLoop output ceiling", () => {
  it("forwards the active vendor's outputTokenLimit to every chat round", async () => {
    const provider = new RecordingPromptProvider(endTurnScript("done"));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ outputTokenLimit: 16_384 }),
        getSecret: () => "test-key",
      },
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("answer", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.params[0]?.outputTokenLimit).toBe(16_384);
  });

  it("sends a chat ceiling above the background bound unclamped", async () => {
    // Chat ceilings must not be clamped to the plugin background limit.
    const provider = new RecordingPromptProvider(endTurnScript("done"));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ outputTokenLimit: 32_768 }),
        getSecret: () => "test-key",
      },
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("answer", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.params[0]?.outputTokenLimit).toBe(32_768);
    expect(32_768).toBeGreaterThan(MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT);
  });

  it("supplies the default ceiling when an existing vendor block declares none", async () => {
    const settings = fakeLlmSettings();
    delete settings.vendors[settings.provider].outputTokenLimit;
    const provider = new RecordingPromptProvider(endTurnScript("done"));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: { get: () => settings, getSecret: () => "test-key" },
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("answer", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.params[0]?.outputTokenLimit).toBe(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT);
  });

  // Host and provider truncation share the same continuation path.
  it("continues a host-capped round through the same length-continuation path", async () => {
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible", outputTokenLimit: 128 }),
        getSecret: () => "test-key",
      },
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: Array<{ kind: string; branch: string }> = [];
    const result = await loop.runTurn(
      "write a long answer",
      { onDecision: (event) => { decisions.push({ kind: event.kind, branch: event.branch }); } },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(result.text).toBe("Part one and part two.");
    expect(decisions).toContainEqual({ kind: "length.continuation", branch: "continue" });
    expect(provider.params[1]?.outputTokenLimit).toBe(128);
  });
});

describe("ConversationLoop progress notification", () => {
  // Assert localized notification structure rather than English prose.
  const NUDGE_HEADER = t("be_conversationLoop.progressNudge", {
    round: 0, elapsedSeconds: 0, toolCalls: 0, toolErrors: 0,
  }).split("\n")[0];

  function settingsWithNudgeCadence(progressNudgeRounds: number) {
    return {
      get: (key: string) =>
        key === "chat"
          ? { ...DEFAULT_SETTINGS.chat, progressNudgeRounds }
          : fakeLlmSettings(),
      getSecret: () => "test-key",
    };
  }

  function loopingProvider() {
    const round = (id: string): StreamEvent[] => [
      { type: "tool_call", id, name: "probe", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ];
    return new RecordingPromptProvider([
      round("t1"),
      round("t2"),
      round("t3"),
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
  }

  function probeRegistry() {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "probe",
      description: "Probe",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));
    return toolRegistry;
  }

  it("injects a wire-only notification on the cadence and records the decision", async () => {
    const provider = loopingProvider();
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: settingsWithNudgeCadence(2),
      toolRegistry: probeRegistry(),
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: Array<{ kind: string; branch: string }> = [];
    await loop.runTurn(
      "keep working",
      { onDecision: (event) => { decisions.push({ kind: event.kind, branch: event.branch }); } },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(decisions).toContainEqual({ kind: "progress.nudge", branch: "cadence" });

    const lastOf = (index: number) => {
      const message = provider.messages[index]?.at(-1);
      return message && message.role === "user" ? String(message.content) : "";
    };
    expect(lastOf(2)).toContain(NUDGE_HEADER);
    expect(lastOf(0)).not.toContain(NUDGE_HEADER);
    expect(lastOf(1)).not.toContain(NUDGE_HEADER);

    const stored = loop.getHistory().getMessages()
      .map((message) => String((message as { content?: unknown }).content ?? ""));
    expect(stored.some((content) => content.includes(NUDGE_HEADER))).toBe(false);
  });

  it("counts assistant rounds, not loop iterations, and skips continuation rounds", async () => {
    // Notification cadence counts assistant rounds, excluding length continuations.
    const provider = new RecordingPromptProvider([
      [
        { type: "tool_call", id: "t1", name: "probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "tool_call", id: "t2", name: "probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: {
        get: (key: string) =>
          key === "chat"
            ? { ...DEFAULT_SETTINGS.chat, progressNudgeRounds: 2 }
            : fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      toolRegistry: probeRegistry(),
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: Array<{ kind: string; branch: string }> = [];
    await loop.runTurn(
      "keep working",
      { onDecision: (event) => { decisions.push({ kind: event.kind, branch: event.branch }); } },
      undefined,
      { ...userKeyboardTurn() },
    );

    const last = (index: number) => provider.messages[index]?.at(-1);
    const lastContent = (index: number) =>
      String((last(index) as { content?: unknown } | undefined)?.content ?? "");

    expect(last(2)?.role).toBe("assistant");
    expect(lastContent(2)).not.toContain(NUDGE_HEADER);
    expect(lastContent(3)).toContain(NUDGE_HEADER);
    expect(
      decisions.filter((decision) => decision.kind === "progress.nudge"),
    ).toEqual([{ kind: "progress.nudge", branch: "cadence" }]);
  });

  it("shares one user row with the reasoning re-prompt when both fire", async () => {
    // Merge simultaneous instructions into one user row to preserve role alternation.
    const thought = "I should check the tokenizer next.";
    const provider = new RecordingPromptProvider([
      [
        { type: "reasoning_delta", text: thought },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: settingsWithNudgeCadence(1),
      toolRegistry: probeRegistry(),
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: string[] = [];
    await loop.runTurn(
      "check it",
      { onDecision: (event) => { decisions.push(event.kind); } },
      undefined,
      { ...userKeyboardTurn() },
    );

    const secondRound = provider.messages[1]!;
    const trailingUserRows = [...secondRound]
      .reverse()
      .findIndex((message) => message.role !== "user");
    expect(trailingUserRows).toBe(1);
    const appended = secondRound.at(-1)!;
    expect(appended.role).toBe("user");
    // Assert instruction order, not an elapsed-seconds value controlled by scheduling.
    const rePrompt = t("be_conversationLoop.reasoningOnlyContinuePrompt");
    const appendedText = String(appended.content);
    expect(appendedText.startsWith(`${rePrompt}\n\n`)).toBe(true);
    expect(appendedText.slice(rePrompt.length + 2)).toContain(NUDGE_HEADER);
    expect(secondRound.at(-2)!.role).toBe("assistant");
    expect(secondRound.at(-2)!.content).toBe(thought);
    expect(decisions).toContain("progress.nudge");
    expect(decisions).toContain("reasoning_only.continuation");

    expect(JSON.stringify(loop.getHistory().getMessages()))
      .not.toContain(NUDGE_HEADER);
  });

  it("injects nothing when the cadence is 0", async () => {
    const provider = loopingProvider();
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      settingsService: settingsWithNudgeCadence(0),
      toolRegistry: probeRegistry(),
    }));
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: string[] = [];
    await loop.runTurn(
      "keep working",
      { onDecision: (event) => { decisions.push(event.kind); } },
      undefined,
      { ...userKeyboardTurn() },
    );

    expect(decisions).not.toContain("progress.nudge");
    const anyNudge = provider.messages.some((round) =>
      round.some((message) => String((message as { content?: unknown }).content ?? "")
        .includes(NUDGE_HEADER)));
    expect(anyNudge).toBe(false);
  });
});
