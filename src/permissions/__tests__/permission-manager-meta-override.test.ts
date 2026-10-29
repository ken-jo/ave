import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionManager } from "../permission-manager.js";

vi.mock("../permissions-store.js", () => ({
  readPermissionsFile: vi.fn(async () => null),
  updatePermissionsFile: vi.fn(async () => undefined),
}));

// Host metadata is evidence; ordinary decisions follow docs/architecture/permission-decision-tree.md.
describe("host operation decision contracts", () => {
  let manager: PermissionManager;
  beforeEach(() => { manager = new PermissionManager("/tmp/test-meta-override-permissions.json"); });

  it.each(["strict", "default"] as const)("asks normally for an ordinary host operation in %s", (mode) => {
    manager.setMode(mode);
    expect(manager.checkDetailed("agent_spawn", "builtin", "meta", undefined, { decisionOverride: "ask" })).toMatchObject({ decision: "ask", reasonCode: "file-write" });
  });

  it.each(["agent_spawn", "agent_interrupt"])("reviews %s in auto mode", (name) => {
    manager.setMode("auto");
    expect(manager.checkDetailed(name, "builtin", "meta", undefined, { decisionOverride: "ask" })).toMatchObject({ decision: "ask", reviewer: { route: "foreground-auto" } });
  });

  it("allows an ordinary host operation in allow mode", () => {
    manager.setMode("allow");
    expect(manager.checkDetailed("agent_spawn", "builtin", "meta", undefined, { decisionOverride: "ask" }).decision).toBe("allow");
  });

  it("denies a host operation without a decision contract", () => {
    expect(manager.checkDetailed("some_meta_tool", "builtin", "meta")).toMatchObject({ decision: "deny", reasonCode: "invalid-meta" });
  });

  it.each(["default", "auto", "strict", "allow"] as const)("denies forged external host operations in %s", (mode) => {
    manager.setMode(mode);
    manager.setRules([{ pattern: "forged_meta", action: "allow" }]);
    for (const source of ["plugin", "mcp"] as const) {
      expect(manager.checkDetailed("forged_meta", source, "meta", undefined, { decisionOverride: "ask" })).toMatchObject({ decision: "deny", reasonCode: "invalid-meta" });
    }
  });

  it("allows an audited host contract after immutable checks", () => {
    expect(manager.checkDetailed("ask_user_question", "builtin", "meta", undefined, { decisionOverride: "always-allow-with-audit" }).decision).toBe("allow");
    manager.setRules([{ pattern: "ask_user_question", action: "deny" }]);
    expect(manager.checkDetailed("ask_user_question", "builtin", "meta", undefined, { decisionOverride: "always-allow-with-audit" }).decision).toBe("deny");
  });

  it("honors an explicit rule before an ordinary host operation", () => {
    manager.setRules([{ pattern: "agent_spawn", action: "allow" }]);
    expect(manager.checkDetailed("agent_spawn", "builtin", "meta", undefined, { decisionOverride: "ask" })).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  });

  it("honors a durable grant before an ordinary host operation", async () => {
    await manager.addAlwaysAllowedPersist("agent_spawn");
    expect(manager.checkDetailed("agent_spawn", "builtin", "meta", undefined, { decisionOverride: "ask" })).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
  });

  it("keeps other-principal approval before rules and audited contracts", () => {
    manager.setMode("allow");
    manager.setRules([{ pattern: "ask_user_question", action: "allow" }]);
    expect(manager.checkDetailed("ask_user_question", "builtin", "meta", "overlay:meeting-detection", { decisionOverride: "always-allow-with-audit" })).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
  });
});
