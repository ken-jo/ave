// Golden expectations transcribed from docs/architecture/permission-decision-tree.md.
import { describe, expect, it } from "vitest";
import {
  decidePermission,
  NO_APPROVER_MESSAGE,
  type PermissionDecisionRequest,
  type PermissionFloorCode,
  type PermissionPipelineOutcome,
} from "../decision-pipeline.js";

const EXPECTED_NO_APPROVER_MESSAGE = "Nobody can approve this request; do not retry.";
const MODES = ["strict", "default", "auto", "allow"] as const;
type ExpectedAction = PermissionPipelineOutcome | "reviewer";
type ActionRow = {
  name: string;
  evidence: Partial<PermissionDecisionRequest>;
  expected: readonly [ExpectedAction, ExpectedAction, ExpectedAction, ExpectedAction];
};
const READ = { name: "read_file", source: "builtin", kind: "read" } as const;
const WRITE = { name: "write_file", source: "builtin", kind: "file-write" } as const;
const SHELL = { name: "shell", source: "builtin", kind: "shell" } as const;
const SAFE_SHELL = { sandboxed: true, readOnlyProven: true, unproven: false, destructive: false };
const QUESTION = ["ask", "ask", "reviewer", "allow"] as const;

// The first twelve action rows are the mode matrix; its thirteenth row is tested for every human fallback below.
const ACTION_ROWS: readonly ActionRow[] = [
  { name: "ordinary file read", evidence: {}, expected: ["allow", "allow", "allow", "allow"] },
  { name: "secret file read", evidence: { secretRead: true }, expected: QUESTION },
  { name: "recoverable project write", evidence: { tool: WRITE, fileWrite: { insideProject: true, checkpointAvailable: true } }, expected: ["ask", "allow", "allow", "allow"] },
  { name: "outside project write", evidence: { tool: WRITE, fileWrite: { insideProject: false, checkpointAvailable: true } }, expected: QUESTION },
  { name: "proven sandboxed read-only shell", evidence: { tool: SHELL, shell: SAFE_SHELL }, expected: ["allow", "allow", "allow", "allow"] },
  { name: "mutating sandboxed shell", evidence: { tool: SHELL, shell: { ...SAFE_SHELL, readOnlyProven: false } }, expected: ["ask", "sandbox-auto", "sandbox-auto", "sandbox-auto"] },
  { name: "unproven sandboxed shell", evidence: { tool: SHELL, shell: { ...SAFE_SHELL, unproven: true } }, expected: QUESTION },
  { name: "host shell", evidence: { tool: SHELL, shell: { ...SAFE_SHELL, sandboxed: false } }, expected: QUESTION },
  { name: "network action", evidence: { tool: { name: "web_fetch", source: "builtin", kind: "network" } }, expected: QUESTION },
  { name: "read-only external tool", evidence: { tool: { name: "remote_read", source: "mcp", kind: "mcp", readOnlyHint: true } }, expected: ["allow", "allow", "allow", "allow"] },
  { name: "other external tool", evidence: { tool: { name: "remote_call", source: "mcp", kind: "mcp" } }, expected: QUESTION },
  { name: "mandatory human floor", evidence: { floor: { code: "protected-path", reason: "Protected control path." } }, expected: ["ask-forced", "ask-forced", "ask-forced", "ask-forced"] },
];

function request(evidence: Partial<PermissionDecisionRequest> = {}): PermissionDecisionRequest {
  return { tool: READ, mode: "default", headless: false, ...evidence };
}

describe("permission decision mode matrix", () => {
  for (const row of ACTION_ROWS) {
    for (const [index, mode] of MODES.entries()) {
      for (const headless of [false, true]) {
        it(`${row.name}, ${mode}, headless=${headless}`, () => {
          const expected = row.expected[index];
          const decision = decidePermission(request({ ...row.evidence, mode, headless }));
          if (expected === "reviewer") {
            expect(decision).toMatchObject({ outcome: "ask", reviewRequired: true });
          } else if (headless && (expected === "ask" || expected === "ask-forced")) {
            expect(decision).toEqual({ outcome: "deny", reasonCode: "no-approver", reason: EXPECTED_NO_APPROVER_MESSAGE });
          } else {
            expect(decision.outcome).toBe(expected);
            expect(decision.reviewRequired).toBeUndefined();
          }
        });
      }
    }
  }
});

describe("ordered admission, floors and explicit rules", () => {
  const floors: readonly PermissionFloorCode[] = ["protected-path", "critical-delete", "project-escape", "exfiltration", "other-principal"];
  for (const mode of MODES) {
    for (const code of floors) {
      for (const headless of [false, true]) {
        it(`${code} precedes grants and reviewer, ${mode}, headless=${headless}`, () => {
          const evidence = request({ mode, headless, floor: { code, reason: "Mandatory floor." }, rules: { ask: "Ask rule.", allow: "Allow rule.", remembered: "Prior grant." }, reviewer: { status: "success", level: "low" } });
          expect(decidePermission(evidence).outcome).toBe(headless ? "deny" : "ask-forced");
          expect(decidePermission(evidence).reviewRequired).toBeUndefined();
          expect(decidePermission({ ...evidence, rules: { ...evidence.rules, deny: "Deny rule." } })).toEqual({ outcome: "deny", reasonCode: "rule-deny", reason: "Deny rule." });
          expect(decidePermission({ ...evidence, admissionDenial: { code: "policy-unreadable", reason: "Policy unavailable." } })).toEqual({ outcome: "deny", reasonCode: "policy-unreadable", reason: "Policy unavailable." });
        });
      }
    }
  }
  for (const [index, mode] of MODES.entries()) {
    it(`ordinary ask rules reach mode handling before read and grants in ${mode}`, () => {
      const result = decidePermission(request({ mode, rules: { ask: "Ask before reading.", allow: "Tool grant.", remembered: "Prior grant." } }));
      expect(result.outcome).toBe(["ask", "ask", "ask", "allow"][index]);
      expect(result.reviewRequired).toBe(mode === "auto" ? true : undefined);
    });
    for (const kind of ["allow", "remembered"] as const) {
      it(`${kind} explicit grant precedes secret classification in ${mode}`, () => {
        expect(decidePermission(request({ mode, headless: true, secretRead: true, rules: { [kind]: "Explicit grant." } })).outcome).toBe("allow");
      });
    }
  }
});

describe("reviewer and human availability", () => {
  it("exports the exact no-approver message", () => {
    expect(NO_APPROVER_MESSAGE).toBe(EXPECTED_NO_APPROVER_MESSAGE);
  });
  const reviewerRows = [
    { reviewer: { status: "success", level: "low" }, outcome: "allow" },
    { reviewer: { status: "success", level: "medium" }, outcome: "allow" },
    { reviewer: { status: "success", level: "high" }, outcome: "ask" },
    { reviewer: { status: "success" }, outcome: "ask" },
    { reviewer: { status: "error", level: "low" }, outcome: "ask" },
    { reviewer: { status: "abort", level: "medium" }, outcome: "ask" },
    { reviewer: { status: "success", level: "low", breakerOpen: true }, outcome: "ask" },
  ] as const;
  for (const { reviewer, outcome } of reviewerRows) {
    for (const headless of [false, true]) {
      it(`review ${reviewer.status}/${"level" in reviewer ? reviewer.level : "missing"}, breaker=${"breakerOpen" in reviewer}, headless=${headless}`, () => {
        const result = decidePermission(request({ mode: "auto", secretRead: true, headless, reviewer }));
        expect(result.outcome).toBe(headless && outcome === "ask" ? "deny" : outcome);
        expect(result.reviewRequired).toBeUndefined();
        if (headless && outcome === "ask") expect(result.reason).toBe(EXPECTED_NO_APPROVER_MESSAGE);
      });
    }
  }
  it("owner away waits for a human instead of denying", () => {
    expect(decidePermission(request({ ownerAway: true, secretRead: true })).outcome).toBe("ask");
  });
});

describe("classification boundaries", () => {
  for (const mode of MODES) {
    it(`manual rerun requires fresh human approval in ${mode}`, () => {
      const evidence = request({ mode, manualRerun: true, rules: { allow: "Grant.", remembered: "Prior grant." }, reviewer: { status: "success", level: "low" } });
      expect(decidePermission(evidence)).toMatchObject({ outcome: "ask", reasonCode: "manual-rerun" });
      expect(decidePermission({ ...evidence, headless: true })).toMatchObject({ outcome: "deny", reason: EXPECTED_NO_APPROVER_MESSAGE });
      expect(decidePermission({ ...evidence, floor: { code: "critical-delete", reason: "Critical delete." } }).outcome).toBe("ask-forced");
      expect(decidePermission({ ...evidence, rules: { deny: "Deny." } }).outcome).toBe("deny");
    });
  }
  for (const mode of ["strict", "default", "auto"] as const) {
    it(`missing checkpoint requires approval in ${mode}`, () => {
      const result = decidePermission(request({ mode, tool: WRITE, fileWrite: { insideProject: true, checkpointAvailable: false } }));
      expect(result.outcome).toBe("ask");
      expect(result.requiresCodeCheckpoint).toBeUndefined();
    });
  }
  it("checkpoint-backed automatic writes carry their execution requirement", () => {
    expect(decidePermission(request({ tool: WRITE, fileWrite: { insideProject: true, checkpointAvailable: true } })).requiresCodeCheckpoint).toBe(true);
  });
  it("an outside directory boolean cannot substitute for an authenticated grant", () => {
    expect(decidePermission(request({ tool: WRITE, fileWrite: { insideProject: false, checkpointAvailable: true, directoryApproved: true } })).outcome).toBe("ask");
  });
  for (const signal of ["destructive", "unproven", "escalated"] as const) {
    it(`${signal} overrides a read-only shell proof`, () => {
      expect(decidePermission(request({ tool: SHELL, shell: { ...SAFE_SHELL, [signal]: true } })).outcome).toBe("ask");
    });
  }
  it("missing shell evidence cannot earn sandbox automation", () => {
    expect(decidePermission(request({ tool: SHELL })).outcome).toBe("ask");
  });
  it("remote source without a read-only hint cannot inherit ordinary read allowance", () => {
    expect(decidePermission(request({ tool: { ...READ, source: "mcp" } })).outcome).toBe("ask");
  });
  it("secret evidence overrides an external read-only hint", () => {
    expect(decidePermission(request({ secretRead: true, tool: { ...READ, source: "mcp", readOnlyHint: true } })).outcome).toBe("ask");
  });
});

describe("rest-of-turn human routing", () => {
  const pauses = [
    { kind: "consecutive", reason: "Consecutive review limit reached." },
    { kind: "total", reason: "Turn review limit reached." },
  ] as const;

  for (const automationPause of pauses) {
    for (const row of ACTION_ROWS) {
      for (const mode of MODES) {
        for (const headless of [false, true]) {
          it(`${automationPause.kind} pause, ${row.name}, ${mode}, headless=${headless}`, () => {
            const result = decidePermission(request({ ...row.evidence, mode, headless, sessionId: "paused-session", automationPause }));
            if (headless) {
              expect(result).toEqual({ outcome: "deny", reasonCode: "no-approver", reason: EXPECTED_NO_APPROVER_MESSAGE });
            } else if (row.evidence.floor) {
              expect(result).toEqual({ outcome: "ask-forced", reasonCode: row.evidence.floor.code, reason: row.evidence.floor.reason });
            } else {
              expect(result).toEqual({ outcome: "ask", reasonCode: "automation-paused", reason: automationPause.reason });
            }
            expect(result.reviewRequired).toBeUndefined();
            expect(result.requiresCodeCheckpoint).toBeUndefined();
          });
        }
      }
    }

    for (const mode of MODES) {
      for (const headless of [false, true]) {
        for (const grant of ["allow", "remembered"] as const) {
          it(`${automationPause.kind} pause overrides ${grant} in ${mode}, headless=${headless}`, () => {
            expect(decidePermission(request({ mode, headless, automationPause, rules: { [grant]: "Explicit prior approval." } })))
              .toEqual(headless ? { outcome: "deny", reasonCode: "no-approver", reason: EXPECTED_NO_APPROVER_MESSAGE }
                : { outcome: "ask", reasonCode: "automation-paused", reason: automationPause.reason });
          });
        }

        it(`${automationPause.kind} pause cannot override admission or rule deny in ${mode}, headless=${headless}`, () => {
          const evidence = request({ mode, headless, automationPause, rules: { deny: "Explicit deny.", allow: "Prior allow." }, floor: { code: "protected-path", reason: "Protected target." } });
          expect(decidePermission(evidence)).toEqual({ outcome: "deny", reasonCode: "rule-deny", reason: "Explicit deny." });
          expect(decidePermission({ ...evidence, admissionDenial: { code: "credential-store", reason: "Host credential admission." } }))
            .toEqual({ outcome: "deny", reasonCode: "credential-store", reason: "Host credential admission." });
        });
      }
    }

    for (const level of ["low", "medium"] as const) {
      for (const headless of [false, true]) {
        it(`${automationPause.kind} pause overrides successful ${level} review, headless=${headless}`, () => {
          const result = decidePermission(request({ mode: "auto", headless, secretRead: true, automationPause, reviewer: { status: "success", level } }));
          expect(result).toEqual(headless ? { outcome: "deny", reasonCode: "no-approver", reason: EXPECTED_NO_APPROVER_MESSAGE }
            : { outcome: "ask", reasonCode: "automation-paused", reason: automationPause.reason });
        });
      }
    }
  }

  it("pause evidence applies only to the supplied request and never infers session state", () => {
    const paused = request({ sessionId: "paused-session", automationPause: { kind: "total", reason: "Turn review limit reached." } });
    expect(decidePermission(paused).outcome).toBe("ask");
    expect(decidePermission(request({ sessionId: "paused-session" })).outcome).toBe("allow");
    expect(decidePermission(request({ sessionId: "another-session" })).outcome).toBe("allow");
  });
});
