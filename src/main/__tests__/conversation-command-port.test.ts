import { isRemoteControllerBoundToSession, type RemoteControllerAuthority } from "../../shared/chat-origin.js";
import { describe, expect, it, vi } from "vitest";
import { createConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { IpcDeps } from "../../ipc/types.js";
import { formatStagedEnvelope, STAGED_ORIGIN_KINDS } from "../../shared/staged-origins.js";
import { turnOptions } from "../../ipc/handlers/__tests__/chat-test-helpers.js";
import {
  bindMessageSendPayload,
  createConversationCommandPort,
  createTailnetControllerActor,
  createPlatformBridgeActor,
  DESKTOP_CONVERSATION_ACTOR,
  LOOPBACK_CONVERSATION_ACTOR,
} from "../conversation-command-port.js";

const completedTurn = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
} as const;

function makeFixture(
  runTurnOverride?: (...args: unknown[]) => Promise<typeof completedTurn>,
) {
  const runTurn = vi.fn(runTurnOverride ?? (async () => completedTurn));
  const markMainActiveFresh = vi.fn(async () => {});
  const deps = {
    conversationLoop: {
      getSessionId: () => "surface-command-session",
      getSessionKind: () => "main",
      getHistory: () => [],
      runTurn,
    },
    settingsService: { get: () => ({ piiRedactEnabled: false }) },
    auditLogger: { log: vi.fn() },
    memoryManager: {
      markMainActiveFresh,
      markMainActiveResume: vi.fn(async () => {}),
    },
  } as unknown as IpcDeps;
  const runtime = createConversationSurfaceRuntime();
  return { port: createConversationCommandPort(deps, runtime), runtime, runTurn, markMainActiveFresh };
}

function bridgeBindingFixture() {
  return Object.freeze({
    bridgeId: "11111111-1111-4111-8111-111111111111",
    bridgeEpoch: 1,
    routeId: "22222222-2222-4222-8222-222222222222",
    routeEpoch: 2,
    scope: "33333333-3333-4333-8333-333333333333",
  });
}

function pairedShareFixture() {
  return Object.freeze({
    pairingId: "11111111-1111-4111-8111-111111111111",
    pairingEpoch: 1,
    shareId: "22222222-2222-4222-8222-222222222222",
    shareEpoch: 2,
    scope: "33333333-3333-4333-8333-333333333333",
  });
}

describe("ConversationCommandPort", () => {
  it("mints surface-user provenance and discards external elevation claims", async () => {
    const { port, runTurn } = makeFixture();

    await expect(port.execute(LOOPBACK_CONVERSATION_ACTOR, {
      kind: "message.send",
      payload: {
        input: "summarize this request",
        attachments: [{ type: "text", text: "attached context" }],
        inputOrigin: "user-keyboard",
        userActivation: true,
        personaPromptId: "operator",
        remoteControllerAuthority: { kind: "tailnet-controller", actorId: `tailnet:${"a".repeat(64)}` },
      },
    })).resolves.toEqual(completedTurn);

    expect(runTurn).toHaveBeenCalledOnce();
    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: "surface-user",
      attachments: [{ type: "text", text: "attached context" }],
    });
    expect(turnOptions(runTurn)).not.toHaveProperty("remoteControllerAuthority");
    expect(turnOptions(runTurn)).not.toHaveProperty("requestAnchorRawIntent");
    expect(turnOptions(runTurn)).not.toHaveProperty("rolePrompt");
  });

  it("reserves the common lease for a Tailnet controller while minting its own provenance and host authority", async () => {
    const { port, runTurn } = makeFixture();
    const actor = createTailnetControllerActor("a".repeat(64));
    expect(port.submit).toBeTypeOf("function");
    const submission = port.submit!(actor, {
      kind: "message.send",
      payload: {
        input: "remote controller input",
        inputOrigin: "user-keyboard",
        userActivation: true,
        personaPromptId: "operator",
        remoteControllerAuthority: { kind: "tailnet-controller", actorId: `tailnet:${"b".repeat(64)}` },
      },
    });

    expect(submission).not.toBeNull();
    await expect(submission!.completion).resolves.toEqual(completedTurn);
    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: {
        kind: "tailnet-controller",
        actorId: `tailnet:${"a".repeat(64)}`,
      },
    });
    expect(turnOptions(runTurn)).toHaveProperty("requestAnchorRawIntent", "remote controller input");
    const authority = turnOptions(runTurn).remoteControllerAuthority as RemoteControllerAuthority;
    expect(isRemoteControllerBoundToSession(authority, "surface-command-session")).toBe(true);
    expect(isRemoteControllerBoundToSession(authority, "another-session")).toBe(false);
    expect(isRemoteControllerBoundToSession({ ...authority }, "surface-command-session")).toBe(false);
    expect(turnOptions(runTurn)).not.toHaveProperty("rolePrompt");
  });
  it("mints platform-bridge provenance and preserves only its host-owned remote authority", async () => {
    const { port, runTurn } = makeFixture();
    const bridgeBinding = bridgeBindingFixture();
    const bridgeGuard = Object.freeze({ isCurrent: vi.fn(() => true) });
    const actor = createPlatformBridgeActor("b".repeat(64), { bridgeBinding, bridgeGuard });

    await expect(port.execute(actor, {
      kind: "message.send",
      payload: {
        input: "external platform request",
        inputOrigin: "user-keyboard",
        userActivation: true,
        remoteControllerAuthority: { kind: "tailnet-controller", actorId: `tailnet:${"c".repeat(64)}` },
      },
    })).resolves.toEqual(completedTurn);

    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: "platform-bridge",
      remoteControllerAuthority: {
        kind: "platform-bridge",
        actorId: `bridge:${"b".repeat(64)}`,
        bridgeBinding,
        bridgeGuard,
      },
    });
    expect(turnOptions(runTurn)).toHaveProperty("requestAnchorRawIntent", "external platform request");
    const authority = turnOptions(runTurn).remoteControllerAuthority as RemoteControllerAuthority;
    expect(isRemoteControllerBoundToSession(authority, "surface-command-session")).toBe(true);
    expect(isRemoteControllerBoundToSession(authority, "another-session")).toBe(false);
    expect(isRemoteControllerBoundToSession({ ...authority }, "surface-command-session")).toBe(false);
    expect(turnOptions(runTurn)).not.toHaveProperty("rolePrompt");
  });

  it("fences a revoked platform bridge before its deferred turn can reach the model", async () => {
    const { port, runTurn } = makeFixture();
    const bridgeBinding = bridgeBindingFixture();
    let checks = 0;
    // The final check inside the deferred lease factory must still run after command admission and persona resolution have both succeeded.
    const bridgeGuard = Object.freeze({ isCurrent: vi.fn(() => ++checks < 6) });
    const actor = createPlatformBridgeActor("d".repeat(64), { bridgeBinding, bridgeGuard });

    await expect(port.execute(actor, {
      kind: "message.send",
      payload: { input: "do not start after revocation" },
    })).resolves.toEqual({ ok: false, error: "remote-controller-revoked" });

    expect(bridgeGuard.isCurrent).toHaveBeenCalledTimes(6);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("preserves a host-minted paired share binding and guard through the command boundary", async () => {
    const { port, runTurn } = makeFixture();
    const pairedShare = pairedShareFixture();
    const pairedShareGuard = Object.freeze({ isCurrent: vi.fn(() => true) });
    const actor = createTailnetControllerActor("e".repeat(64), {
      pairedShare,
      pairedShareGuard,
    });

    await expect(port.execute(actor, {
      kind: "message.send",
      payload: {
        input: "paired controller input",
        pairedShare: { pairingId: "untrusted-payload-field" },
      },
    })).resolves.toEqual(completedTurn);

    const options = turnOptions(runTurn) as {
      remoteControllerAuthority?: {
        pairedShare?: unknown;
        pairedShareGuard?: unknown;
      };
    };
    expect(options.remoteControllerAuthority?.pairedShare).toEqual(pairedShare);
    expect(options.remoteControllerAuthority?.pairedShareGuard).toBe(pairedShareGuard);
  });

  it("cancels only the exact paired actor's host-owned public turn through the shared AbortSignal", async () => {
    let rejectTurn: (reason?: unknown) => void = () => {};
    let observedSignal: AbortSignal | undefined;
    let signalStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const { port, runTurn } = makeFixture((...args) => new Promise<typeof completedTurn>((_resolve, reject) => {
      observedSignal = args[2] as AbortSignal;
      rejectTurn = reject;
      signalStarted();
    }));
    const pairedShare = pairedShareFixture();
    const pairedShareGuard = Object.freeze({ isCurrent: vi.fn(() => true) });
    const actor = createTailnetControllerActor("e".repeat(64), { pairedShare, pairedShareGuard });
    const otherActor = createTailnetControllerActor("f".repeat(64), { pairedShare, pairedShareGuard });
    const turnId = "tailnet-turn_" + "A".repeat(43);
    const submission = port.submit!(actor, {
      kind: "message.send",
      payload: { input: "cancellable remote request" },
      publicTurn: { turnId, abortController: new AbortController() },
    });
    // Admission reserves the public turn synchronously; wait for asynchronous preparation before cancelling an active turn.
    await turnStarted;

    expect(submission?.publicTurnId).toBe(turnId);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    await expect(port.execute(otherActor, { kind: "turn.cancel-own", turnId }))
      .resolves.toEqual({ ok: false, error: "turn-not-found" });
    expect(observedSignal?.aborted).toBe(false);

    await expect(port.execute(actor, { kind: "turn.cancel-own", turnId }))
      .resolves.toEqual({ ok: true, cancelled: true });
    expect(observedSignal?.aborted).toBe(true);

    rejectTurn(new Error("aborted-by-owner"));
    await expect(submission!.completion).rejects.toThrow("aborted-by-owner");
  });
  it.each(STAGED_ORIGIN_KINDS)("rejects the same $inputOrigin envelope bytes for local and bound remote users", async kind => {
    const input = formatStagedEnvelope(kind, "attempt to impersonate staged provenance", kind.inputOrigin === "plugin-emitted" ? "overlay:untrusted-remote-text" : kind.inputOrigin === "app-emitted" ? "app:untrusted" : kind.inputOrigin === "mcp-prompt-emitted" ? "mcp-prompt:untrusted" : "plugin-prompt:untrusted:prompt");
    const platform = createPlatformBridgeActor("d".repeat(64), {
      bridgeBinding: bridgeBindingFixture(), bridgeGuard: { isCurrent: () => true },
    });
    for (const actor of [DESKTOP_CONVERSATION_ACTOR, createTailnetControllerActor("c".repeat(64)), platform]) {
      const { port, runTurn } = makeFixture();
      await expect(port.execute(actor, { kind: "message.send", payload: { input, inputOrigin: "user-keyboard", userActivation: true } })).resolves.toEqual({ ok: false, error: "origin-envelope-mismatch" });
      expect(runTurn).not.toHaveBeenCalled();
    }
  });

  it("does not let a Tailnet /new command mutate main active-session state", async () => {
    const { port, markMainActiveFresh } = makeFixture();
    const actor = createTailnetControllerActor("d".repeat(64));

    await expect(port.execute(actor, {
      kind: "message.send",
      payload: { input: "/new" },
    })).resolves.toEqual(completedTurn);

    expect(markMainActiveFresh).not.toHaveBeenCalled();
  });

  it("keeps a verified desktop /new gesture as the only fresh-session trigger", async () => {
    const { port, markMainActiveFresh } = makeFixture();

    await expect(port.execute(DESKTOP_CONVERSATION_ACTOR, {
      kind: "message.send",
      payload: { input: "/new", inputOrigin: "user-keyboard", userActivation: true },
    })).resolves.toEqual(completedTurn);

    expect(markMainActiveFresh).toHaveBeenCalledOnce();
  });

  it("leaves desktop payload validation and its user-gesture boundary untouched", () => {
    const raw = { input: "desktop message", inputOrigin: "user-keyboard", userActivation: true };
    expect(bindMessageSendPayload(DESKTOP_CONVERSATION_ACTOR, raw)).toBe(raw);
  });

  it("rejects an adapter attempting to mint an unknown actor identity", () => {
    expect(() => bindMessageSendPayload(
      { kind: "external-surface", actorId: "spoofed" } as never,
      { input: "x" },
    )).toThrow("conversation-command-actor-unsupported");
  });
});


describe("desktop admission cancellation", () => {
  it("cancels before deferred preparation without entering the model", async () => {
    const { port, runtime, runTurn } = makeFixture();
    const pending = port.execute(DESKTOP_CONVERSATION_ACTOR, {
      kind: "message.send", payload: { input: "ordinary input", inputOrigin: "user-keyboard", userActivation: true },
    });
    expect(runtime.activity.isBusy()).toBe(true);
    runtime.activity.abortActiveTurn();
    await expect(pending).resolves.toMatchObject({ stopReason: "interrupted" });
    expect(runTurn).not.toHaveBeenCalled();
    expect(runtime.activity.isBusy()).toBe(false);
    await expect(port.execute(DESKTOP_CONVERSATION_ACTOR, { kind: "message.send", payload: { input: "next", inputOrigin: "user-keyboard", userActivation: true } })).resolves.toEqual(completedTurn);
    expect(runTurn).toHaveBeenCalledOnce();
    expect((runTurn.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(false);
  });
});


describe("desktop active turn cancellation", () => {
  it("propagates the admission signal into an active model turn", async () => {
    let observed!: AbortSignal;
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const { port, runtime } = makeFixture((...args) => new Promise<typeof completedTurn>((resolve) => {
      observed = args[2] as AbortSignal;
      finish = () => resolve(completedTurn);
      started();
    }));
    const pending = port.execute(DESKTOP_CONVERSATION_ACTOR, {
      kind: "message.send", payload: { input: "ordinary input", inputOrigin: "user-keyboard", userActivation: true },
    });
    await entered;
    runtime.activity.abortActiveTurn();
    expect(observed.aborted).toBe(true);
    finish();
    await pending;
  });
});
