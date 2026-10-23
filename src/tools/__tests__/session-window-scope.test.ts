import { describe, expect, it } from "vitest";
import { resolveSessionWindow } from "../session-window-scope.js";

const origins: Record<string, string> = { child: "main", grandchild: "child" };
const liveOrigin = (sessionId: string): string | undefined => origins[sessionId];

describe("resolveSessionWindow", () => {
  it("still reaches the nearest hosted ancestor through the shared walk", () => {
    const deps = { liveOriginSessionId: liveOrigin, windowIdForHostedSession: (id: string) => (id === "main" ? 7 : null) };
    expect(resolveSessionWindow("grandchild", deps)).toEqual({ windowId: 7, hostSessionId: "main" });
    expect(resolveSessionWindow(undefined, deps)).toBeNull();
    expect(resolveSessionWindow("a", { ...deps, liveOriginSessionId: (id) => (id === "a" ? "b" : "a") })).toBeNull();
  });
});
