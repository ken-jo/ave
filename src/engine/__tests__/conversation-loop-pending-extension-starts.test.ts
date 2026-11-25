// A turn offers the waiting extension starts to whoever can answer: a person at the keyboard gets one card each, a turn
// nobody can answer starts none, and any other turn leaves them waiting.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, listPendingExtensionStarts, setExtensionStartAsker, type ExtensionStartAsker,
} from "../../permissions/extension-start-consent.js";

function waiting(overrides: Record<string, unknown> = {}) {
  const ask = vi.fn<ExtensionStartAsker["ask"]>(async () => "yes");
  const notify = vi.fn<ExtensionStartAsker["notify"]>();
  const retry = vi.fn(async () => {});
  setExtensionStartAsker({ ask, notify });
  for (const key of ["plugin-child:a", "mcp-stdio:b"]) deferExtensionStart({ key, kind: "plugin-child", label: key, cause: "no-backend", retry });
  const loop = new ConversationLoop(makeBasicConversationLoopDeps(overrides));
  (loop as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider([[
    { type: "text_delta", text: "done" } as StreamEvent,
    { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
  ]]);
  return { loop, ask, notify, retry };
}

afterEach(() => __resetExtensionStartsForTest());

describe("waiting extension starts at a turn", () => {
  it("asks the person who typed the turn once per start, in that conversation", async () => {
    const { loop, ask, notify, retry } = waiting();
    await loop.runTurn("hello", {}, undefined, userKeyboardTurn());
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls.map(([start, session]) => [start.key, session])).toEqual([
      ["plugin-child:a", { sessionId: loop.getSessionId(), attended: true }],
      ["mcp-stdio:b", { sessionId: loop.getSessionId(), attended: true }],
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves them waiting at a turn nobody typed", async () => {
    const { loop, ask, notify, retry } = waiting();
    await loop.runTurn("hello", {}, undefined, { inputOrigin: "queue-auto" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ask).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["pending", "pending"]);
  });

  it.each([{ headless: true }, { approvalSurface: "unavailable" }])("starts none, with one notice each, at a turn nobody can answer (%o)", async (deps) => {
    const { loop, ask, notify, retry } = waiting(deps);
    await loop.runTurn("hello", {}, undefined, { inputOrigin: "queue-auto" });
    await loop.runTurn("again", {}, undefined, { inputOrigin: "queue-auto" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls.map(([start, why]) => [start.key, why])).toEqual([["plugin-child:a", "unattended"], ["mcp-stdio:b", "unattended"]]);
    expect(ask).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
