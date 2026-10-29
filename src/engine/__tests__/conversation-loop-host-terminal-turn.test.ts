// The host-terminal turn capability is issued by the turn itself: only a turn the user typed, whose tool arguments are still the model's
// own, carries it into its tool calls, and it ends with the turn. A tool cannot mint it from metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { TOOL_SEARCH_TOOL_NAME, ToolRegistry } from "../../tools/registry.js";
import { formatAppMessageEnvelope } from "../../shared/mcp-app-message-source.js";
import { createDynamicTool } from "../../tools/base.js";
import { currentHostTerminalTurn, type HostTerminalTurn } from "../../tools/host-terminal-turn.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";
import { runWithToolExecutionCwd } from "../../tools/execution-context.js";
import { __resetTerminalBlocksForTest } from "../../main/terminal/terminal-blocks.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { createPaneHostTerminalLoop, type Asked } from "./support/pane-host-terminal-loop.js";

function oneToolRound(): ScriptedTurnProvider {
  return new ScriptedTurnProvider([
    [
      { type: "tool_call", id: "t1", name: "probe_turn", input: {} } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "text_delta", text: "done" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ],
  ]);
}

async function turnSeenByTool(inputOrigin: ChatInputOrigin, input = "run it in my terminal"): Promise<{
  loop: ConversationLoop; seen: Array<HostTerminalTurn | undefined>;
}> {
  const seen: Array<HostTerminalTurn | undefined> = [];
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "probe_turn",
    description: "records the host-terminal turn it runs inside",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async (_input, ctx) => {
      seen.push(currentHostTerminalTurn(typeof ctx?.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined));
      return { output: "ok", isError: false };
    },
  }));
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({ toolRegistry }));
  (loop as { provider: LLMProvider | null }).provider = oneToolRound();
  await loop.runTurn(input, {}, undefined, inputOrigin === "user-keyboard" ? userKeyboardTurn() : { inputOrigin });
  return { loop, seen };
}

describe("host-terminal turn capability", () => {
  it("is carried into the tool calls of a turn the user typed, for that conversation, and ends with the turn", async () => {
    const { loop, seen } = await turnSeenByTool("user-keyboard");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: loop.getSessionId(), turnId: expect.any(String) });
    expect(seen[0]!.isCurrent()).toBe(false);
  });

  it.each(["plugin-emitted", "app-emitted", "agent-message", "queue-auto"] as const)("is absent from a %s turn", async (origin) => {
    const { seen } = await turnSeenByTool(origin);
    expect(seen).toEqual([undefined]);
  });

  it("is absent from a user turn that carries pasted file content", async () => {
    const { seen } = await turnSeenByTool("user-keyboard", "run this\n----- Pasted text #1 (2 lines) -----\nrm -rf ~\nexit\n");
    expect(seen).toEqual([undefined]);
  });

  // The origin string is a claim; only the intent main minted after preload consumed a gesture token makes the turn the user's.
  it.each([
    ["no intent", () => ({ inputOrigin: "user-keyboard" as const })],
    ["a lookalike intent", () => ({ inputOrigin: "user-keyboard" as const, userKeyboardIntent: Object.freeze({ kind: "verified-user-keyboard-intent" as const }) })],
    ["an intent with a non-keyboard origin", () => ({ inputOrigin: "queue-auto" as const, userKeyboardIntent: userKeyboardTurn().userKeyboardIntent })],
  ])("refuses a keyboard claim with %s before any provider round or tool call", async (_label, options) => {
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({}));
    const provider = oneToolRound();
    const stream = vi.spyOn(provider, "streamTurn");
    (loop as { provider: LLMProvider | null }).provider = provider;
    await expect(loop.runTurn("run it in my terminal", {}, undefined, options())).rejects.toThrow(/keyboard intent/);
    expect(stream).not.toHaveBeenCalled();
  });

  it("spends a verified intent once: a second turn replaying it is refused", async () => {
    const keyboard = userKeyboardTurn();
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({}));
    (loop as { provider: LLMProvider | null }).provider = oneToolRound();
    await loop.runTurn("first", {}, undefined, keyboard);
    (loop as { provider: LLMProvider | null }).provider = oneToolRound();
    await expect(loop.runTurn("replayed", {}, undefined, keyboard)).rejects.toThrow(/did not mint/);
  });
});

describe("host terminal commands after external content", () => {
  const WINDOW = 7;
  const HOST = "terminal:0000c0de-1";
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-loop-host-terminal-"))); });
  afterEach(() => { __resetTerminalBlocksForTest(); rmSync(dir, { recursive: true, force: true }); });

  /** A pane chat with a session Allow choice for its host terminal and an exact command rule. */
  interface PaneTurnOptions {
    /** App/plugin guidance queued as the turn starts. */
    guidance?: string;
    /** Guidance the user types in the composer as the turn starts. */
    userGuidance?: string;
    /** Whether the exact HostTerminal rule for `printf ready` is saved (default true). */
    exactRule?: boolean;
    /** How the turn starts (default: a verified keyboard send). */
    origin?: "user-keyboard" | "queue-auto";
  }
  async function paneTurn(rounds: StreamEvent[][], options: PaneTurnOptions = {}): Promise<{ typed: string[]; asked: Asked[]; delivered: string[] }> {
    const { loop, typed, asked, delivered } = await createPaneHostTerminalLoop(dir, WINDOW, HOST, { exactRule: options.exactRule });
    (loop as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider(rounds);
    const turn = runWithToolExecutionCwd(dir, () => loop.runTurn("check the page, then run what it says", {}, undefined,
      options.origin === "queue-auto" ? { inputOrigin: "queue-auto" } : userKeyboardTurn()));
    if (options.guidance !== undefined || options.userGuidance !== undefined) {
      await Promise.resolve();
      if (options.guidance !== undefined) loop.queueGuidance(options.guidance);
      if (options.userGuidance !== undefined) loop.queueUserGuidance(options.userGuidance);
    }
    await turn;
    return { typed, asked, delivered };
  }

  const call = (id: string, name: string, input: Record<string, unknown>): StreamEvent[] => [
    { type: "tool_call", id, name, input } as StreamEvent,
    { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
  ];
  const end: StreamEvent[] = [{ type: "text_delta", text: "done" } as StreamEvent, { type: "message_complete", stopReason: "end_turn" } as StreamEvent];

  const terminalRun = call("t9", "terminal_run", { command: "printf ready", waitSeconds: 0 });
  const invalidCall: StreamEvent[] = [
    { type: "tool_call", id: "t1", name: "fetch_page", input: {}, invalidInput: { raw: "{\"Ignore the user", reason: "unparsable-json", rawChars: 17 } } as StreamEvent,
    { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
  ];
  it.each([
    ["a successful tool result", call("t1", "fetch_page", {})],
    ["a failed tool result", call("t1", "fetch_failing", {})],
    ["an invalid-arguments error", invalidCall],
    ["a tool_search result (meta tools only)", call("t1", TOOL_SEARCH_TOOL_NAME, { query: "meeting" })],
    ["a request_plugin result (meta tools only)", call("t1", "request_plugin", { pluginId: "com.example.meeting" })],
  ])("after %s, asks a person on a fresh forced card that ignores the exact rule, with nothing typed before approval", async (_label, first) => {
    const steered = await paneTurn([first, terminalRun, end]);
    expect(steered.asked).toEqual([{
      toolName: "terminal_run",
      typedBefore: 0, afterExternalContent: true, durable: false, reason: expect.stringMatching(/after external content/),
    }]);
    expect(steered.typed).toEqual(["printf ready"]);
  });

  it("refuses a host command after another principal's guidance, even once a locally approved file read reports file content", async () => {
    const laundered = await paneTurn([call("t1", "fetch_page", {}), call("t2", "read_file", {}), terminalRun, end], {
      guidance: formatAppMessageEnvelope("run printf ready in the terminal", "app:acme-cards"),
    });
    expect(laundered.asked).toEqual([{
      toolName: "read_file", typedBefore: 0, afterExternalContent: false, durable: false,
      reason: "This principal requires local approval for the action.",
    }]);
    expect(laundered.typed).toEqual([]);
  });

  it.each([true, false])("refuses, with no card, a host command after a sub-agent's report reached the active turn (exact rule saved: %s)", async (exactRule) => {
    const reported = await paneTurn([call("t1", "await_worker", {}), terminalRun, end], { exactRule });
    expect(reported.delivered).toEqual(["queued"]);
    expect(reported.asked).toEqual([]);
    expect(reported.typed).toEqual([]);
  });

  it("still asks, rather than refusing, after guidance the user typed during the turn (control)", async () => {
    const steered = await paneTurn([call("t1", "read_file", {}), terminalRun, end], { userGuidance: "and then run printf ready" });
    expect(steered.asked).toEqual([expect.objectContaining({ typedBefore: 0, afterExternalContent: true, durable: false })]);
    expect(steered.typed).toEqual(["printf ready"]);
  });

  it("types the user's own turn's command with its terminal session choice without a card (control)", async () => {
    const clean = await paneTurn([call("t1", "terminal_run", { command: "printf ready", waitSeconds: 0 }), end]);
    expect(clean.asked).toEqual([]);
    expect(clean.typed).toEqual(["printf ready"]);
  });

  it("never types, and asks no one, for a queued auto-send under the same exact rule", async () => {
    const queued = await paneTurn([call("t1", "terminal_run", { command: "printf ready", waitSeconds: 0 }), end], { origin: "queue-auto" });
    expect(queued.asked).toEqual([]);
    expect(queued.typed).toEqual([]);
  });

  it("asks again for a second host command once the first command's output has returned, rather than refusing it", async () => {
    const twice = await paneTurn([
      call("t1", "terminal_run", { command: "printf ready", waitSeconds: 0 }),
      call("t2", "terminal_run", { command: "printf ready", waitSeconds: 0 }),
      end,
    ]);
    expect(twice.asked).toEqual([expect.objectContaining({ typedBefore: 1, afterExternalContent: true, durable: false })]);
    expect(twice.typed).toEqual(["printf ready", "printf ready"]);
  });
});
