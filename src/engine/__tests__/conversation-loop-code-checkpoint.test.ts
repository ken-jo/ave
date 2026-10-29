import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { restoreCodeCheckpoint, withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import { ToolRegistry } from "../../tools/registry.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "../../tools/file-tools.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-turn-checkpoint-")));
  vi.stubEnv("AVE_HOME", join(root, "state"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("turn-owned code checkpoint integration", () => {
  it("makes the parent unavailable for child edits without retaining child turns", async () => {
    const file = join(root, "child.txt");
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());
    const memoryManager = new MemoryManager({ aveDir: join(root, "state") });
    const child = new ConversationLoop(makeConversationLoopDeps({
      memoryManager, toolRegistry: registry,
      getDefaultProject: () => ({ projectRoot: root, projectName: "checkpoint workspace" }),
    }));
    child.initializeConversation("subagent", { projectRoot: root, projectName: "checkpoint workspace" });
    let round = 0;
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        if (round++ === 0) {
          yield { type: "tool_call", id: "child-edit", name: "write_file", input: { path: file, content: "child" } };
          yield { type: "message_complete", stopReason: "tool_use" };
        } else yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    (child as unknown as { provider: LLMProvider }).provider = provider;
    const parentId = "parent";
    await withCodeCheckpoint({ sessionId: parentId, messageId: "spawn" }, () =>
      child.runTurn("Create the child file.", undefined, undefined, { ...userKeyboardTurn() }));
    expect(await readFile(file, "utf8")).toBe("child");
    expect(await restoreCodeCheckpoint(parentId, "spawn", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    const ledger = JSON.parse(await readFile(join(root, "state/code-checkpoints/turns.json"), "utf8"));
    expect(ledger.turns.map((turn: { sessionId: string }) => turn.sessionId)).toEqual([parentId]);
    await child.runTurn("Finish.", undefined, undefined, { ...userKeyboardTurn() });
    expect(JSON.parse(await readFile(join(root, "state/code-checkpoints/turns.json"), "utf8")).turns).toHaveLength(1);
  });

  it("binds native edits to durable user message identities through the real query and execution paths", async () => {
    const file = join(root, "source.txt");
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool()); registry.register(new WriteFileTool()); registry.register(new EditFileTool());
    const rounds: StreamEvent[][] = [
      [{ type: "tool_call", id: "create-call", name: "write_file", input: { path: file, content: "created\r\n" } }, { type: "message_complete", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "Created." }, { type: "message_complete", stopReason: "end_turn" }],
      [{ type: "tool_call", id: "read-call", name: "read_file", input: { path: file } }, { type: "message_complete", stopReason: "tool_use" }],
      [{ type: "tool_call", id: "edit-call", name: "edit_file", input: { path: file, oldText: "created", newText: "updated" } }, { type: "message_complete", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "Updated." }, { type: "message_complete", stopReason: "end_turn" }],
    ];
    let index = 0;
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() { yield* rounds[index++] ?? []; },
    };
    const memoryManager = new MemoryManager({ aveDir: join(root, "state") });
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager, toolRegistry: registry,
      getDefaultProject: () => ({ projectRoot: root, projectName: "checkpoint workspace" }),
    }));
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    await loop.runTurn("Create the source file.", undefined, undefined, { ...userKeyboardTurn() });
    const first = loop.getHistory().getMessages().find((message) => message.role === "user")!.meta!.messageId!;
    expect(await readFile(file, "utf8")).toBe("created\r\n");
    await loop.runTurn("Update the source file.", undefined, undefined, { ...userKeyboardTurn() });
    const second = loop.getHistory().getMessages().filter((message) => message.role === "user").at(-1)!.meta!.messageId!;
    expect(await readFile(file, "utf8")).toBe("updated\r\n");
    expect(await restoreCodeCheckpoint(loop.getSessionId(), second, { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("created\r\n");
    expect(await restoreCodeCheckpoint(loop.getSessionId(), first, { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((memoryManager.loadSession(loop.getSessionId()) as GenericMessage[] | null)?.filter((message) => message.role === "user").map((message) => message.meta?.messageId)).toEqual([first, second]);
  });
});
