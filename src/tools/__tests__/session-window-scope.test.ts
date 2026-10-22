import { describe, expect, it } from "vitest";
import { resolveRootSessionId, resolveSessionWindow } from "../session-window-scope.js";

const origins: Record<string, string> = { child: "main", grandchild: "child" };
const liveOrigin = (sessionId: string): string | undefined => origins[sessionId];

describe("resolveRootSessionId", () => {
  it("returns a session that is not a running sub-agent as its own root", () => {
    expect(resolveRootSessionId("main", liveOrigin)).toBe("main");
    expect(resolveRootSessionId("unrelated", liveOrigin)).toBe("unrelated");
  });

  it("walks nested sub-agents to the conversation that spawned them", () => {
    expect(resolveRootSessionId("child", liveOrigin)).toBe("main");
    expect(resolveRootSessionId("grandchild", liveOrigin)).toBe("main");
  });

  it("throws on a cyclic origin chain", () => {
    expect(() => resolveRootSessionId("a", (id) => (id === "a" ? "b" : "a"))).toThrow(/cyclic or deeper/);
  });

  it("throws past the nesting limit instead of guessing a root", () => {
    const deep = (id: string): string | undefined => {
      const depth = Number(id.slice(1));
      return depth < 20 ? `s${depth + 1}` : undefined;
    };
    expect(() => resolveRootSessionId("s0", deep)).toThrow(/cyclic or deeper/);
    expect(resolveRootSessionId("s12", deep)).toBe("s20");
  });
});

describe("resolveSessionWindow", () => {
  it("still reaches the nearest hosted ancestor through the shared walk", () => {
    const deps = { liveOriginSessionId: liveOrigin, windowIdForHostedSession: (id: string) => (id === "main" ? 7 : null) };
    expect(resolveSessionWindow("grandchild", deps)).toEqual({ windowId: 7, hostSessionId: "main" });
    expect(resolveSessionWindow(undefined, deps)).toBeNull();
    expect(resolveSessionWindow("a", { ...deps, liveOriginSessionId: (id) => (id === "a" ? "b" : "a") })).toBeNull();
  });
});
