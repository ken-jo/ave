import { describe, expect, it } from "vitest";
import { createRoutineProjectRootResolver, type SessionLiveLoop } from "../session-live-loop.js";

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
