import { describe, expect, it } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { makeConversationLoopMemoryManager } from "./conversation-loop-test-helpers.js";

describe("user-owned choices follow actual session retirement", () => {
  it.each(["cleanup", "new", "load"] as const)("clears choices after %s session teardown", async operation => {
    const target = "33333333-3333-4333-8333-333333333333";
    const deps = makeBasicConversationLoopDeps({ memoryManager: makeConversationLoopMemoryManager([], target) });
    const loop = new ConversationLoop(deps);
    const outgoing = loop.sessionId;
    deps.permissionManager!.setUserOwnedSurfaceChoice(outgoing, "browser", "allow");
    deps.permissionManager!.setUserOwnedSurfaceChoice(outgoing, "host-terminal", "auto");
    deps.permissionManager!.setUserOwnedSurfaceChoice("separate-session", "browser", "allow");
    if (operation === "cleanup") await loop.cleanupSession();
    else if (operation === "new") await loop.newConversation();
    else expect(await loop.loadSession(target)).toBe(true);
    expect(deps.permissionManager!.getUserOwnedSurfaceChoice(outgoing, "browser")).toBe("ask");
    expect(deps.permissionManager!.getUserOwnedSurfaceChoice(outgoing, "host-terminal")).toBe("ask");
    expect(deps.permissionManager!.getUserOwnedSurfaceChoice("separate-session", "browser")).toBe("allow");
  });
});
