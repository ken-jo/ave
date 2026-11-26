// A turn offers the waiting extension starts to whoever can answer: a person at the keyboard gets one card each, a turn
// nobody can answer starts none, and any other turn leaves them waiting.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { issueUnattendedTurnAuthority } from "../../shared/authorization-required.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { answerEachStart } from "../../__tests__/support/approved-extension-start.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, listPendingExtensionStarts, setExtensionStartAsker, type ExtensionStartAsker,
} from "../../permissions/extension-start-consent.js";

function waiting(overrides: Record<string, unknown> = {}) {
  const ask = vi.fn<ExtensionStartAsker["ask"]>(answerEachStart(() => "yes"));
  const notify = vi.fn<ExtensionStartAsker["notify"]>();
  const retry = vi.fn(async () => {});
  setExtensionStartAsker({ ask, notify });
  for (const key of ["plugin-child:a", "mcp-stdio:b"]) deferExtensionStart({ key, identity: "fixture", kind: "plugin-child", label: key, cause: "no-backend", retry });
  const loop = new ConversationLoop(makeBasicConversationLoopDeps(overrides));
  (loop as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider([[
    { type: "text_delta", text: "done" } as StreamEvent,
    { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
  ]]);
  return { loop, ask, notify, retry };
}

afterEach(() => __resetExtensionStartsForTest());

describe("waiting extension starts at a turn", () => {
  it("asks the person who typed the turn about every waiting start on one card, in that conversation", async () => {
    const { loop, ask, notify, retry } = waiting();
    await loop.runTurn("hello", {}, undefined, userKeyboardTurn());
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls.map(([starts, session]) => [starts.map((start) => start.key), session])).toEqual([
      [["plugin-child:a", "mcp-stdio:b"], { sessionId: loop.getSessionId() }],
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["queued", "unattended owner", "remote controller"])("leaves them waiting at a %s turn", async (kind) => {
    const { loop, ask, notify, retry } = waiting();
    const options = kind === "queued" ? { inputOrigin: "queue-auto" as const }
      : kind === "unattended owner" ? { ...userKeyboardTurn(), unattendedAuthority: issueUnattendedTurnAuthority() }
      : { inputOrigin: "tailnet-surface" as const, remoteControllerAuthority: bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:owner",
          pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
          pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => true } }, loop.getSessionId()) };
    await loop.runTurn("hello", {}, undefined, options);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ask).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["pending", "pending"]);
  });

  it("runs a start a backend has come to confine at any turn, with no card", async () => {
    const { loop, ask, retry } = waiting();
    const confined = vi.fn(async () => {});
    deferExtensionStart({ key: "plugin-child:c", identity: "fixture", kind: "plugin-child", label: "c", cause: "no-backend", retry: confined, recheck: () => "confined" });
    await loop.runTurn("hello", {}, undefined, { inputOrigin: "queue-auto" });
    await vi.waitFor(() => expect(confined).toHaveBeenCalledTimes(1));
    expect(ask).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
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
