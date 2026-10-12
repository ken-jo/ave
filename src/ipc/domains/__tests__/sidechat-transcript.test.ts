import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../../contract/app-contract.js";
import type { SubAgentTranscriptRequest } from "../../../shared/subagent-transcript.js";
import type { IpcDeps } from "../../types.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerSideChatHandlers } from "../sidechat.js";

const SIDE_SESSION = "34fd6270-309d-4e47-878b-75c0742a6ac2";
const CHILD_SESSION = "sub-owned-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d";
const FOREIGN_ORIGIN = "89df5053-7dd8-4550-85c5-1a11011f7868";
const FOREIGN_CHILD = "sub-foreign-cafeb2d0-9bb2-4190-8f4f-26b2ebe2e507";
const REPLACEMENT_SESSION = "5f711b23-ee4f-4cbb-88e0-53b872bbda82";
const REQUEST: SubAgentTranscriptRequest = {
  originSessionId: SIDE_SESSION,
  childSessionId: CHILD_SESSION,
};

function frame(url = "file:///index.html"): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

function setup() {
  const sideLoop = {
    getSessionId: vi.fn(() => SIDE_SESSION),
    isSessionTransitioning: vi.fn(() => false),
  };
  const runner = {
    isPersistedSpawnOfOrigin: vi.fn((origin: string, child: string) =>
      origin === SIDE_SESSION && child === CHILD_SESSION),
    getPersistedTranscript: vi.fn((request: SubAgentTranscriptRequest) => ({
      ok: true as const,
      childSessionId: request.childSessionId,
      messages: [{ index: 0, role: "assistant", content: "Owned persisted transcript" }],
    })),
  };
  const getSubAgentRunner = vi.fn(() => runner);
  const auditLogger = { log: vi.fn() };
  const deps = {
    sideChatConversationLoop: sideLoop,
    getSubAgentRunner,
    auditLogger,
    getMainWindow: () => null,
  } as unknown as IpcDeps;
  registerSideChatHandlers(deps);
  return { deps, sideLoop, runner, getSubAgentRunner, auditLogger };
}

function read(payload: unknown = REQUEST, event = frame()): unknown {
  const handler = handlers.get(CHANNELS.sidechat.getSubAgentTranscript);
  expect(handler).toBeTypeOf("function");
  return handler!(event, payload);
}

beforeEach(() => handlers.clear());

describe("side-chat child transcript owner boundary", () => {
  it("reads a metadata-owned child of the current side-chat session", () => {
    const { runner } = setup();
    expect(read()).toEqual({
      ok: true,
      childSessionId: CHILD_SESSION,
      messages: [{ index: 0, role: "assistant", content: "Owned persisted transcript" }],
    });
    expect(runner.isPersistedSpawnOfOrigin).toHaveBeenCalledWith(SIDE_SESSION, CHILD_SESSION);
    expect(runner.getPersistedTranscript).toHaveBeenCalledExactlyOnceWith(REQUEST);
  });

  it("denies a foreign origin before runner lookup", () => {
    const { getSubAgentRunner, runner } = setup();
    expect(read({ ...REQUEST, originSessionId: FOREIGN_ORIGIN }))
      .toEqual({ ok: false, error: "origin-session-not-active" });
    expect(getSubAgentRunner).not.toHaveBeenCalled();
    expect(runner.getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("denies a foreign child before reading its transcript", () => {
    const { runner } = setup();
    expect(read({ ...REQUEST, childSessionId: FOREIGN_CHILD }))
      .toEqual({ ok: false, error: "sub-agent-reference-not-found" });
    expect(runner.isPersistedSpawnOfOrigin).toHaveBeenCalledWith(SIDE_SESSION, FOREIGN_CHILD);
    expect(runner.getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("denies reads after the host side chat closes", () => {
    const { deps, getSubAgentRunner } = setup();
    deps.sideChatConversationLoop = undefined;
    expect(read()).toEqual({ ok: false, error: "side-chat-unavailable" });
    expect(getSubAgentRunner).not.toHaveBeenCalled();
  });

  it("denies the old origin after the side-chat session is replaced", () => {
    const { sideLoop, getSubAgentRunner } = setup();
    sideLoop.getSessionId.mockReturnValue(REPLACEMENT_SESSION);
    expect(read()).toEqual({ ok: false, error: "origin-session-not-active" });
    expect(getSubAgentRunner).not.toHaveBeenCalled();
  });

  it("denies reads during a side-chat session transition", () => {
    const { sideLoop, getSubAgentRunner } = setup();
    sideLoop.isSessionTransitioning.mockReturnValue(true);
    expect(read()).toEqual({ ok: false, error: "origin-session-not-active" });
    expect(getSubAgentRunner).not.toHaveBeenCalled();
  });

  it("denies an unauthorized frame before consulting the active session", () => {
    const { sideLoop, getSubAgentRunner, auditLogger } = setup();
    expect(read(REQUEST, frame("https://foreign.invalid/")))
      .toEqual({ ok: false, error: "unauthorized-frame" });
    expect(sideLoop.getSessionId).not.toHaveBeenCalled();
    expect(getSubAgentRunner).not.toHaveBeenCalled();
    expect(auditLogger.log).toHaveBeenCalledOnce();
  });

  it.each([
    [{ ...REQUEST, originSessionId: "../other" }, "invalid-origin-session-id"],
    [{ ...REQUEST, childSessionId: "../other" }, "invalid-child-session-id"],
    [null, "invalid-origin-session-id"],
  ])("denies malformed request %j", (payload, error) => {
    const { runner } = setup();
    expect(read(payload)).toEqual({ ok: false, error });
    expect(runner.getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("remains registered and denies reads when no side chat is configured", () => {
    const getSubAgentRunner = vi.fn();
    registerSideChatHandlers({
      sideChatConversationLoop: undefined,
      getSubAgentRunner,
      auditLogger: { log: vi.fn() },
    } as unknown as IpcDeps);
    expect(read()).toEqual({ ok: false, error: "side-chat-unavailable" });
    expect(getSubAgentRunner).not.toHaveBeenCalled();
  });

  it("does not read when child ownership cannot be established", () => {
    const { runner } = setup();
    runner.isPersistedSpawnOfOrigin.mockReturnValue(false);
    expect(read()).toEqual({ ok: false, error: "sub-agent-reference-not-found" });
    expect(runner.getPersistedTranscript).not.toHaveBeenCalled();
  });
});
