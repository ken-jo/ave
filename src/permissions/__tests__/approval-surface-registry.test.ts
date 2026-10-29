import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { ApprovalSurfaceRegistry, approvalSurfaceRegistry, updateApprovalSurface } from "../approval-surface-registry.js";

function surface() {
  return { isDestroyed: () => false } as WebContents;
}

describe("approval surface registrations", () => {
  it("routes a conversation terminal through its live session attachment and revokes the link on release", () => {
    const registry = new ApprovalSurfaceRegistry();
    const first = surface();
    const second = surface();
    registry.bindTerminalSession("internal-terminal", "child");
    expect(registry.resolve(undefined, "internal-terminal")).toBeNull();
    registry.register("root", first);
    registry.inherit("child", "root");
    expect(registry.resolve(undefined, "internal-terminal")).toBe(first);
    expect(registry.terminalSessionId("internal-terminal")).toBe("child");
    expect(registry.resolve("another-session", "internal-terminal")).toBeNull();
    registry.register("root", second);
    expect(registry.resolve(undefined, "internal-terminal")).toBe(second);
    registry.releaseOwner(second);
    expect(registry.resolve(undefined, "internal-terminal")).toBeNull();
    registry.register("root", first);
    registry.releaseTerminal("internal-terminal");
    expect(registry.resolve(undefined, "internal-terminal")).toBeNull();
    expect(() => registry.bindTerminalSession("internal-terminal", "")).toThrow("empty identity");
  });
  it("routes attachment, inheritance and lifecycle changes through the common update function", () => {
    const first = surface();
    const second = surface();
    const root = "common-update-root";
    const child = "common-update-child";
    const moved = "common-update-moved";
    const tab = "terminal:common-update";
    try {
      updateApprovalSurface({ kind: "attach", sessionId: root, surface: first });
      updateApprovalSurface({ kind: "inherit", sessionId: child, parentSessionId: root });
      updateApprovalSurface({ kind: "attach-terminal", tabId: tab, surface: first });
      updateApprovalSurface({ kind: "attach-unattributed", surface: first });
      expect(approvalSurfaceRegistry.resolve(child)).toBe(first);
      expect(approvalSurfaceRegistry.resolve(undefined, tab)).toBe(first);
      expect(approvalSurfaceRegistry.resolve(undefined)).toBe(first);
      updateApprovalSurface({ kind: "attach", sessionId: root, surface: second });
      updateApprovalSurface({ kind: "move", previousSessionId: child, sessionId: moved });
      expect(approvalSurfaceRegistry.resolve(child)).toBeNull();
      expect(approvalSurfaceRegistry.resolve(moved)).toBe(second);
      updateApprovalSurface({ kind: "release-owner", surface: second });
      expect(approvalSurfaceRegistry.resolve(root)).toBeNull();
      expect(approvalSurfaceRegistry.resolve(moved)).toBeNull();
      updateApprovalSurface({ kind: "release-terminal", tabId: tab });
      expect(approvalSurfaceRegistry.resolve(undefined, tab)).toBeNull();
      updateApprovalSurface({ kind: "release", sessionId: root });
      updateApprovalSurface({ kind: "release-owner", surface: first });
      expect(approvalSurfaceRegistry.resolve(undefined)).toBeNull();
    } finally {
      for (const sessionId of [root, child, moved]) updateApprovalSurface({ kind: "release", sessionId });
      updateApprovalSurface({ kind: "release-terminal", tabId: tab });
      updateApprovalSurface({ kind: "attach-unattributed", surface: null });
    }
  });

  it("rejects malformed common updates instead of silently ignoring contract violations", () => {
    expect(() => updateApprovalSurface({ kind: "unknown" } as never)).toThrow("invalid update operation");
    expect(() => updateApprovalSurface(undefined as never)).toThrow("invalid update operation");
    expect(() => updateApprovalSurface(null as never)).toThrow("invalid update operation");
    expect(() => updateApprovalSurface({ kind: "attach", sessionId: "", surface: null })).toThrow("empty identity");
    expect(() => updateApprovalSurface({ kind: "release-owner", surface: undefined as never })).toThrow("invalid owner registration");
    expect(() => updateApprovalSurface({ kind: "release-owner", surface: null as never })).toThrow("invalid owner release");
  });

  it("has no owner until a host explicitly registers one", () => {
    const registry = new ApprovalSurfaceRegistry();
    const owner = surface();
    registry.registerUnattributed(owner);
    expect(registry.resolve(undefined)).toBe(owner);
    expect(registry.resolve("unknown")).toBeNull();
    registry.register("background", null);
    expect(registry.resolve("background")).toBeNull();
  });

  it("follows live parent links through multiple generations and owner transfers", () => {
    const registry = new ApprovalSurfaceRegistry();
    const first = surface();
    const second = surface();
    registry.register("root", first);
    registry.inherit("child", "root");
    registry.inherit("grandchild", "child");
    expect(registry.resolve("grandchild")).toBe(first);
    registry.register("root", second);
    expect(registry.resolve("grandchild")).toBe(second);
    registry.release("root");
    expect(registry.resolve("grandchild")).toBeNull();
    registry.inherit("orphan", undefined);
    expect(registry.resolve("orphan")).toBeNull();
  });

  it("moves a run's registration while revoking its outgoing session", () => {
    const registry = new ApprovalSurfaceRegistry();
    const owner = surface();
    registry.register("outgoing", owner);
    registry.move("outgoing", "current");
    expect(registry.resolve("outgoing")).toBeNull();
    expect(registry.resolve("current")).toBe(owner);
    registry.inherit("old-child", "current");
    registry.move("old-child", "new-child");
    expect(registry.resolve("old-child")).toBeNull();
    expect(registry.resolve("new-child")).toBe(owner);
    registry.move("current", "current");
    expect(() => registry.move("missing", "other")).toThrow("unregistered outgoing session");
    expect(() => registry.move("missing", "missing")).toThrow("unregistered outgoing session");
  });

  it("rejects invalid identities and cyclic parent registration without destroying existing authority", () => {
    const registry = new ApprovalSurfaceRegistry();
    const owner = surface();
    registry.register("root", owner);
    registry.inherit("child", "root");
    expect(() => registry.inherit("root", "child")).toThrow("cyclic parent registration");
    expect(() => registry.inherit("self", "self")).toThrow("cyclic parent registration");
    expect(registry.resolve("child")).toBe(owner);
    expect(() => registry.register(" ", owner)).toThrow("empty identity");
    expect(() => registry.inherit("child", "")).toThrow("empty identity");
    expect(() => registry.resolve(" ")).toThrow("empty identity");
    expect(() => registry.registerTerminal("", owner)).toThrow("empty identity");
    expect(() => registry.register("invalid-owner", undefined as never)).toThrow("invalid owner registration");
    expect(() => registry.registerTerminal("terminal:invalid", {} as never)).toThrow("invalid owner registration");
    expect(() => registry.registerUnattributed(undefined as never)).toThrow("invalid owner registration");
  });

  it("never borrows a session or unattributed owner for an unregistered terminal", () => {
    const registry = new ApprovalSurfaceRegistry();
    const owner = surface();
    const terminalOwner = surface();
    registry.register("session", owner);
    registry.registerUnattributed(owner);
    expect(registry.resolve("session", "terminal:one")).toBeNull();
    registry.registerTerminal("terminal:one", terminalOwner);
    expect(registry.resolve(undefined, "terminal:one")).toBe(terminalOwner);
    registry.releaseTerminal("terminal:one");
    expect(registry.resolve(undefined, "terminal:one")).toBeNull();
  });

  it("revokes only the closing owner's registrations, including terminals and unattributed asks", () => {
    const registry = new ApprovalSurfaceRegistry();
    const first = surface();
    const second = surface();
    registry.register("first", first);
    registry.register("second", second);
    registry.inherit("child", "first");
    registry.registerTerminal("terminal:one", first);
    registry.registerUnattributed(first);
    registry.releaseOwner(first);
    expect(registry.resolve("first")).toBeNull();
    expect(registry.resolve("child")).toBeNull();
    expect(registry.resolve(undefined)).toBeNull();
    expect(registry.resolve(undefined, "terminal:one")).toBeNull();
    expect(registry.resolve("second")).toBe(second);
  });
});
