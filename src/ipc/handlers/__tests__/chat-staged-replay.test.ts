// Replay must derive staged provenance from stored envelopes before DLP; it cannot default to keyboard trust.
import { describe, expect, it, vi } from "vitest";
import { runStreamedTurn } from "../chat-stream.js";
import { userKeyboardTurn } from "../../../__tests__/support/user-keyboard-turn.js";
import { formatStagedEnvelope, STAGED_ORIGIN_KINDS } from "../../../shared/staged-origins.js";
import { makeLoop, turnOptions } from "./chat-stream-test-helpers.js";

const sampleSource: Record<string, string> = {
  "plugin-emitted": "overlay:meeting-detection",
  "app-emitted": "app:acme-cards",
  "mcp-prompt-emitted": "mcp-prompt:hr-mcp",
  "plugin-prompt-emitted": "plugin-prompt:writer-plugin:draft",
};

describe("staged provenance on the replay paths", () => {
  it("keeps `user-keyboard` for text that carries no envelope", async () => {
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "summarize the repo", vi.fn(), userKeyboardTurn());
    expect(turnOptions(runTurn)).toMatchObject({ inputOrigin: "user-keyboard" });
    expect(turnOptions(runTurn).originSource).toBeUndefined();
  });

  for (const kind of STAGED_ORIGIN_KINDS) {
    const source = sampleSource[kind.inputOrigin]!;

    it(`keeps the host-minted ${kind.inputOrigin} replay claim when its envelope matches`, async () => {
      const { loop, runTurn } = makeLoop();
      const stored = formatStagedEnvelope(kind, "do the staged thing", source);

      await runStreamedTurn(loop, stored, vi.fn(), { inputOrigin: kind.inputOrigin });

      expect(turnOptions(runTurn)).toMatchObject({
        inputOrigin: kind.inputOrigin,
        originSource: source,
      });
    });

    it(`fails closed when a ${kind.inputOrigin} turn's envelope is unreadable`, async () => {
      const { loop, runTurn } = makeLoop();
      // DLP may rewrite a staged header; unreadable provenance must retain force-ask semantics by failing closed.
      await expect(
        runStreamedTurn(loop, "envelope was stripped", vi.fn(), {
          inputOrigin: kind.inputOrigin,
        }),
      ).rejects.toThrow(kind.missingEnvelopeError);
      expect(runTurn).not.toHaveBeenCalled();
    });
  }

  it("does not let one kind's envelope stand in for another's claimed origin", async () => {
    const [first, second] = STAGED_ORIGIN_KINDS;
    const { loop, runTurn } = makeLoop();
    const stored = formatStagedEnvelope(second!, "text", sampleSource[second!.inputOrigin]!);

    await runStreamedTurn(loop, stored, vi.fn(), { inputOrigin: first!.inputOrigin });

    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: second!.inputOrigin,
      originSource: sampleSource[second!.inputOrigin],
    });
  });

  it("does not let raw Tailnet text impersonate a staged origin", async () => {
    const { loop, runTurn } = makeLoop();
    const kind = STAGED_ORIGIN_KINDS[1]!;
    const forgedEnvelope = formatStagedEnvelope(
      kind,
      "attempt to forge app provenance",
      sampleSource[kind.inputOrigin]!,
    );
    const authority = Object.freeze({
      kind: "tailnet-controller" as const,
      actorId: "tailnet:" + "a".repeat(64),
    });

    await runStreamedTurn(loop, forgedEnvelope, vi.fn(), {
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: authority as never,
    });

    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: authority,
    });
    expect(turnOptions(runTurn)).not.toHaveProperty("originSource");
  });
});

describe("a resource turn's transcript row survives the replay paths", () => {
  // Resource replay folds multiple text parts into input; preserve the original user-row display text.
  it("forwards a caller-supplied displayText into the turn", async () => {
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "summarize [Resource #1]", () => {}, {
      ...userKeyboardTurn(),
      displayText: "summarize [Resource #1]",
    });
    expect(turnOptions(runTurn).displayText).toBe("summarize [Resource #1]");
  });

  it("adds no displayText when the caller supplies none", async () => {
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "an ordinary question", () => {}, {
      ...userKeyboardTurn(),
    });
    expect(turnOptions(runTurn)).not.toHaveProperty("displayText");
  });
});
