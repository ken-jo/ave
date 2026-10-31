import { describe, expect, it } from "vitest";
import { decidePermission, type PermissionDecisionRequest } from "../decision-pipeline.js";
import { MODES, QUESTION_MODE_CELLS as ASK_RULE_CELLS } from "./fixtures/mode-matrix.js";

// Golden data transcribed from docs/architecture/permission-decision-tree.md,
// including its mode matrix and resolved host-shell/headless conflicts.
// Expectations use contract cells and dimensions, never production classifiers.
type ContractCell = "allow" | "sandbox-auto" | "ask" | "reviewer";
type ExpectedOutcome = "allow" | "sandbox-auto" | "ask" | "ask-forced" | "deny";
type Boundary = "inside-project" | "outside-project";
type ModeCells = readonly [ContractCell, ContractCell, ContractCell, ContractCell];
interface ActionRow {
  name: string;
  tool: PermissionDecisionRequest["tool"];
  evidence?: Pick<PermissionDecisionRequest, "secretRead" | "shell">;
  checkpoint?: boolean;
  fileName?: string;
  effect?: "read" | "write";
  inside: ModeCells;
  outside: ModeCells;
}

const BOUNDARIES: readonly Boundary[] = ["inside-project", "outside-project"];
const FLOORS = [undefined, "protected-path", "critical-delete", "project-escape", "other-principal"] as const;
const RULES = ["none", "deny", "ask", "allow", "remembered", "ask+allow"] as const;
const ACTIONS: readonly ActionRow[] = [
  { name: "ordinary file read", tool: { name: "read_file", source: "builtin", kind: "read" }, inside: ["allow", "allow", "allow", "allow"], outside: ["allow", "allow", "allow", "allow"] },
  { name: "secret file read", fileName: ".env", tool: { name: "read_file", source: "builtin", kind: "read" }, evidence: { secretRead: true }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "recoverable file write", tool: { name: "write_file", source: "builtin", kind: "file-write" }, checkpoint: true, inside: ["ask", "allow", "allow", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "file write without checkpoint", tool: { name: "write_file", source: "builtin", kind: "file-write" }, checkpoint: false, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "recoverable secret file write", fileName: ".env", tool: { name: "write_file", source: "builtin", kind: "write" }, checkpoint: true, inside: ["ask", "allow", "allow", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "secret file write without checkpoint", fileName: ".env", tool: { name: "write_file", source: "builtin", kind: "write" }, checkpoint: false, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "proven sandboxed read-only shell", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: true, readOnlyProven: true, unproven: false, destructive: false } }, inside: ["allow", "allow", "allow", "allow"], outside: ["allow", "allow", "allow", "allow"] },
  { name: "safe mutating sandboxed shell", effect: "write", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: true, readOnlyProven: false, unproven: false, destructive: false } }, inside: ["ask", "sandbox-auto", "sandbox-auto", "sandbox-auto"], outside: ["ask", "sandbox-auto", "sandbox-auto", "sandbox-auto"] },
  { name: "unproven sandboxed shell", effect: "write", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: true, readOnlyProven: false, unproven: true, destructive: false } }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "destructive sandboxed shell", effect: "write", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: true, readOnlyProven: false, unproven: false, destructive: true } }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "host shell with read-only proof", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: false, readOnlyProven: true, unproven: false, destructive: false } }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "mutating host shell", effect: "write", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: false, readOnlyProven: false, unproven: false, destructive: false } }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "escalated shell with read-only proof", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: true, readOnlyProven: true, unproven: false, destructive: false, escalated: true } }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "mutating escalated shell", effect: "write", tool: { name: "bash", source: "builtin", kind: "shell" }, evidence: { shell: { sandboxed: true, readOnlyProven: false, unproven: false, destructive: false, escalated: true } }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "network fetch", tool: { name: "web_fetch", source: "builtin", kind: "network" }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "read-only external tool", tool: { name: "catalog_list", source: "mcp", kind: "mcp", readOnlyHint: true }, inside: ["allow", "allow", "allow", "allow"], outside: ["allow", "allow", "allow", "allow"] },
  { name: "external tool without read-only hint", tool: { name: "catalog_update", source: "mcp", kind: "mcp" }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
  { name: "external tool explicit mutating hint", tool: { name: "catalog_update", source: "mcp", kind: "mcp", readOnlyHint: false }, inside: ["ask", "ask", "reviewer", "allow"], outside: ["ask", "ask", "reviewer", "allow"] },
];

// The six rule fixtures are independent contract inputs; ask+allow proves priority.
const RULE_EVIDENCE: Record<(typeof RULES)[number], PermissionDecisionRequest["rules"]> = {
  none: undefined,
  deny: { deny: "An explicit deny rule matches." },
  ask: { ask: "An explicit ask rule matches." },
  allow: { allow: "An explicit allow rule matches." },
  remembered: { remembered: "A matching approval was remembered." },
  "ask+allow": { ask: "An explicit ask rule matches.", allow: "An explicit allow rule also matches." },
};

interface GoldenCase {
  name: string;
  request: PermissionDecisionRequest;
  expected: ExpectedOutcome;
  reviewRequired: boolean;
}
const CASES: GoldenCase[] = [];
for (const action of ACTIONS) {
  for (const boundary of BOUNDARIES) {
    for (const [modeIndex, mode] of MODES.entries()) {
      for (const headless of [false, true]) {
        for (const floor of FLOORS) {
          for (const exfiltration of [false, true]) for (const rule of RULES) {
            const fileName = action.fileName ?? "item";
            const path = boundary === "inside-project" ? `/workspace/project/${fileName}` : `/outside/${fileName}`;
            const paths = { lexical: path, canonical: path };
            const request: PermissionDecisionRequest = {
              tool: action.tool,
              ...action.evidence,
              mode,
              headless,
              paths: [{ ...paths, effect: action.effect ?? (action.checkpoint === undefined ? "read" : "write") }],
              ...(action.checkpoint === undefined ? {} : { fileWrite: { insideProject: boundary === "inside-project", checkpointAvailable: action.checkpoint } }),
              ...(floor ? { floor: { code: floor, reason: "Mandatory one-time approval." } } : {}),
              rules: RULE_EVIDENCE[rule],
              ...(exfiltration ? { exfiltration: { reason: "An upload signal was observed." } } : {}),
            };
            // Owner precedence: deny rules; mandatory floors; explicit ask rules;
            // explicit/remembered allow; ordinary exfiltration guardrail; the action's matrix cell; human availability.
            let expected: ContractCell | "ask-forced" | "deny";
            if (rule === "deny") expected = "deny";
            else if (floor) expected = "ask-forced";
            else if (rule === "ask" || rule === "ask+allow") expected = exfiltration && headless ? "deny" : ASK_RULE_CELLS[modeIndex];
            else if (rule === "allow" || rule === "remembered") expected = "allow";
            else if (exfiltration) expected = headless ? "deny" : ASK_RULE_CELLS[modeIndex];
            else expected = (boundary === "inside-project" ? action.inside : action.outside)[modeIndex];
            const reviewRequired = expected === "reviewer";
            if (reviewRequired) expected = "ask";
            else if (headless && (expected === "ask" || expected === "ask-forced")) expected = "deny";
            CASES.push({
              name: `${action.name} / ${boundary} / ${mode} / ${headless ? "headless" : "human"} / ${floor ?? "no-floor"} / ${exfiltration ? "guardrail" : "no-guardrail"} / ${rule}`,
              request,
              expected: expected as ExpectedOutcome,
              reviewRequired,
            });
          }
        }
      }
    }
  }
}

const REVIEW_RESULTS: readonly {
  name: string;
  evidence: NonNullable<PermissionDecisionRequest["reviewer"]>;
  foreground: ExpectedOutcome;
  headless: ExpectedOutcome;
}[] = [
  { name: "low", evidence: { status: "success", level: "low" }, foreground: "allow", headless: "allow" },
  { name: "medium", evidence: { status: "success", level: "medium" }, foreground: "allow", headless: "allow" },
  { name: "high", evidence: { status: "success", level: "high" }, foreground: "ask", headless: "deny" },
  { name: "error", evidence: { status: "error" }, foreground: "ask", headless: "deny" },
  { name: "abort", evidence: { status: "abort" }, foreground: "ask", headless: "deny" },
  { name: "open breaker", evidence: { status: "success", level: "low", breakerOpen: true }, foreground: "ask", headless: "deny" },
];

describe("permission contract Cartesian matrix", () => {
  it("covers every action, boundary, mode, availability, floor, guardrail and rule combination", () => {
    expect(ACTIONS).toHaveLength(18);
    expect(CASES).toHaveLength(17_280);
    expect(new Set(CASES.map((entry) => entry.name)).size).toBe(17_280);
  });

  it.each(CASES)("$name", ({ request, expected, reviewRequired }) => {
    const decision = decidePermission(request);
    expect(decision.outcome).toBe(expected);
    expect(decision.reviewRequired === true).toBe(reviewRequired);
    if (expected === "deny" && request.headless && request.rules?.deny === undefined) {
      expect(decision.reason).toBe("Nobody can approve this request; do not retry.");
    }
    // Review comes before the no-human fallback. Every eligible Cartesian cell
    // is also evaluated against independently tabulated reviewer outcomes.
    if (reviewRequired) {
      for (const result of REVIEW_RESULTS) {
        const reviewed = decidePermission({ ...request, reviewer: result.evidence });
        expect(reviewed.outcome, result.name).toBe(request.headless ? result.headless : result.foreground);
        expect(reviewed.reviewRequired, result.name).toBeUndefined();
        if (request.headless && result.headless === "deny") {
          expect(reviewed.reason, result.name).toBe("Nobody can approve this request; do not retry.");
        }
      }
    } else if (request.floor || request.rules?.deny !== undefined) {
      // Favorable evidence cannot bypass admission-deny/floor precedence.
      expect(decidePermission({ ...request, reviewer: { status: "success", level: "low" } }).outcome).toBe(expected);
    }
  });
});
