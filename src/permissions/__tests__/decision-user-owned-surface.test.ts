// Expected outcomes come from the user-owned surface contract in permission-decision-tree.md.
import { describe, expect, it } from "vitest";
import { decidePermission, NO_APPROVER_MESSAGE, type PermissionDecisionRequest } from "../decision-pipeline.js";

const base: PermissionDecisionRequest = { tool: { name: "action", source: "builtin", kind: "read" }, mode: "allow", headless: false };

describe.each(["browser", "host-terminal"] as const)("%s session surface policy", kind => {
  for (const mode of ["strict", "default", "auto", "allow"] as const) for (const choice of ["allow", "auto", "ask"] as const) {
    it.each([{}, { allow: "generic rule" }, { remembered: "generic memory" }])(`${mode}/${choice} obeys surface choice before generic grants: %j`, rules => {
      for (const headless of [false, true]) {
        const result = decidePermission({ ...base, mode, headless, rules, userOwnedSurface: { kind, choice } });
        expect(result.outcome).toBe(headless ? "deny" : choice === "allow" ? "allow" : "ask");
        expect(result.reviewRequired).toBe(!headless && choice === "auto" ? true : undefined);
      }
    });
    it(`${mode}/${choice} obeys an ask rule before any session choice`, () => {
      const evidence = { ...base, mode, rules: { ask: "Ask explicitly.", allow: "Generic allow." }, userOwnedSurface: { kind, choice }, reviewer: { status: "success" as const, level: "low" as const } };
      expect(decidePermission(evidence)).toEqual({ outcome: "ask", reasonCode: "rule-ask", reason: "Ask explicitly." });
      expect(decidePermission({ ...evidence, headless: true })).toMatchObject({ outcome: "deny", reason: NO_APPROVER_MESSAGE });
    });
    it(`${mode}/${choice} denies headless regardless of generic permission`, () => {
      expect(decidePermission({ ...base, mode, headless: true, rules: { allow: "generic" }, userOwnedSurface: { kind, choice } })).toMatchObject({ outcome: "deny", reason: NO_APPROVER_MESSAGE });
    });
    it(`${mode}/${choice} preserves deny and actual floors`, () => {
      for (const headless of [false, true]) {
        const request = { ...base, mode, headless, userOwnedSurface: { kind, choice }, floor: { code: "exfiltration" as const, reason: "upload" } };
        expect(decidePermission(request).outcome).toBe(headless ? "deny" : "ask-forced");
        expect(decidePermission({ ...request, rules: { deny: "blocked" } })).toMatchObject({ outcome: "deny", reasonCode: "rule-deny" });
        expect(decidePermission({ ...request, floor: { code: "other-principal", reason: "tainted" } }).outcome).toBe(headless ? "deny" : "ask-forced");
        expect(decidePermission({ ...request, admissionDenial: { code: "policy-unreadable", reason: "Unknown policy" } })).toMatchObject({ outcome: "deny", reasonCode: "policy-unreadable" });
      }
    });
  }
  it.each(["low", "medium", "high"] as const)("only a consistent logical assessment permits auto: %s", level => {
    expect(decidePermission({ ...base, userOwnedSurface: { kind, choice: "auto" }, reviewer: { status: "success", level } }).outcome).toBe(level === "low" ? "allow" : "ask");
  });
  it.each(["error", "abort"] as const)("logical %s is a normal human fallback", status => {
    expect(decidePermission({ ...base, userOwnedSurface: { kind, choice: "auto" }, reviewer: { status, level: "low" } })).toMatchObject({ outcome: "ask", reasonCode: "user-owned-surface-human-required" });
  });
});
