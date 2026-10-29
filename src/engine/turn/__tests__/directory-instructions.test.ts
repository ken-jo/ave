// Attach first-touch directory instructions once per session and revalidate changed launch chains.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { createDynamicTool } from "../../../tools/base.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../../llm/types.js";
import { MAX_TOOL_RESULT_LINES } from "../../../shared/tool-result-trim.js";
import { ConversationHistory } from "../../conversation-history.js";
import type { GenericMessage } from "../../llm/types.js";
import {
  DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES,
  directoryInstructionsForToolResult,
  liveDirectoryInstructions,
} from "../directory-instructions.js";
import { userKeyboardTurn } from "../../../__tests__/support/user-keyboard-turn.js";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ave-dir-instructions-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "AGENTS.md"), "src rule");
});

afterEach(async () => {
  await cleanupTmpDir(project);
});

function attach(attached: Map<string, number>, overrides: Partial<Parameters<typeof directoryInstructionsForToolResult>[0]> = {}) {
  return directoryInstructionsForToolResult({
    projectRoot: project,
    source: "builtin",
    toolInput: { path: join("src", "index.ts") },
    isError: false,
    toolResultContent: "tool output",
    stubbedOnWire: false,
    attached,
    ...overrides,
  });
}

function toolResultRow(result: NonNullable<ReturnType<typeof attach>>, meta: GenericMessage["meta"] = {}): GenericMessage {
  return {
    role: "tool_result",
    toolUseId: "call_1",
    toolName: "read_file",
    content: `tool output\n\n${result.text}`,
    meta: { ...meta, directoryInstructions: result.attached },
  };
}

describe("directoryInstructionsForToolResult", () => {
  it("frames the file as project-provided and attaches it only once", () => {
    const attached = new Map<string, number>();
    const result = attach(attached);
    expect(result?.text).toContain('trust="project-provided"');
    expect(result?.text).toContain("src rule");
    expect(result?.attached).toEqual([{ source: join("src", "AGENTS.md"), bytes: Buffer.byteLength(result!.text, "utf-8") }]);
    expect(attach(attached)).toBeUndefined();
  });

  it("attaches nothing for failed calls, non-builtin tools, inputs without a path, or stubbed results", () => {
    expect(attach(new Map(), { isError: true })).toBeUndefined();
    expect(attach(new Map(), { source: "mcp" })).toBeUndefined();
    expect(attach(new Map(), { toolInput: { command: "ls src" } })).toBeUndefined();
    expect(attach(new Map(), { projectRoot: undefined })).toBeUndefined();
    expect(attach(new Map(), { stubbedOnWire: true })).toBeUndefined();
  });
});

describe("directory instructions and compaction", () => {
  it("counts a file as attached only while a row carrying it reaches the provider", () => {
    const first = attach(new Map())!;
    const row = toolResultRow(first);
    expect(attach(liveDirectoryInstructions([row]))).toBeUndefined();

    const stubbed = toolResultRow(first, { compactedAt: new Date().toISOString() });
    expect(liveDirectoryInstructions([stubbed]).size).toBe(0);
    expect(attach(liveDirectoryInstructions([stubbed]))?.text).toContain("src rule");

    expect(attach(liveDirectoryInstructions([]))?.text).toContain("src rule");
  });
});

describe("directory instructions in the query loop", () => {
  function readTurn(id: string): StreamEvent[][] {
    return [
      [
        { type: "tool_call", id, name: "read_file", input: { path: join("src", "index.ts") } },
        { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 1 } },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } },
      ],
    ];
  }

  it("records the attachment on the row and re-attaches after compaction stubs it", async () => {
    const turns = [...readTurn("t-1"), ...readTurn("t-2"), ...readTurn("t-3")];
    let index = 0;
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn(): AsyncIterable<StreamEvent> {
        yield* turns[index++] ?? [];
      },
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }));
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: async () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    loop.sessionProjectRoot = project;
    const toolRows = () => loop.history.getMessages().filter((message) => message.role === "tool_result");

    await loop.runTurn("read it", undefined, undefined, { ...userKeyboardTurn() });
    await loop.runTurn("read it again", undefined, undefined, { ...userKeyboardTurn() });
    const [first, second] = toolRows();
    expect(first?.content).toContain("src rule");
    expect(first?.meta?.directoryInstructions?.map((entry) => entry.source)).toEqual([join("src", "AGENTS.md")]);
    expect(second?.content).not.toContain("src rule");

    const compacted = loop.history.getMessages().map((message) => message === first
      ? { ...message, meta: { ...message.meta, compactedAt: new Date().toISOString() } }
      : message);
    loop.history.clear();
    loop.history.restore(compacted);
    await loop.runTurn("and again", undefined, undefined, { ...userKeyboardTurn() });
    expect(toolRows().at(-1)?.content).toContain("src rule");

    loop.gitIgnoreVerdicts.set("repo\0path", true);
    await loop.newConversation();
    expect(loop.gitIgnoreVerdicts.size).toBe(0);
  });
});

describe("directory instruction budgets", () => {
  it("cuts a long file so the whole tool result stays under the per-result cap", () => {
    const lines = Array.from({ length: 150 }, (_, index) => `rule line ${index}`);
    writeFileSync(join(project, "src", "AGENTS.md"), lines.join("\n"));
    const result = attach(new Map())!;
    expect(result.text).toContain("rule line 0");
    expect(result.text).not.toContain("rule line 149");
    expect(result.text).toContain(join("src", "AGENTS.md"));
    const stored = new ConversationHistory().append(toolResultRow(result));
    expect(stored.meta.truncated).toBeUndefined();
  });

  it("waits for a later touch when the tool output already fills the result budget", () => {
    const attached = new Map<string, number>();
    const fullOutput = Array.from({ length: MAX_TOOL_RESULT_LINES }, (_, index) => `line ${index}`).join("\n");
    expect(attach(attached, { toolResultContent: fullOutput })).toBeUndefined();
    expect(attached.size).toBe(0);
    expect(attach(attached)?.text).toContain("src rule");
  });

  it("stops attaching once the live blocks reach the session cap", () => {
    const full = new Map([["other/AGENTS.md", DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES]]);
    expect(attach(full)).toBeUndefined();
    const almost = new Map([["other/AGENTS.md", DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES - 10]]);
    expect(attach(almost)).toBeUndefined();
    expect(attach(new Map())?.text).toContain("src rule");
  });
});

describe("project instruction cache", () => {
  it("notices a file created on the chain after the first read", () => {
    const aveDir = mkdtempSync(join(tmpdir(), "ave-dir-instructions-home-"));
    try {
      const memory = new MemoryManager({ aveDir });
      expect(memory.getProjectAgentsMd(project).layers).toHaveLength(0);
      writeFileSync(join(project, "CLAUDE.md"), "fallback rule");
      expect(memory.getProjectAgentsMd(project).layers[0]?.content).toContain("fallback rule");
      writeFileSync(join(project, "CLAUDE.md"), "edited rule");
      const later = new Date(Date.now() + 5_000);
      utimesSync(join(project, "CLAUDE.md"), later, later);
      expect(memory.getProjectAgentsMd(project).layers[0]?.content).toContain("edited rule");
    } finally {
      void cleanupTmpDir(aveDir);
    }
  });
});
