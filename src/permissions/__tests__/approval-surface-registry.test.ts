import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { ApprovalSurfaceRegistry } from "../approval-surface-registry.js";

function surface() {
  return { isDestroyed: () => false } as WebContents;
}

describe("approval surface registrations", () => {
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
