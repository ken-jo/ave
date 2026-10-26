import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalSurfaceRegistry } from "../../permissions/approval-surface-registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import {
  makeConversationLoopDeps,
  makeConversationLoopMemoryManager,
} from "./conversation-loop-test-helpers.js";

const loops: ConversationLoop[] = [];
const inheritedSessions: string[] = [];

afterEach(async () => {
  for (const loop of loops.splice(0)) {
    approvalSurfaceRegistry.release(loop.sessionId);
    await loop.auditLogger.close();
  }
  for (const sessionId of inheritedSessions.splice(0)) approvalSurfaceRegistry.release(sessionId);
});

function createLoop() {
  const loop = new ConversationLoop(makeConversationLoopDeps());
  loops.push(loop);
  return loop;
}

function owner(id: number): WebContents {
  return { id, isDestroyed: () => false } as WebContents;
}

describe("conversation approval-owner lifecycle", () => {
  it("does not register a run whose constructor fails", () => {
    let failedSessionId: string | undefined;
    const refresh = vi.spyOn(ConversationLoop.prototype, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        failedSessionId = this.sessionId;
        loops.push(this);
        throw new Error("provider selection rejected");
      });
    try {
      expect(() => createLoop()).toThrow("provider selection rejected");
      expect(failedSessionId).toBeTypeOf("string");
      expect(() => approvalSurfaceRegistry.move(failedSessionId!, "replacement-run"))
        .toThrow("approval-surface: unregistered outgoing session");
    } finally {
      refresh.mockRestore();
    }
  });

  it("registers a new run without borrowing another run's surface", () => {
    const interactive = createLoop();
    const surface = owner(1);
    approvalSurfaceRegistry.register(interactive.sessionId, surface);
    const background = createLoop();
    expect(approvalSurfaceRegistry.resolve(interactive.sessionId)).toBe(surface);
    expect(approvalSurfaceRegistry.resolve(background.sessionId)).toBeNull();
  });

  it("transfers the run's explicit owner through initialization and new sessions", async () => {
    const loop = createLoop();
    const surface = owner(2);
    approvalSurfaceRegistry.register(loop.sessionId, surface);
    const constructed = loop.sessionId;
    loop.initializeConversation();
    expect(approvalSurfaceRegistry.resolve(constructed)).toBeNull();
    expect(approvalSurfaceRegistry.resolve(loop.sessionId)).toBe(surface);
    const initialized = loop.sessionId;
    await loop.newConversation();
    expect(approvalSurfaceRegistry.resolve(initialized)).toBeNull();
    expect(approvalSurfaceRegistry.resolve(loop.sessionId)).toBe(surface);
  });

  it("moves the owner to a loaded session and revokes children of the outgoing session", async () => {
    const stored = "c9c01f31-663b-493e-8dc1-521e81e904f8";
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager: makeConversationLoopMemoryManager([], stored),
    }));
    loops.push(loop);
    const surface = owner(3);
    const outgoing = loop.sessionId;
    const child = "sub-outgoing-approval-owner";
    inheritedSessions.push(child);
    approvalSurfaceRegistry.register(outgoing, surface);
    approvalSurfaceRegistry.inherit(child, outgoing);
    expect(await loop.loadSession(stored)).toBe(true);
    expect(approvalSurfaceRegistry.resolve(stored)).toBe(surface);
    expect(approvalSurfaceRegistry.resolve(outgoing)).toBeNull();
    expect(approvalSurfaceRegistry.resolve(child)).toBeNull();
  });

  it("preserves an inherited binding when a child receives its addressable id", () => {
    const parent = createLoop();
    const child = createLoop();
    const first = owner(4);
    const second = owner(5);
    approvalSurfaceRegistry.register(parent.sessionId, first);
    approvalSurfaceRegistry.inherit(child.sessionId, parent.sessionId);
    const temporary = child.sessionId;
    child.sessionId = "sub-addressable-approval-owner";
    expect(approvalSurfaceRegistry.resolve(temporary)).toBeNull();
    expect(approvalSurfaceRegistry.resolve(child.sessionId)).toBe(first);
    approvalSurfaceRegistry.register(parent.sessionId, second);
    expect(approvalSurfaceRegistry.resolve(child.sessionId)).toBe(second);
  });

  it("keeps a routine explicitly without a surface through its session replacement", async () => {
    const routine = createLoop();
    await routine.startRoutineConversation("scheduled-owner", "Scheduled run");
    expect(approvalSurfaceRegistry.resolve(routine.sessionId)).toBeNull();
    await routine.cleanupSession();
    expect(approvalSurfaceRegistry.resolve(routine.sessionId)).toBeNull();
  });

  it("releases a discarded run's owner without revoking its parent", async () => {
    const parent = createLoop();
    const child = createLoop();
    const surface = owner(6);
    approvalSurfaceRegistry.register(parent.sessionId, surface);
    approvalSurfaceRegistry.inherit(child.sessionId, parent.sessionId);
    await child.cleanupSession();
    expect(approvalSurfaceRegistry.resolve(child.sessionId)).toBeNull();
    expect(approvalSurfaceRegistry.resolve(parent.sessionId)).toBe(surface);
  });
});
