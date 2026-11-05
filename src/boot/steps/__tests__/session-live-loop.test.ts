import { describe, expect, it } from "vitest";
import { createRoutineChatResolver, createRoutineProjectRootResolver, type SessionLiveLoop } from "../session-live-loop.js";

const loop = (sessionId: string, projectRoot: string | null): SessionLiveLoop => ({
  getSessionId: () => sessionId,
  getSessionProjectRoot: () => projectRoot,
});

function resolver(options: {
  tiles?: SessionLiveLoop[];
  side?: SessionLiveLoop;
  panes?: SessionLiveLoop[];
  metadata?: Record<string, { projectRoot?: string }>;
  roots?: Record<string, string>;
}) {
  return createRoutineProjectRootResolver({
    resolveRootSessionId: (sessionId) => options.roots?.[sessionId] ?? sessionId,
    findLoopBySessionId: (sessionId) => options.tiles?.find((l) => l.getSessionId() === sessionId),
    sideChatConversationLoop: options.side,
    paneChatLoops: { all: () => options.panes ?? [] },
    loadSessionMetadata: (sessionId) => options.metadata?.[sessionId] ?? null,
    defaultProjectRoot: () => "/default-workspace",
  });
}

describe("routine project root resolver", () => {
  it("takes the project of the live loop that holds the session, in a tile, the side chat or a pane chat", () => {
    const resolve = resolver({
      tiles: [loop("tile", "/p/tile")],
      side: loop("side", "/p/side"),
      panes: [loop("other-pane", "/p/other"), loop("pane", "/p/pane")],
    });
    expect(resolve("tile")).toBe("/p/tile");
    expect(resolve("side")).toBe("/p/side");
    expect(resolve("pane")).toBe("/p/pane");
  });

  it("resolves a subagent to its root conversation", () => {
    const resolve = resolver({ panes: [loop("root", "/p/root")], roots: { child: "root" } });
    expect(resolve("child")).toBe("/p/root");
  });

  it("falls back to saved metadata, then the default workspace, and refuses an unknown session", () => {
    const resolve = resolver({
      side: loop("side", null),
      metadata: { saved: { projectRoot: "/p/saved" }, plain: {}, side: { projectRoot: "/p/side-saved" } },
    });
    expect(resolve("saved")).toBe("/p/saved");
    expect(resolve("plain")).toBe("/default-workspace");
    expect(resolve("side")).toBe("/p/side-saved");
    expect(resolve("unknown")).toBeUndefined();
  });
});

describe("routine chat resolver (대화에 연결)", () => {
  const resolve = createRoutineChatResolver({
    resolveRootSessionId: (sessionId) => ({ child: "open", "side-child": "side" } as Record<string, string>)[sessionId] ?? sessionId,
    findLoopBySessionId: (sessionId) => (sessionId === "open" ? loop("open", null) : undefined),
    sideChatConversationLoop: loop("side", null),
    paneChatLoops: { all: () => [loop("pane", null)] },
    loadMainChatMetadata: (sessionId) => ({ saved: {}, side: {}, run: { routineId: "r1" } } as Record<string, { routineId?: string }>)[sessionId],
  });

  it("binds the root main chat, open in a tile or saved by the main store", () => {
    expect(resolve("open")).toBe("open");
    expect(resolve("child")).toBe("open");
    expect(resolve("saved")).toBe("saved");
  });

  it("has no chat for the side chat, a pane chat, a schedule item's own run or an unknown session", () => {
    expect(resolve("side")).toBeUndefined();
    expect(resolve("side-child")).toBeUndefined();
    expect(resolve("pane")).toBeUndefined();
    expect(resolve("run")).toBeUndefined();
    expect(resolve("unknown")).toBeUndefined();
  });
});
