import { describe, expect, it } from "vitest";
import { buildApprovalScopeOptions } from "../approval-scope-options.js";

describe("folder approval scopes", () => {
  it("offers once, session and persistent folder grants in scope order", () => {
    expect(buildApprovalScopeOptions({ candidatePath: "/project/file", suggestedParent: "/project" })).toEqual([
      { id: "o1", choice: "allow-once", widens: false, path: "/project/file" },
      { id: "o2", choice: "allow-session", widens: true, path: "/project" },
      { id: "o3", choice: "allow-always", widens: true, path: "/project" },
      { id: "o4", choice: "deny-once", widens: false },
    ]);
  });

  it("respects host narrowing and requires a safe parent for remembered folder grants", () => {
    for (const input of [
      { candidatePath: "/project/file", suggestedParent: null },
      { candidatePath: "/project/file", suggestedParent: "/project", allowedChoices: ["allow-once", "deny-once"] as const },
    ]) expect(buildApprovalScopeOptions(input).map(option => option.choice)).toEqual(["allow-once", "deny-once"]);
  });
});
